const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-admin-regrade-"));
  process.env.DB_PATH = path.join(tmpDir, "admin-regrade.db");
  const db = require("../db");
  const { runRegradeBatch } = require("../lib/grading-regrade");

  try {
    await db.getDb();
    db.upsertUser(
      "regrade-user",
      "重评测试用户",
      "2026-08-13T10:00:00.000+08:00",
      "2026-08-13T10:00:00.000+08:00"
    );
    const baseRow = {
      user_id: "regrade-user",
      chapter_id: "V14-C1",
      chapter_label: "第一章",
      unit_id: "V14-C1-pre",
      unit_label: "第一章前测",
      question_id: "same-question",
      question_type: "short_answer",
      phase: "pre",
      points: 2,
      response: "学生答案",
      is_correct: 0,
      status: "ai_reviewed",
      score: 0,
      max_score: 2,
      created_at: "2026-08-13T10:01:00.000+08:00"
    };
    db.insertQuizResult({ ...baseRow, id: "regrade-success" });
    db.insertQuizResult({
      ...baseRow,
      id: "regrade-neighbour",
      created_at: "2026-08-13T10:02:00.000+08:00"
    });
    db.insertQuizResult({
      ...baseRow,
      id: "regrade-failure",
      question_id: "failure-question",
      created_at: "2026-08-13T10:03:00.000+08:00"
    });
    db.insertQuizResult({
      ...baseRow,
      id: "regrade-missing-ai-score",
      question_id: "missing-ai-score-question",
      created_at: "2026-08-13T10:04:00.000+08:00"
    });
    db.insertQuizResult({
      ...baseRow,
      id: "regrade-low-confidence",
      question_id: "low-confidence-question",
      created_at: "2026-08-13T10:05:00.000+08:00"
    });
    db.getDbSync().run(
      `UPDATE quiz_results
       SET ai_score = 0, ai_error_type = 'api_error',
           ai_feedback = '评分出错：旧接口失败。已先按 0 分计入，不影响继续学习。'
       WHERE id IN ('regrade-success', 'regrade-neighbour', 'regrade-failure')`
    );
    db.getDbSync().run(
      `UPDATE quiz_results
       SET ai_score = 0, ai_confidence = 0.4, ai_error_type = 'none',
           ai_feedback = '模型评分置信度不足，建议复核。'
       WHERE id = 'regrade-low-confidence'`
    );

    const courseAssessment = {
      authoritativeGradingQuestions(_index, rows) {
        return rows.map((row) => ({
          questionId: row.question_id,
          unitId: row.unit_id,
          chapterId: row.chapter_id,
          questionType: "short_answer",
          questionText: "测试题",
          referenceAnswer: "参考答案",
          rubric: "过程正确得满分",
          concepts: ["测试概念"],
          points: row.max_score,
          response: row.response
        }));
      }
    };
    let uuidCounter = 0;
    const common = {
      db,
      courseAssessment,
      assessmentIndex: new Map(),
      runtime: {
        provider: "openai-compatible",
        model: "auto",
        liveConfigured: true
      },
      nowIso: () => "2026-08-13T10:10:00.000+08:00",
      randomUUID: () => `audit-${++uuidCounter}`
    };

    const success = await runRegradeBatch({
      ...common,
      requestedIds: ["regrade-success"],
      gradeOnly: async () => [{
        questionId: "same-question",
        unitId: "V14-C1-pre",
        chapterId: "V14-C1",
        score: 2,
        confidence: 0.96,
        errorType: "none",
        feedback: "重新评分完成。",
        provider: "openai-compatible"
      }]
    });
    assert.equal(success.applied, 1);
    assert.equal(success.failed, 0);

    const changed = db.getDbSync().exec(
      `SELECT score, ai_score, is_correct, ai_error_type
       FROM quiz_results WHERE id = 'regrade-success'`
    )[0].values[0];
    assert.deepEqual(changed, [2, 2, 1, "none"]);
    const untouchedNeighbour = db.getDbSync().exec(
      `SELECT score, ai_score, is_correct, ai_error_type
       FROM quiz_results WHERE id = 'regrade-neighbour'`
    )[0].values[0];
    assert.deepEqual(
      untouchedNeighbour,
      [0, 0, 0, "api_error"],
      "同一用户、单元和题号的相邻历史记录不能被批量覆盖"
    );

    const failed = await runRegradeBatch({
      ...common,
      requestedIds: ["regrade-failure"],
      gradeOnly: async () => [{
        questionId: "failure-question",
        unitId: "V14-C1-pre",
        chapterId: "V14-C1",
        score: 0,
        confidence: 0,
        errorType: "api_timeout",
        feedback: "本次模型仍然超时。",
        provider: "timeout"
      }]
    });
    assert.equal(failed.applied, 0);
    assert.equal(failed.failed, 1);
    const unchangedFailure = db.getDbSync().exec(
      `SELECT score, ai_score, is_correct, ai_error_type, ai_feedback
       FROM quiz_results WHERE id = 'regrade-failure'`
    )[0].values[0];
    assert.deepEqual(unchangedFailure.slice(0, 4), [0, 0, 0, "api_error"]);
    assert.match(unchangedFailure[4], /旧接口失败/);

    const candidates = db.shortAnswerRegradeCandidates({ limit: 20 });
    assert.equal(candidates.rows.some((row) => row.id === "regrade-success"), false);
    assert.equal(candidates.rows.some((row) => row.id === "regrade-failure"), true);
    assert.equal(candidates.rows.some((row) => row.id === "regrade-neighbour"), true);
    assert.equal(candidates.rows.some((row) => row.id === "regrade-missing-ai-score"), true);
    assert.equal(candidates.rows.some((row) => row.id === "regrade-low-confidence"), true);
    assert.equal(
      candidates.rows.find((row) => row.id === "regrade-missing-ai-score")?.failure_reason,
      "missing_ai_score"
    );
    assert.equal(
      candidates.rows.find((row) => row.id === "regrade-low-confidence")?.failure_reason,
      "low_confidence"
    );

    const audits = db.gradingRegradeAudits({ limit: 20 });
    const appliedAudit = audits.find((row) => row.quiz_result_id === "regrade-success");
    const failedAudit = audits.find((row) => row.quiz_result_id === "regrade-failure");
    assert.equal(appliedAudit.status, "applied");
    assert.equal(failedAudit.status, "failed");
    assert.match(failedAudit.error_message, /超时/);
    assert.match(appliedAudit.previous_grade_json, /api_error/);
    assert.match(appliedAudit.applied_grade_json, /ai_reviewed/);

    const skipped = await runRegradeBatch({
      ...common,
      requestedIds: ["regrade-success"],
      gradeOnly: async () => {
        throw new Error("already reviewed records must not call the model");
      }
    });
    assert.equal(skipped.skipped, 1);
    assert.ok(skipped.results[0].auditId);
    const skippedAudit = db.gradingRegradeAudits({
      batchId: skipped.batchId,
      limit: 10
    })[0];
    assert.equal(skippedAudit.status, "skipped");
    assert.match(skippedAudit.error_message, /不再处于可重新评分状态/);

    console.log("admin grading regrade tests passed");
  } finally {
    db.saveNow();
    db.releaseWriteLock();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

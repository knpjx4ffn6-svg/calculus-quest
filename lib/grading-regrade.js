const crypto = require("crypto");

function gradingResultFailed(result = {}) {
  return [
    "api_error",
    "api_timeout",
    "parse_error",
    "empty_response",
    "mock_provider",
    "manual_fallback",
    "unknown"
  ].includes(String(result.errorType || "").trim().toLowerCase());
}

async function runRegradeBatch({
  db,
  courseAssessment,
  assessmentIndex,
  gradeOnly,
  requestedIds = [],
  runtime = {},
  nowIso = () => new Date().toISOString(),
  randomUUID = () => crypto.randomUUID()
}) {
  const ids = Array.from(new Set(
    requestedIds.map((id) => String(id || "").trim()).filter(Boolean)
  ));
  const preview = db.shortAnswerRegradeCandidates({
    ids,
    limit: ids.length
  });
  const rowById = new Map(preview.rows.map((row) => [row.id, row]));
  const batchId = randomUUID();
  const results = [];

  for (const quizResultId of ids) {
    const row = rowById.get(quizResultId);
    const createdAt = nowIso();
    if (!row) {
      const auditId = randomUUID();
      const current = db.getQuizResultById(quizResultId) || {};
      db.insertGradingRegradeAudit({
        id: auditId,
        batch_id: batchId,
        quiz_result_id: quizResultId,
        user_id: current.user_id || "",
        question_id: current.question_id || "",
        unit_id: current.unit_id || "",
        status: "skipped",
        llm_provider: runtime.provider,
        llm_model: runtime.model,
        error_message: current.id
          ? "记录已不再处于可重新评分状态。"
          : "未找到指定的简答题记录。",
        created_at: createdAt
      });
      results.push({
        quizResultId,
        auditId,
        status: "skipped",
        code: "grading_target_no_longer_retryable"
      });
      continue;
    }

    const gradingQuestions = courseAssessment.authoritativeGradingQuestions(assessmentIndex, [row]);
    const question = gradingQuestions[0];
    if (!question) {
      const auditId = randomUUID();
      db.insertGradingRegradeAudit({
        id: auditId,
        batch_id: batchId,
        quiz_result_id: row.id,
        user_id: row.user_id,
        question_id: row.question_id,
        unit_id: row.unit_id,
        status: "skipped",
        llm_provider: runtime.provider,
        llm_model: runtime.model,
        error_message: "当前课程路线中找不到该题目的权威题面或评分标准。",
        created_at: createdAt
      });
      results.push({
        quizResultId,
        auditId,
        status: "skipped",
        code: "grading_authoritative_question_missing"
      });
      continue;
    }

    let proposed = null;
    let gradingException = null;
    try {
      const graded = await gradeOnly([question]);
      proposed = graded[0] || null;
    } catch (error) {
      gradingException = error;
    }

    if (gradingException || !proposed || gradingResultFailed(proposed)) {
      const auditId = randomUUID();
      db.insertGradingRegradeAudit({
        id: auditId,
        batch_id: batchId,
        quiz_result_id: row.id,
        user_id: row.user_id,
        question_id: row.question_id,
        unit_id: row.unit_id,
        status: "failed",
        proposed_grade: proposed || {},
        llm_provider: proposed?.provider || runtime.provider,
        llm_model: runtime.model,
        error_message: gradingException?.message || proposed?.feedback || "模型未返回可应用的评分。",
        created_at: createdAt
      });
      results.push({
        quizResultId,
        auditId,
        status: "failed",
        code: gradingException ? "grading_request_failed" : proposed?.errorType || "grading_result_missing"
      });
      continue;
    }

    const auditId = randomUUID();
    const applied = db.applyQuizResultRegrade({
      id: auditId,
      batch_id: batchId,
      quiz_result_id: row.id,
      proposed_grade: proposed,
      llm_provider: proposed.provider || runtime.provider,
      llm_model: runtime.model,
      created_at: createdAt
    });
    if (!applied.ok) {
      db.insertGradingRegradeAudit({
        id: auditId,
        batch_id: batchId,
        quiz_result_id: row.id,
        user_id: row.user_id,
        question_id: row.question_id,
        unit_id: row.unit_id,
        status: "skipped",
        proposed_grade: proposed,
        llm_provider: proposed.provider || runtime.provider,
        llm_model: runtime.model,
        error_message: applied.code || "评分结果未应用。",
        created_at: createdAt
      });
    }
    results.push({
      quizResultId,
      auditId,
      status: applied.ok ? "applied" : "skipped",
      code: applied.ok ? "" : applied.code,
      applied: applied.ok ? applied.applied : null
    });
  }

  return {
    batchId,
    runtime,
    applied: results.filter((item) => item.status === "applied").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    results
  };
}

module.exports = {
  gradingResultFailed,
  runRegradeBatch
};

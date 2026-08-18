const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server health timeout\n${logs.join("")}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function startMockLlm(port) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = body.messages?.map((message) => message.content || "").join("\n") || "";
      if (prompt.includes("接口失败回答")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock upstream unavailable" } }));
        return;
      }
      const maxScore = Number(prompt.match(/满分：(\d+(?:\.\d+)?) 分/)?.[1] || 2);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              score: maxScore,
              isCorrect: true,
              confidence: 0.97,
              errorType: "none",
              weakConcepts: [],
              feedback: "重评通过。",
              reasoning: "回答符合参考答案。"
            })
          }
        }]
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function adminRequest(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-admin-regrade-api-"));
  const dbPath = path.join(tmpDir, "admin-regrade-api.db");
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const db = require("../db");
  const courseAssessment = require("../lib/course-assessment");
  const route = JSON.parse(
    fs.readFileSync(path.join(root, "data", "multi-scene-learning-route.json"), "utf8")
  );
  const assessmentIndex = courseAssessment.buildAssessmentIndex(route);
  const entry = Array.from(assessmentIndex.values()).find(
    (item) => item.question?.type === "short_answer"
  );
  assert.ok(entry, "the course route must contain a short-answer question");

  await db.getDb();
  const createdAt = "2026-08-13T10:00:00.000+08:00";
  const users = [
    ["api-regrade-success-user", "重评成功用户"],
    ["api-regrade-failure-user", "重评失败用户"]
  ];
  users.forEach(([id, nickname]) => db.upsertUser(id, nickname, createdAt, createdAt));
  const rowBase = {
    chapter_id: entry.chapterId,
    chapter_label: entry.chapterTitle || "",
    unit_id: entry.unitId,
    unit_label: entry.unitTitle || "",
    question_id: entry.question.id,
    question_type: "short_answer",
    phase: entry.phase,
    points: Number(entry.question.points || 2),
    is_correct: 0,
    status: "ai_reviewed",
    score: 0,
    max_score: Number(entry.question.points || 2),
    created_at: createdAt
  };
  const successIds = Array.from({ length: 6 }, (_, index) => `api-regrade-success-${index + 1}`);
  successIds.forEach((id, index) => {
    db.insertQuizResult({
      ...rowBase,
      id,
      user_id: users[0][0],
      response: `正常回答 ${index + 1}`,
      created_at: `2026-08-13T10:0${index}:00.000+08:00`
    });
  });
  db.getDbSync().run(
    `UPDATE learning_state_versions
     SET generation = 2, revision = 1, updated_at = ?
     WHERE user_id = ?`,
    ["2026-08-13T10:30:00.000+08:00", users[0][0]]
  );
  const currentGenerationNeighbourId = "api-regrade-current-generation-neighbour";
  db.insertQuizResult({
    ...rowBase,
    id: currentGenerationNeighbourId,
    user_id: users[0][0],
    response: "当前代次同题答案",
    created_at: "2026-08-13T11:00:00.000+08:00"
  });
  db.insertQuizResult({
    ...rowBase,
    id: "api-regrade-failure",
    user_id: users[1][0],
    response: "接口失败回答"
  });
  db.getDbSync().run(
    `UPDATE quiz_results
     SET ai_score = 0, ai_error_type = 'api_error',
          ai_feedback = '旧评分接口失败。已先按 0 分计入，不影响继续学习。'
     WHERE id LIKE 'api-regrade-success-%' OR id = 'api-regrade-failure'`
  );
  db.saveNow();
  db.releaseWriteLock();

  const appPort = await freePort();
  const llmPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const adminToken = "admin-regrade-api-token";
  const logs = [];
  let child;
  let mockLlm;

  try {
    mockLlm = await startMockLlm(llmPort);
    child = spawn(process.execPath, ["server.js", String(appPort)], {
      cwd: root,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        HOST: "127.0.0.1",
        ADMIN_TOKEN: adminToken,
        LLM_PROVIDER: "mock",
        GRADING_LLM_PROVIDER: "openai-compatible",
        GRADING_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
        GRADING_API_KEY: "test-key",
        GRADING_MODEL: "auto",
        NODE_ENV: "test"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
    child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
    await waitForHealth(baseUrl, child, logs);

    const preview = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade-candidates?limit=10"
    );
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.ok, true);
    assert.equal(preview.payload.data.total, 8);
    assert.equal(preview.payload.data.runtime.model, "auto");
    assert.equal(preview.payload.data.runtime.liveConfigured, true);
    const missingAiScoreCandidate = preview.payload.data.rows.find(
      (row) => row.id === currentGenerationNeighbourId
    );
    assert.ok(missingAiScoreCandidate);
    assert.equal(missingAiScoreCandidate.failure_reason, "missing_ai_score");

    const beforeOverview = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/overview"
    );
    assert.equal(beforeOverview.payload.data.avgAccuracy, 0);
    assert.equal(beforeOverview.payload.data.totalQuizResults, 8);
    const beforeQuestionErrors = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/question-errors"
    );
    const beforeQuestion = beforeQuestionErrors.payload.data.find(
      (row) => row.question_id === rowBase.question_id && row.unit_id === rowBase.unit_id
    );
    assert.ok(beforeQuestion);
    assert.equal(beforeQuestion.error_rate, 100);
    assert.equal(beforeQuestion.avg_score, 0);
    const beforePhaseResponse = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/phase-comparison"
    );
    const beforeSuccessPhase = beforePhaseResponse.payload.data.find(
      (row) => row.user_id === users[0][0] && row.chapter_id === rowBase.chapter_id
    );
    assert.ok(beforeSuccessPhase);
    assert.equal(beforeSuccessPhase[`${rowBase.phase}_accuracy`], 0);
    const beforeUserDetailResponse = await adminRequest(
      baseUrl,
      adminToken,
      `/api/admin/stats/user-detail?userId=${encodeURIComponent(users[0][0])}`
    );
    const beforeUserDetail = beforeUserDetailResponse.payload.data;
    assert.equal(beforeUserDetail.quizOverall.submissions, 7);
    assert.equal(beforeUserDetail.quizOverall.questions, 7);
    assert.equal(beforeUserDetail.quizOverall.correct, 0);
    assert.equal(beforeUserDetail.quizOverall.totalScore, 0);
    assert.equal(beforeUserDetail.quizOverall.generationCount, 2);
    assert.equal(beforeUserDetail.quizOverall.currentGeneration, 2);

    const missingConfirmation = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade",
      {
        method: "POST",
        body: JSON.stringify({
          ids: [successIds[0]],
          limit: 20
        })
      }
    );
    assert.equal(missingConfirmation.response.status, 400);
    assert.equal(
      missingConfirmation.payload.code,
      "grading_regrade_confirmation_required"
    );

    const oversized = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade",
      {
        method: "POST",
        body: JSON.stringify({
          ids: successIds,
          limit: 20,
          confirm: "REVIEW_AND_REGRADING"
        })
      }
    );
    assert.equal(oversized.response.status, 400);
    assert.equal(oversized.payload.code, "grading_regrade_batch_invalid");

    const executions = [];
    for (const id of [...successIds, "api-regrade-failure"]) {
      const execution = await adminRequest(
        baseUrl,
        adminToken,
        "/api/admin/grading/regrade",
        {
          method: "POST",
          body: JSON.stringify({
            ids: [id],
            limit: 1,
            confirm: "REVIEW_AND_REGRADING"
          })
        }
      );
      assert.equal(execution.response.status, 200, JSON.stringify(execution.payload));
      executions.push(execution.payload.data);
    }
    assert.equal(executions.reduce((sum, item) => sum + item.applied, 0), 6);
    assert.equal(executions.reduce((sum, item) => sum + item.failed, 0), 1);
    assert.equal(executions.reduce((sum, item) => sum + item.skipped, 0), 0);

    const responses = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/short-answer-responses?limit=10"
    );
    const successRow = responses.payload.data.rows.find((row) => row.id === successIds[0]);
    const failureRow = responses.payload.data.rows.find((row) => row.id === "api-regrade-failure");
    assert.equal(successRow.ai_error_type, "none");
    assert.equal(successRow.score, rowBase.max_score);
    assert.equal(successRow.is_correct, 1);
    assert.equal(failureRow.ai_error_type, "api_error");
    assert.equal(failureRow.score, 0);
    assert.match(failureRow.ai_feedback, /旧评分接口失败/);
    const rowMap = new Map(
      responses.payload.data.rows.map((row) => [row.id, row])
    );
    successIds.forEach((id) => {
      assert.equal(rowMap.get(id).score, rowBase.max_score);
      assert.equal(rowMap.get(id).is_correct, 1);
      assert.equal(rowMap.get(id).ai_error_type, "none");
    });
    const neighbourRow = rowMap.get(currentGenerationNeighbourId);
    assert.ok(neighbourRow);
    assert.equal(neighbourRow.score, 0);
    assert.equal(neighbourRow.is_correct, 0);
    assert.equal(neighbourRow.ai_error_type, "");

    const afterOverview = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/overview"
    );
    assert.equal(afterOverview.payload.data.avgAccuracy, 75);
    assert.equal(afterOverview.payload.data.totalQuizResults, 8);
    const afterQuestionErrors = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/question-errors"
    );
    const afterQuestion = afterQuestionErrors.payload.data.find(
      (row) => row.question_id === rowBase.question_id && row.unit_id === rowBase.unit_id
    );
    assert.ok(afterQuestion);
    assert.equal(afterQuestion.error_rate, 25);
    assert.equal(afterQuestion.avg_score, rowBase.max_score * 0.75);
    const phase = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/phase-comparison"
    );
    const successPhase = phase.payload.data.find((row) => row.user_id === users[0][0]);
    assert.equal(successPhase[`${rowBase.phase}_accuracy`], 85.7);
    assert.equal(successPhase[`${rowBase.phase}_score`], rowBase.max_score * successIds.length);
    const afterUserDetailResponse = await adminRequest(
      baseUrl,
      adminToken,
      `/api/admin/stats/user-detail?userId=${encodeURIComponent(users[0][0])}`
    );
    const afterUserDetail = afterUserDetailResponse.payload.data;
    const detailRowMap = new Map(
      afterUserDetail.quizQuestionRows.map((row) => [row.id, row])
    );
    successIds.forEach((id) => {
      assert.equal(detailRowMap.get(id).learning_generation, 1);
      assert.equal(detailRowMap.get(id).score, rowBase.max_score);
      assert.equal(detailRowMap.get(id).is_correct, 1);
    });
    assert.equal(
      detailRowMap.get(currentGenerationNeighbourId).learning_generation,
      2
    );
    assert.equal(detailRowMap.get(currentGenerationNeighbourId).score, 0);
    assert.equal(detailRowMap.get(currentGenerationNeighbourId).is_correct, 0);
    assert.equal(afterUserDetail.quizOverall.submissions, beforeUserDetail.quizOverall.submissions);
    assert.equal(afterUserDetail.quizOverall.questions, beforeUserDetail.quizOverall.questions);
    assert.equal(afterUserDetail.quizOverall.correct, 6);
    assert.equal(afterUserDetail.quizOverall.incorrect, 1);
    assert.equal(afterUserDetail.quizOverall.accuracy, 85.7);
    assert.equal(afterUserDetail.quizOverall.totalScore, rowBase.max_score * successIds.length);
    assert.equal(afterUserDetail.quizOverall.scoreRate, 85.7);
    assert.equal(
      afterUserDetail.quizOverall.generationCount,
      beforeUserDetail.quizOverall.generationCount
    );
    assert.equal(
      afterUserDetail.quizOverall.currentGeneration,
      beforeUserDetail.quizOverall.currentGeneration
    );

    const audits = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade-audits?limit=20"
    );
    assert.equal(audits.response.status, 200);
    assert.equal(audits.payload.data.length, 7);
    assert.equal(audits.payload.data.filter((row) => row.status === "applied").length, 6);
    assert.equal(audits.payload.data.filter((row) => row.status === "failed").length, 1);

    const secondPreview = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade-candidates?limit=10"
    );
    assert.equal(secondPreview.payload.data.total, 2);
    assert.deepEqual(
      new Set(secondPreview.payload.data.rows.map((row) => row.id)),
      new Set(["api-regrade-failure", currentGenerationNeighbourId])
    );

    console.log("admin grading regrade API tests passed");
  } finally {
    await stopChild(child);
    if (mockLlm) await new Promise((resolve) => mockLlm.close(resolve));
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

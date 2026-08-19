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
      const prompt = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        .messages?.map((message) => message.content || "").join("\n") || "";
      const maxScore = Number(prompt.match(/满分：(\d+(?:\.\d+)?) 分/)?.[1] || 25);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              score: maxScore,
              isCorrect: true,
              confidence: 0.98,
              errorType: "none",
              weakConcepts: [],
              feedback: "Regrade completed.",
              reasoning: "The response meets the rubric."
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-legacy-main-regrade-"));
  const dbPath = path.join(tmpDir, "legacy-main-regrade.db");
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const db = require("../db");
  const courseAssessment = require("../lib/course-assessment");
  const route = JSON.parse(
    fs.readFileSync(path.join(root, "data", "multi-scene-learning-route.json"), "utf8")
  );
  const assessmentIndex = courseAssessment.buildAssessmentIndex(route);
  const questionId = "GH-05-post-q4";
  const legacyContext = {
    question_id: questionId,
    chapter_id: "V14-C2",
    unit_id: "V14-C2-post",
    phase: "post"
  };
  const canonicalEntry = assessmentIndex.get(questionId);
  assert.ok(canonicalEntry, "current main must retain the historical question");
  assert.equal(canonicalEntry.unitId, "GH-05-post");
  assert.equal(courseAssessment.assessmentEntry(assessmentIndex, legacyContext), null);
  assert.equal(
    courseAssessment.assessmentEntry(assessmentIndex, legacyContext, {
      allowLegacyMainRegradeContext: true
    })?.unitId,
    canonicalEntry.unitId
  );
  assert.equal(
    courseAssessment.assessmentEntry(assessmentIndex, {
      ...legacyContext,
      unit_id: "V14-C2-post-copy"
    }, { allowLegacyMainRegradeContext: true }),
    null,
    "a same-id row with an unverified context must not fall back to main"
  );
  assert.equal(
    courseAssessment.authoritativeGradingQuestions(assessmentIndex, [{
      ...legacyContext,
      response: "legacy response"
    }]).length,
    0,
    "normal grading remains strict"
  );
  assert.equal(
    courseAssessment.authoritativeGradingQuestions(assessmentIndex, [{
      ...legacyContext,
      response: "legacy response"
    }], { allowLegacyMainRegradeContext: true }).length,
    1
  );

  await db.getDb();
  const createdAt = "2026-08-19T09:00:00.000+08:00";
  const userId = "legacy-main-regrade-user";
  const resultId = "legacy-main-gh05-post-q4";
  const maxScore = Number(canonicalEntry.question.points || 0);
  db.upsertUser(userId, "Legacy Main Regrade", createdAt, createdAt);
  db.insertQuizResult({
    id: resultId,
    user_id: userId,
    chapter_id: legacyContext.chapter_id,
    chapter_label: "Chapter 2",
    unit_id: legacyContext.unit_id,
    unit_label: "Historical post assessment",
    question_id: questionId,
    question_type: "short_answer",
    phase: legacyContext.phase,
    points: maxScore,
    response: "legacy response",
    is_correct: 0,
    status: "ai_reviewed",
    score: 0,
    max_score: maxScore,
    created_at: createdAt
  });
  db.getDbSync().run(
    `UPDATE quiz_results
     SET ai_score = 0, ai_error_type = 'api_error',
         ai_feedback = 'The original grading request failed.'
     WHERE id = ?`,
    [resultId]
  );
  db.saveNow();
  db.releaseWriteLock();

  const appPort = await freePort();
  const llmPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const adminToken = "legacy-main-regrade-token";
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

    const beforeCandidates = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade-candidates?limit=10"
    );
    assert.equal(beforeCandidates.response.status, 200);
    assert.equal(beforeCandidates.payload.data.total, 1);
    assert.equal(beforeCandidates.payload.data.rows[0].id, resultId);

    const beforeOverview = await adminRequest(baseUrl, adminToken, "/api/admin/stats/overview");
    assert.equal(beforeOverview.payload.data.avgAccuracy, 0);

    const regrade = await adminRequest(baseUrl, adminToken, "/api/admin/grading/regrade", {
      method: "POST",
      body: JSON.stringify({
        ids: [resultId],
        confirm: "REVIEW_AND_REGRADING"
      })
    });
    assert.equal(regrade.response.status, 200, JSON.stringify(regrade.payload));
    assert.equal(regrade.payload.data.applied, 1);
    assert.equal(regrade.payload.data.failed, 0);
    assert.equal(regrade.payload.data.skipped, 0);

    const afterCandidates = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade-candidates?limit=10"
    );
    assert.equal(afterCandidates.payload.data.total, 0);

    const responses = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/stats/short-answer-responses?limit=10"
    );
    const updated = responses.payload.data.rows.find((row) => row.id === resultId);
    assert.ok(updated);
    assert.equal(updated.status, "ai_reviewed");
    assert.equal(updated.score, maxScore);
    assert.equal(updated.ai_score, maxScore);
    assert.equal(updated.is_correct, 1);
    assert.equal(updated.ai_error_type, "none");

    const overview = await adminRequest(baseUrl, adminToken, "/api/admin/stats/overview");
    assert.equal(overview.payload.data.avgAccuracy, 100);
    const questionErrors = await adminRequest(baseUrl, adminToken, "/api/admin/stats/question-errors");
    const questionStats = questionErrors.payload.data.find((row) => (
      row.question_id === questionId && row.unit_id === legacyContext.unit_id
    ));
    assert.ok(questionStats);
    assert.equal(questionStats.error_rate, 0);
    assert.equal(questionStats.avg_score, maxScore);
    const phase = await adminRequest(baseUrl, adminToken, "/api/admin/stats/phase-comparison");
    const phaseStats = phase.payload.data.find((row) => (
      row.user_id === userId && row.chapter_id === legacyContext.chapter_id
    ));
    assert.ok(phaseStats);
    assert.equal(phaseStats.post_accuracy, 100);
    assert.equal(phaseStats.post_score, maxScore);
    const detail = await adminRequest(
      baseUrl,
      adminToken,
      `/api/admin/stats/user-detail?userId=${encodeURIComponent(userId)}`
    );
    assert.equal(detail.payload.data.quizOverall.questions, 1);
    assert.equal(detail.payload.data.quizOverall.correct, 1);
    assert.equal(detail.payload.data.quizOverall.totalScore, maxScore);

    const audits = await adminRequest(
      baseUrl,
      adminToken,
      "/api/admin/grading/regrade-audits?limit=10"
    );
    const audit = audits.payload.data.find((row) => row.quiz_result_id === resultId);
    assert.ok(audit);
    assert.equal(audit.status, "applied");
  } finally {
    await stopChild(child);
    if (mockLlm) await new Promise((resolve) => mockLlm.close(resolve));
    db.saveNow();
    db.releaseWriteLock();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("legacy main regrade API tests passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const route = require("../data/multi-scene-learning-route.json");
const courseAssessment = require("../lib/course-assessment");
const reconciliation = require("../lib/quiz-snapshot-reconciliation");

const assessmentIndex = courseAssessment.buildAssessmentIndex(route);

function questionText(entry) {
  return entry.question.question
    || entry.question.prompt
    || entry.question.title
    || entry.question.text
    || "";
}

function snapshotRecord(entry, overrides = {}) {
  const question = entry.question;
  const answer = Array.isArray(question.answer) ? [...question.answer] : question.answer ?? [];
  const response = question.type === "short_answer"
    ? "我会先写出定义，再说明题干条件和判断依据。"
    : question.type === "multiple"
      ? answer
      : answer[0];
  return {
    id: `snapshot-${entry.unitId}-${question.id}`,
    unitId: entry.unitId,
    chapterId: entry.chapterId,
    phase: entry.phase,
    questionId: question.id,
    questionType: question.type,
    questionText: questionText(entry),
    answer,
    response,
    maxScore: Number(question.points || 0),
    points: Number(question.points || 0),
    isCorrect: question.type === "short_answer" ? null : true,
    status: question.type === "short_answer" ? "pending_review" : "correct",
    score: question.type === "short_answer" ? 0 : Number(question.points || 0),
    timestamp: "2026-08-19T10:00:00.000+08:00",
    ...overrides
  };
}

function findEntry(predicate) {
  const entry = Array.from(assessmentIndex.values()).find(predicate);
  assert.ok(entry, "the current main assessment must contain the fixture question");
  return entry;
}

function testMainV2Isolation() {
  const mainObjective = findEntry((entry) => entry.question.type === "single");
  const secondMainObjective = findEntry(
    (entry) => entry.question.type === "single" && entry.question.id !== mainObjective.question.id
  );
  const mainShortAnswer = findEntry((entry) => entry.question.type === "short_answer");
  const validObjective = snapshotRecord(mainObjective);
  const validShortAnswer = snapshotRecord(mainShortAnswer);
  const fingerprint = courseAssessment.assessmentFingerprint(route);

  // v2 keeps some question ids but puts them in different units.  This must
  // not be treated as a main result merely because the id happens to overlap.
  const v2UnitRecord = snapshotRecord(mainObjective, {
    id: "v2-same-question-different-unit",
    unitId: "GH-01-pre"
  });
  const changedQuestionRecord = snapshotRecord(secondMainObjective, {
    id: "v2-same-context-changed-question",
    questionText: "v2 题库中的另一道题",
    answer: ["not-the-main-answer"]
  });
  const changedTypeRecord = snapshotRecord(secondMainObjective, {
    id: "v2-same-context-changed-type",
    questionType: "short_answer"
  });

  const rows = reconciliation.buildReconciledQuizResults({
    snapshot: {
      courseAssessmentFingerprint: fingerprint,
      quizResults: [
        validObjective,
        validShortAnswer,
        v2UnitRecord,
        changedQuestionRecord,
        changedTypeRecord,
        {
          ...validObjective,
          id: "v2-question-id-only",
          questionId: "V14-C1-pre-q1"
        }
      ]
    },
    userId: "isolation-user",
    learningGeneration: 1,
    assessmentIndex,
    courseAssessment,
    assessmentFingerprint: fingerprint
  });

  assert.deepEqual(
    rows.map((row) => `${row.unit_id}:${row.question_id}`).sort(),
    [
      `${mainObjective.unitId}:${mainObjective.question.id}`,
      `${mainShortAnswer.unitId}:${mainShortAnswer.question.id}`
    ].sort(),
    "only the current main question set may be reconciled"
  );
  assert.equal(
    reconciliation.buildReconciledQuizResults({
      snapshot: {
        quizResults: [validObjective, validShortAnswer, v2UnitRecord]
      },
      userId: "isolation-user",
      learningGeneration: 1,
      assessmentIndex,
      courseAssessment
    }).length,
    0,
    "an unversioned snapshot with a foreign record must not partly enter main"
  );
  assert.equal(
    reconciliation.snapshotQuestionMatches(changedQuestionRecord, secondMainObjective.question),
    false
  );
  assert.equal(
    reconciliation.buildReconciledQuizResults({
      snapshot: { courseAssessmentFingerprint: "v2-adaptive-assessment", quizResults: [validObjective] },
      userId: "isolation-user",
      learningGeneration: 1,
      assessmentIndex,
      courseAssessment,
      assessmentFingerprint: fingerprint
    }).length,
    0,
    "a snapshot explicitly produced by v2 must never enter main"
  );
  assert.equal(
    reconciliation.snapshotLooksLikeAnotherAssessment({
      quizAttempts: {
        "GH-01-K01-formative": {
          records: [{ unitId: "GH-01-K01-formative", questionId: "GH-01-K01-check-q1" }]
        }
      }
    },
    assessmentIndex),
    true,
    "an unversioned v2 adaptive snapshot must be recognized as another assessment"
  );
  assert.equal(
    reconciliation.buildReconciledQuizResults({
      snapshot: {
        quizResults: [validObjective],
        completed: [mainObjective.unitId, "GH-01-K01-formative"],
        submittedQuizzes: [mainObjective.unitId, "GH-01-K01-formative"],
        quizAttempts: {
          "GH-01-K01-formative": {
            records: [{ unitId: "GH-01-K01-formative", questionId: "GH-01-K01-check-q1" }]
          }
        }
      },
      userId: "isolation-user",
      learningGeneration: 1,
      assessmentIndex,
      courseAssessment,
      assessmentFingerprint: fingerprint
    }).length,
    0,
    "a legacy v2 snapshot must not import a coincidentally valid main question"
  );
  assert.equal(
    reconciliation.buildReconciledQuizResults({
      snapshot: {
        quizResults: [validObjective],
        pendingKnowledgeTransition: null,
        knowledgeTransitionChoices: {}
      },
      userId: "isolation-user",
      learningGeneration: 1,
      assessmentIndex,
      courseAssessment,
      assessmentFingerprint: fingerprint
    }).length,
    0,
    "the v2 transition-state shell must be isolated even before its first adaptive quiz"
  );
}

function queryRows(db, sql, params = []) {
  const statement = db.getDbSync().prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function quizSubmissionCount(db) {
  return Number(queryRows(
    db,
    `SELECT COUNT(*) AS count
     FROM (
       SELECT user_id, unit_id, created_at
       FROM quiz_results
       GROUP BY user_id, unit_id, created_at
     )`
  )[0].count || 0);
}

async function testDatabaseIdempotencyAndRegrade(dbPath) {
  process.env.DB_PATH = dbPath;
  const db = require("../db");
  await db.getDb();
  const entry = findEntry((item) => item.question.type === "short_answer");
  const userId = "reconcile-db-user";
  const pending = reconciliation.buildReconciledQuizResults({
    snapshot: { quizResults: [snapshotRecord(entry)] },
    userId,
    learningGeneration: 1,
    assessmentIndex,
    courseAssessment
  })[0];
  assert.ok(pending);
  db.upsertUser(userId, "对账测试", "2026-08-19T09:00:00.000+08:00", "2026-08-19T09:00:00.000+08:00");
  db.insertQuizResult(pending);

  const pendingSync = db.reconcileQuizResults([pending]);
  assert.deepEqual(
    { inserted: pendingSync.inserted, updated: pendingSync.updated },
    { inserted: 0, updated: 0 },
    "replaying an unresolved snapshot must not duplicate or change it"
  );

  const graded = {
    ...pending,
    ai_score: Number(entry.question.points || 0),
    ai_confidence: 0.98,
    ai_feedback: "重评成功。",
    ai_error_type: "",
    is_correct: 1,
    status: "ai_reviewed",
    score: Number(entry.question.points || 0)
  };
  const gradedSync = db.reconcileQuizResults([graded]);
  assert.deepEqual(
    { inserted: gradedSync.inserted, updated: gradedSync.updated },
    { inserted: 0, updated: 1 },
    "a later AI result must complete the pending row"
  );
  const repeatGradedSync = db.reconcileQuizResults([graded]);
  assert.deepEqual(
    { inserted: repeatGradedSync.inserted, updated: repeatGradedSync.updated },
    { inserted: 0, updated: 0 },
    "replaying the same AI result must be a no-op"
  );

  const oldGeneration = { ...graded, id: "old-generation-result", learning_generation: 1 };
  db.reconcileQuizResults([{
    ...oldGeneration,
    question_id: `${entry.question.id}-old`,
    unit_id: entry.unitId
  }]);
  const newGeneration = { ...graded, id: "new-generation-result", learning_generation: 2 };
  const newGenerationSync = db.reconcileQuizResults([newGeneration]);
  assert.equal(newGenerationSync.inserted, 1, "a new learning generation gets its own row");
  assert.equal(
    queryRows(db, "SELECT COUNT(*) AS count FROM quiz_results WHERE user_id = ? AND question_id = ?", [userId, entry.question.id])[0].count,
    2,
    "the old and new learning generations must both remain"
  );

  const collisionUser = "reconcile-collision-user";
  db.upsertUser(collisionUser, "冲突测试", "2026-08-19T09:00:00.000+08:00", "2026-08-19T09:00:00.000+08:00");
  db.insertQuizResult({ ...pending, id: "shared-client-id", user_id: collisionUser, question_id: `${entry.question.id}-collision` });
  const collision = db.reconcileQuizResults([{
    ...graded,
    id: "shared-client-id",
    unit_id: `${entry.unitId}-collision`,
    question_id: `${entry.question.id}-collision-2`
  }]);
  assert.equal(collision.inserted, 0, "a client id collision must not attach to another logical result");

  db.saveNow();
  db.releaseWriteLock();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(baseUrl + pathname, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return {
    response,
    payload: await response.json().catch(() => ({}))
  };
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${logs.join("")}`);
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

async function testSnapshotApiReconciliation(baseUrl, adminToken) {
  const shortAnswer = findEntry((entry) => entry.question.type === "short_answer");
  const objective = findEntry(
    (entry) => entry.question.type === "single" && entry.unitId !== shortAnswer.unitId
  );
  const fingerprint = courseAssessment.assessmentFingerprint(route);
  const overviewBefore = await requestJson(baseUrl, "/api/admin/stats/overview", {
    token: adminToken
  });
  const candidatesBefore = await requestJson(
    baseUrl,
    "/api/admin/grading/regrade-candidates?limit=50",
    { token: adminToken }
  );
  assert.equal(overviewBefore.response.status, 200, JSON.stringify(overviewBefore.payload));
  assert.equal(candidatesBefore.response.status, 200, JSON.stringify(candidatesBefore.payload));

  const registered = await requestJson(baseUrl, "/api/auth/register", {
    method: "POST",
    body: {
      nickname: `快照接口对账${Date.now().toString().slice(-6)}`,
      email: "",
      password: "snapshot-reconciliation-123"
    }
  });
  assert.equal(registered.response.status, 200, JSON.stringify(registered.payload));
  const token = registered.payload.token;
  const participantId = registered.payload.participant?.participantId;
  assert.ok(token && participantId, "the snapshot test account must be authenticated");

  const initial = await requestJson(baseUrl, "/api/learning/snapshot", { token });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const pendingSnapshot = {
    courseAssessmentFingerprint: fingerprint,
    quizResults: [snapshotRecord(objective), snapshotRecord(shortAnswer)],
    quizAttempts: {},
    submittedQuizzes: [objective.unitId, shortAnswer.unitId],
    capturedAt: "2026-08-19T10:02:00.000+08:00"
  };
  const saved = await requestJson(baseUrl, "/api/learning/snapshot", {
    method: "POST",
    token,
    body: {
      generation: initial.payload.generation,
      baseRevision: initial.payload.revision,
      reason: "snapshot_results_missing_from_table",
      snapshot: pendingSnapshot
    }
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.deepEqual(
    {
      inserted: saved.payload.quizReconciliation?.inserted,
      updated: saved.payload.quizReconciliation?.updated,
      total: saved.payload.quizReconciliation?.total
    },
    { inserted: 2, updated: 0, total: 2 },
    "a main snapshot must immediately make both submissions available to statistics"
  );

  const storedPending = await requestJson(baseUrl, "/api/learning/quiz-results", { token });
  assert.equal(storedPending.response.status, 200, JSON.stringify(storedPending.payload));
  assert.equal(storedPending.payload.data.length, 2);
  const pendingRow = storedPending.payload.data.find((row) => row.question_id === shortAnswer.question.id);
  assert.ok(pendingRow, "the saved short answer must have a database row");
  assert.equal(pendingRow.status, "pending_review");

  const overviewAfterSave = await requestJson(baseUrl, "/api/admin/stats/overview", {
    token: adminToken
  });
  const candidatesAfterSave = await requestJson(
    baseUrl,
    "/api/admin/grading/regrade-candidates?limit=50",
    { token: adminToken }
  );
  assert.equal(
    overviewAfterSave.payload.data.totalQuizResults,
    overviewBefore.payload.data.totalQuizResults + 2,
    "both restored unit submissions must enter the administrator aggregate"
  );
  assert.equal(candidatesAfterSave.payload.data.total, candidatesBefore.payload.data.total + 1);
  assert.ok(
    candidatesAfterSave.payload.data.rows.some((row) => row.user_id === participantId),
    "the restored pending short answer must be visible to regrade"
  );

  const gradedShortAnswer = snapshotRecord(shortAnswer, {
    aiScore: Number(shortAnswer.question.points || 0),
    aiConfidence: 0.98,
    aiFeedback: "快照中的异步评分已返回。",
    aiErrorType: "",
    isCorrect: true,
    status: "ai_reviewed",
    score: Number(shortAnswer.question.points || 0)
  });
  const reviewed = await requestJson(baseUrl, "/api/learning/snapshot", {
    method: "POST",
    token,
    body: {
      generation: saved.payload.generation,
      baseRevision: saved.payload.revision,
      reason: "snapshot_short_answer_regraded",
      snapshot: {
        ...pendingSnapshot,
        quizResults: [snapshotRecord(objective), gradedShortAnswer],
        capturedAt: "2026-08-19T10:03:00.000+08:00"
      }
    }
  });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.payload));
  assert.deepEqual(
    {
      inserted: reviewed.payload.quizReconciliation?.inserted,
      updated: reviewed.payload.quizReconciliation?.updated
    },
    { inserted: 0, updated: 1 },
    "a completed AI review in a later snapshot must update the existing result"
  );

  const storedReviewed = await requestJson(baseUrl, "/api/learning/quiz-results", { token });
  const reviewedRow = storedReviewed.payload.data.find((row) => row.question_id === shortAnswer.question.id);
  assert.ok(reviewedRow, "the regraded short answer must remain queryable");
  assert.equal(reviewedRow.status, "ai_reviewed");
  assert.equal(Number(reviewedRow.ai_score), Number(shortAnswer.question.points || 0));
  assert.equal(Number(reviewedRow.is_correct), 1);

  const candidatesAfterReview = await requestJson(
    baseUrl,
    "/api/admin/grading/regrade-candidates?limit=50",
    { token: adminToken }
  );
  assert.equal(candidatesAfterReview.payload.data.total, candidatesBefore.payload.data.total);
  const overviewAfterReview = await requestJson(baseUrl, "/api/admin/stats/overview", {
    token: adminToken
  });
  assert.equal(
    overviewAfterReview.payload.data.totalQuizResults,
    overviewAfterSave.payload.data.totalQuizResults,
    "regrading updates an existing result instead of creating another submission"
  );

  const v2Registered = await requestJson(baseUrl, "/api/auth/register", {
    method: "POST",
    body: {
      nickname: `v2题库隔离${Date.now().toString().slice(-6)}`,
      email: "",
      password: "v2-snapshot-isolation-123"
    }
  });
  assert.equal(v2Registered.response.status, 200, JSON.stringify(v2Registered.payload));
  const v2Token = v2Registered.payload.token;
  const v2Initial = await requestJson(baseUrl, "/api/learning/snapshot", { token: v2Token });
  const v2Saved = await requestJson(baseUrl, "/api/learning/snapshot", {
    method: "POST",
    token: v2Token,
    body: {
      generation: v2Initial.payload.generation,
      baseRevision: v2Initial.payload.revision,
      reason: "legacy_v2_adaptive_snapshot",
      snapshot: {
        // v2 snapshots lack the main fingerprint but always serialize this
        // transition shell, even before the learner takes its first small quiz.
        pendingKnowledgeTransition: null,
        knowledgeTransitionChoices: {},
        quizResults: [snapshotRecord(objective)],
        quizAttempts: {},
        submittedQuizzes: [objective.unitId],
        capturedAt: "2026-08-19T10:04:00.000+08:00"
      }
    }
  });
  assert.equal(v2Saved.response.status, 200, JSON.stringify(v2Saved.payload));
  assert.deepEqual(
    {
      inserted: v2Saved.payload.quizReconciliation?.inserted,
      updated: v2Saved.payload.quizReconciliation?.updated,
      total: v2Saved.payload.quizReconciliation?.total
    },
    { inserted: 0, updated: 0, total: 0 },
    "a v2 snapshot must never add a coincidentally valid main question"
  );
  const v2Rows = await requestJson(baseUrl, "/api/learning/quiz-results", { token: v2Token });
  assert.equal(v2Rows.response.status, 200, JSON.stringify(v2Rows.payload));
  assert.deepEqual(v2Rows.payload.data, []);
}

async function testStartupRecovery(dbPath) {
  const db = require("../db");
  const beforeRows = Number(queryRows(db, "SELECT COUNT(*) AS count FROM quiz_results")[0].count || 0);
  const beforeSubmissions = quizSubmissionCount(db);
  const beforePending = Number(queryRows(db, "SELECT COUNT(*) AS count FROM quiz_results WHERE status = 'pending_review'")[0].count || 0);
  const entry = findEntry((item) => item.question.type === "short_answer");
  const objective = findEntry(
    (item) => item.question.type === "single" && item.unitId !== entry.unitId
  );
  const userId = "startup-recovery-user";
  db.upsertUser(userId, "启动恢复", "2026-08-19T09:00:00.000+08:00", "2026-08-19T09:00:00.000+08:00");
  db.currentLearningGeneration(userId, "2026-08-19T09:00:00.000+08:00");
  db.insertSnapshot({
    id: "startup-recovery-snapshot",
    user_id: userId,
    reason: "before_server_start",
    generation: 1,
    revision: 1,
    created_at: "2026-08-19T09:01:00.000+08:00",
    data: {
      quizResults: [snapshotRecord(objective), snapshotRecord(entry)],
      quizAttempts: {}
    }
  });
  db.saveNow();
  db.releaseWriteLock();

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "snapshot-recovery-test-token";
  const logs = [];
  const child = spawn(process.execPath, ["server.js", String(port)], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      HOST: "127.0.0.1",
      ADMIN_TOKEN: adminToken,
      NODE_ENV: "test",
      LLM_PROVIDER: "mock"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  try {
    await waitForHealth(baseUrl, child, logs);
    const response = await fetch(`${baseUrl}/api/admin/stats/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.data.totalQuizResults, beforeSubmissions + 2, "startup must restore both valid main submissions");

    const exported = await fetch(`${baseUrl}/api/admin/export`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const exportPayload = await exported.json();
    assert.equal(exported.status, 200, JSON.stringify(exportPayload));
    assert.equal(
      exportPayload.data.quizResults.length,
      beforeRows + 2,
      "startup must restore both valid main result rows"
    );

    const candidates = await fetch(`${baseUrl}/api/admin/grading/regrade-candidates?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const candidatePayload = await candidates.json();
    assert.equal(candidates.status, 200, JSON.stringify(candidatePayload));
    assert.equal(candidatePayload.data.total, beforePending + 1, "restored pending short answer must be regradable");
    await testSnapshotApiReconciliation(baseUrl, adminToken);
  } finally {
    await stopChild(child);
  }
}

async function main() {
  testMainV2Isolation();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-quiz-snapshot-reconciliation-"));
  const dbPath = path.join(tmpDir, "reconciliation.db");
  const previousDbPath = process.env.DB_PATH;
  try {
    await testDatabaseIdempotencyAndRegrade(dbPath);
    await testStartupRecovery(dbPath);
    console.log("quiz snapshot reconciliation tests passed");
  } finally {
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

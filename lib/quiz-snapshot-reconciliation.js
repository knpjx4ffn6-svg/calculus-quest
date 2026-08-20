const FAILURE_TYPES = new Set([
  "api_error",
  "api_timeout",
  "parse_error",
  "empty_response",
  "mock_provider",
  "manual_fallback",
  "unknown"
]);

const FAILURE_PATTERNS = [
  "评分出错",
  "评分超时",
  "解析失败",
  "模型接口返回了空文本",
  "未启用真实大模型",
  "已先按 0 分计入"
];

// These are serialized by the v2 knowledge-point adaptive flow. They do not
// exist in the main route, whose chapter-level formative quizzes use a
// different assessment set. Legacy snapshots have no fingerprint, so the
// markers keep an entire v2 snapshot from contributing even a coincidentally
// matching question id to main statistics.
const V2_SNAPSHOT_STATE_KEYS = [
  "pendingKnowledgeTransition",
  "knowledgeTransitionChoices"
];
const V2_ADAPTIVE_UNIT_PATTERN = /(?:^|-)K\d+-formative$/u;
const V2_ADAPTIVE_QUESTION_PATTERN = /-check-q\d+$/u;

function valueOf(record, camelKey, snakeKey = camelKey) {
  if (Object.prototype.hasOwnProperty.call(record || {}, camelKey)) return record[camelKey];
  return record?.[snakeKey];
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedQuestionText(value) {
  return String(value || "")
    .replace(/^\s*【[^】]{1,80}】\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedAnswerValues(value) {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return values
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .sort();
}

function snapshotQuestionMatches(record, question) {
  const suppliedType = valueOf(record, "questionType", "question_type") ?? valueOf(record, "mode");
  if (suppliedType !== undefined && suppliedType !== null && String(suppliedType).trim()) {
    if (String(suppliedType).trim().toLowerCase() !== String(question.type || "").trim().toLowerCase()) {
      return false;
    }
  }

  const suppliedText = valueOf(record, "questionText", "question_text");
  const authoritativeText = question.question || question.prompt || question.title || question.text || "";
  if (suppliedText !== undefined && suppliedText !== null && String(suppliedText).trim()) {
    if (normalizedQuestionText(suppliedText) !== normalizedQuestionText(authoritativeText)) return false;
  }

  const suppliedMaxScore = finiteNumber(valueOf(record, "maxScore", "max_score"));
  if (suppliedMaxScore !== null && Math.abs(suppliedMaxScore - Math.max(0, Number(question.points || 0))) > 1e-9) {
    return false;
  }

  if (question.type !== "short_answer" && Object.prototype.hasOwnProperty.call(record || {}, "answer")) {
    const expected = normalizedAnswerValues(question.answer);
    const supplied = normalizedAnswerValues(record.answer);
    if (JSON.stringify(expected) !== JSON.stringify(supplied)) return false;
  }
  return true;
}

function boundedScore(value, maxScore) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const max = Math.max(0, Number(maxScore || 0));
  const bounded = max ? Math.max(0, Math.min(max, number)) : Math.max(0, number);
  return Math.round(bounded * 10) / 10;
}

function normalizeMultipleResponse(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim().startsWith("[")
      ? (() => {
          try { return JSON.parse(value); } catch { return []; }
        })()
      : [];
  return Array.from(new Set(
    values.map((item) => String(item ?? "").trim()).filter(Boolean)
  )).slice(0, 30);
}

function normalizeResponse(question, value) {
  if (question?.type === "multiple") return normalizeMultipleResponse(value);
  if (Array.isArray(value)) return value.length ? String(value[0] ?? "").trim().slice(0, 12000) : "";
  return String(value ?? "").trim().slice(0, 12000);
}

function responsePresent(question, response) {
  return question?.type === "multiple"
    ? Array.isArray(response) && response.length > 0
    : String(response ?? "").trim() !== "";
}

function normalizedErrorType(record) {
  const value = String(valueOf(record, "aiErrorType", "ai_error_type") || "")
    .trim()
    .toLowerCase();
  return ["", "none", "no_error"].includes(value) ? "" : value;
}

function hasFailedReview(record) {
  const errorType = normalizedErrorType(record);
  const feedback = String(valueOf(record, "aiFeedback", "ai_feedback") || "");
  return FAILURE_TYPES.has(errorType)
    || record?.fallbackScored === true
    || FAILURE_PATTERNS.some((pattern) => feedback.includes(pattern));
}

function hasGradingState(record) {
  return valueOf(record, "aiScore", "ai_score") !== undefined
    && valueOf(record, "aiScore", "ai_score") !== null
    || Boolean(normalizedErrorType(record))
    || record?.fallbackScored === true
    || String(valueOf(record, "status") || "").trim().toLowerCase() === "ai_reviewed"
    || String(valueOf(record, "aiFeedback", "ai_feedback") || "").trim() !== "";
}

function snapshotRecordCandidates(snapshot = {}) {
  const candidates = [];
  const attempts = snapshot?.quizAttempts
    && typeof snapshot.quizAttempts === "object"
    && !Array.isArray(snapshot.quizAttempts)
    ? snapshot.quizAttempts
    : {};

  Object.values(attempts).forEach((attempt) => {
    if (!Array.isArray(attempt?.records)) return;
    attempt.records.forEach((record) => {
      candidates.push({
        record: {
          ...record,
          unitId: record?.unitId || record?.unit_id || attempt.unitId || attempt.unit_id || "",
          chapterId: record?.chapterId || record?.chapter_id || attempt.chapterId || attempt.chapter_id || "",
          phase: record?.phase || record?.assessmentPhase || attempt.phase || attempt.assessmentPhase || ""
        },
        fallbackCreatedAt: attempt.submittedAt || attempt.submitted_at || ""
      });
    });
  });

  if (Array.isArray(snapshot?.quizResults)) {
    snapshot.quizResults.forEach((record) => {
      candidates.push({
        record,
        fallbackCreatedAt: snapshot.capturedAt || snapshot.clientCapturedAt || ""
      });
    });
  }
  return candidates;
}

function snapshotUnitIdentifiers(snapshot = {}) {
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : {};
  const units = new Set();
  const add = (value) => {
    const unitId = String(value || "").trim();
    if (unitId) units.add(unitId);
  };

  (Array.isArray(source.submittedQuizzes) ? source.submittedQuizzes : []).forEach(add);
  (Array.isArray(source.completed) ? source.completed : []).forEach(add);
  const attempts = source.quizAttempts
    && typeof source.quizAttempts === "object"
    && !Array.isArray(source.quizAttempts)
    ? source.quizAttempts
    : {};
  Object.keys(attempts).forEach(add);
  snapshotRecordCandidates(source).forEach(({ record }) => {
    add(valueOf(record, "unitId", "unit_id"));
  });
  return units;
}

function snapshotLooksLikeAnotherAssessment(snapshot = {}, assessmentIndex) {
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : {};
  if (V2_SNAPSHOT_STATE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key))) {
    return true;
  }

  const knownUnitIds = new Set(
    Array.from(assessmentIndex?.values?.() || []).map((entry) => String(entry.unitId || "").trim())
  );
  if (Array.from(snapshotUnitIdentifiers(source)).some((unitId) => V2_ADAPTIVE_UNIT_PATTERN.test(unitId))) {
    return true;
  }
  return snapshotRecordCandidates(source).some(({ record }) => {
    const unitId = String(valueOf(record, "unitId", "unit_id") || "").trim();
    const questionId = String(valueOf(record, "questionId", "question_id") || "").trim();
    return unitId
      && questionId
      && !knownUnitIds.has(unitId)
      && V2_ADAPTIVE_UNIT_PATTERN.test(unitId)
      && V2_ADAPTIVE_QUESTION_PATTERN.test(questionId);
  });
}

function validTimestamp(value, fallback) {
  const candidate = String(value || "").trim();
  if (candidate && Number.isFinite(Date.parse(candidate))) return candidate;
  return String(fallback || new Date().toISOString());
}

function buildReconciledQuizResults({
  snapshot = {},
  userId = "",
  learningGeneration = 1,
  fallbackCreatedAt = "",
  assessmentIndex,
  courseAssessment,
  assessmentFingerprint = ""
} = {}) {
  const normalizedUserId = String(userId || "").trim();
  const generation = Number(learningGeneration);
  if (!normalizedUserId || !Number.isInteger(generation) || generation < 1) return [];
  if (!assessmentIndex || !courseAssessment?.assessmentEntry) return [];
  const snapshotFingerprint = String(snapshot.courseAssessmentFingerprint || "").trim();
  const expectedFingerprint = String(assessmentFingerprint || "").trim();
  if (snapshotFingerprint && expectedFingerprint && snapshotFingerprint !== expectedFingerprint) return [];
  if (!snapshotFingerprint && snapshotLooksLikeAnotherAssessment(snapshot, assessmentIndex)) return [];

  const byQuestion = new Map();
  snapshotRecordCandidates(snapshot).forEach(({ record, fallbackCreatedAt: attemptCreatedAt }) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const questionId = String(valueOf(record, "questionId", "question_id") || "").trim();
    const unitId = String(valueOf(record, "unitId", "unit_id") || "").trim();
    if (!questionId || !unitId) return;
    const key = `${unitId}\u001f${questionId}`;
    const existing = byQuestion.get(key);
    if (!existing || hasGradingState(record) || !hasGradingState(existing)) {
      byQuestion.set(key, {
        ...existing,
        ...record,
        _fallbackCreatedAt: attemptCreatedAt || existing?._fallbackCreatedAt || ""
      });
    }
  });

  const rows = [];
  let legacySnapshotHasForeignRecord = false;
  byQuestion.forEach((record) => {
    const questionId = String(valueOf(record, "questionId", "question_id") || "").trim();
    const requestedUnitId = String(valueOf(record, "unitId", "unit_id") || "").trim();
    const requestedChapterId = String(valueOf(record, "chapterId", "chapter_id") || "").trim();
    const requestedPhase = String(valueOf(record, "phase", "assessment_phase") || "").trim();
    const entry = courseAssessment.assessmentEntry(assessmentIndex, {
      questionId,
      unitId: requestedUnitId,
      chapterId: requestedChapterId,
      phase: requestedPhase
    });
    if (!entry || !entry.question) {
      if (!snapshotFingerprint) legacySnapshotHasForeignRecord = true;
      return;
    }

    const question = entry.question;
    if (!snapshotQuestionMatches(record, question)) {
      if (!snapshotFingerprint) legacySnapshotHasForeignRecord = true;
      return;
    }
    const response = normalizeResponse(question, valueOf(record, "response"));
    if (!responsePresent(question, response)) return;
    const maxScore = Math.max(0, Number(question.points || 0));
    const createdAt = validTimestamp(
      valueOf(record, "timestamp", "created_at") || valueOf(record, "createdAt", "created_at"),
      record._fallbackCreatedAt || snapshot.capturedAt || fallbackCreatedAt
    );
    const base = {
      id: `${normalizedUserId}-g${generation}-${entry.unitId}-${question.id}`,
      user_id: normalizedUserId,
      chapter_id: entry.chapterId,
      chapter_label: entry.chapterLabel || "",
      unit_id: entry.unitId,
      unit_label: entry.unitLabel || "",
      question_id: question.id,
      question_type: question.type,
      phase: entry.phase,
      points: maxScore,
      response,
      max_score: maxScore,
      learning_generation: generation,
      created_at: createdAt,
      ai_score: null,
      ai_confidence: null,
      ai_feedback: "",
      ai_error_type: ""
    };

    if (question.type !== "short_answer") {
      const scored = courseAssessment.scoreObjectiveQuestion(question, response);
      rows.push({
        ...base,
        is_correct: scored.isCorrect ? 1 : 0,
        status: scored.status || (scored.isCorrect ? "correct" : "incorrect"),
        score: scored.score,
        max_score: scored.maxScore
      });
      return;
    }

    const failed = hasFailedReview(record);
    const rawAiScore = finiteNumber(valueOf(record, "aiScore", "ai_score"));
    const aiScore = rawAiScore === null && failed ? 0 : boundedScore(rawAiScore, maxScore);
    const rawErrorType = normalizedErrorType(record);
    const errorType = rawErrorType || (failed ? "unknown" : "");
    const aiConfidenceValue = finiteNumber(valueOf(record, "aiConfidence", "ai_confidence"));
    const aiConfidence = aiScore === null && !failed
      ? null
      : Math.max(0, Math.min(1, aiConfidenceValue === null ? 0 : aiConfidenceValue));
    const aiFeedback = String(valueOf(record, "aiFeedback", "ai_feedback") || "").slice(0, 4000);
    const graded = aiScore !== null || failed;
    const isCorrect = graded
      ? failed
        ? 0
        : valueOf(record, "isCorrect", "is_correct") === true || Number(valueOf(record, "isCorrect", "is_correct")) === 1
          ? 1
          : 0
      : -1;
    rows.push({
      ...base,
      is_correct: isCorrect,
      status: graded ? "ai_reviewed" : "pending_review",
      score: aiScore === null ? 0 : aiScore,
      ai_score: aiScore,
      ai_confidence: aiConfidence,
      ai_feedback: aiFeedback,
      ai_error_type: errorType
    });
  });
  // A legacy snapshot has no immutable course fingerprint. If it contains a
  // record from another assessment, do not import its coincidentally matching
  // records one by one into main statistics.
  return legacySnapshotHasForeignRecord ? [] : rows;
}

module.exports = {
  buildReconciledQuizResults,
  hasFailedReview,
  snapshotQuestionMatches,
  snapshotLooksLikeAnotherAssessment
};

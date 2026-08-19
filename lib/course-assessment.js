const PHASE_KEYS = {
  preQuiz: "pre",
  formativeQuiz: "formative",
  postQuiz: "post"
};

const PRIVATE_QUESTION_FIELDS = new Set([
  "answer",
  "answerText",
  "analysis",
  "commentPrompt",
  "correctAnswer",
  "explanation",
  "hasAnswer",
  "referenceAnswer",
  "rubric",
  "solution"
]);
const RETRYABLE_AI_ERROR_TYPES = new Set([
  "api_error",
  "api_timeout",
  "parse_error",
  "empty_response",
  "mock_provider",
  "manual_fallback",
  "unknown"
]);

function isQuestion(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.id
    && value.type
    && (value.question || value.prompt || value.title || value.text)
  );
}

function clonePublicValue(value) {
  if (Array.isArray(value)) return value.map(clonePublicValue);
  if (!value || typeof value !== "object") return value;

  const question = isQuestion(value);
  const clone = {};
  Object.entries(value).forEach(([key, child]) => {
    if (question && PRIVATE_QUESTION_FIELDS.has(key)) return;
    clone[key] = clonePublicValue(child);
  });
  return clone;
}

function buildPublicLearningRoute(route) {
  return clonePublicValue(route || {});
}

function addFlowQuestions(index, flow = {}, context = {}) {
  Object.entries(PHASE_KEYS).forEach(([flowKey, phase]) => {
    const quiz = flow?.[flowKey];
    const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
    questions.forEach((question) => {
      if (!isQuestion(question) || index.has(question.id)) return;
      index.set(question.id, {
        ...context,
        phase,
        unitId: `${context.unitPrefix || context.chapterId}-${phase}`,
        unitLabel: quiz.title || "",
        question
      });
    });
  });
}

function buildAssessmentIndex(route) {
  const index = new Map();
  const knowledgePointLabels = new Map();
  (route?.chapters || []).forEach((chapter) => {
    (chapter.modules || []).forEach((module) => {
      (module.knowledgePoints || []).forEach((knowledgePoint) => {
        const id = String(knowledgePoint?.id || "").trim();
        const label = String(knowledgePoint?.name || knowledgePoint?.title || "").trim();
        if (id && label) knowledgePointLabels.set(id, label);
      });
    });
  });
  Object.defineProperty(index, "knowledgePointLabels", {
    value: knowledgePointLabels,
    enumerable: false
  });
  (route?.chapters || []).forEach((chapter) => {
    const chapterContext = {
      chapterId: chapter.id || "",
      chapterLabel: chapter.title || "",
      unitPrefix: chapter.id || ""
    };

    // The chapter-level curated quizzes are the current public learning route.
    addFlowQuestions(index, chapter.flow, chapterContext);

    // Keep module quizzes available for older route modes without overriding
    // the curated chapter-level version of a duplicated question.
    (chapter.modules || []).forEach((module) => {
      addFlowQuestions(index, module.flow, {
        chapterId: chapter.id || "",
        chapterLabel: chapter.title || "",
        moduleId: module.id || "",
        moduleTitle: module.title || "",
        unitPrefix: module.id || chapter.id || ""
      });
    });
  });
  return index;
}

function studentFacingConcepts(index, values) {
  const concepts = Array.isArray(values) ? values : values == null ? [] : [values];
  const labels = index?.knowledgePointLabels;
  return Array.from(new Set(
    concepts
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => labels?.get(value) || value)
  ));
}

function normalizeChoiceValues(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return Array.from(new Set(
    values
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 30)
  )).sort();
}

function scoreObjectiveQuestion(question, response) {
  const maxScore = Math.max(0, Number(question?.points || 0));
  const expected = normalizeChoiceValues(question?.answer);
  const actual = normalizeChoiceValues(response);
  const isCorrect = expected.length > 0
    && expected.length === actual.length
    && expected.every((value, index) => value === actual[index]);
  return {
    isCorrect,
    score: isCorrect ? maxScore : 0,
    maxScore,
    status: isCorrect ? "correct" : "incorrect"
  };
}

function assessmentEntry(index, query = {}) {
  const questionId = String(query.questionId || query.question_id || "").trim();
  const entry = index?.get(questionId);
  if (!entry) return null;
  const chapterId = String(query.chapterId || query.chapter_id || "").trim();
  const unitId = String(query.unitId || query.unit_id || "").trim();
  const phase = String(query.phase || "").trim();
  if (chapterId && entry.chapterId !== chapterId) return null;
  if (unitId && entry.unitId !== unitId) return null;
  if (phase && entry.phase !== phase) return null;
  return entry;
}

function assessmentEntriesForUnit(index, query = {}) {
  const chapterId = String(query.chapterId || query.chapter_id || "").trim();
  const unitId = String(query.unitId || query.unit_id || "").trim();
  const phase = String(query.phase || "").trim();
  return Array.from(index?.values?.() || []).filter((entry) => (
    (!chapterId || entry.chapterId === chapterId)
    && (!unitId || entry.unitId === unitId)
    && (!phase || entry.phase === phase)
  ));
}

function publicReviewFields(question = {}) {
  return {
    answer: Array.isArray(question.answer) ? [...question.answer] : question.answer ?? [],
    analysis: String(question.analysis || question.referenceAnswer || question.answerText || ""),
    commentPrompt: String(question.commentPrompt || question.rubric || "")
  };
}

function automaticGradingRetryable(row = {}) {
  const status = String(row.status || "").trim().toLowerCase();
  const errorType = String(row.aiErrorType || row.ai_error_type || "").trim().toLowerCase();
  return status === "pending_review"
    || Number(row.isCorrect ?? row.is_correct) === -1
    || RETRYABLE_AI_ERROR_TYPES.has(errorType);
}

function authoritativeGradingQuestions(index, rows = [], options = {}) {
  return (rows || []).flatMap((row) => {
    if (options.retryableOnly && !automaticGradingRetryable(row)) return [];
    const entry = assessmentEntry(index, row);
    const question = entry?.question;
    const response = row?.response;
    if (!question || question.type !== "short_answer" || response === undefined || response === null || response === "") {
      return [];
    }
    return [{
      questionId: question.id,
      unitId: row.unitId || row.unit_id || entry.unitId,
      chapterId: row.chapterId || row.chapter_id || entry.chapterId,
      questionType: question.type,
      questionText: question.question || question.prompt || question.title || question.text || "",
      referenceAnswer: question.referenceAnswer || question.answerText || question.analysis || "",
      rubric: question.rubric || question.commentPrompt || "",
      concepts: studentFacingConcepts(index, question.knowledgePointIds || question.concepts || question.tags),
      points: Math.max(0, Number(question.points || 0)),
      response: typeof response === "string" ? response : JSON.stringify(response)
    }];
  });
}

module.exports = {
  automaticGradingRetryable,
  assessmentEntry,
  assessmentEntriesForUnit,
  authoritativeGradingQuestions,
  buildAssessmentIndex,
  buildPublicLearningRoute,
  publicReviewFields,
  scoreObjectiveQuestion
};

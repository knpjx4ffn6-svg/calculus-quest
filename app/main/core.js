// DOM references, storage, API helpers, and course loading.
const els = {
  metricChapters: document.querySelector("#metric-chapters"),
  metricScenes: document.querySelector("#metric-scenes"),
  metricGlm: document.querySelector("#metric-glm"),
  metricHtml: document.querySelector("#metric-html"),
  metricAudio: document.querySelector("#metric-audio"),
  chapterList: document.querySelector("#chapter-list"),
  lessonList: document.querySelector("#lesson-list"),
  chapterTitle: document.querySelector("#chapter-title"),
  lessonType: document.querySelector("#lesson-type"),
  lessonTitle: document.querySelector("#lesson-title"),
  lessonSummary: document.querySelector("#lesson-summary"),
  lessonPlayer: document.querySelector("#lesson-player"),
  completeLesson: document.querySelector("#complete-lesson"),
  fullscreenPlayer: document.querySelector("#fullscreen-player"),
  authGate: document.querySelector("#auth-gate"),
  loginForm: document.querySelector("#login-form"),
  loginTitle: document.querySelector("#login-title"),
  loginCopy: document.querySelector("#login-copy"),
  loginIdentifier: document.querySelector("#login-identifier"),
  nickname: document.querySelector("#nickname"),
  email: document.querySelector("#email"),
  loginPassword: document.querySelector("#login-password"),
  registerPassword: document.querySelector("#register-password"),
  registerPasswordConfirm: document.querySelector("#register-password-confirm"),
  loginSubmit: document.querySelector("#login-submit"),
  loginFeedback: document.querySelector("#login-feedback"),
  authStatus: document.querySelector("#auth-status"),
  authSubtitle: document.querySelector("#auth-subtitle"),
  authAction: document.querySelector("#auth-action"),
  userMenu: document.querySelector("#user-menu"),
  authMenuToggle: document.querySelector("#auth-menu-toggle"),
  authMenuPanel: document.querySelector("#auth-menu-panel"),
  authAvatar: document.querySelector("#auth-avatar"),
  authAvatarLarge: document.querySelector("#auth-avatar-large"),
  authMenuName: document.querySelector("#auth-menu-name"),
  authMenuIdentity: document.querySelector("#auth-menu-identity"),
  authLogout: document.querySelector("#auth-logout"),
  profileForm: document.querySelector("#profile-form"),
  profileNickname: document.querySelector("#profile-nickname"),
  profileEmail: document.querySelector("#profile-email"),
  profileEditNote: document.querySelector("#profile-edit-note"),
  profileSave: document.querySelector("#profile-save"),
  profileFeedback: document.querySelector("#profile-feedback"),
  agentBoard: document.querySelector("#agent-board"),
  agenticCoachPanel: document.querySelector("#agentic-coach-panel"),
  resourceGrid: document.querySelector("#resource-grid"),
  libraryCount: document.querySelector("#library-count"),
  completedCount: document.querySelector("#completed-count"),
  progressQuizCount: document.querySelector("#progress-quiz-count"),
  progressActivityCount: document.querySelector("#progress-activity-count"),
  chapterProgress: document.querySelector("#chapter-progress"),
  quizDashboard: document.querySelector("#quiz-dashboard"),
  activityLog: document.querySelector("#activity-log"),
  reflectionNote: document.querySelector("#reflection-note"),
  evaluationBoard: document.querySelector("#evaluation-board"),
  evaluationMetrics: document.querySelector("#evaluation-metrics"),
  evaluationRuns: document.querySelector("#evaluation-runs")
};

let lastRenderedProfileParticipantId = "";
let learningSnapshotGeneration = 0;
let learningSnapshotRevision = 0;
let learningSnapshotReady = false;
let learningSnapshotSyncPaused = false;
let learningSnapshotSyncChain = Promise.resolve();
let learningSnapshotRetryTimer = null;
let authTransitionInProgress = false;
const learningEventRequests = new Set();
const learningEventMaxDeliveryAttempts = 3;
const learningEventRetryDelayMs = 750;

function storageKeyFor(participantId) {
  return participantId ? `${STORAGE_KEY}:${participantId}` : STORAGE_KEY;
}

function learningDefaults() {
  return {
    completed: [],
    quizResults: [],
    quizDrafts: {},
    quizAttempts: {},
    submittedQuizzes: [],
    selectedKnowledgeScenes: {},
    returnToQuiz: null,
    narrationCollapsed: false,
    logs: [],
    note: "",
    analytics: {
      visitedUnits: {},
      path: [],
      repeats: {},
      skips: []
    },
    currentChapterId: chapters[0]?.id || "V14-C1",
    currentUnitId: "",
    currentView: "home",
    lastLearningContext: null
  ,
    agenticPath: null
  };
}

function learningQuizUnitId(record = {}) {
  return String(record?.unitId || record?.unit_id || "").trim();
}

function learningSubmittedQuizIds(learningState = state) {
  const quizResults = Array.isArray(learningState?.quizResults)
    ? learningState.quizResults
    : [];
  const quizAttempts = learningState?.quizAttempts
    && typeof learningState.quizAttempts === "object"
    && !Array.isArray(learningState.quizAttempts)
    ? learningState.quizAttempts
    : {};
  return [...new Set([
    ...(Array.isArray(learningState?.submittedQuizzes) ? learningState.submittedQuizzes : []),
    ...quizResults.map(learningQuizUnitId),
    ...Object.keys(quizAttempts)
  ].filter(Boolean))];
}

function normalizeLearningStateCompatibility(learningState) {
  if (!learningState || typeof learningState !== "object") return learningState;
  learningState.quizResults = Array.isArray(learningState.quizResults)
    ? learningState.quizResults
    : [];
  learningState.quizAttempts = learningState.quizAttempts
    && typeof learningState.quizAttempts === "object"
    && !Array.isArray(learningState.quizAttempts)
    ? learningState.quizAttempts
    : {};
  learningState.submittedQuizzes = learningSubmittedQuizIds(learningState);
  return learningState;
}

function loadState() {
  const fallback = { ...learningDefaults(), participant: null, authToken: "" };
  try {
    const lastPid = localStorage.getItem(LAST_PARTICIPANT_KEY);
    const key = lastPid ? storageKeyFor(lastPid) : STORAGE_KEY;
    const raw = localStorage.getItem(key);
    const saved = raw ? JSON.parse(raw) : {};
    const sessionToken = sessionStorage.getItem(AUTH_TOKEN_KEY) || "";
    const legacyToken = saved.authToken || localStorage.getItem(AUTH_TOKEN_KEY) || "";
    if (Object.prototype.hasOwnProperty.call(saved, "authToken")) {
      delete saved.authToken;
      localStorage.setItem(key, JSON.stringify(saved));
    }
    localStorage.removeItem(AUTH_TOKEN_KEY);
    if (!sessionToken && legacyToken) sessionStorage.setItem(AUTH_TOKEN_KEY, legacyToken);
    return normalizeLearningStateCompatibility({
      ...fallback,
      ...saved,
      authToken: sessionToken || legacyToken
    });
  } catch {
    return fallback;
  }
}

state = loadState();
currentView = validViews.has(state.currentView) ? state.currentView : "home";
currentChapterId = state.currentChapterId || chapters[0].id;
currentUnitId = state.currentUnitId || "";

function persistStateLocally() {
  state.currentChapterId = currentChapterId;
  state.currentUnitId = currentUnitId;
  state.currentView = currentView;
  const key = state.participant?.participantId
    ? storageKeyFor(state.participant.participantId)
    : STORAGE_KEY;
  const persisted = { ...state };
  delete persisted.authToken;
  localStorage.setItem(key, JSON.stringify(persisted));
}

function saveState() {
  persistStateLocally();
  queueLearningSnapshot("state_change");
}

const COURSEWARE_RESOURCE_VERSION = "20260727-courseware-interaction-v4";

function appRelativeUrl(path = "") {
  const value = String(path || "");
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) return value;
  return new URL(value.replace(/^\/+/, ""), document.baseURI).toString();
}

function resourceUrl(path) {
  const encoded = encodeURI(path);
  if (!/^resources\/open-maic\/.*\.(?:html|htm)(?:[?#]|$)/i.test(path)) return encoded;
  return `${encoded}${encoded.includes("?") ? "&" : "?"}v=${COURSEWARE_RESOURCE_VERSION}`;
}

async function fetchJson(path, errorMessage) {
  const response = await fetch(appRelativeUrl(resourceUrl(path)));
  if (!response.ok) throw new Error(errorMessage || `${path} 加载失败`);
  return response.json();
}

function isMultiSceneLearningRoute() {
  return COURSE_MODE === "multi-scene-adaptive";
}

function routeInteractionTypes() {
  const types = multiSceneLearningRoute?.interactionTypes || MULTI_SCENE_INTERACTION_TYPES;
  const defaults = new Map(MULTI_SCENE_INTERACTION_TYPES.map((item) => [item.id, item]));
  return types.map((item) => ({
    ...item,
    id: item.id === "diagram" ? "mindMap" : item.id,
    label: item.title || (item.id === "diagram" ? "关系图" : item.label),
    widgetType: item.widgetType || item.id,
    icon: defaults.get(item.id === "diagram" ? "mindMap" : item.id)?.icon || item.icon || item.label || item.id
  }));
}

function routeUnitIds() {
  return curriculum.flatMap((chapter) => chapter.units || []).map((unit) => unit.id);
}

function multiSceneRouteModuleChapters(route = multiSceneLearningRoute) {
  if (route?.displayMode === "chapters" || route?.groupModulesAsChapters === false) return [];
  const moduleChapters = [];
  (route?.chapters || []).forEach((parentChapter, parentIndex) => {
    (parentChapter.modules || []).forEach((module, moduleIndex) => {
      moduleChapters.push({
        id: module.id,
        title: module.title,
        summary: module.coreQuestion || module.coreIntuition || parentChapter.summary || "",
        parentChapterId: parentChapter.id || `V14-C${parentIndex + 1}`,
        parentChapterLabel: parentChapter.title || `第 ${parentIndex + 1} 章`,
        parentChapterSummary: parentChapter.summary || "",
        parentChapterOrder: parentChapter.order || parentIndex + 1,
        moduleOrder: module.order || moduleIndex + 1,
        moduleIds: [module.id],
        modules: [module],
        order: moduleChapters.length + 1
      });
    });
  });
  return moduleChapters;
}

function normalizeOpenMaicChapter(routeChapter = {}, index = 0) {
  return {
    id: routeChapter.id || `V14-C${index + 1}`,
    label: routeChapter.title || `第 ${index + 1} 章`,
    summary: routeChapter.summary || "",
    extension: Boolean(routeChapter.extension || routeChapter.track === "extension"),
    track: routeChapter.track || (routeChapter.extension ? "extension" : "main"),
    badge: routeChapter.badge || (routeChapter.extension ? "扩展" : ""),
    recommendedAfter: routeChapter.recommendedAfter || "",
    routeChapterId: routeChapter.parentChapterId || routeChapter.id || "",
    parentChapterId: routeChapter.parentChapterId || "",
    parentChapterLabel: routeChapter.parentChapterLabel || "",
    parentChapterSummary: routeChapter.parentChapterSummary || "",
    parentChapterOrder: routeChapter.parentChapterOrder || 0,
    moduleOrder: routeChapter.moduleOrder || index + 1,
    isModuleChapter: Boolean(routeChapter.parentChapterId),
    moduleIds: routeChapter.moduleIds || [],
    order: routeChapter.order || index + 1
  };
}

function applyMultiSceneLearningRoute(route) {
  if (!route?.chapters?.length) return;
  const moduleChapters = multiSceneRouteModuleChapters(route);
  const displayChapters = moduleChapters.length ? moduleChapters : route.chapters;
  chapters.splice(0, chapters.length, ...displayChapters.map(normalizeOpenMaicChapter));
  Object.keys(chapterGuides).forEach((key) => delete chapterGuides[key]);
  displayChapters.forEach((chapter, index) => {
    const modules = chapter.modules || [];
    const knowledgeCount = modules.reduce((sum, module) => sum + (module.knowledgePoints || []).length, 0);
    const moduleNames = modules.map((module) => module.title).filter(Boolean);
    const focusNames = modules.flatMap((module) => module.knowledgePoints || []).map((kp) => kp.name).filter(Boolean);
    chapter.summary = compactChapterGoal(chapter, modules);
    chapterGuides[chapter.id] = {
      bridge: chapter.parentChapterId ? `${chapter.parentChapterId} · ${chapter.parentChapterLabel}` : (chapter.moduleIds || modules.map((module) => module.id)).join(" / "),
      goal: chapter.summary,
      difficulty: chapter.extension ? `扩展 · ${knowledgeCount} 个知识点` : `${knowledgeCount} 个知识点`,
      pace: chapter.extension ? `推荐在 ${chapter.recommendedAfter || "主线后"} 学习` : moduleNames.length > 1 ? `${moduleNames.length} 个模块` : "核心路径",
      checkpoint: focusNames.length ? focusNames.slice(0, 4).join(" / ") : "讲解页 + 自选互动场景"
    };
  });
  const totals = route.totals || {};
  courseIndex = {
    chapters: displayChapters.map((chapter) => ({
      id: chapter.id,
      label: chapter.title,
      extension: Boolean(chapter.extension),
      track: chapter.track || (chapter.extension ? "extension" : "main"),
      badge: chapter.badge || "",
      recommendedAfter: chapter.recommendedAfter || "",
      parentChapterId: chapter.parentChapterId || "",
      parentChapterLabel: chapter.parentChapterLabel || "",
      modules: (chapter.modules || []).length,
      scenes: (chapter.modules || []).reduce((sum, module) => sum + multiSceneRouteModuleUnits(module).length, 0)
    })),
    totals: {
      chapters: displayChapters.length,
      modules: totals.modules || route.chapters.flatMap((chapter) => chapter.modules || []).length,
      knowledgePoints: totals.knowledgePoints || route.chapters.flatMap((chapter) => chapter.modules || []).flatMap((module) => module.knowledgePoints || []).length,
      interactionChoices: totals.interactionChoices || 0,
      audio: 0
    }
  };
}

async function loadMultiSceneLearningRoute() {
  if (multiSceneLearningRoute) return multiSceneLearningRoute;
  multiSceneLearningRoute = await fetchJson(MULTI_SCENE_ROUTE_PATH, "多场景自适应学习路线加载失败");
  applyMultiSceneLearningRoute(multiSceneLearningRoute);
  return multiSceneLearningRoute;
}

function beijingNow() {
  const d = new Date();
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, -1) + "+08:00";
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayOptionLabel(option = {}) {
  const label = String(option.label ?? option.text ?? "").trim();
  const value = String(option.value ?? "").trim();
  if (!label || !value) return label;
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return label.replace(new RegExp(`^\\s*${escapedValue}\\s*[.．、:：)）-]\\s*`, "i"), "").trim() || label;
}

function compactLearningCopy(value = "", fallback = "", maxLength = 42) {
  const text = String(value || fallback || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[；;。]+/g, "。")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const first = text.split(/[。！？!?]/).find(Boolean) || text;
  return first.length <= maxLength ? first : `${first.slice(0, maxLength - 1)}…`;
}

function compactKnowledgeGoal(knowledgePoint = {}, module = {}) {
  const raw = knowledgePoint.goal || knowledgePoint.learningObjective || module.coreQuestion || "";
  const name = String(knowledgePoint.name || "").trim();
  let cleaned = String(raw)
    .replace(/^能(?:够)?/, "")
    .replace(/^解释/, "理解")
    .replace(/「([^」]+)」的核心含义/, "$1")
    .replace(/“([^”]+)”的核心含义/, "$1")
    .replace(/并用交互证据说明自己的判断。?$/, "并能举例判断。")
    .replace(/自己的判断/g, "判断")
    .replace(/核心含义/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name && (!cleaned || cleaned === name || cleaned === `理解${name}`)) cleaned = `理解${name}，并能举例判断。`;
  const fallback = name ? `理解${name}，并能举例判断。` : "理解核心概念，并能举例判断。";
  const summary = compactLearningCopy(cleaned, fallback, 26);
  return summary.endsWith("。") ? summary : `${summary}。`;
}

function compactChapterGoal(chapter = {}, modules = []) {
  const names = modules.flatMap((module) => module.knowledgePoints || []).map((kp) => kp.name).filter(Boolean);
  const source = chapter.summary || modules.map((module) => module.coreQuestion || module.coreIntuition || module.title).filter(Boolean).join("，");
  const fallback = names.length ? `围绕${names.slice(0, 3).join("、")}建立直觉` : "建立本章核心直觉";
  const summary = compactLearningCopy(source, fallback, 38);
  return summary.endsWith("。") ? summary : `${summary}。`;
}

function chapterDisplayCopy(chapter = {}) {
  const copy = typeof CHAPTER_DISPLAY_COPY !== "undefined" ? CHAPTER_DISPLAY_COPY[chapter.id] : null;
  return {
    label: copy?.label || String(chapter.label || "").replace(/^扩展：/, "") || "学习章节",
    summary: copy?.summary || compactLearningCopy(chapter.summary || "", "核心知识点", 28),
    focus: copy?.focus || ""
  };
}

function chapterTrackLabel(chapter = {}) {
  if (chapter.extension || chapter.track === "extension") return "扩展";
  const mainChapters = (typeof curriculum !== "undefined" ? curriculum : chapters)
    .filter((item) => !(item.extension || item.track === "extension"));
  const index = mainChapters.findIndex((item) => item.id === chapter.id);
  return index >= 0 && index < 3 ? "基础" : "进阶";
}

function renderInlineMath(text) {
  if (!text || typeof text !== "string") return escapeHtml(String(text || ""));
  if (typeof katex === "undefined") return escapeHtml(text);
  const parts = [];
  let last = 0;
  const re = /\$([^$]+)\$/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(escapeHtml(text.slice(last, m.index)));
    try {
      parts.push(katex.renderToString(m[1], { throwOnError: false, displayMode: false, trust: false, maxExpand: 1000 }));
    } catch {
      parts.push(escapeHtml(m[0]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(escapeHtml(text.slice(last)));
  return parts.join("");
}

function quizLatestResultsByQuestion(records = []) {
  const latest = {};
  (records || []).forEach((entry) => {
    const questionId = entry?.questionId || entry?.question?.id;
    if (!questionId || latest[questionId]) return;
    latest[questionId] = entry?.result ? { ...entry.result, questionId } : entry;
  });
  return latest;
}

function quizNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function quizFormatScore(value) {
  const n = quizNumber(value, 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

function quizMaxScoreFor(question = {}, result = {}) {
  return quizNumber(result.maxScore ?? result.max_score ?? question.points ?? result.points, 0);
}

function quizScoreFromAiScore(score, maxScore = 0) {
  if (score === undefined || score === null || score === "") return null;
  const max = quizNumber(maxScore, 0);
  const raw = quizNumber(score, 0);
  if (!max) return Math.max(0, raw);
  return Math.round(Math.max(0, Math.min(max, raw)) * 10) / 10;
}

function quizScoreFromPercent(percent, maxScore = 0) {
  if (percent === undefined || percent === null || percent === "") return null;
  const pct = Math.max(0, Math.min(100, quizNumber(percent, 0)));
  const max = quizNumber(maxScore, 0);
  return Math.round((pct / 100) * max * 10) / 10;
}

function quizAiReviewFailed(result = {}) {
  return typeof QuizReviewState !== "undefined" && QuizReviewState.aiReviewFailed(result);
}

function quizReviewIsPending(result = {}) {
  if (typeof QuizReviewState !== "undefined") return QuizReviewState.isPending(result);
  return result.status === "pending_review" || result.isCorrect === null;
}

function normalizeFailedQuizReviews() {
  if (typeof QuizReviewState === "undefined") return 0;
  let changed = 0;
  const normalizeRecords = (records = []) => records.map((result) => {
      const normalized = QuizReviewState.normalizeFailed(result);
      if (normalized !== result) changed += 1;
      return normalized;
    });
  state.quizResults = normalizeRecords(state.quizResults || []);
  Object.values(state.quizAttempts || {}).forEach((attempt) => {
    if (Array.isArray(attempt?.records)) attempt.records = normalizeRecords(attempt.records);
  });
  return changed;
}

function quizEarnedScore(result = {}, question = {}) {
  const max = quizMaxScoreFor(question, result);
  if (!max) return 0;
  if (quizAiReviewFailed(result)) return 0;
  if (result.aiScore !== undefined && result.aiScore !== null) return quizScoreFromAiScore(result.aiScore, max);
  if (quizReviewIsPending(result)) return null;
  if (result.score !== undefined && result.score !== null) return Math.max(0, Math.min(max, quizNumber(result.score, 0)));
  if (result.isCorrect === true) return max;
  if (result.isCorrect === false) return 0;
  return null;
}

function quizQuestionScoreLabel(question = {}, result = null) {
  const max = quizMaxScoreFor(question, result || {});
  if (!max) return "";
  if (!result) return `\u672c\u9898 ${quizFormatScore(max)} \u5206`;
  const earned = quizEarnedScore(result, question);
  if (earned === null) return `\u672c\u9898\u5f97\u5206\uff1a\u590d\u6838\u4e2d / ${quizFormatScore(max)} \u5206`;
  return `\u672c\u9898\u5f97\u5206\uff1a${quizFormatScore(earned)} / ${quizFormatScore(max)} \u5206`;
}

function summarizeQuizAttempt(records = [], questions = []) {
  const latest = quizLatestResultsByQuestion(records);
  const results = Object.values(latest);
  const objective = results.filter((result) => result?.isCorrect === true || result?.isCorrect === false);
  const pendingReview = results.filter((result) => quizReviewIsPending(result)).length;
  const questionById = new Map((questions || []).map((question) => [question.id, question]));
  const totalPossible = (questions || []).reduce((sum, question) => sum + quizMaxScoreFor(question, {}), 0) || results.reduce((sum, result) => sum + quizMaxScoreFor({}, result), 0);
  let earnedScore = 0;
  let scoredPossible = 0;
  let scoredQuestions = 0;
  results.forEach((result) => {
    const question = questionById.get(result.questionId || result.question_id) || {};
    const earned = quizEarnedScore(result, question);
    if (earned === null) return;
    earnedScore += earned;
    scoredPossible += quizMaxScoreFor(question, result);
    scoredQuestions += 1;
  });
  const totalQuestions = questions.length || results.length;
  return {
    totalQuestions,
    objectiveTotal: objective.length,
    correctObjective: objective.filter((result) => result.isCorrect === true).length,
    pendingReview,
    scoredQuestions,
    earnedScore: Math.round(earnedScore * 10) / 10,
    scoredPossible: Math.round(scoredPossible * 10) / 10,
    totalPossible,
    scoreReady: Boolean(totalPossible) && scoredQuestions >= totalQuestions && pendingReview === 0
  };
}

function quizOutcomeHtml(summary) {
  const parts = [];
  if (summary.totalPossible > 0) {
    const scoreText = summary.scoreReady
      ? `\u603b\u5206 <strong>${quizFormatScore(summary.earnedScore)}</strong> / ${quizFormatScore(summary.totalPossible)} \u5206`
      : `\u5df2\u5224\u5206 <strong>${quizFormatScore(summary.earnedScore)}</strong> / ${quizFormatScore(summary.scoredPossible || summary.totalPossible)} \u5206`;
    parts.push(scoreText);
  }
  if (summary.objectiveTotal > 0) {
    const objectiveLabel = summary.pendingReview > 0 ? "\u5ba2\u89c2\u9898" : "\u9898";
    parts.push(`${summary.objectiveTotal} \u9053${objectiveLabel}\u4e2d\u7b54\u5bf9\u4e86 <strong>${summary.correctObjective}</strong> \u9053`);
  }
  if (summary.pendingReview > 0) {
    parts.push(`${summary.pendingReview} \u9053\u7b80\u7b54\u9898\u7b49\u5f85\u590d\u6838`);
  }
  if (!parts.length) {
    parts.push(`${summary.totalQuestions} \u9053\u9898\u5df2\u63d0\u4ea4`);
  }
  return parts.join("\uff1b");
}
// Render $...$ math inside text that may already contain HTML tags
function renderMathInHtml(html) {
  if (!html || typeof html !== "string") return escapeHtml(String(html || ""));
  const sanitized = CourseContentSecurity.sanitizeRichHtml(html);
  if (typeof katex === "undefined") return sanitized;
  return sanitized.replace(/\$([^$]+)\$/g, (_, math) => {
    try {
      return katex.renderToString(math, { throwOnError: false, displayMode: false, trust: false, maxExpand: 1000 });
    } catch {
      return escapeHtml("$" + math + "$");
    }
  });
}

function isSignedIn() {
  return Boolean(state.participant?.participantId && state.authToken);
}

function participantDisplayName(participant = state.participant) {
  return participant?.nickname || participant?.email || participant?.displayName || "未命名用户";
}

function participantSubtitle(participant = state.participant) {
  if (!participant) return "User";
  if (participant.nickname && participant.email) return participant.email;
  if (participant.nickname) return "未填写邮箱";
  if (participant.email) return "未填写昵称";
  return "待补充账号信息";
}

function avatarLetter(name = "") {
  const text = String(name || "U").trim();
  return (Array.from(text)[0] || "U").toUpperCase();
}

function setUserMenuOpen(open) {
  if (!els.userMenu || !els.authMenuToggle || !els.authMenuPanel) return;
  els.authMenuToggle.setAttribute("aria-expanded", open ? "true" : "false");
  els.authMenuPanel.hidden = !open;
}

function renderAuth() {
  if (!els.authGate) return;
  const signedIn = isSignedIn();
  const participantId = signedIn ? state.participant.participantId : "";
  const participantChanged = participantId !== lastRenderedProfileParticipantId;
  lastRenderedProfileParticipantId = participantId;
  els.authGate.hidden = signedIn;
  if (els.authAction) els.authAction.hidden = signedIn;
  if (els.userMenu) els.userMenu.hidden = !signedIn;
  const displayName = signedIn ? participantDisplayName() : "未登录";
  const subtitle = signedIn ? participantSubtitle() : "User";
  if (els.authStatus) els.authStatus.textContent = displayName;
  if (els.authStatus) els.authStatus.title = displayName;
  if (els.authSubtitle) {
    els.authSubtitle.textContent = subtitle;
    els.authSubtitle.title = subtitle;
  }
  if (els.authMenuName) els.authMenuName.textContent = displayName;
  if (els.authMenuIdentity) {
    const missing = signedIn && (!state.participant?.nickname || !state.participant?.email);
    const identityText = missing
      ? "补充昵称或邮箱，之后都能作为登录入口。"
      : subtitle;
    els.authMenuIdentity.textContent = identityText;
    els.authMenuIdentity.title = identityText;
  }
  const letter = avatarLetter(displayName);
  if (els.authAvatar) els.authAvatar.textContent = letter;
  if (els.authAvatarLarge) els.authAvatarLarge.textContent = letter;
  if (els.profileNickname) els.profileNickname.value = signedIn ? state.participant.nickname || "" : "";
  if (els.profileEmail) els.profileEmail.value = signedIn ? state.participant.email || "" : "";
  const canEditProfile = signedIn && state.participant?.canEditProfile !== false && !state.participant?.profileUpdatedAt;
  [els.profileNickname, els.profileEmail].forEach((input) => {
    if (!input) return;
    input.disabled = !canEditProfile;
    if (!signedIn || participantChanged) input.removeAttribute("aria-invalid");
  });
  if (els.profileSave) {
    els.profileSave.disabled = !canEditProfile;
    els.profileSave.textContent = canEditProfile ? "保存账号信息" : "账号信息已锁定";
  }
  if (els.profileEditNote) {
    els.profileEditNote.textContent = canEditProfile
      ? "账号信息只能修改一次，保存后将锁定。"
      : "账号信息已锁定，不能再次修改。";
    els.profileEditNote.dataset.tone = canEditProfile ? "warning" : "locked";
  }
  if ((!signedIn || participantChanged) && els.profileFeedback) {
    els.profileFeedback.textContent = "";
    els.profileFeedback.dataset.tone = "muted";
  }
  if (els.authAction) {
    els.authAction.textContent = "登录";
    els.authAction.setAttribute("aria-label", "打开账号登录");
  }
  if (!signedIn) setUserMenuOpen(false);
}

function showLogin(message = "") {
  if (!els.authGate) return;
  els.authGate.hidden = false;
  if (els.loginFeedback) els.loginFeedback.textContent = message;
  els.loginIdentifier?.focus();
}

async function apiRequest(path, body = {}, options = {}) {
  const requestToken = typeof body?.token === "string" && body.token
    ? body.token
    : state.authToken;
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(appRelativeUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller?.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.message || "请求失败，请稍后再试。");
      error.status = response.status;
      error.field = payload.field || "";
      error.code = payload.code || "";
      error.retryAfterSeconds = payload.retryAfterSeconds || 0;
      throw error;
    }
    return payload;
  } catch (error) {
    if (controller?.signal.aborted) {
      const timeoutError = new Error("请求超时，请检查网络后重试。");
      timeoutError.status = 408;
      timeoutError.code = "request_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function learningSnapshot() {
  return {
    courseAssessmentFingerprint: String(
      typeof multiSceneLearningRoute !== "undefined"
        ? multiSceneLearningRoute?.courseAssessmentFingerprint || ""
        : ""
    ).trim(),
    participant: state.participant,
    completed: state.completed || [],
    quizResults: state.quizResults || [],
    quizDrafts: state.quizDrafts || {},
    quizAttempts: state.quizAttempts || {},
    submittedQuizzes: state.submittedQuizzes || [],
    selectedKnowledgeScenes: state.selectedKnowledgeScenes || {},
    returnToQuiz: state.returnToQuiz || null,
    narrationCollapsed: Boolean(state.narrationCollapsed),
    logs: state.logs || [],
    note: state.note || "",
    analytics: state.analytics || {},
    currentChapterId,
    currentUnitId,
    currentView,
    lastLearningContext: state.lastLearningContext || null,
    agenticPath: state.agenticPath || null,
    capturedAt: beijingNow()
  };
}

function snapshotContentJson(snapshot) {
  const stable = { ...(snapshot || {}) };
  delete stable.capturedAt;
  delete stable.clientCapturedAt;
  return JSON.stringify(stable);
}

function setLearningSnapshotVersion(payload = {}) {
  const generation = Number(payload.generation);
  const revision = Number(payload.revision);
  if (Number.isInteger(generation) && generation > 0) learningSnapshotGeneration = generation;
  if (Number.isInteger(revision) && revision >= 0) learningSnapshotRevision = revision;
}

function mergeClientRecords(existing = [], incoming = [], keyFor) {
  const records = new Map();
  [...existing, ...incoming].forEach((record, index) => {
    if (!record || typeof record !== "object") return;
    records.set(keyFor(record) || `record-${index}`, record);
  });
  return Array.from(records.values());
}

function quizResultFromServer(row = {}) {
  let response = row.response || "";
  if (typeof response === "string" && response.startsWith("[")) {
    try { response = JSON.parse(response); } catch {}
  }
  return {
    id: row.id,
    unitId: row.unit_id,
    questionId: row.question_id,
    chapterId: row.chapter_id,
    chapterLabel: row.chapter_label,
    unitLabel: row.unit_label,
    questionType: row.question_type,
    points: row.points,
    phase: row.phase,
    timestamp: row.created_at,
    response,
    isCorrect: row.is_correct === 1 ? true : row.is_correct === 0 ? false : null,
    status: row.status,
    score: row.score,
    maxScore: row.max_score,
    aiScore: row.ai_score,
    aiConfidence: row.ai_confidence,
    aiFeedback: row.ai_feedback || "",
    aiErrorType: row.ai_error_type || "",
    answer: row.answer,
    analysis: row.analysis || "",
    commentPrompt: row.commentPrompt || "",
    estimateLabel: null
  };
}

function applyServerLearningSnapshot(serverSnapshot, options = {}) {
  const replace = options.replace === true;
  const identity = {
    participant: state.participant,
    authToken: state.authToken
  };
  const incoming = serverSnapshot && typeof serverSnapshot === "object" ? serverSnapshot : null;

  if (replace) {
    clearPreviewKnowledgeSceneSelections();
    Object.assign(state, learningDefaults(), incoming || {}, identity);
    normalizeLearningStateCompatibility(state);
    currentChapterId = state.currentChapterId || chapters[0]?.id || "V14-C1";
    currentUnitId = state.currentUnitId || "";
    currentView = validViews.has(state.currentView) ? state.currentView : "home";
    return;
  }
  if (!incoming) return;

  state.completed = [...new Set([...(state.completed || []), ...(incoming.completed || [])])];
  state.submittedQuizzes = [...new Set([
    ...(state.submittedQuizzes || []),
    ...(incoming.submittedQuizzes || [])
  ])];
  state.quizResults = mergeClientRecords(
    state.quizResults || [],
    incoming.quizResults || [],
    (item) => item.id || [item.unitId, item.questionId, item.timestamp].filter(Boolean).join("|")
  );
  state.logs = [...new Set([...(state.logs || []), ...(incoming.logs || [])])].slice(0, 100);
  state.quizAttempts = { ...(incoming.quizAttempts || {}), ...(state.quizAttempts || {}) };
  state.quizDrafts = { ...(incoming.quizDrafts || {}), ...(state.quizDrafts || {}) };
  if (Object.prototype.hasOwnProperty.call(incoming, "selectedKnowledgeScenes")) {
    state.selectedKnowledgeScenes = { ...(incoming.selectedKnowledgeScenes || {}) };
  }
  if (!state.note && incoming.note) state.note = incoming.note;
  if (!state.agenticPath && incoming.agenticPath) state.agenticPath = incoming.agenticPath;
  if (!state.lastLearningContext && incoming.lastLearningContext) {
    state.lastLearningContext = incoming.lastLearningContext;
  }
  normalizeLearningStateCompatibility(state);
}

async function loadAuthoritativeQuizResults(options = {}) {
  const response = await fetch("api/learning/quiz-results", {
    headers: { Authorization: `Bearer ${state.authToken}` }
  });
  if (!response.ok) return;
  const payload = await response.json().catch(() => ({}));
  if (!payload.ok || !Array.isArray(payload.data)) return;
  const results = payload.data.map(quizResultFromServer);
  if (options.replace && results.length) {
    state.quizResults = results;
  } else if (!options.replace) {
    state.quizResults = mergeClientRecords(
      state.quizResults || [],
      results,
      (item) => item.id || [item.unitId, item.questionId, item.timestamp].filter(Boolean).join("|")
    );
  }
  if (results.length) {
    state.submittedQuizzes = [...new Set([
      ...(state.submittedQuizzes || []),
      ...results.map((item) => item.unitId).filter(Boolean)
    ])];
  }
  normalizeLearningStateCompatibility(state);
}

async function hydrateLearningState(options = {}) {
  if (!isSignedIn()) return false;
  learningSnapshotReady = false;
  const response = await fetch("api/learning/snapshot", {
    headers: { Authorization: `Bearer ${state.authToken}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || "学习记录恢复失败，请重新登录。");
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }

  setLearningSnapshotVersion(payload);
  const replaceWithServer = options.replace === true || Boolean(payload.snapshot);
  applyServerLearningSnapshot(payload.snapshot, { ...options, replace: replaceWithServer });
  await loadAuthoritativeQuizResults({ ...options, replace: replaceWithServer }).catch(() => {});
  normalizeFailedQuizReviews();
  learningSnapshotReady = true;
  persistStateLocally();
  lastSnapshotJson = snapshotContentJson(learningSnapshot());
  return true;
}

function queueLearningSnapshot(reason = "state_change") {
  if (!isSignedIn() || !learningSnapshotReady || learningSnapshotSyncPaused) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncLearningSnapshot(reason);
  }, 900);
}

async function performLearningSnapshotSync(reason = "manual") {
  if (!isSignedIn() || !learningSnapshotReady || learningSnapshotSyncPaused) return;
  const snapshot = learningSnapshot();
  const snapshotJson = snapshotContentJson(snapshot);
  if (reason === "state_change" && snapshotJson === lastSnapshotJson) return;
  try {
    const payload = await apiRequest("/api/learning/snapshot", {
      token: state.authToken,
      generation: learningSnapshotGeneration,
      baseRevision: learningSnapshotRevision,
      reason,
      snapshot
    }, { timeoutMs: 15000 });
    setLearningSnapshotVersion(payload);
    lastSnapshotJson = snapshotJson;
    clearLearningSnapshotRetry();
  } catch (error) {
    if (
      error.code === "snapshot_generation_conflict"
      || error.code === "snapshot_revision_conflict"
    ) {
      clearLearningSnapshotRetry();
      await hydrateLearningState({ replace: true }).catch(() => {});
    } else if (
      reason !== "retry_after_failure"
      && learningSnapshotSyncErrorIsRetryable(error)
    ) {
      scheduleLearningSnapshotRetry();
    }
    console.warn("Learning snapshot sync failed:", error.message);
  }
}

function learningSnapshotSyncErrorIsRetryable(error = {}) {
  const status = Number(error.status || 0);
  return !status
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

function clearLearningSnapshotRetry() {
  clearTimeout(learningSnapshotRetryTimer);
  learningSnapshotRetryTimer = null;
}

function scheduleLearningSnapshotRetry() {
  if (learningSnapshotRetryTimer) return;
  const token = state.authToken;
  learningSnapshotRetryTimer = setTimeout(() => {
    learningSnapshotRetryTimer = null;
    if (
      token
      && token === state.authToken
      && isSignedIn()
      && learningSnapshotReady
      && !learningSnapshotSyncPaused
    ) {
      syncLearningSnapshot("retry_after_failure");
    }
  }, 30000);
}

function syncLearningSnapshot(reason = "manual") {
  learningSnapshotSyncChain = learningSnapshotSyncChain
    .catch(() => {})
    .then(() => performLearningSnapshotSync(reason));
  return learningSnapshotSyncChain;
}

async function pauseLearningSnapshotSync() {
  clearLearningSnapshotRetry();
  clearTimeout(syncTimer);
  await learningSnapshotSyncChain.catch(() => {});
  if (isSignedIn() && learningSnapshotReady && !learningSnapshotSyncPaused) {
    await performLearningSnapshotSync("before_pause");
  }
  learningSnapshotSyncPaused = true;
  clearLearningSnapshotRetry();
}

function resumeLearningSnapshotSync() {
  learningSnapshotSyncPaused = false;
}

function learningEventClientId() {
  if (globalThis.crypto?.randomUUID) return `learning-${globalThis.crypto.randomUUID()}`;
  return `learning-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function learningEventDeliveryRetryable(error = {}) {
  const status = Number(error.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function deliverLearningEvent(item, token) {
  let lastError = null;
  for (let attempt = 0; attempt < learningEventMaxDeliveryAttempts; attempt += 1) {
    try {
      return await apiRequest("/api/learning/events", {
        token,
        events: [item]
      }, { timeoutMs: 10000 });
    } catch (error) {
      lastError = error;
      if (
        !learningEventDeliveryRetryable(error)
        || attempt + 1 >= learningEventMaxDeliveryAttempts
      ) break;
      const retryAfterMs = Math.max(0, Number(error.retryAfterSeconds || 0) * 1000);
      const delayMs = Math.max(learningEventRetryDelayMs * (attempt + 1), retryAfterMs)
        + Math.round(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("学习事件同步失败。");
}

async function trackLearningEvent(type, payload = {}, syncSnapshot = true) {
  if (!isSignedIn() || authTransitionInProgress) return;
  const token = state.authToken;
  const clientAt = new Date().toISOString();
  const eventPayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? {
        ...payload,
        timing: {
          ...(payload.timing || {}),
          clientAt: payload.timing?.clientAt || clientAt
        }
      }
    : { value: payload, timing: { clientAt } };
  const request = deliverLearningEvent({
    eventId: learningEventClientId(),
    type,
    payload: eventPayload
  }, token);
  learningEventRequests.add(request);
  if (syncSnapshot && state.authToken === token && !authTransitionInProgress) {
    queueLearningSnapshot(type);
  }
  try {
    await request;
  } catch (error) {
    console.warn("Learning event sync failed:", error.message);
  } finally {
    learningEventRequests.delete(request);
  }
}

async function waitForLearningEventSync(maxWaitMs = 20000) {
  const deadline = Date.now() + Math.max(1000, Number(maxWaitMs || 0));
  while (learningEventRequests.size && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await Promise.race([
      Promise.allSettled(Array.from(learningEventRequests)),
      new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, remaining))))
    ]);
  }
  return learningEventRequests.size === 0;
}

async function loginParticipant(credentials = {}) {
  await pauseLearningSnapshotSync();
  persistStateLocally();

  try {
    const mode = credentials.mode === "register" ? "register" : "login";
    const payload = await apiRequest(
      mode === "register" ? "/api/auth/register" : "/api/auth/login",
      mode === "register"
        ? {
            nickname: credentials.nickname || "",
            email: credentials.email || "",
            password: credentials.password || ""
          }
        : {
            identifier: credentials.identifier || "",
            password: credentials.password || ""
          }
    );
    const lastPid = localStorage.getItem(LAST_PARTICIPANT_KEY);
    const newPid = payload.participant.participantId;
    const isSameUser = lastPid === newPid;
    let hasSavedState = isSameUser;

    if (!isSameUser) {
      clearPreviewKnowledgeSceneSelections();
      const oldGeneric = localStorage.getItem(STORAGE_KEY);
      if (oldGeneric && !localStorage.getItem(storageKeyFor(newPid))) {
        localStorage.setItem(storageKeyFor(newPid), oldGeneric);
        localStorage.removeItem(STORAGE_KEY);
      }

      const saved = localStorage.getItem(storageKeyFor(newPid));
      hasSavedState = Boolean(saved);
      if (saved) {
        const restored = JSON.parse(saved);
        delete restored.authToken;
        Object.assign(state, learningDefaults(), restored);
      } else {
        Object.assign(state, learningDefaults());
      }
      normalizeLearningStateCompatibility(state);
      currentChapterId = state.currentChapterId || chapters[0]?.id || "V14-C1";
      currentUnitId = state.currentUnitId || "";
      switchView("home");
    }

    state.participant = payload.participant;
    state.authToken = payload.token;
    sessionStorage.setItem(AUTH_TOKEN_KEY, payload.token);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.setItem(LAST_PARTICIPANT_KEY, newPid);
    learningSnapshotGeneration = 0;
    learningSnapshotRevision = 0;
    await hydrateLearningState({ replace: !isSameUser && !hasSavedState });
    if (typeof agenticRecoverInterruptedGrading === "function") {
      await agenticRecoverInterruptedGrading();
    }

    persistStateLocally();
    renderAll();
    setupInteractionTracking();
    resumeLearningSnapshotSync();
    await syncLearningSnapshot("login");
  } catch (error) {
    resumeLearningSnapshotSync();
    throw error;
  }
}

async function updateParticipantProfile(profile = {}) {
  if (!isSignedIn()) throw new Error("请先登录。");
  const payload = await apiRequest("/api/auth/profile", {
    token: state.authToken,
    nickname: profile.nickname || "",
    email: profile.email || ""
  });
  state.participant = payload.participant;
  saveState();
  renderAuth();
  addLog("更新了账号信息。");
  return payload.participant;
}

async function logoutParticipant() {
  if (authTransitionInProgress) return;
  authTransitionInProgress = true;
  try {
    clearTimeout(syncTimer);
    if (typeof analyticsEndParticipantSession === "function") {
      analyticsEndParticipantSession("logout");
    }
    if (typeof analyticsFlushUntilSettled === "function") {
      await analyticsFlushUntilSettled(20000);
    } else if (typeof analyticsFlush === "function") {
      await analyticsFlush();
    }
    await waitForLearningEventSync(20000);
    await syncLearningSnapshot("logout");
    await pauseLearningSnapshotSync();
    persistStateLocally();
    const token = state.authToken;
    if (token) {
      await apiRequest("/api/auth/logout", { token }, { timeoutMs: 10000 }).catch(() => {});
    }
    stopNarrationQueue();
    state.participant = null;
    state.authToken = "";
    learningSnapshotGeneration = 0;
    learningSnapshotRevision = 0;
    learningSnapshotReady = false;
    onlinePeriodStart = null;
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LAST_PARTICIPANT_KEY);
    // Reset runtime learning state to defaults
    clearPreviewKnowledgeSceneSelections();
    Object.assign(state, learningDefaults(), { participant: null, authToken: "" });
    currentChapterId = chapters[0]?.id || "V14-C1";
    currentUnitId = "";
    switchView("home");
    renderAuth();
    showLogin();
  } finally {
    resumeLearningSnapshotSync();
    authTransitionInProgress = false;
  }
}

function quizDraftKey(unitId, questionId) {
  return `${unitId}:${questionId}`;
}

function readQuizDraft(unitId, questionId, fallback = "") {
  const value = state.quizDrafts?.[quizDraftKey(unitId, questionId)];
  return value === undefined ? fallback : value;
}

function rememberQuizDraft(unitId, questionId, value) {
  state.quizDrafts = state.quizDrafts || {};
  state.quizDrafts[quizDraftKey(unitId, questionId)] = value;
  saveState();
}

function quizRecordsForUnit(unitId) {
  const history = (state.quizResults || []).filter((row) => row.unitId === unitId);
  const persisted = state.quizAttempts?.[unitId]?.records || [];
  return [...history, ...persisted];
}

function rememberQuizAttempt(unit, records = []) {
  if (!unit?.id) return;
  state.quizAttempts = state.quizAttempts || {};
  state.quizAttempts[unit.id] = {
    unitId: unit.id,
    chapterId: unit.chapterId,
    unitLabel: unit.label,
    phase: unit.assessmentPhase || "",
    submittedAt: beijingNow(),
    records
  };
}

function quizResponseHasValue(question = {}, value) {
  if (question.type === "multiple") return Array.isArray(value) && value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function restoredQuizResultFromDraft(unit, question, index = 0) {
  const fallback = question.type === "multiple" ? [] : "";
  const draft = readQuizDraft(unit.id, question.id, fallback);
  if (!quizResponseHasValue(question, draft)) return null;

  if (question.type === "short_answer") {
    return {
      mode: "short_answer",
      response: String(draft),
      isCorrect: null,
      status: "pending_review",
      score: null,
      maxScore: question.points || 0,
      restoredFromDraft: true,
      questionId: question.id,
      questionIndex: index
    };
  }

  const selected = question.type === "multiple" ? [...draft] : [draft];
  const answer = [...(question.answer || [])].sort();
  const isCorrect = JSON.stringify([...selected].sort()) === JSON.stringify(answer);
  return {
    mode: question.type,
    response: question.type === "multiple" ? selected : selected[0],
    isCorrect,
    status: isCorrect ? "correct" : "incorrect",
    score: isCorrect ? question.points || 0 : 0,
    maxScore: question.points || 0,
    restoredFromDraft: true,
    questionId: question.id,
    questionIndex: index
  };
}

async function loadChapterManifest(chapterId) {
  if (isMultiSceneLearningRoute()) {
    await loadMultiSceneLearningRoute();
    return null;
  }
  if (manifests.has(chapterId)) return manifests.get(chapterId);
  if (manifestPromises.has(chapterId)) return manifestPromises.get(chapterId);

  const chapter = chapters.find((item) => item.id === chapterId) || chapters[0];
  const promise = (async () => {
    try {
      const manifest = await fetchJson(`resources/open-maic/${chapter.id}/index.json`, `${chapter.label} index 加载失败`);
      manifests.set(chapter.id, manifest);
      buildCurriculum();
      return manifest;
    } catch (error) {
      console.warn(`${chapter.label} lightweight index unavailable`, error);
      throw new Error(`${chapter.label} 轻量索引加载失败，请检查 resources/open-maic/${chapter.id}/index.json 是否已部署。`);
    } finally {
      manifestPromises.delete(chapter.id);
    }
  })();
  manifestPromises.set(chapter.id, promise);
  return promise;
}

async function ensureChapterLoaded(chapterId, options = {}) {
  if (options.showLoading !== false) {
    const chapter = chapters.find((item) => item.id === chapterId) || chapters[0];
    renderLoadingStatus(chapter.label);
  }
  if (isMultiSceneLearningRoute()) {
    await loadMultiSceneLearningRoute();
    buildCurriculum();
    return;
  }
  await loadChapterManifest(chapterId);
  buildCurriculum();
}

async function loadCourseIndex() {
  if (courseIndex) return courseIndex;
  if (isMultiSceneLearningRoute()) {
    await loadMultiSceneLearningRoute();
    return courseIndex;
  }
  try {
    courseIndex = await fetchJson(COURSE_INDEX_PATH, "course-index 加载失败");
  } catch (error) {
    console.warn("Course index unavailable; metrics will use loaded chapters only.", error);
    courseIndex = { chapters: [], totals: null };
  }
  return courseIndex;
}

function chapterStats(chapterId) {
  return courseIndex?.chapters?.find((chapter) => chapter.id === chapterId) || null;
}

function totalMainUnitCount() {
  if (isMultiSceneLearningRoute()) return allUnits().length || courseIndex?.totals?.knowledgePoints || 0;
  const chapterCount = courseIndex?.chapters?.length || curriculum.length || chapters.length;
  const coreCount = AGENTIC_CORE_SCENE_ORDERS.length;
  return chapterCount && coreCount ? chapterCount * coreCount : allUnits().length || 0;
}

function unitCountsTowardProgress(unit) {
  return Boolean(unit) && (
    state.completed.includes(unit.id) ||
    (typeof agenticIsSkipped === "function" && agenticIsSkipped(unit.id))
  );
}

function isMainUnitId(id = "") {
  if (isMultiSceneLearningRoute()) return Boolean(findMainUnit(id));
  return chapters.some((chapter) => id.startsWith(`${chapter.id}-scene-`));
}

function scheduleChapterPrefetch() {
  if (isMultiSceneLearningRoute()) return;
  if (prefetchStarted) return;
  prefetchStarted = true;
  const queue = chapters.map((chapter) => chapter.id).filter((id) => !manifests.has(id));
  const loadNext = () => {
    const chapterId = queue.shift();
    if (!chapterId) return;
    loadChapterManifest(chapterId)
      .then(() => {
        buildCurriculum();
        renderMetrics();
        renderChapters();
        renderLessons();
        if (currentView === "library") renderLibrary();
        if (currentView === "progress") renderProgress();
      })
      .catch((error) => console.warn("Chapter prefetch failed:", chapterId, error))
      .finally(() => window.setTimeout(loadNext, 80));
  };
  window.setTimeout(loadNext, 120);
}

function preloadChapterResources(chapterId) {
  // Large interactive lessons and audio are loaded only when the learner opens them.
}

function renderLoadingStatus(chapterLabel = "课程") {
  if (!els.lessonPlayer) return;
  els.lessonPlayer.innerHTML = `
    <div class="empty-state loading-state">
      <h2>正在加载课程资源</h2>
      <p>正在读取「${escapeHtml(chapterLabel)}」的课程内容、互动实验和测验数据。</p>
      <div class="progress-line" aria-label="资源加载中">
        <span style="width:42%"></span>
      </div>
      <small>现在按章节加载，互动实验和音频会在打开时按需读取。</small>
    </div>
  `;
}

function buildCurriculum() {
  if (isMultiSceneLearningRoute()) {
    curriculum = buildMultiSceneLearningCurriculum();
  } else {
    curriculum = chapters.map(buildChapter);
  }

  const currentChapter = getChapter();
  if (currentChapter?.units?.length && (!currentUnitId || !findMainUnit(currentUnitId))) {
    currentUnitId = currentChapter.units[0].id;
  }
}

function buildMultiSceneLearningCurriculum() {
  const moduleChapters = multiSceneRouteModuleChapters(multiSceneLearningRoute);
  const routeChapters = moduleChapters.length ? moduleChapters : (multiSceneLearningRoute?.chapters || []);
  if (!routeChapters.length) {
    return chapters.map((chapter) => ({ ...chapter, units: [], allUnits: [], loaded: false }));
  }
  return routeChapters.map((routeChapter, chapterIndex) => buildMultiSceneLearningChapter(routeChapter, chapterIndex));
}

function openMaicQuestionKnowledgePointIds(question = {}) {
  const explicit = question.knowledgePointIds || question.knowledge_point_ids || question.coachHint?.knowledgePointIds || [];
  return Array.isArray(explicit) ? explicit.filter(Boolean) : [];
}

function openMaicQuestionSource(question = {}) {
  return QuizQuestionOrder.questionSource(question);
}

function openMaicShouldHideQuestion(question = {}, phase = "") {
  return QuizQuestionOrder.shouldHideQuestion(question, phase);
}

function openMaicQuestionDifficultyRank(question = {}) {
  return QuizQuestionOrder.difficultyRank(question);
}

function openMaicSortedQuestions(questions = [], phase = "") {
  return QuizQuestionOrder.orderQuestions(questions, phase);
}

function openMaicQuizFlowForPhase(flow = {}, phase = "") {
  const questions = openMaicSortedQuestions(flow.questions || [], phase);
  return {
    ...flow,
    questions,
    originalQuestionCount: (flow.questions || []).length,
    filteredQuestionCount: questions.length
  };
}

function openMaicReviewHasCourseware(routeChapter = {}) {
  const review = routeChapter.flow?.review || {};
  return Boolean(
    review.canvas ||
    review.slides?.length ||
    review.sections?.length ||
    review.cards?.length ||
    review.items?.length ||
    review.htmlPath ||
    review.resourceCandidates?.length ||
    review.courseware ||
    review.content
  );
}

function openMaicFormativeMidpointIndex(routeChapter = {}, allKnowledgePoints = []) {
  if (!allKnowledgePoints.length) return 0;
  const fallback = Math.max(1, Math.ceil(allKnowledgePoints.length / 2));
  const modules = routeChapter.modules || [];
  const moduleBoundaries = [];
  let seen = 0;
  modules.forEach((module) => {
    seen += (module.knowledgePoints || []).length;
    if (seen > 0 && seen < allKnowledgePoints.length) moduleBoundaries.push(seen);
  });
  if (!moduleBoundaries.length) return fallback;
  return moduleBoundaries.reduce((best, next) => {
    const bestDistance = Math.abs(best - fallback);
    const nextDistance = Math.abs(next - fallback);
    return nextDistance < bestDistance ? next : best;
  }, moduleBoundaries[0]);
}

function openMaicFormativeQuizFlow(routeChapter = {}, allKnowledgePoints = [], formativeIndex = 0) {
  const flow = routeChapter.flow?.formativeQuiz || {};
  const splitIndex = Math.max(0, Math.min(formativeIndex, allKnowledgePoints.length));
  const learnedIds = new Set(allKnowledgePoints.slice(0, splitIndex).map((entry) => entry.knowledgePoint?.id).filter(Boolean));
  const bridgeIds = new Set(allKnowledgePoints.slice(splitIndex).map((entry) => entry.knowledgePoint?.id).filter(Boolean));
  const questions = openMaicSortedQuestions(flow.questions || [], "formative");
  const reviewQuestions = questions.filter((question) => openMaicQuestionKnowledgePointIds(question).some((id) => learnedIds.has(id)));
  const bridgeQuestions = questions.filter((question) => openMaicQuestionKnowledgePointIds(question).some((id) => bridgeIds.has(id)));
  return {
    ...flow,
    title: "形成性测验：回顾已学，预告后学",
    questions,
    midCourse: true,
    coveredKnowledgePointIds: [...learnedIds],
    bridgeKnowledgePointIds: [...bridgeIds],
    reviewQuestionCount: reviewQuestions.length,
    bridgeQuestionCount: bridgeQuestions.length,
    originalQuestionCount: (flow.questions || []).length,
    filteredQuestionCount: questions.length
  };
}

function multiSceneRouteModuleUnits(module = {}) {
  const knowledgeCount = (module.knowledgePoints || []).length;
  return new Array(knowledgeCount + 4).fill(null);
}

function buildMultiSceneLearningChapter(routeChapter, chapterIndex = 0) {
  const chapter = normalizeOpenMaicChapter(routeChapter, chapterIndex);
  const units = [];
  let sceneOrder = 1;
  const modules = routeChapter.modules || [];
  const allKnowledgePoints = modules.flatMap((module, moduleIndex) => (module.knowledgePoints || []).map((knowledgePoint, kpIndex) => ({ module, moduleIndex, knowledgePoint, kpIndex })));
  const formativeIndex = openMaicFormativeMidpointIndex(routeChapter, allKnowledgePoints);
  const formativeFlow = openMaicFormativeQuizFlow(routeChapter, allKnowledgePoints, formativeIndex);
  units.push(createOpenMaicQuizUnit(chapter, routeChapter, "pre", sceneOrder++, -1));
  allKnowledgePoints.forEach((entry, index) => {
    if (index === formativeIndex) units.push(createOpenMaicQuizUnit(chapter, routeChapter, "formative", sceneOrder++, -1, formativeFlow));
    units.push(createOpenMaicKnowledgeUnit(chapter, entry.module, entry.knowledgePoint, entry.kpIndex, sceneOrder++, entry.moduleIndex));
  });
  if (allKnowledgePoints.length <= formativeIndex) units.push(createOpenMaicQuizUnit(chapter, routeChapter, "formative", sceneOrder++, -1, formativeFlow));
  if (openMaicReviewHasCourseware(routeChapter)) units.push(createOpenMaicReviewUnit(chapter, routeChapter, sceneOrder++, -1));
  units.push(createOpenMaicQuizUnit(chapter, routeChapter, "post", sceneOrder++, -1));

  return {
    ...chapter,
    routeChapter,
    modules: routeChapter.modules || [],
    manifest: null,
    units,
    allUnits: units,
    loaded: true
  };
}

function createOpenMaicQuizUnit(chapter, module, phase, sceneOrder, moduleIndex, flowOverride = null) {
  const rawFlow = flowOverride || module.flow?.[phase === "pre" ? "preQuiz" : phase === "post" ? "postQuiz" : "formativeQuiz"] || {};
  const flow = openMaicQuizFlowForPhase(rawFlow, phase);
  const label = phaseText(phase);
  const readableTitle = readableRouteText(flow.title, `${module.id} ${label}`);
  const stepLabel = multiSceneQuizStepLabel(phase);
  return {
    id: `${module.id}-${phase}`,
    kind: "quiz",
    chapterId: chapter.id,
    moduleId: module.id,
    moduleTitle: module.title,
    moduleOrder: moduleIndex + 1,
    sceneOrder,
    flowKind: "core",
    flowLabel: module.id,
    label: stepLabel,
    summary: `${module.title} · ${readableTitle}`,
    type: "quiz",
    assessmentPhase: phase,
    placeholderQuiz: !(flow.questions || []).length,
    conceptClusterId: module.id,
    conceptClusterLabel: module.title,
    conceptClusterFocus: module.coreQuestion || "",
    representation: "assessment",
    scenarioType: phase === "pre" ? "diagnose" : phase === "post" ? "transfer" : "check",
    difficultyBand: flow.difficulty || "medium",
    scene: {
      type: "quiz",
      title: readableTitle,
      order: sceneOrder,
      content: {
        questions: flow.questions || [],
        quizConfig: flow,
        placeholder: true
      },
      actions: []
    }
  };
}

function multiSceneQuizStepLabel(phase = "") {
  return {
    pre: "知识前测",
    formative: "形成测验",
    post: "结业后测"
  }[phase] || phaseText(phase) || "测验";
}

function readableRouteText(value = "", fallback = "") {
  const text = String(value || "").trim();
  if (!text || /\?{2,}/.test(text)) return fallback;
  return text;
}

function createOpenMaicKnowledgeUnit(chapter, module, knowledgePoint, kpIndex, sceneOrder, moduleIndex) {
  const candidates = normalizeResourceCandidates(knowledgePoint.resourceCandidates || []);
  return {
    id: knowledgePoint.id,
    kind: "knowledge",
    chapterId: chapter.id,
    moduleId: module.id,
    moduleTitle: module.title,
    moduleOrder: moduleIndex + 1,
    knowledgeIndex: kpIndex + 1,
    sceneOrder,
    flowKind: "core",
    flowLabel: module.id,
    label: knowledgePoint.name,
    summary: compactKnowledgeGoal(knowledgePoint, module),
    type: "knowledge",
    assessmentPhase: "",
    conceptClusterId: knowledgePoint.id,
    conceptClusterLabel: knowledgePoint.name,
    conceptClusterFocus: knowledgePoint.goal || module.coreQuestion || "",
    representation: "mixed",
    scenarioType: "student_choice",
    difficultyBand: "core",
    resourceCandidates: candidates,
    scene: {
      type: "knowledge",
      title: knowledgePoint.name,
      order: sceneOrder,
      content: {
        chapter,
        module,
        knowledgePoint: {
          ...knowledgePoint,
          resourceCandidates: candidates
        },
        interactionTypes: routeInteractionTypes()
      },
      actions: []
    }
  };
}

function createOpenMaicReviewUnit(chapter, module, sceneOrder, moduleIndex) {
  return {
    id: `${module.id}-review`,
    kind: "review",
    chapterId: chapter.id,
    moduleId: module.id,
    moduleTitle: module.title,
    moduleOrder: moduleIndex + 1,
    sceneOrder,
    flowKind: "core",
    flowLabel: module.id,
    label: "证据回看",
    summary: `${module.title} · 证据链回看`,
    type: "slide",
    assessmentPhase: "",
    conceptClusterId: module.id,
    conceptClusterLabel: module.title,
    conceptClusterFocus: module.coreQuestion || "",
    representation: "verbal",
    scenarioType: "review",
    difficultyBand: "core",
    scene: {
      type: "slide",
      title: readableRouteText(module.flow?.review?.title, "全课整理：证据链回看"),
      order: sceneOrder,
      content: {
        routeReview: true,
        module
      },
      actions: []
    }
  };
}

function normalizeResourceCandidates(candidates = []) {
  return [...candidates]
    .filter((candidate) => candidate?.root && candidate?.file)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function knowledgeInteractionTypes(unit) {
  return unit?.scene?.content?.interactionTypes || routeInteractionTypes();
}

function knowledgeResourceCandidate(unit, typeId = "") {
  const candidates = unit?.resourceCandidates || unit?.scene?.content?.knowledgePoint?.resourceCandidates || [];
  if (!typeId) return candidates[0] || null;
  const type = knowledgeInteractionTypes(unit).find((item) => item.id === typeId) || {};
  const aliases = new Set([typeId, type.widgetType, type.id]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase()));
  if (aliases.has("mindmap")) aliases.add("diagram");
  if (aliases.has("diagram")) aliases.add("mindmap");
  if (aliases.has("3d")) aliases.add("visualization3d");
  if (aliases.has("visualization3d")) aliases.add("3d");
  return candidates.find((candidate) => {
    const candidateType = String(candidate?.type || "").toLowerCase();
    const widgetType = String(candidate?.widgetType || "").toLowerCase();
    return aliases.has(candidateType) || aliases.has(widgetType);
  }) || null;
}

function knowledgeSceneRecommendation(unit) {
  if (!unit || unit.type !== "knowledge" || typeof SceneRecommender === "undefined") {
    return { ranked: [], recommended: null };
  }
  const content = unit.scene?.content || {};
  const knowledgePoint = content.knowledgePoint || {};
  const module = content.module || {};
  const evidence = state.analytics?.interactionEvidence?.[unit.id] || {};
  const masteryLevel = typeof agenticKnowledgeMasteryForUnit === "function"
    ? agenticKnowledgeMasteryForUnit(unit.id)
    : null;
  const reviewMode = typeof agenticKnowledgeReviewMode === "function"
    ? agenticKnowledgeReviewMode(unit.id)
    : false;
  return SceneRecommender.rank({
    knowledgePoint: {
      id: unit.id,
      name: knowledgePoint.name || unit.label,
      goal: knowledgePoint.goal || unit.conceptClusterFocus || "",
      misconception: knowledgePoint.misconception || "",
      coreQuestion: module.coreQuestion || "",
      moduleTitle: module.title || unit.moduleTitle || ""
    },
    candidates: unit.resourceCandidates || knowledgePoint.resourceCandidates || [],
    masteryLevel,
    experiencedTypes: evidence.experiencedSceneTypes || [],
    reviewMode
  });
}

function knowledgeSceneDisplayLabel(typeOrId = "") {
  const type = typeof typeOrId === "object"
    ? typeOrId
    : { id: String(typeOrId || "") };
  const id = type.id === "diagram" ? "mindMap" : type.id;
  return {
    simulation: "动手调一调",
    game: "找错并改正",
    mindMap: "知识怎么连",
    visualization3d: "换个角度看"
  }[id] || type.title || type.label || id || "互动场景";
}

function selectedKnowledgeSceneType(unit) {
  if (!unit?.id) return "";
  state.selectedKnowledgeScenes = state.selectedKnowledgeScenes || {};
  previewKnowledgeScenes = previewKnowledgeScenes || {};
  const types = knowledgeInteractionTypes(unit);
  const canPersist = typeof agenticUnitCompletionAllowed !== "function"
    || agenticUnitCompletionAllowed(unit.id);
  if (typeof KnowledgeSceneSelection !== "undefined") {
    return KnowledgeSceneSelection.selectedTypeForAccess(
      unit.id,
      state.selectedKnowledgeScenes,
      previewKnowledgeScenes,
      types,
      canPersist
    );
  }
  const validIds = new Set(types.map((type) => type.id));
  const selections = canPersist ? state.selectedKnowledgeScenes : previewKnowledgeScenes;
  const existing = selections[unit.id];
  return existing && validIds.has(existing) ? existing : "";
}

function clearPreviewKnowledgeSceneSelections(unitId = "") {
  previewKnowledgeScenes = previewKnowledgeScenes || {};
  if (unitId) {
    delete previewKnowledgeScenes[unitId];
    return;
  }
  previewKnowledgeScenes = {};
}

function clearKnowledgeSceneSelectionForUnit(unitId = "") {
  if (!unitId) return;
  state.selectedKnowledgeScenes = state.selectedKnowledgeScenes || {};
  delete state.selectedKnowledgeScenes[unitId];
  clearPreviewKnowledgeSceneSelections(unitId);
}

function setKnowledgeSceneType(unitId, typeId) {
  const unit = getUnit(unitId);
  if (!unit || unit.type !== "knowledge") return false;
  const types = knowledgeInteractionTypes(unit);
  state.selectedKnowledgeScenes = state.selectedKnowledgeScenes || {};
  previewKnowledgeScenes = previewKnowledgeScenes || {};
  const canPersist = typeof agenticUnitCompletionAllowed !== "function"
    || agenticUnitCompletionAllowed(unit.id);
  const result = typeof KnowledgeSceneSelection !== "undefined"
    ? KnowledgeSceneSelection.recordSelectionForAccess(
        unit.id,
        state.selectedKnowledgeScenes,
        previewKnowledgeScenes,
        typeId,
        types,
        canPersist
      )
    : (() => {
        const target = canPersist ? state.selectedKnowledgeScenes : previewKnowledgeScenes;
        const valid = types.some((type) => type.id === typeId);
        if (!valid || target[unit.id] === typeId) return { changed: false, persisted: canPersist };
        target[unit.id] = typeId;
        if (canPersist) delete previewKnowledgeScenes[unit.id];
        else delete state.selectedKnowledgeScenes[unit.id];
        return { changed: true, persisted: canPersist };
      })();
  if (!result.changed) return false;

  if (currentUnitId === unit.id && typeof analyticsLeaveUnit === "function") {
    analyticsLeaveUnit("switch_knowledge_scene");
  }
  if (result.persisted) saveState();
  const selected = types.find((type) => type.id === typeId);
  const candidate = knowledgeResourceCandidate(unit, typeId);
  if (currentUnitId === unit.id && typeof analyticsResumeUnitTimer === "function") {
    analyticsResumeUnitTimer(unit);
  }
  trackLearningEvent("select_knowledge_scene", {
    unitId: unit.id,
    chapterId: unit.chapterId,
    moduleId: unit.moduleId,
    knowledgePoint: unit.label,
    sceneType: typeId,
    sceneLabel: knowledgeSceneDisplayLabel(selected || typeId),
    resourceTitle: candidate?.title || "",
    hasResource: Boolean(candidate),
    previewOnly: !result.persisted
  }, result.persisted);
  analyticsTrack("knowledge_scene_select", {
    data: {
      unitId: unit.id,
      chapterId: unit.chapterId,
      moduleId: unit.moduleId,
      knowledgePoint: unit.label,
      sceneType: typeId,
      sceneLabel: knowledgeSceneDisplayLabel(selected || typeId),
      resourceTitle: candidate?.title || "",
      hasResource: Boolean(candidate),
      previewOnly: !result.persisted
    }
  });
  return true;
}

function buildChapter(chapter) {
    const manifest = manifests.get(chapter.id);
  if (!manifest) {
    return {
      ...chapter,
      manifest: null,
      units: [],
      allUnits: [],
      loaded: false
    };
  }

    const quizTotal = manifest.scenes.filter((scene) => scene.type === "quiz").length;
    let quizIndex = 0;
    const scenes = manifest.scenes.map((scene, index) => {
      const assessmentPhase = scene.type === "quiz" ? assessmentPhaseFor(quizIndex++, quizTotal) : "";
      const sceneOrder = scene.order || index + 1;
      const metadata = typeof inferredSceneMetadata === "function" ? inferredSceneMetadata(chapter.id, scene, sceneOrder, assessmentPhase) : {};
      Object.assign(scene, metadata);
      const isCorePath = AGENTIC_CORE_SCENE_ORDERS.includes(sceneOrder);
      return {
        id: `${chapter.id}-scene-${sceneOrder}`,
        kind: "scene",
        chapterId: chapter.id,
        scene,
        sceneOrder,
        flowKind: isCorePath ? "core" : "adaptive",
        flowLabel: isCorePath ? "核心路径" : (AGENTIC_ADAPTIVE_SCENE_LABELS[sceneOrder] || "新加课件"),
        label: summarizeScene(scene, index, assessmentPhase),
        summary: describeScene(scene),
        type: scene.type,
        assessmentPhase,
        conceptClusterId: metadata.conceptClusterId || "",
        conceptClusterLabel: metadata.conceptClusterLabel || "",
        conceptClusterFocus: metadata.conceptClusterFocus || "",
        representation: metadata.representation || "",
        scenarioType: metadata.scenarioType || "",
        difficultyBand: metadata.difficultyBand || ""
      };
    });
    const coreUnits = scenes.filter((unit) => unit.flowKind === "core");
    const orderedScenes = orderMainScenes(coreUnits);

    return {
      ...chapter,
      manifest,
      units: coreUnits,
      allUnits: orderedScenes,
      loaded: true
    };
}

function orderMainScenes(scenes) {
  const pre = scenes.filter((unit) => unit.assessmentPhase === "pre");
  const rest = scenes.filter((unit) => unit.assessmentPhase !== "pre");
  return [...pre, ...rest];
}

function assessmentPhaseFor(index, total) {
  if (index === 0) return "pre";
  if (index === total - 1) return "post";
  return "formative";
}

function phaseText(phase) {
  return {
    pre: "前测",
    formative: "形成性测验",
    post: "后测"
  }[phase] || "";
}

function phaseGoal(phase) {
  return {
    pre: "别紧张！这不是考试，只是为了了解你对这个话题的已有理解，答错没关系，学完之后会再做一次后测来对比进步。",
    formative: "边学边检查卡点，把错误变成下一步提示。",
    post: "完成最后检查，确认是否可以进入下一章。"
  }[phase] || "";
}

function summarizeScene(scene, index, assessmentPhase = "") {
  if (scene.type === "quiz") {
    return phaseText(assessmentPhase) || (index === 0 ? "前测" : "阶段测");
  }

  if (scene.type === "slide") {
    if (/地图|路线/.test(scene.title)) return "概念地图";
    if (/公式|桥/.test(scene.title)) return "公式桥";
    if (/复盘|兜底|检查/.test(scene.title)) return "复盘页";
    return "讲解页";
  }

  return `实验：${compactTitle(scene.title)}`;
}

function compactTitle(title) {
  return title
    .replace(/^.*?：/, "")
    .replace(/实验|挑战|游戏|探针|同步器|生成器|分类器|播放器|仪表盘|可视化|大作战|大比拼|闯关|扫描仪/g, "")
    .replace(/^\d+_/, "")
    .replace(/\.html$/, "")
    .slice(0, 12);
}

function describeScene(scene) {
  if (scene.type === "quiz") return "站内整页答题，提交后记录学习证据。";
  if (scene.type === "slide") return "概念讲解，配合教师旁白。";
  return "站内互动实验。";
}

function learningClusterForUnit(unit) {
  if (!unit) return null;
  if (unit.conceptClusterId) {
    const chapter = getChapter(unit.chapterId);
    return learningClustersForChapter(chapter).find((cluster) => cluster.id === unit.conceptClusterId) || {
      id: unit.conceptClusterId,
      label: unit.conceptClusterLabel || "学习小节",
      focus: unit.conceptClusterFocus || "同一知识点的多场景学习。",
      orders: [unit.sceneOrder],
      chapterId: unit.chapterId
    };
  }
  const template = (typeof learningClusterTemplatesForChapter === "function" ? learningClusterTemplatesForChapter(unit.chapterId) : [])
    .find((cluster) => cluster.orders.includes(unit.sceneOrder));
  if (!template) return null;
  return { ...template, chapterId: unit.chapterId };
}

function learningClustersForChapter(chapter) {
  const units = typeof agenticDisplayUnitsForChapter === "function"
    ? agenticDisplayUnitsForChapter(chapter)
    : (chapter?.allUnits || chapter?.units || []);
  const metadataGroups = new Map();
  (units || []).forEach((unit) => {
    if (!unit.conceptClusterId) return;
    const item = metadataGroups.get(unit.conceptClusterId) || {
      id: unit.conceptClusterId,
      label: unit.conceptClusterLabel || "学习小节",
      focus: unit.conceptClusterFocus || "同一知识点的多场景学习。",
      chapterId: chapter?.id || unit.chapterId || "",
      orders: [],
      units: [],
      completed: 0,
      active: false,
      source: "metadata"
    };
    item.orders.push(unit.sceneOrder);
    item.units.push(unit);
    if (unitCountsTowardProgress(unit)) item.completed += 1;
    if (unit.id === currentUnitId) item.active = true;
    metadataGroups.set(unit.conceptClusterId, item);
  });
  if (metadataGroups.size) {
    return Array.from(metadataGroups.values())
      .map((cluster) => ({ ...cluster, orders: Array.from(new Set(cluster.orders)).sort((a, b) => a - b), units: cluster.units.sort((a, b) => a.sceneOrder - b.sceneOrder) }))
      .sort((a, b) => (a.orders[0] || 0) - (b.orders[0] || 0));
  }
  const byOrder = new Map((units || []).map((unit) => [unit.sceneOrder, unit]));
  return (typeof learningClusterTemplatesForChapter === "function" ? learningClusterTemplatesForChapter(chapter?.id) : [])
    .map((template) => {
      const clusterUnits = template.orders.map((order) => byOrder.get(order)).filter(Boolean);
      const completed = clusterUnits.filter((unit) => unitCountsTowardProgress(unit)).length;
      const active = clusterUnits.some((unit) => unit.id === currentUnitId);
      return { ...template, chapterId: chapter?.id || "", units: clusterUnits, completed, active };
    })
    .filter((cluster) => cluster.units.length);
}

function learningSceneRole(unit) {
  if (!unit) return "学习模块";
  if (unit.type === "quiz") return phaseText(unit.assessmentPhase) || "测验";
  if (unit.flowKind === "adaptive") return unit.flowLabel || "自适应学习";
  if (unit.type === "interactive") return "互动实验";
  if (unit.type === "slide") return "概念讲解";
  if (unit.type === "knowledge") return "讲解页 + 自选互动";
  return "学习模块";
}

function siblingLearningScenes(unit) {
  const cluster = learningClusterForUnit(unit);
  if (!cluster) return [];
  const chapter = getChapter(unit.chapterId);
  const all = chapter?.allUnits || chapter?.units || [];
  return all.filter((candidate) => cluster.orders.includes(candidate.sceneOrder));
}
function getChapter(id = currentChapterId) {
  return curriculum.find((chapter) => chapter.id === id) || curriculum[0] || chapters[0];
}

function findMainUnit(id) {
  for (const chapter of curriculum) {
    const unit = (chapter.allUnits || chapter.units || []).find((item) => item.id === id);
    if (unit) return unit;
  }
  return null;
}

function getUnit(id = currentUnitId) {
  const explicitLookup = arguments.length > 0;
  const mainUnit = findMainUnit(id);
  if (mainUnit) return mainUnit;
  if (explicitLookup) return null;
  return getChapter()?.units?.[0] || null;
}

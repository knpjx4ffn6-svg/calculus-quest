const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const presentation = require("../admin/presentation");

assert.equal(typeof presentation.publicCourseText, "function");
assert.equal(typeof presentation.feedbackContentHtml, "function");
assert.equal(typeof presentation.sceneTypeLabel, "function");
assert.equal(typeof presentation.knowledgeSceneLabel, "function");
assert.equal(typeof presentation.questionDisplayLabel, "function");
assert.equal(typeof presentation.questionInteractionLabel, "function");
assert.equal(typeof presentation.questionTypeLabel, "function");
assert.equal(typeof presentation.compareTableValues, "function");
assert.equal(typeof presentation.coachActionLabel, "function");
assert.equal(typeof presentation.plannerReasonsText, "function");

assert.equal(
  presentation.publicCourseText("V14-C1 GH-01-K01 输入、输出和函数规则"),
  "输入、输出和函数规则"
);
assert.equal(
  presentation.publicCourseText("GH-01 知识点：输入、输出和函数规则"),
  "知识点：输入、输出和函数规则"
);
assert.equal(presentation.publicCourseText("V14-C1", "未命名章节"), "未命名章节");
assert.equal(presentation.publicCourseText("V14-C1-post", "结业后测"), "结业后测");
assert.equal(presentation.publicCourseText("V14-X1 EXT-01-K01 微分方程", ""), "微分方程");
assert.equal(presentation.sceneTypeLabel("slide"), "讲解页");
assert.equal(presentation.sceneTypeLabel("simulation"), "动手调一调");
assert.equal(presentation.sceneTypeLabel("game"), "找错并改正");
assert.equal(
  presentation.knowledgeSceneLabel("GH-01-K01 输入、输出和函数规则", "game"),
  "输入、输出和函数规则 · 找错并改正"
);
assert.equal(
  presentation.knowledgeSceneLabel("输入、输出和函数规则", ""),
  "输入、输出和函数规则 · 历史记录未包含场景"
);
assert.equal(presentation.questionDisplayLabel("GH-01-PRE-Q3", "pre"), "前测第 3 题");
assert.equal(
  presentation.questionInteractionLabel({
    questionId: "GH-01-pre-q1",
    phase: "pre",
    order: 1,
    moduleTitle: "函数、坐标与图像读法入门",
    questionText: "输入 2 后，函数机器会输出什么？"
  }),
  "函数、坐标与图像读法入门 · 前测第 1 题「输入 2 后，函数机器会输出什么？」"
);
assert.doesNotMatch(
  presentation.questionInteractionLabel({
    questionId: "GH-01-pre-q1",
    phase: "pre",
    order: 1,
    moduleTitle: "GH-01 函数、坐标与图像读法入门"
  }),
  /GH-01/
);
assert.equal(presentation.questionTypeLabel("short_answer"), "简答题");
assert.equal(presentation.riskLevelLabel("high"), "高风险");
assert.equal(presentation.coachActionLabel("alternate_scene"), "换一种表征重学");
assert.equal(presentation.coachActionLabel("select_knowledge"), "自主勾选知识点");
assert.equal(presentation.coachActionLabel("review_knowledge"), "回看知识点");
assert.equal(presentation.coachActionLabel("unskip_knowledge"), "补学已跳过内容");
assert.equal(presentation.coachActionLabel("review_and_unskip_knowledge"), "回看并补学知识点");
assert.equal(presentation.coachActionLabel("unknown_internal_action"), "其他学习选择");
assert.equal(
  presentation.plannerReasonsText("same_concept_cluster;different_representation"),
  "属于同一知识簇、采用不同表征"
);
assert.equal(presentation.qaStatusLabel("pass"), "通过");
assert.ok(presentation.compareTableValues("10", "2", "asc") > 0);
assert.ok(presentation.compareTableValues("80%", "60%", "desc") < 0);
assert.ok(presentation.compareTableValues("2分 5秒", "45秒", "asc") > 0);
assert.ok(presentation.compareTableValues("2026-07-16 10:00", "2026-07-15 10:00", "desc") < 0);
assert.ok(presentation.compareTableValues("暂无", "1", "asc") > 0);

const shortContent = presentation.feedbackContentHtml("PPT乱码问题", (value) => value);
assert.equal(shortContent, '<p class="feedback-body">PPT乱码问题</p>');
assert.equal((shortContent.match(/PPT乱码问题/g) || []).length, 1);

const longText = "这是一条需要完整展示的较长反馈。".repeat(20);
const longContent = presentation.feedbackContentHtml(longText, (value) => value);
assert.equal((longContent.match(/这是一条需要完整展示的较长反馈。/g) || []).length, 20);
assert.doesNotMatch(longContent, /<summary>/);

const adminSource = fs.readFileSync(path.join(__dirname, "..", "admin", "admin.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(__dirname, "..", "admin.html"), "utf8");
assert.doesNotMatch(adminSource, /<td>\$\{d\.nickname\}<\/td>/);
assert.doesNotMatch(adminSource, /<td[^>]*>\$\{users\[i\]\}<\/td>/);
assert.doesNotMatch(adminSource, /<th>\$\{ch\}<\/th>/);
[
  "quiz_submission",
  "quiz_resource_link_open",
  "quiz_resource_review_returned",
  "quiz_resource_review_abandoned",
  "short_answer_regrade_requested",
  "short_answer_regrade_succeeded",
  "short_answer_regrade_failed",
  "quiz_review_ready",
  "courseware_pre_check_submitted",
  "courseware_formative_check_submitted",
  "courseware_exit_ticket_submitted",
  "courseware_confidence_submitted",
  "courseware_reflection_submitted",
  "knowledge_proactive_agent_decided",
  "knowledge_proactive_agent_silent",
  "knowledge_proactive_suggestion_shown",
  "knowledge_proactive_suggestion_accepted",
  "knowledge_proactive_suggestion_dismissed",
  "knowledge_quiz_review_continue",
  "knowledge_quiz_review_next",
  "knowledge_quiz_review_stopped",
  "knowledge_quiz_review_completed"
].forEach((eventType) => {
  assert.match(adminSource, new RegExp(`\\b${eventType}:\\s*["']`), `${eventType} must have a Chinese admin label`);
  if (eventType.startsWith("courseware_")) {
    assert.match(adminSource, /type\.startsWith\("courseware_"\)/, `${eventType} must use the courseware behavior summary`);
  } else {
    assert.match(adminSource, new RegExp(`type === ["']${eventType}["']|includes\\([^\\n]*["']${eventType}["']`), `${eventType} must have an admin behavior summary`);
  }
});
assert.match(adminHtml, /id="proactive-funnel-metrics"/);
assert.match(adminHtml, /id="export-phase-csv"/);
assert.match(adminHtml, /id="export-paths-csv"/);
assert.match(adminHtml, /id="export-engagement-csv"/);
assert.match(adminHtml, /id="export-courseware-checks-csv"/);
assert.match(adminHtml, /id="preview-regrade-btn"/);
assert.match(adminHtml, /id="run-regrade-btn"/);
assert.match(adminHtml, /id="select-all-regrade"/);
assert.match(adminHtml, /全选全部候选/);
assert.match(adminHtml, /id="export-regrade-audits-csv"/);
assert.match(adminHtml, /id="table-regrade-candidates"/);
assert.match(adminHtml, /admin\/admin\.js\?v=20260814-admin-regrade-v4/);
assert.doesNotMatch(adminHtml, /id="table-phase-comparison"/);
assert.match(adminSource, /function phaseCsvRows/);
assert.match(adminSource, /function pathCsvRows/);
assert.match(adminSource, /function engagementCsvRows/);
assert.match(adminSource, /function renderProactiveFunnel/);
assert.match(adminSource, /interactionDashboard\?\.proactiveFunnel/);
assert.match(adminSource, /function loadRegradeCandidates/);
assert.match(adminSource, /function runSelectedRegrade/);
assert.match(adminSource, /function refreshRegradeAffectedViews/);
assert.match(adminSource, /function chunkedRegradeIds/);
assert.match(adminSource, /await loadUserDetail\(openUserDetailId, \{ scroll: false, signal \}\)/);
assert.match(adminSource, /function regradeAuditCsvRows/);
assert.match(adminSource, /REVIEW_AND_REGRADING/);
const regradeRefreshSource = adminSource.match(
  /async function refreshRegradeAffectedViews[\s\S]*?(?=\nasync function runSelectedRegrade)/
)?.[0] || "";
assert.ok(regradeRefreshSource, "the regrade refresh function must be inspectable");
[
  "overview",
  "user-progress",
  "chapter-accuracy",
  "question-errors",
  "phase-comparison",
  "question-type-accuracy",
  "score-distribution",
  "short-answer-responses"
].forEach((endpoint) => {
  assert.match(
    regradeRefreshSource,
    new RegExp(`fetchStats\\("${endpoint}"\\)`),
    `regrade refresh must reload ${endpoint}`
  );
});
assert.match(regradeRefreshSource, /cachedChapterData\s*=\s*chapter/);
assert.match(regradeRefreshSource, /cachedPhaseData\s*=\s*phase/);
assert.match(regradeRefreshSource, /loadUserDetail\(detailUserId,\s*\{\s*scroll:\s*false\s*\}\)/);
assert.match(
  adminSource,
  /await loadRegradeCandidates\(\{\s*quiet:\s*true\s*\}\);[\s\S]*await refreshRegradeAffectedViews\(affectedUserIds\)/,
  "a successful regrade must refresh candidates before all affected learning-outcome views"
);

console.log("admin presentation tests passed");

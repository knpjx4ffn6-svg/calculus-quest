// Admin dashboard behavior, data loading, charts, and exports.
// Derive the deployment root from this script, so /admin, /admin.html and path-prefixed deployments agree.
const ADMIN_SCRIPT_URL = document.currentScript?.src ? new URL(document.currentScript.src, window.location.href) : null;
const API_BASE = ADMIN_SCRIPT_URL
  ? new URL("../", ADMIN_SCRIPT_URL).href.replace(/\/$/, "")
  : new URL(".", window.location.href).href.replace(/\/admin(?:\.html)?\/?$/, "").replace(/\/$/, "");
let adminToken = sessionStorage.getItem("cq_admin_token") || "";
let charts = {};
let allUsers = [];
let cachedChapterData = [];
let cachedPhaseData = [];
let cachedFeedbackRows = [];
let cachedFeedbackSummary = {
  total: 0,
  courseware: 0,
  users: 0,
  targets: 0,
  lastAt: "",
  byType: { learning_content: 0, courseware: 0, platform: 0, other: 0 }
};
let interactionsData = { rows: [], total: 0, limit: 100, offset: 0 };
let visibleInteractionRows = [];
let interactionPage = Number(sessionStorage.getItem("cq_interaction_page") || 0);
let interactionPageSize = Number(sessionStorage.getItem("cq_interaction_page_size") || 100);
let interactionUserId = sessionStorage.getItem("cq_interaction_user") || "";
let interactionDetailMode = sessionStorage.getItem("cq_interaction_detail") === "all" ? "all" : "meaningful";
let cachedUnitEngagementRows = [];
let cachedPathRows = [];
let cachedAgenticTraceRows = [];
let cachedRegradeCandidates = [];
let cachedUserDetail = null;
let regradeRuntime = { provider: "", model: "", liveConfigured: false };
const REGRADE_REQUEST_SIZE = 1;
const adminQuestionMeta = Object.create(null);
let unitEngagementSort = { key: sessionStorage.getItem("cq_unit_engagement_sort_key") || "seconds", dir: sessionStorage.getItem("cq_unit_engagement_sort_dir") || "desc" };
let currentRange = sessionStorage.getItem("cq_admin_range") || "";
let loadController = null;
let feedbackLoadController = null;
let refreshCooldown = false;
let refreshTimer = null;
let feedbackFilterTimer = null;

// ---- Auth ----
function checkAuth() {
  if (adminToken) {
    testToken().then(result => {
      if (result.ok) { showApp(); }
      else if (result.status === 0) {
        // Network error — keep token, show login with error
        showLogin();
        document.getElementById("login-error").classList.remove("hidden");
        document.getElementById("login-error").textContent = adminConnectionError(result);
      } else {
        adminToken = ""; sessionStorage.removeItem("cq_admin_token"); showLogin();
      }
    });
  } else { showLogin(); }
}

function showLogin() {
  document.getElementById("login-gate").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

function showApp() {
  document.getElementById("login-gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  // Initial load — no debounce, but abort any stale requests
  if (loadController) loadController.abort();
  loadController = new AbortController();
  loadAll(loadController.signal);
  window.CQAnnouncementAdmin?.load();
}

async function testToken() {
  try {
    const r = await fetch(`${API_BASE}/api/admin/stats/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    return { ok: r.ok, status: r.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || "网络请求失败" };
  }
}

function adminConnectionError(result = {}) {
  const detail = result.error ? `（${result.error}）` : "";
  return `无法连接管理接口 ${API_BASE}/api/admin/stats/overview${detail}`;
}

document.getElementById("login-btn").addEventListener("click", async () => {
  const token = document.getElementById("admin-token-input").value.trim();
  if (!token) return;
  adminToken = token;
  const result = await testToken();
  if (result.ok) {
    sessionStorage.setItem("cq_admin_token", token);
    showApp();
  } else if (result.status === 0) {
    // Network error — keep token, show server-down message
    adminToken = ""; // clear to avoid retrying
    document.getElementById("login-error").classList.remove("hidden");
    document.getElementById("login-error").textContent = adminConnectionError(result);
  } else {
    adminToken = "";
    document.getElementById("login-error").classList.remove("hidden");
    document.getElementById("login-error").textContent = "Token 无效，请重试。";
  }
});

document.getElementById("admin-token-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});

document.getElementById("logout-btn").addEventListener("click", () => {
  adminToken = "";
  sessionStorage.removeItem("cq_admin_token");
  showLogin();
});

// ---- API helpers ----
async function fetchStats(endpoint, params = "", signal) {
  let url = `${API_BASE}/api/admin/stats/${endpoint}`;
  const parts = [];
  if (currentRange) {
    parts.push("range=" + currentRange);
  } else {
    const start = document.getElementById("date-start")?.value || "";
    const end = document.getElementById("date-end")?.value || "";
    if (start) parts.push("start_date=" + encodeURIComponent(start));
    if (end) parts.push("end_date=" + encodeURIComponent(end));
  }
  if (params) parts.push(params);
  if (parts.length) url += "?" + parts.join("&");
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal
  });
  if (!r.ok) throw new Error(`API error: ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.message);
  return j.data;
}

async function adminApi(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.message || `API error: ${response.status}`);
    error.code = payload.code || "";
    error.status = response.status;
    error.runtime = payload.runtime || null;
    throw error;
  }
  return payload.data;
}

function normalizePageData(data, fallbackLimit = 500) {
  return AdminCsv.normalizePageData(data, fallbackLimit);
}

function courseLabelById(value = "") {
  const id = String(value || "").trim();
  if (!id) return "";
  const unitKey = Object.keys(adminUnitLabels).find((key) => key.toLowerCase() === id.toLowerCase());
  if (unitKey) return adminUnitLabels[unitKey];
  const chapterKey = Object.keys(adminChapterLabels).find((key) => key.toLowerCase() === id.toLowerCase());
  return chapterKey ? adminChapterLabels[chapterKey] : "";
}

function publicCourseText(value = "", fallback = "") {
  return courseLabelById(value)
    || AdminPresentation.publicCourseText(value, courseLabelById(fallback) || fallback);
}

let courseDisplayIndexPromise = null;

function registerCourseDisplayIndex(route = {}) {
  const chapters = Array.isArray(route.chapters) ? route.chapters : [];
  if (!chapters.length) return;
  (route.interactionTypes || []).forEach((type) => {
    const id = type.id === "diagram" ? "mindMap" : type.id;
    if (id) adminSceneTypeLabels[id] = AdminPresentation.sceneTypeLabel(id);
  });
  adminChapterOrder = chapters.map((chapter) => chapter.id);
  chapters.forEach((chapter) => {
    adminChapterLabels[chapter.id] = chapter.title || "未命名章节";
    adminUnitLabels[`${chapter.id}-pre`] = `${chapter.title || "本章"} · 知识前测`;
    adminUnitLabels[`${chapter.id}-formative`] = `${chapter.title || "本章"} · 形成测验`;
    adminUnitLabels[`${chapter.id}-post`] = `${chapter.title || "本章"} · 结业后测`;
    (chapter.modules || []).forEach((module) => {
      const moduleTitle = module.title || chapter.title || "本节";
      adminUnitLabels[module.id] = moduleTitle;
      adminUnitLabels[`${module.id}-pre`] = `${moduleTitle} · 前测`;
      adminUnitLabels[`${module.id}-formative`] = `${moduleTitle} · 形成性测验`;
      adminUnitLabels[`${module.id}-review`] = `${moduleTitle} · 全课整理`;
      adminUnitLabels[`${module.id}-post`] = `${moduleTitle} · 后测`;
      (module.knowledgePoints || []).forEach((knowledgePoint) => {
        adminUnitLabels[knowledgePoint.id] = knowledgePoint.name || `${moduleTitle} · 知识点`;
        adminKnowledgePointIds.add(knowledgePoint.id);
      });
    });
    [
      ["preQuiz", "pre"],
      ["formativeQuiz", "formative"],
      ["postQuiz", "post"]
    ].forEach(([flowKey, phase]) => {
      const questions = chapter.flow?.[flowKey]?.questions || [];
      questions.forEach((question, index) => {
        const id = String(question.id || "").trim();
        if (!id) return;
        adminQuestionMeta[id.toLowerCase()] = {
          questionId: id,
          phase,
          order: Number(question.selectionOrder || index + 1),
          moduleId: question.moduleId || "",
          moduleTitle: question.moduleTitle || adminUnitLabels[question.moduleId] || "",
          questionText: question.question || question.prompt || question.title || question.text || "",
          knowledgePointIds: Array.isArray(question.knowledgePointIds) ? question.knowledgePointIds : []
        };
      });
    });
  });
}

async function loadCourseDisplayIndex(signal) {
  if (!courseDisplayIndexPromise) {
    courseDisplayIndexPromise = fetch(`${API_BASE}/api/course/multi-scene-learning-route`, { signal })
      .then((response) => response.ok ? response.json() : null)
      .then((route) => registerCourseDisplayIndex(route || {}))
      .catch((error) => {
        if (error.name === "AbortError") throw error;
      });
  }
  return courseDisplayIndexPromise;
}

// ---- Chart helpers ----
function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function destroyAllCharts() {
  Object.keys(charts).forEach(k => destroyChart(k));
}

function setChartState(canvasId, hasData, message, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return false;
  const wrap = canvas.parentElement;
  const itemCount = Math.max(0, Number(options.itemCount || 0));
  const minHeight = Math.max(120, Number(options.minHeight || 220));
  const maxHeight = Math.max(minHeight, Number(options.maxHeight || 520));
  const perItem = Math.max(0, Number(options.perItem || 0));
  const preferredHeight = perItem && itemCount
    ? Math.min(maxHeight, Math.max(minHeight, itemCount * perItem + 72))
    : minHeight;

  wrap.querySelector(".chart-empty-state")?.remove();
  wrap.classList.toggle("is-empty", !hasData);
  wrap.style.setProperty("--chart-height", `${hasData ? preferredHeight : 112}px`);
  canvas.hidden = !hasData;
  if (!hasData) {
    wrap.insertAdjacentHTML(
      "beforeend",
      `<p class="chart-empty-state">${esc(message || "当前筛选范围内暂无可展示数据。")}</p>`
    );
  }
  return Boolean(hasData);
}

function tableCellValue(row, index) {
  const cell = row.cells[index];
  if (!cell) return "";
  return cell.dataset.sortValue || cell.textContent || "";
}

function tableRowIsEmptyState(row) {
  return row.cells.length === 1 && Number(row.cells[0].colSpan || 1) > 1;
}

function syncTableDensity(table) {
  if (!table) return;
  const wrap = table.closest(".table-wrap");
  if (!wrap) return;
  const rows = Array.from(table.tBodies || []).flatMap((body) => Array.from(body.rows));
  const dataRows = rows.filter((row) => !tableRowIsEmptyState(row));
  wrap.classList.toggle("is-empty", dataRows.length === 0);
  wrap.classList.toggle("is-scrollable", dataRows.length > 10);
  wrap.classList.toggle("is-compact", dataRows.length > 0 && dataRows.length <= 4);
}

function applyTableSort(table, columnIndex, direction) {
  const tbody = table?.tBodies?.[0];
  if (!tbody) return;
  const rows = Array.from(tbody.rows).map((row, originalIndex) => ({ row, originalIndex }));
  rows.sort((left, right) => {
    const leftEmpty = tableRowIsEmptyState(left.row);
    const rightEmpty = tableRowIsEmptyState(right.row);
    if (leftEmpty && rightEmpty) return left.originalIndex - right.originalIndex;
    if (leftEmpty) return 1;
    if (rightEmpty) return -1;
    const compared = AdminPresentation.compareTableValues(
      tableCellValue(left.row, columnIndex),
      tableCellValue(right.row, columnIndex),
      direction
    );
    return compared || left.originalIndex - right.originalIndex;
  });
  const fragment = document.createDocumentFragment();
  rows.forEach(({ row }) => fragment.appendChild(row));
  tbody.appendChild(fragment);

  table.dataset.sortColumn = String(columnIndex);
  table.dataset.sortDirection = direction;
  table.querySelectorAll("thead th.table-sortable").forEach((header) => {
    const active = Number(header.dataset.tableSortIndex) === columnIndex;
    header.classList.toggle("sorted-asc", active && direction === "asc");
    header.classList.toggle("sorted-desc", active && direction === "desc");
    header.setAttribute("aria-sort", active ? (direction === "asc" ? "ascending" : "descending") : "none");
  });
  syncTableDensity(table);
}

function prepareSortableTables(root = document) {
  const tables = root.matches?.("table")
    ? [root]
    : Array.from(root.querySelectorAll?.("table") || []);
  tables.forEach((table) => {
    const customSort = table.querySelector("thead th[data-sort]");
    table.querySelectorAll("thead th").forEach((header, index) => {
      const label = header.textContent.trim();
      const disabled = customSort
        || header.dataset.sortDisabled === "true"
        || label === "操作";
      if (disabled) return;
      header.classList.add("table-sortable");
      header.dataset.tableSortIndex = String(index);
      header.tabIndex = 0;
      header.setAttribute("role", "button");
      header.setAttribute("aria-sort", "none");
      header.title = `${label}：点击排序`;
    });
    const columnIndex = Number(table.dataset.sortColumn);
    if (Number.isInteger(columnIndex) && columnIndex >= 0) {
      applyTableSort(table, columnIndex, table.dataset.sortDirection || "asc");
    } else {
      syncTableDensity(table);
    }
  });
}

function resetInteractionPage() {
  interactionPage = 0;
  sessionStorage.setItem("cq_interaction_page", String(interactionPage));
}

function interactionQueryParams() {
  const limit = Math.max(1, Math.min(Number(interactionPageSize || 100), 1000));
  const offset = Math.max(0, interactionPage) * limit;
  const parts = [
    "limit=" + encodeURIComponent(limit),
    "offset=" + encodeURIComponent(offset)
  ];
  if (interactionUserId) parts.push("userId=" + encodeURIComponent(interactionUserId));
  parts.push("detail=" + encodeURIComponent(interactionDetailMode));
  return parts.join("&");
}

// ---- Load all data ----
async function loadAll(signal) {
  document.getElementById("load-error").classList.add("hidden");
  try {
    const openUserDetailId = cachedUserDetail?.user?.id || "";
    await loadCourseDisplayIndex(signal);
    const [overview, daily, userProg, chapter, questions, phase, qType, scoreDist, hourly, shortAnswers, feedbackDashboard, interactions, interactionDashboard, agenticTrace] = await Promise.all([
      fetchStats("overview", "", signal),
      fetchStats("daily-activity", "", signal),
      fetchStats("user-progress", "", signal),
      fetchStats("chapter-accuracy", "", signal),
      fetchStats("question-errors", "", signal),
      fetchStats("phase-comparison", "", signal),
      fetchStats("question-type-accuracy", "", signal),
      fetchStats("score-distribution", "", signal),
      fetchStats("hourly-activity", "", signal),
      fetchStats("short-answer-responses", "", signal),
      fetchStats("feedback", feedbackFilterQueryParams(), signal),
      fetchStats("interactions", interactionQueryParams(), signal),
      fetchStats("interaction-dashboard", interactionQueryParams(), signal),
      fetchStats("agentic-decision-trace", interactionUserId ? "userId=" + encodeURIComponent(interactionUserId) : "", signal)
    ]);
    allUsers = userProg;
    cachedChapterData = chapter;
    cachedPhaseData = phase;
    interactionsData = interactions;
    const interactionSummary = interactionDashboard?.summary || null;
    const proactiveFunnel = interactionDashboard?.proactiveFunnel || null;
    const actionCoverage = interactionDashboard?.actionCoverage || null;
    const pathRule = interactionDashboard?.pathRule || { minSeconds: 10 };
    const unitEngagement = interactionDashboard?.unitEngagement || [];
    const pathAnalysis = interactionDashboard?.pathAnalysis || [];
    cachedPathRows = safeRows(pathAnalysis);

    try { renderMetrics(overview, phase); } catch (e) { console.warn("Metrics:", e); }
    try { renderDailyChart(daily); } catch (e) { console.warn("Daily chart:", e); }
    try { renderUserRankChart(userProg); } catch (e) { console.warn("User rank:", e); }
    try { renderChapterDistChart(chapter); } catch (e) { console.warn("Chapter dist chart:", e); }
    try { renderHeatmap(chapter); } catch (e) { console.warn("Heatmap:", e); }
    try { renderChapterSummary(chapter, phase); } catch (e) { console.warn("Chapter summary:", e); }
    try { renderQuestionErrors(questions); } catch (e) { console.warn("Question errors:", e); }
    try { renderQuestionTypeChart(qType); } catch (e) { console.warn("Question type chart:", e); }
    try { renderPrePostChart(phase); } catch (e) { console.warn("Pre/post chart:", e); }
    try { renderScoreDistChart(scoreDist); } catch (e) { console.warn("Score dist chart:", e); }
    try { renderLearningGainChart(phase); } catch (e) { console.warn("Learning gain chart:", e); }
    try { renderPhaseCompactTable(phase); } catch (e) { console.warn("Phase table:", e); }
    try { renderUserTable(userProg); } catch (e) { console.warn("User table:", e); }
    try { renderFeedbackDashboard(feedbackDashboard); } catch (e) { console.warn("Feedback:", e); }
    try { renderActivityTab(hourly); } catch (e) { console.warn("Activity tab:", e); }
    try { renderShortAnswers(shortAnswers); } catch (e) { console.warn("Short answers:", e); }
    loadRegradeCandidates({ quiet: true }).catch((e) => console.warn("Regrade candidates:", e));
    try { renderInteractionUserOptions(userProg); } catch (e) { console.warn("Interaction users:", e); }
    try { renderInteractionSummary(interactionSummary); } catch (e) { console.warn("Interaction summary:", e); }
    try { renderProactiveFunnel(proactiveFunnel); } catch (e) { console.warn("Proactive funnel:", e); }
    try { renderActionCoverage(actionCoverage); } catch (e) { console.warn("Action coverage:", e); }
    try { renderUnitEngagement(unitEngagement); } catch (e) { console.warn("Unit engagement:", e); }
    try { renderPathAnalysis(pathAnalysis, pathRule); } catch (e) { console.warn("Path analysis:", e); }
    try { renderAgenticTrace(agenticTrace); } catch (e) { console.warn("Agentic trace:", e); }
    try { renderInteractions(interactions); } catch (e) { console.warn("Interactions:", e); }
    prepareSortableTables();
    if (openUserDetailId) {
      try {
        await loadUserDetail(openUserDetailId, { scroll: false, signal });
      } catch (error) {
        if (error.name === "AbortError") throw error;
        console.warn("User detail refresh:", error);
      }
    }

    document.getElementById("status-dot").className = "dot on";
    document.getElementById("status-text").textContent = "已连接";
    document.getElementById("last-refresh").textContent = new Date().toLocaleTimeString("zh-CN");
  } catch (e) {
    if (e.name === "AbortError") return; // silently ignore aborted requests
    document.getElementById("status-dot").className = "dot off";
    document.getElementById("status-text").textContent = "加载失败";
    document.getElementById("load-error").classList.remove("hidden");
    document.getElementById("load-error").textContent = "数据加载失败: " + e.message;
  }
}

async function loadUsers() {
  allUsers = await fetchStats("user-progress");
  renderUserTable(allUsers);
}

// ---- Metrics ----
function renderMetrics(o, phase) {
  const gainEntries = (phase || []).filter(d => d.post_count > 0 && d.pre_count > 0);
  const avgGain = gainEntries.length > 0
    ? (gainEntries.reduce((s, d) => s + ((d.post_accuracy || 0) - (d.pre_accuracy || 0)), 0) / gainEntries.length).toFixed(1)
    : "-";
  const improvedCount = gainEntries.filter(d => (d.post_accuracy || 0) > (d.pre_accuracy || 0)).length;

  const rangeLabel = currentRange || "all";
  const rangeNames = { today: "今天", yesterday: "昨天", "24h": "近24小时", "14d": "近14天", "30d": "近30天", month: "本月" };
  const dateDesc = rangeNames[rangeLabel] || (currentRange ? "所选范围" : "全部历史");

  document.getElementById("overview-metrics").innerHTML = `
    <div class="metric-card highlight">
      <div class="label">总用户数</div><div class="value">${o.totalUsers}</div>
      <div class="sub">已注册学习者</div>
    </div>
    <div class="metric-card">
      <div class="label">测验提交总数</div><div class="value">${o.totalQuizResults}</div>
      <div class="sub">${dateDesc}</div>
    </div>
    <div class="metric-card">
      <div class="label">${currentRange ? "区间活跃" : "今日活跃"}</div><div class="value">${currentRange ? o.activeInRange : o.activeToday}</div>
      <div class="sub">${currentRange ? dateDesc : "当日有活动记录"}</div>
    </div>
    <div class="metric-card">
      <div class="label">总体正确率</div><div class="value">${o.avgAccuracy}%</div>
      <div class="sub">${dateDesc} · 已评分题目</div>
    </div>
    <div class="metric-card good">
      <div class="label">平均学习增益</div><div class="value small">${avgGain === "-" ? "-" : (Number(avgGain) >= 0 ? "+" : "") + avgGain + "%"}</div>
      <div class="sub">${gainEntries.length} 组前/后测对比, ${improvedCount} 组进步</div>
    </div>
    <div class="metric-card warn">
      <div class="label">关键学习行为</div><div class="value">${o.meaningfulInteractions ?? o.totalEvents}</div>
      <div class="sub">${dateDesc} · 原始交互 ${o.rawInteractionEvents ?? o.totalEvents} 条</div>
    </div>
  `;
  renderResearchCoverage(o);
}

function renderResearchCoverage(data = {}) {
  const node = document.getElementById("research-coverage");
  if (!node) return;
  const totalUsers = Math.max(0, Number(data.totalUsers || 0));
  const coverage = [
    ["有测验数据", data.usersWithQuiz, "学习结果"],
    ["有交互数据", data.usersWithInteractions, "过程行为"],
    ["有前后测配对", data.pairedPrePostUsers, "学习增益"],
    ["提交过反馈", data.usersWithFeedback, "主观体验"]
  ];
  node.innerHTML = `
    <div class="research-coverage-heading">
      <div>
        <span>研究数据覆盖</span>
        <strong>${data.activeDays || 0} 个活跃日期</strong>
      </div>
      <p>${data.feedbackCount || 0} 条反馈 · ${data.agentDecisionCount || 0} 次智能教练决策</p>
    </div>
    <div class="research-coverage-grid">
      ${coverage.map(([label, value, note]) => {
        const count = Number(value || 0);
        const percent = totalUsers ? Math.round((count / totalUsers) * 100) : 0;
        return `<div class="coverage-item">
          <div><span>${label}</span><strong>${count}/${totalUsers}</strong></div>
          <div class="coverage-bar" aria-label="${label} ${percent}%"><span style="width:${percent}%"></span></div>
          <small>${percent}% · ${note}</small>
        </div>`;
      }).join("")}
    </div>
  `;
}

// ---- Daily Activity Chart ----
function renderDailyChart(data) {
  destroyChart("daily");
  const rows = safeRows(data);
  if (!setChartState("chart-daily", rows.length > 0, "当前范围内还没有活跃或测验提交记录。", {
    itemCount: rows.length,
    minHeight: 240
  })) return;
  const ctx = document.getElementById("chart-daily").getContext("2d");
  charts.daily = new Chart(ctx, {
    type: "line",
    data: {
      labels: rows.map(d => d.date),
      datasets: [
        { label: "活跃用户", data: rows.map(d => d.active_users), borderColor: "#0b8f8a", backgroundColor: "rgba(11,143,138,0.1)", fill: true, tension: 0.3, pointRadius: 3, pointHoverRadius: 5 },
        { label: "测验提交", data: rows.map(d => d.quiz_submissions), borderColor: "#d9972a", backgroundColor: "rgba(217,151,42,0.1)", fill: true, tension: 0.3, pointRadius: 3, pointHoverRadius: 5, yAxisID: "y1" }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { position: "bottom" } },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "活跃用户数" }, grid: { color: "#f0ece4" } },
        y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: "测验提交数" } }
      }
    }
  });
}

// ---- User Rank Chart ----
function renderUserRankChart(data) {
  destroyChart("userRank");
  const sorted = safeRows(data).filter((row) => Number(row.quiz_count || 0) > 0)
    .sort((a, b) => b.quiz_count - a.quiz_count)
    .slice(0, 20);
  if (!setChartState("chart-user-rank", sorted.length > 0, "当前范围内还没有用户提交测验。", {
    itemCount: sorted.length,
    minHeight: 190,
    maxHeight: 520,
    perItem: 25
  })) return;
  const ctx = document.getElementById("chart-user-rank").getContext("2d");
  charts.userRank = new Chart(ctx, {
    type: "bar",
    data: {
      labels: sorted.map(d => d.nickname),
      datasets: [
        { label: "测验数量", data: sorted.map(d => d.quiz_count), backgroundColor: "#0b8f8a", borderRadius: 4 },
        { label: "正确率 %", data: sorted.map(d => d.avg_accuracy), backgroundColor: "#d9972a", borderRadius: 4, yAxisID: "y1" }
      ]
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } },
      scales: {
        y: { ticks: { font: { size: 11 } }, grid: { display: false } },
        y1: { position: "top", beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: "正确率 %" } }
      }
    }
  });
}

// ---- Chapter Distribution Scatter ----
function renderChapterDistChart(data) {
  destroyChart("chapterDist");
  if (!setChartState("chart-chapter-dist", safeRows(data).length > 0, "当前范围内还没有章节正确率数据。", {
    itemCount: safeRows(data).length,
    minHeight: 250
  })) return;
  const chapters = [...new Set(data.map(d => d.chapter_label))];
  const palette = ["#0b8f8a","#d9972a","#cf6048","#4c7847","#3f6fa4","#8b5cf6","#ec4899","#64748b"];
  const datasets = chapters.map((ch, i) => {
    const pts = data.filter(d => d.chapter_label === ch);
    return {
      label: ch,
      data: pts.map(d => ({ x: d.nickname, y: d.accuracy })),
      backgroundColor: palette[i % palette.length],
      pointRadius: 6, pointHoverRadius: 9
    };
  });
  const ctx = document.getElementById("chart-chapter-dist").getContext("2d");
  charts.chapterDist = new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.x} - ${ctx.raw.y}%` } }
      },
      scales: {
        x: { type: "category", title: { display: true, text: "用户" }, ticks: { maxRotation: 45, font: { size: 9 } } },
        y: { beginAtZero: true, max: 105, title: { display: true, text: "正确率 %" }, ticks: { callback: v => v + "%" } }
      }
    }
  });
}

// ---- Heatmap ----
function renderHeatmap(data) {
  const container = document.getElementById("heatmap-container");
  if (!data || !data.length) {
    container.innerHTML = '<p class="inline-empty-state">当前范围内还没有可生成热图的章节答题数据。</p>';
    return;
  }
  const users = [...new Set(data.map(d => d.nickname))];
  const chapters = [...new Set(data.map(d => d.chapter_label))];
  // Sort chapters by ID
  chapters.sort((a, b) => a.localeCompare(b));
  const matrix = [];
  for (const u of users) {
    const row = [];
    for (const ch of chapters) {
      const r = data.find(d => d.nickname === u && d.chapter_label === ch);
      row.push(r ? r.accuracy : null);
    }
    matrix.push(row);
  }

  let html = '<div class="heatmap-table"><table><thead><tr><th>用户</th>';
  for (const ch of chapters) html += `<th>${esc(ch)}</th>`;
  html += '</tr></thead><tbody>';
  for (let i = 0; i < users.length; i++) {
    html += `<tr><td style="font-weight:600;white-space:nowrap;">${esc(users[i])}</td>`;
    for (let j = 0; j < chapters.length; j++) {
      const v = matrix[i][j];
      if (v === null) {
        html += '<td style="color:#ccc;text-align:center;background:#fafaf9;">-</td>';
        continue;
      }
      // Color gradient: red (low) -> yellow (mid) -> green (high)
      const ratio = v / 100;
      const r = Math.round(ratio < 0.5 ? 220 : 220 - (ratio - 0.5) * 2 * 180);
      const g = Math.round(ratio < 0.5 ? 80 + ratio * 2 * 140 : 220 - (ratio - 0.5) * 2 * 60);
      const b = 70;
      html += `<td style="background:rgb(${r},${g},${b});text-align:center;font-weight:600;font-size:0.82rem;color:${v > 60 ? '#fff' : '#333'};">${v}%</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// ---- Chapter Summary Table ----
function renderChapterSummary(chapterData, phaseData) {
  const chapters = [...new Set(chapterData.map(d => d.chapter_label))];
  chapters.sort();
  const tbody = document.getElementById("table-chapter-summary").querySelector("tbody");
  if (!chapters.length) {
    tbody.innerHTML = "<tr><td colspan='6'>当前范围内还没有章节测验数据。</td></tr>";
    return;
  }

  // Build chapter stats
  const stats = chapters.map(ch => {
    const records = chapterData.filter(d => d.chapter_label === ch);
    const users = new Set(records.map(d => d.user_id)).size;
    const total = records.reduce((s, d) => s + d.total, 0);
    const avgAcc = records.length > 0 ? (records.reduce((s, d) => s + d.accuracy, 0) / records.length).toFixed(1) : "-";

    // Calculate learning gain for this chapter
    const phaseEntries = (phaseData || []).filter(d => d.chapter_label === ch && d.pre_count > 0 && d.post_count > 0);
    const gain = phaseEntries.length > 0
      ? (phaseEntries.reduce((s, d) => s + ((d.post_accuracy || 0) - (d.pre_accuracy || 0)), 0) / phaseEntries.length).toFixed(1)
      : "-";
    const gainStr = gain === "-" ? "-" : (Number(gain) >= 0 ? "+" + gain + "%" : gain + "%");

    return { chapter: ch, total, users, avgAcc, gain, gainStr };
  });

  tbody.innerHTML = stats.map(s => `<tr>
    <td style="font-weight:600;">${esc(s.chapter)}</td>
    <td>${s.total}</td><td>${s.users}</td>
    <td><span class="badge ${s.avgAcc === '-' ? '' : Number(s.avgAcc) >= 80 ? 'badge-green' : Number(s.avgAcc) >= 60 ? 'badge-amber' : 'badge-red'}">${s.avgAcc === '-' ? '-' : s.avgAcc + '%'}</span></td>
    <td>-</td>
    <td><span class="badge ${s.gain === '-' ? '' : Number(s.gain) > 0 ? 'badge-green' : Number(s.gain) < 0 ? 'badge-red' : 'badge-amber'}">${s.gainStr}</span></td>
  </tr>`).join("");
}

// ---- Question Errors ----
function renderQuestionErrors(data) {
  destroyChart("questionErrors");
  const rows = safeRows(data);
  const top = rows.slice(0, 30);
  if (setChartState("chart-question-errors", top.length > 0, "当前范围内还没有题目作答记录。", {
    itemCount: top.length,
    minHeight: 220,
    maxHeight: 680,
    perItem: 24
  })) {
    const ctx = document.getElementById("chart-question-errors").getContext("2d");
    charts.questionErrors = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map(d => `${AdminPresentation.questionDisplayLabel(d.question_id, d.phase)}（${moduleName(d.unit_id, d.unit_label || "")}）`),
      datasets: [{
        label: "错误率 %", data: top.map(d => d.error_rate),
        backgroundColor: top.map(d => d.error_rate > 60 ? "#cf6048" : d.error_rate > 30 ? "#d9972a" : "#4c7847"),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, max: 100, ticks: { callback: v => v + "%" } } }
    }
    });
  }

  const table = document.getElementById("table-question-errors");
  table.innerHTML = `<thead><tr><th>题目</th><th>单元</th><th>章节</th><th>题型</th><th>尝试次数</th><th>错误率</th><th>平均得分/满分</th></tr></thead>
    <tbody>${rows.length ? rows.map(d => `<tr>
      <td style="font-weight:600;">${esc(AdminPresentation.questionDisplayLabel(d.question_id, d.phase))}</td>
      <td>${esc(moduleName(d.unit_id, d.unit_label || ""))}</td>
      <td>${esc(publicCourseText(d.chapter_label || chapterName(d.chapter_id), "未命名章节"))}</td>
      <td>${esc(AdminPresentation.questionTypeLabel(d.question_type))}</td>
      <td>${d.attempts}</td>
      <td><span class="badge ${d.error_rate > 60 ? 'badge-red' : d.error_rate > 30 ? 'badge-amber' : 'badge-green'}">${d.error_rate}%</span></td>
      <td>${d.avg_score} / ${d.avg_max}</td>
    </tr>`).join("") : "<tr><td colspan='7'>当前范围内还没有题目作答记录。</td></tr>"}</tbody>`;
}

// ---- Question Type Chart (Polar Area) ----
function renderQuestionTypeChart(data) {
  destroyChart("questionType");
  if (!setChartState("chart-question-type", safeRows(data).length > 0, "当前范围内还没有题型统计。", {
    itemCount: safeRows(data).length,
    minHeight: 230
  })) return;
  const ctx = document.getElementById("chart-question-type").getContext("2d");
  const palette = ["#0b8f8a","#d9972a","#cf6048","#4c7847","#3f6fa4","#8b5cf6","#ec4899"];
  charts.questionType = new Chart(ctx, {
    type: "polarArea",
    data: {
      labels: data.map(d => AdminPresentation.questionTypeLabel(d.question_type)),
      datasets: [{
        data: data.map(d => d.accuracy),
        backgroundColor: data.map((_, i) => palette[i % palette.length] + "88"),
        borderColor: data.map((_, i) => palette[i % palette.length]),
        borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: 正确率 ${ctx.raw}% (n=${data[ctx.dataIndex].total})` } }
      },
      scales: { r: { beginAtZero: true, max: 100, ticks: { callback: v => v + "%", stepSize: 20 } } }
    }
  });
}

// ---- Pre/Post Comparison Chart (Dumbbell-style using scatter + line) ----
function renderPrePostChart(data) {
  destroyChart("prePost");
  // Filter to only entries that have both pre and post
  const entries = safeRows(data).filter(d => d.pre_count > 0 && d.post_count > 0);
  if (!setChartState("chart-pre-post", entries.length > 0, "当前范围内还没有同时完成前测和后测的数据。", {
    itemCount: entries.length,
    minHeight: 220,
    maxHeight: 680,
    perItem: 26
  })) return;

  const labels = entries.map(d => `${d.nickname} / ${d.chapter_label}`);
  const ctx = document.getElementById("chart-pre-post").getContext("2d");

  charts.prePost = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "前测正确率", data: entries.map(d => d.pre_accuracy), backgroundColor: "#cf604888", borderColor: "#cf6048", borderWidth: 1, borderRadius: 2 },
        { label: "形成性测验正确率", data: entries.map(d => d.formative_count > 0 ? d.formative_accuracy : null), backgroundColor: "#d9972a88", borderColor: "#d9972a", borderWidth: 1, borderRadius: 2 },
        { label: "后测正确率", data: entries.map(d => d.post_accuracy), backgroundColor: "#4c784788", borderColor: "#4c7847", borderWidth: 1, borderRadius: 2 }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}%` } }
      },
      scales: {
        y: { ticks: { font: { size: 10 } }, grid: { display: false } },
        x: { beginAtZero: true, max: 105, title: { display: true, text: "正确率 %" }, ticks: { callback: v => v + "%" } }
      }
    }
  });
}

// ---- Score Distribution Histogram ----
function renderScoreDistChart(data) {
  destroyChart("scoreDist");
  const rows = safeRows(data);
  const hasScores = rows.some((row) => Number(row.count || 0) > 0);
  if (!setChartState("chart-score-dist", hasScores, "当前范围内还没有可统计的测验得分。", {
    itemCount: rows.length,
    minHeight: 230
  })) return;
  const buckets = ["0-19%", "20-39%", "40-59%", "60-79%", "80-99%", "满分 (100%)"];
  const map = {};
  rows.forEach(d => { map[d.bucket] = d.count; });

  const ctx = document.getElementById("chart-score-dist").getContext("2d");
  charts.scoreDist = new Chart(ctx, {
    type: "bar",
    data: {
      labels: buckets,
      datasets: [{
        label: "提交数量",
        data: buckets.map(b => map[b] || 0),
        backgroundColor: buckets.map(b => b === "满分 (100%)" ? "#4c7847" : b === "80-99%" ? "#8bc34a" : b === "60-79%" ? "#d9972a" : b === "40-59%" ? "#ff9800" : b === "20-39%" ? "#f44336" : "#cf6048"),
        borderRadius: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "提交次数" }, ticks: { stepSize: 1 } },
        x: { title: { display: true, text: "得分率区间" } }
      }
    }
  });
}

// ---- Learning Gain Chart ----
function renderLearningGainChart(data) {
  destroyChart("learningGain");
  const entries = safeRows(data).filter(d => d.pre_count > 0 && d.post_count > 0);
  if (!setChartState("chart-learning-gain", entries.length > 0, "当前范围内还没有可计算的学习增益。", {
    itemCount: entries.length,
    minHeight: 220,
    maxHeight: 680,
    perItem: 26
  })) return;

  const sorted = [...entries].sort((a, b) => {
    const gainA = (a.post_accuracy || 0) - (a.pre_accuracy || 0);
    const gainB = (b.post_accuracy || 0) - (b.pre_accuracy || 0);
    return gainA - gainB;
  });

  const ctx = document.getElementById("chart-learning-gain").getContext("2d");
  charts.learningGain = new Chart(ctx, {
    type: "bar",
    data: {
      labels: sorted.map(d => `${d.nickname} / ${d.chapter_label}`),
      datasets: [{
        label: "学习增益 (后测 - 前测)",
        data: sorted.map(d => ((d.post_accuracy || 0) - (d.pre_accuracy || 0)).toFixed(1)),
        backgroundColor: sorted.map(d => {
          const gain = (d.post_accuracy || 0) - (d.pre_accuracy || 0);
          return gain > 0 ? "#4c7847" : gain < 0 ? "#cf6048" : "#d9972a";
        }),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `学习增益: ${Number(ctx.raw) >= 0 ? '+' : ''}${ctx.raw}%` } }
      },
      scales: {
        y: { ticks: { font: { size: 10 } }, grid: { display: false } },
        x: { title: { display: true, text: "正确率变化 (%)" }, ticks: { callback: v => (v >= 0 ? '+' : '') + v + "%" } }
      }
    }
  });
}

// ---- Phase Compact Table ----
function renderPhaseCompactTable(data) {
  const tbody = document.getElementById("table-phase-compact").querySelector("tbody");
  if (!data || data.length === 0) {
    tbody.innerHTML = "<tr><td colspan='6'>尚无三阶段测验数据。</td></tr>";
    return;
  }
  const entries = data.filter(d => d.pre_count > 0 || d.formative_count > 0 || d.post_count > 0);
  if (!entries.length) {
    tbody.innerHTML = "<tr><td colspan='6'>当前范围内还没有前测、形成性或后测提交。</td></tr>";
    return;
  }
  tbody.innerHTML = entries.map(d => {
    const diff = (d.post_count > 0 && d.pre_count > 0) ? ((d.post_accuracy || 0) - (d.pre_accuracy || 0)).toFixed(1) : null;
    const diffStr = diff === null ? "-" : (Number(diff) >= 0 ? "+" + diff + "%" : diff + "%");
    const badgeCls = diff === null ? "" : Number(diff) > 0 ? "badge-green" : Number(diff) < 0 ? "badge-red" : "badge-amber";
    const phaseCell = (phase) => {
      const count = Number(d[`${phase}_count`] || 0);
      if (!count) return "—";
      return `${d[`${phase}_accuracy`] ?? "-"}%<br><span class="muted">${d[`${phase}_submissions`] || 0} 次提交 · ${count} 题 · ${d[`${phase}_score`] || 0}/${d[`${phase}_max_score`] || 0} 分</span>`;
    };
    return `<tr>
      <td>${esc(d.nickname || "")}</td><td>${esc(publicCourseText(d.chapter_label, "未命名章节"))}</td>
      <td>${phaseCell("pre")}</td>
      <td>${phaseCell("formative")}</td>
      <td>${phaseCell("post")}</td>
      <td><span class="badge ${badgeCls}">${diffStr}</span></td>
    </tr>`;
  }).join("");
  syncTableDensity(document.getElementById("table-phase-compact"));
}

// ---- User Table ----
function renderUserTable(users) {
  const table = document.getElementById("table-users");
  document.getElementById("user-total-count").textContent = `共 ${users.length} 位用户`;
  table.innerHTML = `<thead><tr><th>昵称</th><th>最后活跃</th><th>活跃天数</th><th>行为记录</th><th>测验提交</th><th>覆盖单元</th><th>正确率</th><th>反馈</th><th>智能教练决策</th><th>操作</th></tr></thead>
    <tbody>${users.length ? users.map(u => `<tr>
      <td style="font-weight:600;">${esc(u.nickname || "未命名")}</td>
      <td>${esc(shortDateTime(u.last_seen_at))}</td>
      <td>${u.active_days || 0}</td>
      <td>${u.event_count || 0}</td>
      <td>${u.quiz_count || 0}</td>
      <td>${u.units_attempted || 0}</td>
      <td><span class="badge ${(u.avg_accuracy||0) >= 80 ? 'badge-green' : (u.avg_accuracy||0) >= 50 ? 'badge-amber' : 'badge-red'}">${u.avg_accuracy || 0}%</span></td>
      <td>${u.feedback_count || 0}</td>
      <td>${u.agent_decision_count || 0}</td>
      <td><button class="btn btn-sm btn-primary view-user-btn" data-user-id="${esc(u.user_id || "")}">详情</button></td>
    </tr>`).join("") : "<tr><td colspan='10'>当前筛选范围内没有匹配用户。</td></tr>"}</tbody>`;

  table.querySelectorAll(".view-user-btn").forEach(btn => {
    btn.addEventListener("click", () => loadUserDetail(btn.dataset.userId));
  });
  prepareSortableTables(table);
}

// ---- User Detail ----
function quizPhaseLabel(phase = "") {
  return ({
    pre: "前测",
    formative: "形成性测验",
    post: "后测"
  })[String(phase || "").trim()] || publicCourseText(phase, "其它测验");
}

function quizResponseText(value) {
  const text = String(value ?? "");
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.join("、");
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
    return String(parsed ?? "");
  } catch {
    return text;
  }
}

function quizQuestionDetail(row = {}) {
  const questionId = String(row.question_id || "").trim();
  const indexed = adminQuestionMeta[questionId.toLowerCase()] || {};
  return {
    label: AdminPresentation.questionDisplayLabel(questionId, row.phase),
    text: String(indexed.questionText || "").trim(),
    id: questionId
  };
}

function quizResultState(row = {}) {
  if (Number(row.is_correct) === 1) {
    return { label: "正确", badgeClass: "badge-green" };
  }
  if (Number(row.is_correct) < 0 || row.status === "pending_review") {
    return { label: "待复核", badgeClass: "badge-amber" };
  }
  const failed = String(row.ai_error_type || "").trim()
    && String(row.ai_error_type || "").trim() !== "none";
  return {
    label: failed ? "评分错误" : "错误",
    badgeClass: failed ? "badge-amber" : "badge-red"
  };
}

function accuracyBadgeClass(value) {
  const number = Number(value || 0);
  return number >= 80 ? "badge-green" : number >= 50 ? "badge-amber" : "badge-red";
}

async function loadUserDetail(userId, options = {}) {
  try {
    const detail = await fetchStats(
      "user-detail",
      `userId=${encodeURIComponent(userId)}`,
      options.signal
    );
    cachedUserDetail = detail;
    const section = document.getElementById("user-detail-section");
    section.classList.remove("hidden");
    document.getElementById("user-detail-title").textContent = `${detail.user.nickname} - 总体数据`;
    const scope = detail.scope || {};
    document.getElementById("user-detail-scope").textContent = scope.allHistory
      ? `汇总该学生全部历史学习代次；当前为第 ${detail.quizOverall?.currentGeneration || 1} 代学习记录。`
      : `按顶部日期范围统计；历史代次仍保留在数据库中。${scope.startDate ? ` 起始 ${shortDateTime(scope.startDate)}` : ""}${scope.endDate ? `，截止 ${shortDateTime(scope.endDate)}` : ""}`;

    // Timeline chart
    destroyChart("userTimeline");
    const questionRows = safeRows(detail.quizQuestionRows || detail.quizResults);
    const sorted = questionRows.slice().reverse();
    const timelineCanvas = document.getElementById("chart-user-timeline");
    if (setChartState("chart-user-timeline", sorted.length > 0, "该学生在当前筛选范围内还没有测验提交。", {
      itemCount: sorted.length,
      minHeight: 220,
      maxHeight: 420
    })) {
      const point = (row) => ({
        x: row.created_at.slice(0, 16),
        y: row.score,
        questionLabel: AdminPresentation.questionDisplayLabel(row.question_id, row.phase)
      });
      const ctx = timelineCanvas.getContext("2d");
      charts.userTimeline = new Chart(ctx, {
        type: "scatter",
        data: {
          datasets: [
            { label: "正确", data: sorted.filter(d => d.is_correct === 1).map(point),
              backgroundColor: "#4c7847", pointRadius: 5, pointHoverRadius: 8 },
            { label: "部分正确", data: sorted.filter(d => d.is_correct === -1).map(point),
              backgroundColor: "#d9972a", pointRadius: 5, pointHoverRadius: 8 },
            { label: "错误", data: sorted.filter(d => d.is_correct === 0).map(point),
              backgroundColor: "#cf6048", pointRadius: 5, pointHoverRadius: 8 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: "bottom" },
            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.questionLabel} · 得分 ${ctx.raw.y}` } }
          },
          scales: {
            x: { ticks: { maxRotation: 45, font: { size: 9 } } },
            y: { beginAtZero: true, title: { display: true, text: "得分" } }
          }
        }
      });
    }

    // Activity summary
    const research = detail.researchSummary || {};
    const environment = research.latestEnvironment || {};
    const quizOverall = detail.quizOverall || {};
    const activeTimeIdleMinutes = Math.max(1, Math.round(Number(research.activeTimeIdleTimeoutMs || 300000) / 60000));
    const excludedIdleText = research.excludedIdleSeconds
      ? `已剔除 ${durationText(research.excludedIdleSeconds)} 空闲噪声`
      : `连续 ${activeTimeIdleMinutes} 分钟无操作即停止计时`;
    document.getElementById("user-research-metrics").innerHTML = `
      <div class="metric-card highlight"><div class="label">测验提交</div><div class="value">${quizOverall.submissions || 0}</div><div class="sub">${quizOverall.questions || 0} 条逐题记录 · ${quizOverall.generationCount || 0} 个学习代次</div></div>
      <div class="metric-card"><div class="label">总体正确率</div><div class="value">${quizOverall.accuracy || 0}%</div><div class="sub">${quizOverall.correct || 0} 对 · ${quizOverall.incorrect || 0} 错 · ${quizOverall.pending || 0} 待复核</div></div>
      <div class="metric-card"><div class="label">累计得分</div><div class="value small">${quizOverall.totalScore || 0} / ${quizOverall.totalMaxScore || 0}</div><div class="sub">得分率 ${quizOverall.scoreRate || 0}%</div></div>
      <div class="metric-card good"><div class="label">有效学习停留</div><div class="value small">${durationText(research.unitStudySeconds || 0)}</div><div class="sub">${research.unitsVisited || 0} 个学习模块</div></div>
      <div class="metric-card"><div class="label">活跃天数</div><div class="value">${research.activeDays || 0}</div><div class="sub">${research.sessions || 0} 个浏览器学习会话</div></div>
      <div class="metric-card"><div class="label">有效在线（估算）</div><div class="value small">${durationText(research.estimatedOnlineSeconds || 0)}</div><div class="sub">${excludedIdleText}</div></div>
      <div class="metric-card"><div class="label">课件动作</div><div class="value">${research.coursewareActions || 0}</div><div class="sub">点击、拖拽、调参、输入与滚动</div></div>
      <div class="metric-card warn"><div class="label">反馈</div><div class="value">${research.feedbackCount || 0}</div><div class="sub">学生主动提交的问题与建议</div></div>
    `;
    document.getElementById("user-activity-summary").innerHTML = `
      <dl class="research-fact-list">
        <div><dt>当前学习代次</dt><dd>第 ${quizOverall.currentGeneration || 1} 代</dd></div>
        <div><dt>覆盖章节</dt><dd>${detail.chapterSummary?.length || 0}</dd></div>
        <div><dt>总事件数</dt><dd>${detail.eventCount}</dd></div>
        <div><dt>完成 / 重复访问</dt><dd>${research.completedUnits || 0} / ${research.repeatVisits || 0}</dd></div>
        <div><dt>原始 / 有效停留</dt><dd>${durationText(research.rawUnitStudySeconds || 0)} / ${durationText(research.unitStudySeconds || 0)}</dd></div>
        <div><dt>30 分钟截尾片段</dt><dd>${research.cappedStudySegments || 0}</dd></div>
        <div><dt>原始 / 有效在线</dt><dd>${durationText(research.rawEstimatedOnlineSeconds || 0)} / ${durationText(research.estimatedOnlineSeconds || 0)}</dd></div>
        <div><dt>空闲剔除片段</dt><dd>${research.idleExcludedSegments || 0}（${activeTimeIdleMinutes} 分钟阈值）</dd></div>
        <div><dt>智能教练决策</dt><dd>${research.agentDecisionCount || 0}</dd></div>
        <div><dt>注册时间</dt><dd>${esc(shortDateTime(detail.user.created_at))}</dd></div>
        <div><dt>最近设备</dt><dd>${esc(environment.deviceType || "尚未记录")}</dd></div>
        <div><dt>视口 / 时区</dt><dd>${esc(environment.viewport ? `${environment.viewport.width}×${environment.viewport.height}` : "尚未记录")} / ${esc(environment.timezone || "尚未记录")}</dd></div>
      </dl>
    `;
    const proactive = detail.proactiveSummary || {};
    document.getElementById("user-proactive-summary").innerHTML = `
      <dl class="research-fact-list">
        <div><dt>Agent 决定介入</dt><dd>${proactive.agentDecided || 0}</dd></div>
        <div><dt>建议实际展示</dt><dd>${proactive.shown || 0}</dd></div>
        <div><dt>接受 / 关闭 / 忽略</dt><dd>${proactive.accepted || 0} / ${proactive.dismissed || 0} / ${proactive.ignored || 0}</dd></div>
        <div><dt>保持安静</dt><dd>${proactive.agentSilent || 0}</dd></div>
        <div><dt>错题复盘完成</dt><dd>${proactive.quizReviewCompleted || 0}</dd></div>
        <div><dt>接受率 / 解决率</dt><dd>${proactive.acceptanceRate || 0}% / ${proactive.resolutionRate || 0}%</dd></div>
      </dl>
    `;

    const phaseSummaryBody = document.querySelector("#table-user-phase-summary tbody");
    phaseSummaryBody.innerHTML = safeRows(detail.quizPhaseSummary).length
      ? safeRows(detail.quizPhaseSummary).map((row) => `<tr>
          <td><strong>${esc(quizPhaseLabel(row.phase))}</strong></td>
          <td>${row.submissions || 0}</td>
          <td>${row.questions || 0}</td>
          <td>${row.correct || 0}</td>
          <td>${row.incorrect || 0}</td>
          <td>${row.pending || 0}</td>
          <td><span class="badge ${accuracyBadgeClass(row.accuracy)}">${row.accuracy || 0}%</span></td>
          <td>${row.total_score || 0} / ${row.total_max_score || 0}</td>
          <td>${row.score_rate || 0}%</td>
          <td class="nowrap">${esc(shortDateTime(row.last_at))}</td>
        </tr>`).join("")
      : "<tr><td colspan='10'>该学生当前没有三阶段测验数据。</td></tr>";

    const chapterPhaseBody = document.querySelector("#table-user-chapter-phase tbody");
    chapterPhaseBody.innerHTML = safeRows(detail.chapterPhaseSummary).length
      ? safeRows(detail.chapterPhaseSummary).map((row) => `<tr>
          <td>${esc(publicCourseText(row.chapter_label || chapterName(row.chapter_id), "未命名章节"))}</td>
          <td>${esc(quizPhaseLabel(row.phase))}</td>
          <td>${row.submissions || 0}</td>
          <td>${row.questions || 0}</td>
          <td>${row.correct || 0} / ${row.incorrect || 0} / ${row.pending || 0}</td>
          <td><span class="badge ${accuracyBadgeClass(row.accuracy)}">${row.accuracy || 0}%</span></td>
          <td>${row.total_score || 0} / ${row.total_max_score || 0}</td>
          <td>${row.score_rate || 0}%</td>
          <td class="nowrap">${esc(shortDateTime(row.last_at))}</td>
        </tr>`).join("")
      : "<tr><td colspan='9'>该学生当前没有章节三阶段数据。</td></tr>";

    const quizDetailBody = document.querySelector("#table-user-quiz-details tbody");
    quizDetailBody.innerHTML = questionRows.length
      ? questionRows.map((row) => {
          const state = quizResultState(row);
          const question = quizQuestionDetail(row);
          const aiDetail = [
            row.ai_feedback || "",
            row.ai_error_type && row.ai_error_type !== "none" ? `错误类型：${row.ai_error_type}` : ""
          ].filter(Boolean).join("；");
          return `<tr>
            <td class="nowrap">${esc(shortDateTime(row.created_at))}</td>
            <td>${row.learning_generation || 1}</td>
            <td>${esc(publicCourseText(row.chapter_label || chapterName(row.chapter_id), "未命名章节"))}</td>
            <td>${esc(quizPhaseLabel(row.phase))}</td>
            <td>${esc(moduleName(row.unit_id, row.unit_label || ""))}</td>
            <td>
              <strong>${esc(question.label)}</strong>
              ${question.text ? `<br>${esc(question.text)}` : ""}
              <br><span class="muted">${esc(question.id || "历史记录未包含题目 ID")}</span>
            </td>
            <td>${esc(AdminPresentation.questionTypeLabel(row.question_type))}</td>
            <td>${esc(quizResponseText(row.response) || "未记录")}</td>
            <td>${row.score || 0} / ${row.max_score || 0}</td>
            <td><span class="badge ${state.badgeClass}">${esc(state.label)}</span></td>
            <td>${esc(aiDetail || (row.question_type === "short_answer" ? "历史记录未包含 AI 反馈" : "—"))}</td>
          </tr>`;
        }).join("")
      : "<tr><td colspan='11'>该学生当前没有逐题作答记录。</td></tr>";
    document.getElementById("user-quiz-detail-note").textContent = detail.scope?.quizRowsTruncated
      ? `共有 ${detail.quizQuestionTotal || 0} 条逐题记录，当前显示最近 ${questionRows.length} 条；导出同样受当前接口上限约束。`
      : `共 ${detail.quizQuestionTotal || questionRows.length} 条逐题记录，包含前测、形成性测验和后测。`;

    const path = detail.effectivePath || {};
    const pathBody = document.querySelector("#table-user-effective-path tbody");
    pathBody.innerHTML = safeRows(path.steps).length
      ? safeRows(path.steps).map((step, index) => `<tr>
          <td>${index + 1}</td>
          <td class="nowrap">${esc(shortDateTime(step.at))}</td>
          <td>${esc(chapterName(step.chapter_id))}</td>
          <td>${esc(moduleName(step.unit_id, step.unit_label || ""))}</td>
          <td>${esc(step.scene_label || AdminPresentation.sceneTypeLabel(step.scene_type))}</td>
          <td>${esc(durationText(step.seconds || 0))}</td>
          <td>${esc(durationText(step.raw_seconds || step.seconds || 0))}</td>
          <td>${step.capped ? '<span class="badge badge-amber">是</span>' : "否"}</td>
        </tr>`).join("")
      : "<tr><td colspan='8'>当前范围内没有达到 10 秒阈值的有效学习路径。</td></tr>";

    const recentEventsBody = document.querySelector("#table-user-recent-events tbody");
    recentEventsBody.innerHTML = (detail.events || []).length
      ? detail.events.slice(0, 40).map((row) => `<tr>
          <td class="nowrap">${esc(shortDateTime(row.created_at))}</td>
          <td>${esc(humanInteractionSummary(row))}</td>
        </tr>`).join("")
      : "<tr><td colspan='2'>当前范围内暂无学习行为。</td></tr>";

    const userFeedbackBody = document.querySelector("#table-user-feedback tbody");
    userFeedbackBody.innerHTML = (detail.feedbackRows || []).length
      ? detail.feedbackRows.map((row) => {
          const location = row.target_scope === "courseware" ? [
            publicCourseText(row.chapter_label || chapterName(row.chapter_id), ""),
            publicCourseText(row.knowledge_point || row.unit_label, "")
          ].filter(Boolean).join(" · ") : "";
          return `<tr>
            <td class="nowrap">${esc(shortDateTime(row.created_at))}</td>
            <td>${esc(feedbackTypeLabels[row.feedback_type] || row.feedback_type)}</td>
            <td>${esc(location || "全局反馈")}</td>
            <td>${AdminPresentation.feedbackContentHtml(row.content || "", esc)}</td>
          </tr>`;
        }).join("")
      : "<tr><td colspan='4'>该学生尚未提交问题反馈。</td></tr>";

    prepareSortableTables(section);
    if (options.scroll !== false) section.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    alert("加载用户详情失败: " + e.message);
  }
}

// ---- Learning Feedback ----
const feedbackTypeLabels = {
  learning_content: "学习内容",
  courseware: "课件反馈",
  platform: "平台功能",
  other: "其他建议"
};

function feedbackFilterQueryParams() {
  const type = document.getElementById("feedback-type-filter")?.value || "";
  const scope = document.getElementById("feedback-scope-filter")?.value || "";
  const query = (document.getElementById("feedback-query-filter")?.value || "").trim();
  const parts = [];
  if (type) parts.push("type=" + encodeURIComponent(type));
  if (scope) parts.push("scope=" + encodeURIComponent(scope));
  if (query) parts.push("q=" + encodeURIComponent(query));
  return parts.join("&");
}

function visibleFeedbackRows() {
  return cachedFeedbackRows;
}

function feedbackTargetLabel(row) {
  if (row.feedback_type !== "courseware") return "全局反馈";
  if (row.target_scope !== "courseware") return "全局课件反馈";
  return publicCourseText(row.resource_title || row.unit_label, "具体课件");
}

function renderFeedbackDashboard(data = {}) {
  if (Array.isArray(data.rows)) cachedFeedbackRows = data.rows;
  if (data.summary && typeof data.summary === "object") {
    cachedFeedbackSummary = {
      total: Number(data.summary.total || 0),
      courseware: Number(data.summary.courseware || 0),
      users: Number(data.summary.users || 0),
      targets: Number(data.summary.targets || 0),
      lastAt: data.summary.lastAt || "",
      byType: {
        learning_content: Number(data.summary.byType?.learning_content || 0),
        courseware: Number(data.summary.byType?.courseware || 0),
        platform: Number(data.summary.byType?.platform || 0),
        other: Number(data.summary.byType?.other || 0)
      }
    };
  }
  const rows = visibleFeedbackRows();
  const summary = cachedFeedbackSummary;
  const metrics = document.getElementById("feedback-metrics");
  if (metrics) {
    metrics.innerHTML = `
      <div class="metric-card highlight">
        <div class="label">总反馈数</div><div class="value">${summary.total}</div>
        <div class="sub">当前日期与筛选条件</div>
      </div>
      <div class="metric-card">
        <div class="label">课件反馈数</div><div class="value">${summary.courseware}</div>
        <div class="sub">具体课件与全局课件建议</div>
      </div>
      <div class="metric-card good">
        <div class="label">反馈学生数</div><div class="value">${summary.users}</div>
        <div class="sub">提交过反馈的学生</div>
      </div>
      <div class="metric-card warn">
        <div class="label">涉及课件数</div><div class="value">${summary.targets}</div>
        <div class="sub">被明确反馈的讲解页或互动课件</div>
      </div>
    `;
  }

  const breakdown = document.getElementById("feedback-breakdown");
  if (breakdown) {
    breakdown.innerHTML = Object.entries(summary.byType || {}).map(([type, count]) => `
      <span><b>${esc(feedbackTypeLabels[type] || type)}</b><strong>${Number(count || 0)}</strong></span>
    `).join("");
  }

  const resultNote = document.getElementById("feedback-result-note");
  if (resultNote) {
    const lastAt = summary.lastAt ? `最近提交 ${shortDateTime(summary.lastAt)}。` : "";
    resultNote.textContent = (summary.total > rows.length
      ? `共 ${summary.total} 条匹配记录，当前显示最近 ${rows.length} 条；CSV 导出当前显示结果。`
      : `当前显示 ${rows.length} 条匹配记录；CSV 包含完整正文。`) + lastAt;
  }

  const tbody = document.querySelector("#table-feedback tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = "<tr><td colspan='6'>当前筛选条件下暂无问题反馈。</td></tr>";
    prepareSortableTables(document.getElementById("table-feedback"));
    return;
  }
  tbody.innerHTML = rows.map((row) => {
    const location = (row.target_scope === "courseware" ? [
      publicCourseText(row.chapter_label || chapterName(row.chapter_id), ""),
      publicCourseText(row.knowledge_point || row.unit_label, "")
    ] : [])
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .map((value) => esc(value))
      .join("<br>");
    const content = String(row.content || "");
    const targetLabel = feedbackTargetLabel(row);
    const sceneLabel = row.scene_type ? AdminPresentation.sceneTypeLabel(row.scene_type) : "";
    const sceneMeta = sceneLabel && !targetLabel.includes(sceneLabel)
      ? `<br><span class="muted">${esc(sceneLabel)}</span>`
      : "";
    return `<tr>
      <td class="nowrap">${esc(shortDateTime(row.created_at))}</td>
      <td><strong>${esc(row.nickname || "未命名")}</strong></td>
      <td><span class="badge badge-blue">${esc(feedbackTypeLabels[row.feedback_type] || row.feedback_type)}</span></td>
      <td>${esc(targetLabel)}${sceneMeta}</td>
      <td>${location || "—"}</td>
      <td class="feedback-content-cell">${AdminPresentation.feedbackContentHtml(content, esc)}</td>
    </tr>`;
  }).join("");
  prepareSortableTables(document.getElementById("table-feedback"));
}

async function loadFeedbackDashboard() {
  if (feedbackLoadController) feedbackLoadController.abort();
  feedbackLoadController = new AbortController();
  const note = document.getElementById("feedback-result-note");
  if (note) note.textContent = "正在加载反馈…";
  try {
    const data = await fetchStats("feedback", feedbackFilterQueryParams(), feedbackLoadController.signal);
    renderFeedbackDashboard(data);
  } catch (error) {
    if (error.name === "AbortError") return;
    if (note) note.textContent = "反馈加载失败，请检查连接后重试。";
  }
}

function debouncedLoadFeedbackDashboard() {
  if (feedbackFilterTimer) clearTimeout(feedbackFilterTimer);
  feedbackFilterTimer = setTimeout(() => {
    feedbackFilterTimer = null;
    loadFeedbackDashboard();
  }, 250);
}

// ---- Activity Tab ----
function renderActivityTab(hourlyData) {
  // Hourly activity
  destroyChart("hourly");
  const hourlyRows = safeRows(hourlyData);
  if (setChartState("chart-hourly", hourlyRows.length > 0, "当前范围内还没有可统计的分时段活动。", {
    itemCount: hourlyRows.length,
    minHeight: 230
  })) {
    const ctx2 = document.getElementById("chart-hourly").getContext("2d");
    // Fill missing hours with 0
    const hourlyMap = {};
    hourlyRows.forEach(d => { hourlyMap[d.hour] = d; });
    const hours = Array.from({length: 24}, (_, i) => i);
    charts.hourly = new Chart(ctx2, {
      type: "bar",
      data: {
        labels: hours.map(h => `${h}:00`),
        datasets: [
          { label: "测验提交", data: hours.map(h => hourlyMap[h]?.quiz_submissions || 0), backgroundColor: "#d9972a", borderRadius: 3 },
          { label: "其它事件", data: hours.map(h => (hourlyMap[h]?.events_count || 0) - (hourlyMap[h]?.quiz_submissions || 0)), backgroundColor: "#0b8f8a", borderRadius: 3 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          tooltip: { callbacks: { footer: ctx => `活跃用户: ${hourlyMap[ctx[0].dataIndex]?.active_users || 0}` } }
        },
        scales: {
          x: { title: { display: true, text: "小时" }, ticks: { maxRotation: 0 } },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: "事件数" } }
        }
      }
    });
  }

}

// ---- Short Answer Responses ----
function shortAnswerReviewState(row = {}) {
  const aiScore = row.ai_score == null ? null : Number(row.ai_score);
  const aiConfidence = row.ai_confidence == null ? null : Number(row.ai_confidence);
  const aiErrorType = String(row.ai_error_type || "").trim().toLowerCase();
  const aiFeedback = row.ai_feedback || "";
  const aiFailed = [
    "api_error",
    "api_timeout",
    "parse_error",
    "empty_response",
    "mock_provider",
    "manual_fallback",
    "unknown"
  ].includes(aiErrorType)
    || /解析失败|评分超时|人工评阅|人工复核|已先按 0 分计入/.test(aiFeedback);
  const lowConfidence = aiScore !== null && (aiConfidence === null || aiConfidence < 0.7);
  if (aiScore === null || lowConfidence || aiFailed) {
    return { label: "待复核", badgeClass: "badge-amber", kind: "pending" };
  }
  if (aiScore > 0) return { label: `已审核 ${aiScore} 分`, badgeClass: "badge-blue", kind: "reviewed" };
  return { label: "错误", badgeClass: "badge-red", kind: "incorrect" };
}

function renderShortAnswers(data) {
  const table = document.getElementById("table-shortanswers");
  const tbody = document.getElementById("table-shortanswers").querySelector("tbody");
  const page = normalizePageData(data, 500);
  const rows = page.rows;
  if (!rows.length) {
    tbody.innerHTML = "<tr><td colspan='8'>尚无简答题提交数据。</td></tr>";
    document.getElementById("shortanswer-summary").textContent = `共 ${page.total} 条简答题提交`;
    prepareSortableTables(table);
    return;
  }
  tbody.innerHTML = rows.map(d => {
    const status = shortAnswerReviewState(d);
    const statusBadge = `<span class="badge ${status.badgeClass}">${esc(status.label)}</span>`;
    const answer = (d.response || "").length > 200
      ? d.response.slice(0, 200) + "..."
      : (d.response || "");
    const scoreDisplay = d.max_score > 0 ? `${d.score} / ${d.max_score}` : `${d.score} (预估)`;
    return `<tr>
      <td style="font-weight:600;">${esc(d.nickname)}</td>
      <td>${esc(publicCourseText(d.chapter_label, "未命名章节"))}</td>
      <td>${esc(moduleName(d.unit_id, d.unit_label || ""))}</td>
      <td>${esc(AdminPresentation.questionDisplayLabel(d.question_id, d.phase))}</td>
      <td style="max-width:350px;word-break:break-word;font-size:0.82rem;" title="${esc(d.response || "")}">${esc(answer)}</td>
      <td>${scoreDisplay}</td>
      <td>${statusBadge}</td>
      <td style="font-size:0.78rem;white-space:nowrap;">${(d.created_at||"").slice(0,16)}</td>
    </tr>`;
 }).join("");
  // Show summary
  const statuses = rows.map(shortAnswerReviewState);
  const reviewed = statuses.filter((status) => status.kind === "reviewed").length;
  const incorrect = statuses.filter((status) => status.kind === "incorrect").length;
  const pending = statuses.filter((status) => status.kind === "pending").length;
  const loadedLabel = page.total > rows.length ? ` · 当前加载 ${rows.length} 条` : "";
  document.getElementById("shortanswer-summary").textContent =
     `共 ${page.total} 条${loadedLabel} | 已审核 ${reviewed} | 错误 ${incorrect} | 待复核 ${pending}`;
  prepareSortableTables(table);
}

function regradeFailureLabel(value = "") {
  return ({
    api_error: "接口错误",
    api_timeout: "评分超时",
    parse_error: "解析失败",
    empty_response: "空响应",
    mock_provider: "模拟模型",
    manual_fallback: "人工回退",
    pending_review: "待批改",
    missing_ai_score: "缺失评分",
    low_confidence: "低置信度",
    legacy_failure: "旧版失败",
    unknown: "未知错误"
  })[String(value || "").trim().toLowerCase()] || "待复核";
}

function selectedRegradeIds() {
  return Array.from(document.querySelectorAll("[data-regrade-id]:checked"))
    .map((input) => input.dataset.regradeId)
    .filter(Boolean);
}

function regradeCandidateCheckboxes() {
  return Array.from(document.querySelectorAll("[data-regrade-id]"));
}

function syncRegradeSelection() {
  const selected = selectedRegradeIds();
  const candidates = regradeCandidateCheckboxes();
  const selectAll = document.getElementById("select-all-regrade");
  const runButton = document.getElementById("run-regrade-btn");
  const summary = document.getElementById("regrade-selection-summary");
  const canRun = regradeRuntime.liveConfigured
    && ["openai-compatible", "innospark", "openai"].includes(regradeRuntime.provider)
    && selected.length > 0;
  if (runButton) runButton.disabled = !canRun;
  if (selectAll) {
    selectAll.disabled = candidates.length === 0;
    selectAll.checked = candidates.length > 0 && selected.length === candidates.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < candidates.length;
  }
  if (summary) {
    summary.textContent = `已选 ${selected.length} / ${candidates.length} 条`;
  }
}

function renderRegradeCandidates(data = {}) {
  cachedRegradeCandidates = safeRows(data.rows);
  regradeRuntime = data.runtime || { provider: "", model: "", liveConfigured: false };
  const statusGrid = document.getElementById("regrade-status-grid");
  const table = document.getElementById("table-regrade-candidates");
  const tbody = table?.querySelector("tbody");
  const errorText = safeRows(data.errorTypes)
    .map((item) => `${regradeFailureLabel(item.error_type)} ${item.count}`)
    .join(" · ") || "无";
  if (statusGrid) {
    statusGrid.innerHTML = [
      ["可重评记录", data.total || 0],
      ["评分提供方", regradeRuntime.provider || "未配置"],
      ["评分模型", regradeRuntime.model || "未配置"],
      ["错误分布", errorText]
    ].map(([label, value]) => (
      `<div class="regrade-status-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
    )).join("");
  }
  if (!tbody) return;
  if (!cachedRegradeCandidates.length) {
    tbody.innerHTML = "<tr><td colspan='8'>当前没有待批改或明确失败的简答题记录。</td></tr>";
    syncTableDensity(table);
    syncRegradeSelection();
    return;
  }
  tbody.innerHTML = cachedRegradeCandidates.map((row) => {
    const feedback = String(row.ai_feedback || "");
    const feedbackPreview = feedback.length > 240 ? `${feedback.slice(0, 240)}...` : feedback;
    return `<tr>
      <td><input type="checkbox" data-regrade-id="${esc(row.id)}" aria-label="选择 ${esc(row.nickname || row.user_id)} 的 ${esc(row.question_id)}" /></td>
      <td><strong>${esc(row.nickname || "")}</strong><br><span class="muted">${esc(row.user_id || "")}</span></td>
      <td>${esc(publicCourseText(row.chapter_label, chapterName(row.chapter_id)))}<br><span class="muted">${esc(moduleName(row.unit_id, row.unit_label || ""))}</span></td>
      <td>${esc(AdminPresentation.questionDisplayLabel(row.question_id, row.phase))}<br><span class="muted">${esc(row.question_id || "")}</span></td>
      <td>${esc(`${row.score || 0} / ${row.max_score || 0}`)}</td>
      <td><span class="badge badge-amber">${esc(regradeFailureLabel(row.failure_reason || row.ai_error_type))}</span></td>
      <td title="${esc(feedback)}">${esc(feedbackPreview || "无反馈")}</td>
      <td style="white-space:nowrap;">${esc(String(row.created_at || "").slice(0, 16))}</td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("[data-regrade-id]").forEach((input) => {
    input.addEventListener("change", syncRegradeSelection);
  });
  syncTableDensity(table);
  syncRegradeSelection();
}

async function loadAllRegradeCandidates() {
  const pageSize = 100;
  let offset = 0;
  let total = Infinity;
  let firstPage = null;
  const rows = [];
  while (offset < total) {
    const page = await adminApi(
      `/api/admin/grading/regrade-candidates?limit=${pageSize}&offset=${offset}`
    );
    if (!firstPage) firstPage = page;
    const pageRows = safeRows(page.rows);
    rows.push(...pageRows);
    total = Math.max(0, Number(page.total || 0));
    if (!pageRows.length) break;
    offset += pageRows.length;
  }
  return {
    ...(firstPage || {}),
    rows,
    total: Number.isFinite(total) ? total : rows.length,
    limit: rows.length,
    offset: 0
  };
}

async function loadRegradeCandidates(options = {}) {
  const previewButton = document.getElementById("preview-regrade-btn");
  const result = document.getElementById("regrade-result");
  const quiet = options.quiet === true;
  const previousText = previewButton?.textContent || "";
  if (previewButton) {
    previewButton.disabled = true;
    previewButton.textContent = "加载中...";
  }
  if (result && !quiet) {
    result.className = "regrade-result";
    result.textContent = "";
  }
  try {
    const data = await loadAllRegradeCandidates();
    renderRegradeCandidates(data);
    if (result && !quiet && !regradeRuntime.liveConfigured) {
      result.className = "regrade-result is-error";
      result.textContent = "服务器尚未配置真实评分模型；可以预览候选，但不能执行重评。";
    }
  } catch (error) {
    if (result && !quiet) {
      result.className = "regrade-result is-error";
      result.textContent = `候选加载失败：${error.message}`;
    }
    if (quiet) throw error;
  } finally {
    if (previewButton) {
      previewButton.disabled = false;
      previewButton.textContent = previousText || "刷新候选";
    }
  }
}

function chunkedRegradeIds(ids = [], size = REGRADE_REQUEST_SIZE) {
  const chunkSize = Math.max(1, Number(size || REGRADE_REQUEST_SIZE));
  const chunks = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }
  return chunks;
}

async function refreshRegradeAffectedViews(affectedUserIds = []) {
  const [overview, userProg, chapter, questions, phase, qType, scoreDist, shortAnswers] = await Promise.all([
    fetchStats("overview"),
    fetchStats("user-progress"),
    fetchStats("chapter-accuracy"),
    fetchStats("question-errors"),
    fetchStats("phase-comparison"),
    fetchStats("question-type-accuracy"),
    fetchStats("score-distribution"),
    fetchStats("short-answer-responses")
  ]);
  allUsers = userProg;
  cachedChapterData = chapter;
  cachedPhaseData = phase;
  renderMetrics(overview, phase);
  renderUserRankChart(userProg);
  renderUserTable(userProg);
  renderChapterDistChart(chapter);
  renderHeatmap(chapter);
  renderChapterSummary(chapter, phase);
  renderQuestionErrors(questions);
  renderQuestionTypeChart(qType);
  renderPrePostChart(phase);
  renderScoreDistChart(scoreDist);
  renderLearningGainChart(phase);
  renderPhaseCompactTable(phase);
  renderShortAnswers(shortAnswers);
  prepareSortableTables();

  const detailUserId = cachedUserDetail?.user?.id;
  if (detailUserId && affectedUserIds.includes(detailUserId)) {
    await loadUserDetail(detailUserId, { scroll: false });
  }
}

async function runSelectedRegrade() {
  const ids = selectedRegradeIds();
  const button = document.getElementById("run-regrade-btn");
  const result = document.getElementById("regrade-result");
  if (!ids.length) {
    syncRegradeSelection();
    return;
  }
  const candidateById = new Map(cachedRegradeCandidates.map((row) => [row.id, row]));
  const affectedUserIds = Array.from(new Set(
    ids.map((id) => candidateById.get(id)?.user_id).filter(Boolean)
  ));
  const confirmed = window.confirm(
    `确认使用服务器当前配置的 ${regradeRuntime.model || "评分模型"} 重新评分选中的 ${ids.length} 条记录？\n\n系统会自动逐条处理并保存。成功才会更新原评分；失败只写审计记录。`
  );
  if (!confirmed) return;
  const previousText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "评分中...";
  }
  if (result) {
    result.className = "regrade-result";
    result.textContent = `正在逐条评分：0 / ${ids.length}。请勿关闭当前页面。`;
  }
  const totals = { applied: 0, failed: 0, skipped: 0, processed: 0 };
  let runError = null;
  let refreshError = null;
  try {
    for (const batchIds of chunkedRegradeIds(ids)) {
      const data = await adminApi("/api/admin/grading/regrade", {
        method: "POST",
        body: JSON.stringify({
          ids: batchIds,
          limit: batchIds.length,
          confirm: "REVIEW_AND_REGRADING"
        })
      });
      totals.applied += Number(data.applied || 0);
      totals.failed += Number(data.failed || 0);
      totals.skipped += Number(data.skipped || 0);
      totals.processed += batchIds.length;
      if (result) {
        result.textContent = `正在逐条评分：${totals.processed} / ${ids.length}。成功 ${totals.applied}，失败 ${totals.failed}，跳过 ${totals.skipped}。`;
      }
    }
  } catch (error) {
    runError = error;
  } finally {
    try {
      await loadRegradeCandidates({ quiet: true });
      await refreshRegradeAffectedViews(affectedUserIds);
    } catch (error) {
      refreshError = error;
    }
    if (result) {
      if (runError) {
        result.className = "regrade-result is-error";
        result.textContent = `处理到 ${totals.processed} / ${ids.length} 条后停止：${runError.message}。已成功的评分不会回滚${refreshError ? `；汇总刷新失败：${refreshError.message}` : "，汇总已同步更新"}。`;
      } else if (refreshError) {
        result.className = "regrade-result is-error";
        result.textContent = `重评完成：成功 ${totals.applied} 条，失败 ${totals.failed} 条，跳过 ${totals.skipped} 条；汇总刷新失败：${refreshError.message}。请点击页面顶部“刷新”。`;
      } else {
        result.className = totals.failed ? "regrade-result is-error" : "regrade-result is-success";
        result.textContent = `重评完成：成功 ${totals.applied} 条，失败 ${totals.failed} 条，跳过 ${totals.skipped} 条。学习效果与用户汇总已同步更新。`;
      }
    }
    if (button) button.textContent = previousText || "重新评分选中记录";
    syncRegradeSelection();
  }
}

function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return { raw: String(value) }; }
}

function viewName(value) {
  const key = String(value || "").replace(/-view$/, "");
  return ({
    home: "首页",
    learn: "学习页",
    library: "资源页",
    progress: "学习记录页",
    feedback: "问题反馈页",
    evaluation: "评测页",
    agent: "Agent 编排页"
  })[key] || (key ? key : "未知页面");
}

let adminChapterOrder = ["A1", "A2a", "A2b", "A3", "A4", "C1", "D1", "D2"];
const adminChapterLabels = {
  A1: "变化与斜率",
  A2a: "向量：方向与长度",
  A2b: "内积与投影",
  A3: "空间变换与局部线性",
  A4: "曲面与正定性",
  C1: "导数、梯度与驻点",
  D1: "梯度下降",
  D2: "凸性与全局最优"
};
const adminUnitOverrides = {
  1: "前测",
  2: "概念地图",
  6: "公式桥",
  8: "形成性测验",
  12: "复盘页",
  15: "后测"
};
const adminKnowledgePointIds = new Set();
const adminSceneTypeLabels = {
  simulation: "动手调一调",
  game: "找错并改正",
  mindMap: "知识怎么连",
  visualization3d: "换个角度看"
};
const adminUnitLabels = {
  "A1-scene-1": "前测",
  "A1-scene-2": "概念地图",
  "A1-scene-3": "实验：函数机器",
  "A1-scene-4": "实验：坐标点",
  "A1-scene-5": "实验：三类函数图像",
  "A1-scene-6": "公式桥",
  "A1-scene-7": "实验：两点斜率",
  "A1-scene-8": "形成性测验",
  "A1-scene-9": "实验：变化快慢排序",
  "A1-scene-10": "实验：局部斜率",
  "A1-scene-11": "实验：函数表示关系网",
  "A1-scene-12": "复盘页",
  "A1-scene-13": "实验：斜率正负判定",
  "A1-scene-14": "实验：微积分变化地图",
  "A1-scene-15": "后测",
  "A2a-scene-1": "前测",
  "A2a-scene-2": "概念地图",
  "A2a-scene-3": "实验：坐标与属性",
  "A2a-scene-4": "实验：首尾相接的旅程",
  "A2a-scene-5": "实验：方向的逆转",
  "A2a-scene-6": "公式桥",
  "A2a-scene-7": "实验：两点间的向量",
  "A2a-scene-8": "形成性测验",
  "A2a-scene-9": "实验：双步策略",
  "A2a-scene-10": "实验：离目标还有多远？",
  "A2a-scene-11": "实验：向量关系图谱",
  "A2a-scene-12": "复盘页",
  "A2a-scene-13": "实验：向量拼图",
  "A2a-scene-14": "实验：优化中的“一步”",
  "A2a-scene-15": "后测",
  "A2b-scene-1": "前测",
  "A2b-scene-2": "概念地图",
  "A2b-scene-3": "实验：夹角旋转台",
  "A2b-scene-4": "实验：内积数值仪表",
  "A2b-scene-5": "实验：投影影子",
  "A2b-scene-6": "公式桥",
  "A2b-scene-7": "实验：方向贡献地图",
  "A2b-scene-8": "形成性测验",
  "A2b-scene-9": "实验：投影命中",
  "A2b-scene-10": "实验：垂直零贡献",
  "A2b-scene-11": "实验：方向导数预备",
  "A2b-scene-12": "复盘页",
  "A2b-scene-13": "实验：方向关系分类",
  "A2b-scene-14": "实验：投影分解仪",
  "A2b-scene-15": "后测",
  "A3-scene-1": "前测",
  "A3-scene-2": "概念地图",
  "A3-scene-3": "实验：基向量变换器",
  "A3-scene-4": "实验：网格形变",
  "A3-scene-5": "实验：单位圆变椭圆",
  "A3-scene-6": "公式桥",
  "A3-scene-7": "实验：点对点映射追踪",
  "A3-scene-8": "形成性测验",
  "A3-scene-9": "实验：矩阵变换反推",
  "A3-scene-10": "实验：变换流程系统全景图",
  "A3-scene-11": "实验：面积与方向观察器",
  "A3-scene-12": "复盘页",
  "A3-scene-13": "实验：网格复原大",
  "A3-scene-14": "实验：局部线性预告",
  "A3-scene-15": "后测",
  "A4-scene-1": "前测",
  "A4-scene-2": "概念地图",
  "A4-scene-3": "实验：曲线到曲面切换台",
  "A4-scene-4": "实验：等高线地形阅读器",
  "A4-scene-5": "实验：二次曲面形状库",
  "A4-scene-6": "公式桥",
  "A4-scene-7": "实验：正定方向",
  "A4-scene-8": "形成性测验",
  "A4-scene-9": "实验：发现线性",
  "A4-scene-10": "实验：多维关系全景图",
  "A4-scene-11": "实验：最快上升方向",
  "A4-scene-12": "复盘页",
  "A4-scene-13": "实验：曲面识别赛",
  "A4-scene-14": "实验：局部模型匹配拼图",
  "A4-scene-15": "后测",
  "C1-scene-1": "前测",
  "C1-scene-2": "概念地图",
  "C1-scene-3": "实验：一元极值斜率扫描",
  "C1-scene-4": "实验：梯度箭头地形图",
  "C1-scene-5": "实验：梯度计算填空板",
  "C1-scene-6": "公式桥",
  "C1-scene-7": "实验：方向导数旋转盘",
  "C1-scene-8": "形成性测验",
  "C1-scene-9": "实验：最快方向",
  "C1-scene-10": "实验：驻点形状切换器",
  "C1-scene-11": "实验：概念关系系统图",
  "C1-scene-12": "复盘页",
  "C1-scene-13": "实验：驻点判断",
  "C1-scene-14": "实验：梯度为零反例",
  "C1-scene-15": "后测",
  "D1-scene-1": "前测",
  "D1-scene-2": "概念地图",
  "D1-scene-3": "实验：优化三要素",
  "D1-scene-4": "实验：目标函数地形探索",
  "D1-scene-5": "实验：一元最低点候选器",
  "D1-scene-6": "公式桥",
  "D1-scene-7": "实验：负梯度下一步模拟",
  "D1-scene-8": "形成性测验",
  "D1-scene-9": "实验：步长稳定性",
  "D1-scene-10": "实验：迭代表格",
  "D1-scene-11": "实验：梯度下降流程图",
  "D1-scene-12": "复盘页",
  "D1-scene-13": "实验：下山路线策略",
  "D1-scene-14": "实验：收敛与停止条件",
  "D1-scene-15": "后测",
  "D2-scene-1": "前测",
  "D2-scene-2": "概念地图",
  "D2-scene-3": "实验：凸碗形地形探索",
  "D2-scene-4": "实验：非凸多山谷探索",
  "D2-scene-5": "实验：凸/非凸曲线切换器",
  "D2-scene-6": "公式桥",
  "D2-scene-7": "实验：概念关系全景图",
  "D2-scene-8": "形成性测验",
  "D2-scene-9": "实验：起点选择策略",
  "D2-scene-10": "实验：等高线低谷识别器",
  "D2-scene-11": "实验：路径盆地",
  "D2-scene-12": "复盘页",
  "D2-scene-13": "实验：凸性判断拼图",
  "D2-scene-14": "实验：可靠优化对比",
  "D2-scene-15": "后测",
};

function chapterName(idOrLabel = "") {
  const value = String(idOrLabel || "");
  const unitMatch = value.match(/^([A-Za-z0-9]+)-(?:scene-\d+|chapter)$/);
  if (unitMatch) return chapterName(unitMatch[1]);
  const routeMatch = value.match(/^(V\d+-[CX]\d+)/i);
  const routeId = routeMatch
    ? Object.keys(adminChapterLabels).find((key) => key.toLowerCase() === routeMatch[1].toLowerCase())
    : "";
  if (routeId && routeId !== value) return chapterName(routeId);
  const id = adminChapterLabels[value] ? value : Object.keys(adminChapterLabels).find((key) => value === adminChapterLabels[key]);
  if (!id) return publicCourseText(value, "未命名章节");
  const index = adminChapterOrder.indexOf(id);
  return index >= 0 ? `第${index + 1}章 ${adminChapterLabels[id]}` : adminChapterLabels[id];
}

function normalizedChapterName(row = {}) {
  return chapterName(row.chapter_id || row.chapter_label || row.unit_id || "");
}

function moduleName(unitId = "", fallback = "") {
  const id = String(unitId || "");
  if (adminUnitLabels[id]) return adminUnitLabels[id];
  const publicFallback = publicCourseText(fallback, "");
  const role = /-pre$/i.test(id)
    ? "前测"
    : /-formative$/i.test(id)
      ? "形成性测验"
      : /-post$/i.test(id)
        ? "后测"
        : /-review$/i.test(id)
          ? "全课整理"
          : "";
  if (role) {
    const routeChapterId = id.match(/^(V\d+-[CX]\d+)/i)?.[1] || "";
    const chapterLabel = routeChapterId ? adminChapterLabels[routeChapterId] || "" : "";
    return publicFallback || (chapterLabel ? `${chapterLabel} · ${role}` : role);
  }
  const match = id.match(/^([A-Za-z0-9]+)-scene-(\d+)$/);
  if (match) {
    const order = Number(match[2]);
    if (adminUnitOverrides[order]) return adminUnitOverrides[order];
  }
  if (/^[A-Za-z0-9]+-chapter$/.test(id)) return "整章";
  if (/^[A-Za-z0-9]+-scene-\d+$/.test(String(fallback || ""))) return moduleName(fallback);
  return publicFallback || unitName(id);
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function unitName(value) {
  const id = String(value || "");
  if (adminUnitLabels[id]) return adminUnitLabels[id];
  const m = id.match(/^([A-Za-z0-9]+)-scene-(\d+)$/);
  if (m) return moduleName(id, `${chapterName(m[1])} 第 ${m[2]} 个学习模块`);
  if (id.startsWith("supplement-")) return "推荐补给资源";
  return publicCourseText(id, "未知模块");
}

function sceneTypeName(value = "", fallback = "") {
  const raw = String(value || "").trim();
  const id = raw === "diagram" ? "mindMap" : raw;
  if (!id) return publicCourseText(fallback, "");
  return adminSceneTypeLabels[id]
    || AdminPresentation.sceneTypeLabel(id)
    || publicCourseText(fallback, "");
}

function isKnowledgePointUnit(unitId = "") {
  const id = String(unitId || "");
  return adminKnowledgePointIds.has(id) || /^(?:GH|EXT)-\d+-K\d+$/i.test(id);
}

function knowledgeSceneName(unitId = "", fallback = "", sceneType = "", sceneLabel = "") {
  const unit = moduleName(unitId, fallback);
  if (!isKnowledgePointUnit(unitId)) return unit;
  const scene = publicCourseText(sceneLabel, "") || (sceneType ? sceneTypeName(sceneType) : "");
  return AdminPresentation.knowledgeSceneLabel(unit, sceneType, scene);
}

function interactionSceneMeta(payload = {}, data = {}) {
  return {
    type: payload.sceneType || data.sceneType || data.selectedSceneType || "",
    label: payload.sceneLabel || data.sceneLabel || "",
    resourceTitle: payload.resourceTitle || data.resourceTitle || ""
  };
}

function interactionUnitName(payload = {}, data = {}) {
  return moduleName(
    payload.unitId || data.unitId || data.unit || "",
    payload.unitLabel || data.unitLabel || data.title || ""
  );
}

function interactionQuestionName(data = {}) {
  const questionId = String(data.questionId || data.question_id || "").trim();
  const indexed = adminQuestionMeta[questionId.toLowerCase()] || {};
  const questionIndex = Number(data.questionIndex ?? data.index);
  return AdminPresentation.questionInteractionLabel({
    questionId,
    phase: data.phase || indexed.phase || "",
    order: indexed.order || (Number.isFinite(questionIndex) ? questionIndex + 1 : null),
    moduleTitle: data.moduleTitle || indexed.moduleTitle || moduleName(data.moduleId || indexed.moduleId, ""),
    questionText: data.questionText || indexed.questionText || ""
  });
}

function interactionLearningLocation(row = {}) {
  const payload = parsePayload(row.payload);
  const data = row.type === "interaction"
    ? payload.data || {}
    : payload.data && typeof payload.data === "object"
      ? payload.data
      : payload;
  const unitId = payload.unitId || data.unitId || data.unit || "";
  const scene = interactionSceneMeta(payload, data);
  const unitLabel = knowledgeSceneName(
    unitId,
    payload.unitLabel || data.unitLabel || data.title || "",
    scene.type,
    scene.label
  );
  const chapterLabel = chapterName(
    payload.chapterId || data.chapterId || payload.chapterLabel || data.chapterLabel || ""
  );
  if (unitLabel && unitLabel !== "未知模块") {
    const plainChapter = publicCourseText(
      payload.chapterLabel || data.chapterLabel || "",
      ""
    );
    if (plainChapter && unitLabel.includes(plainChapter)) return unitLabel;
    if (chapterLabel && chapterLabel !== "未命名章节") return `${chapterLabel} · ${unitLabel}`;
    return unitLabel;
  }
  if (chapterLabel && chapterLabel !== "未命名章节") return chapterLabel;
  if (data.view || payload.view) return viewName(data.view || payload.view);
  return "平台操作";
}

function durationText(seconds) {
  const sec = Number(seconds || 0);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min} 分 ${rest} 秒` : `${min} 分钟`;
}

function shortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function interactionEventType(row) {
  return row.payload?.eventType || row.type || "unknown";
}

function interactionTypeName(type) {
  return ({
    click: "点击",
    register: "账号注册",
    login: "登录成功",
    login_success: "登录成功",
    register_success: "注册成功",
    session_start: "学习会话开始",
    session_end: "学习会话结束",
    view_change: "页面切换",
    ui_click: "页面点击",
    ui_input: "页面输入",
    ui_change: "页面改值",
    ui_keydown: "页面键盘",
    ui_wheel: "页面滚动",
    switch_view: "切换页面",
    chapter_select: "选择章节",
    select_chapter: "选择章节",
    jump_unit: "跳转模块",
    open_unit: "打开模块",
    library_filter: "筛选资源库",
    filter_library: "筛选资源库",
    time_on_unit: "模块停留",
    unit_leave: "离开模块",
    leave_unit: "离开模块",
    unit_enter: "进入模块",
    unit_open: "打开模块",
    repeat_unit_enter: "重复进入",
    unit_complete: "完成模块",
    complete_unit: "完成模块",
    review_unit: "回看模块",
    unit_review_complete: "复习完成",
    visibility: "页面可见性",
    heartbeat: "在线心跳",
    online_period: "在线时段",
    quiz_render: "测验渲染",
    knowledge_render: "知识点渲染",
    knowledge_scene_select: "选择互动场景",
    select_knowledge_scene: "选择互动场景",
    slide_render: "讲解页渲染",
    interactive_render: "实验渲染",
    interactive_ready: "实验打开",
    interactive_click: "实验点击",
    interactive_double_click: "实验双击",
    interactive_context_menu: "实验右键",
    interactive_pointer_down: "实验按下",
    interactive_pointer_up: "实验松开",
    interactive_pointer_cancel: "实验指针取消",
    canvas_pointer_down: "画布按下",
    canvas_pointer_up: "画布松开",
    interactive_drag_start: "实验拖拽开始",
    interactive_drag_move: "实验拖拽中",
    interactive_drag_end: "实验拖拽结束",
    interactive_input: "实验输入",
    interactive_change: "实验改值",
    parameter_change: "参数调整",
    parameter_commit: "参数确认",
    courseware_page_loaded: "课件语义页加载",
    courseware_pre_check_submitted: "课件入口自检提交",
    courseware_prediction_made: "课件预测提交",
    courseware_interaction_change: "课件关键状态变化",
    courseware_hint_used: "课件使用提示",
    courseware_observable_evidence_captured: "课件记录观察证据",
    courseware_short_explanation_submitted: "课件短解释提交",
    courseware_formative_check_submitted: "课件形成性自检提交",
    courseware_interaction_complete: "课件互动完成",
    courseware_challenge_result: "课件挑战结果",
    courseware_exit_ticket_submitted: "课件出口迁移提交",
    courseware_confidence_submitted: "课件信心评分提交",
    courseware_reflection_submitted: "课件反思提交",
    courseware_page_summary_shown: "课件总结展示",
    interactive_keydown: "键盘操作",
    interactive_wheel: "滚轮/滚动",
    interactive_scroll: "课件滚动",
    interactive_submit: "实验提交",
    resource_fullscreen: "课件全屏",
    fullscreen_change: "全屏状态",
    answer_select: "选择答案",
    short_answer_input: "简答输入",
    question_visible: "题目可见",
    quiz_review_shown: "显示测验复盘",
    quiz_review_ready: "错题复盘已就绪",
    quiz_submission: "记录整份测验提交",
    quiz_result: "记录单题结果",
    quiz_answer_revealed: "查看参考答案",
    quiz_resource_link_open: "从测验回看课件",
    quiz_resource_review_returned: "从课件返回测验",
    quiz_resource_review_abandoned: "离开错题回看路径",
    short_answer_regrade_requested: "请求重新批改简答题",
    short_answer_regrade_succeeded: "简答题重新批改成功",
    short_answer_regrade_failed: "简答题重新批改失败",
    quiz_submit_success: "测验提交",
    quiz_submit_blocked: "测验未完整提交",
    agentic_unlock: "智能教练解锁",
    agentic_extension_chapter_unlocked: "智能教练解锁扩展章",
    agentic_decision: "智能教练选择",
    agentic_decision_executed: "落实智能教练选择",
    knowledge_assistant_open: "打开知点",
    knowledge_assistant_close: "关闭知点",
    knowledge_proactive_agent_decided: "知点决定主动介入",
    knowledge_proactive_agent_silent: "知点决定保持安静",
    knowledge_proactive_fallback_silent: "知点降级为保持安静",
    knowledge_proactive_suggestion_shown: "显示知点主动建议",
    knowledge_proactive_suggestion_accepted: "接受知点主动建议",
    knowledge_proactive_suggestion_dismissed: "关闭知点主动建议",
    knowledge_proactive_suggestion_ignored: "隐式忽略知点主动建议",
    knowledge_proactive_budget_exhausted: "知点主动预算已用尽",
    knowledge_proactive_reply_option_selected: "选择主动提示回答起点",
    knowledge_proactive_reply_skipped: "跳过主动提示回答",
    knowledge_quiz_review_continue: "继续追问当前错题",
    knowledge_quiz_review_next: "进入下一道错题",
    knowledge_quiz_review_stopped: "停止本轮错题复盘",
    knowledge_quiz_review_completed: "完成本轮错题复盘",
    knowledge_question_asked: "向知点提问",
    knowledge_answer_received: "收到知点回答",
    knowledge_context_selected: "选择知点上下文",
    knowledge_conversation_draft_started: "开始知点对话草稿",
    knowledge_opening_draft_selected: "选择知点开场问题",
    knowledge_followup_draft_selected: "选择知点追问草稿",
    knowledge_note_saved: "保存知点笔记",
    knowledge_note_removed: "删除知点笔记",
    knowledge_launcher_moved: "移动知点入口",
    knowledge_panel_moved: "移动知点面板",
    knowledge_panel_position_reset: "重置知点面板位置",
    feedback_submit: "提交问题反馈",
    reflection_save: "保存反思",
    skip_units: "跳过模块",
    skip_chapters: "跳过章节",
    reset_progress: "重置进度",
    recommendation_toggle: "推荐面板开关",
    supplement_render: "补充资源渲染",
    supplement_open: "打开补充资源",
    narration_play_click: "播放旁白",
    narration_pause_click: "暂停旁白",
    narration_stop_click: "停止旁白",
    narration_seek_input: "拖动旁白进度",
    narration_toggle: "旁白面板开关",
    narration_segment_play: "播放旁白片段",
    narration_segment_end: "旁白片段结束",
    narration_resume: "恢复旁白",
    narration_pause: "旁白暂停",
    narration_stop: "旁白停止",
    narration_seek: "旁白定位",
    narration_complete: "旁白完成",
    play_narration: "播放旁白",
    pause_narration: "暂停旁白",
    stop_narration: "停止旁白",
    learning_fullscreen_toggle: "学习区全屏切换",
    iframe_event: "互动实验",
    interaction: "交互"
  })[type] || "其他学习行为";
}

function actionCategoryName(category) {
  return ({
    ready: "打开",
    click: "点击",
    gesture: "拖拽/指针",
    parameter: "参数",
    input: "输入/改值",
    keyboard: "键盘",
    wheel: "滚轮/滚动",
    submit: "提交",
    proactive: "主动建议",
    coach: "路径选择",
    quiz: "测验/复盘",
    assistant: "知点对话",
    note: "学习笔记",
    navigation: "学习路径",
    layout: "界面布局",
    assessment: "课件自检",
    reflection: "预测/反思",
    support: "提示支持",
    completion: "互动证据",
    other: "其它"
  })[category] || "未分类";
}

function moduleRoleName(role) {
  return ({
    core: "主线课件",
    adaptive: "MAIC-UI 自适应课件",
    experiment: "互动实验",
    knowledge_point: "知识点互动",
    pretest: "前测",
    posttest: "后测",
    formative_quiz: "形成性测验",
    concept_map: "概念地图",
    formula_bridge: "公式桥",
    instruction: "讲解页",
    relearn: "重学课件",
    extension: "拓展课件",
    quiz: "测验",
    slide: "讲解页"
  })[role] || "未标注";
}

function actionCategoryForType(type = "") {
  if (type.startsWith("courseware_")) {
    if (type === "courseware_page_loaded" || type === "courseware_page_summary_shown") return "ready";
    if (type === "courseware_hint_used") return "support";
    if (/prediction|confidence|reflection|short_explanation/.test(type)) return "reflection";
    if (/pre_check|formative_check|exit_ticket|challenge_result/.test(type)) return "assessment";
    return "completion";
  }
  if (type.startsWith("knowledge_proactive_") || type.startsWith("knowledge_quiz_review_")) return "proactive";
  if (type.startsWith("agentic_")) return "coach";
  if (type.startsWith("knowledge_note_")) return "note";
  if (type.startsWith("knowledge_")) return "assistant";
  if (
    type.startsWith("quiz_")
    || type.startsWith("short_answer_regrade_")
    || type === "answer_select"
    || type === "short_answer_input"
  ) return "quiz";
  if (
    type.includes("unit")
    || type.includes("chapter")
    || type === "skip_units"
    || type === "skip_chapters"
  ) return "navigation";
  if (type === "interactive_ready" || type === "interactive_render") return "ready";
  if (type === "interactive_submit") return "submit";
  if (type === "parameter_change" || type === "parameter_commit") return "parameter";
  if (type === "interactive_input" || type === "interactive_change") return "input";
  if (type === "interactive_keydown") return "keyboard";
  if (type === "interactive_wheel" || type === "interactive_scroll") return "wheel";
  if (type === "interactive_click" || type === "interactive_double_click" || type === "interactive_context_menu") return "click";
  if (/^(interactive_|canvas_).*(pointer|drag)/.test(type)) return "gesture";
  if (type.startsWith("interactive_") || type.startsWith("canvas_")) return "other";
  return "";
}

function compactSummaryText(value = "", limit = 36) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

function summaryTargetName(data = {}, fallback = "控件") {
  const raw = data.label || data.text || data.name || data.tag || fallback;
  return publicCourseText(compactSummaryText(raw, 36), fallback) || fallback;
}

function summaryValueText(data = {}) {
  if (data.valueSummary) return compactSummaryText(data.valueSummary, 36);
  if (data.value?.valueSummary) return compactSummaryText(data.value.valueSummary, 36);
  if (data.value?.new !== undefined) return `从「${data.value.old || ""}」到「${data.value.new}」`;
  if (data.value !== undefined && data.value !== null && data.value !== "") return `为「${compactSummaryText(detailValue(data.value), 36)}」`;
  return "";
}

function proactiveSuggestionKindName(kind = "") {
  return ({
    repeated_parameter: "连续调参观察",
    quiz_review: "错题复盘",
    quiet_dwell: "停留后的澄清"
  })[kind] || "学习时机";
}

function proactiveActionName(action = "") {
  return ({
    observe_change: "观察参数变化",
    review_mistake: "复盘错题",
    self_explain: "自我解释",
    ask_clarification: "回答澄清问题",
    stay_silent: "保持安静"
  })[action] || "下一步支持";
}

function humanInteractionSummary(row) {
  const payload = parsePayload(row.payload);
  const data = row.type === "interaction"
    ? payload.data || {}
    : payload.data && typeof payload.data === "object"
      ? payload.data
      : payload;
  const type = payload.eventType || row.type || "unknown";
  if (type.startsWith("courseware_")) {
    const score = data.score ?? data.formative_score ?? data.pre_check_score ?? data.exit_ticket_score;
    const maxScore = data.max_score;
    const scoreText = score !== undefined && score !== ""
      ? `，得分 ${score}${maxScore !== undefined && maxScore !== "" ? ` / ${maxScore}` : ""}`
      : "";
    const correctness = data.is_correct === true ? "，结果正确"
      : data.is_correct === false ? "，结果需要继续修正"
        : "";
    const target = data.question_id || data.check_id || data.challenge_id || "";
    const targetText = target ? `，项目 ${compactSummaryText(target, 48)}` : "";
    return `${interactionTypeName(type)}${targetText}${scoreText}${correctness}。`;
  }
  if (type === "register") {
    return "学生账号已创建。";
  }
  if (type === "login" || type === "login_success") {
    return "学生登录成功，开始记录本次学习行为。";
  }
  if (type === "register_success") {
    return "学生完成注册并进入学习平台。";
  }
  if (type === "session_start") {
    const environment = data.environment || {};
    const device = environment.deviceType ? `，设备：${environment.deviceType}` : "";
    return `学习会话开始${device}。`;
  }
  if (type === "session_end") {
    const idleRule = data.idleTimeoutMs ? `，连续 ${Math.max(1, Math.round(Number(data.idleTimeoutMs) / 60000))} 分钟无操作后停止计时` : "";
    return `学习会话结束，本次有效活动约 ${durationText(data.pageOpenSeconds || 0)}${idleRule}。`;
  }
  if (type === "click") {
    if (data.view) return `点击了「${data.text || viewName(data.view)}」，准备切换到${viewName(data.view)}。`;
    if (data.unit) return `点击打开${unitName(data.unit)}。`;
    if (data.chapter) return `点击切换到${chapterName(data.chapter)}。`;
    return `点击了页面上的「${data.text || data.tag || "控件"}」。`;
  }
  if (type === "ui_click") {
    if (data.view) return `点击「${data.text || viewName(data.view)}」。`;
    if (data.unit) return `点击打开${unitName(data.unit)}。`;
    if (data.chapter) return `点击切换到${chapterName(data.chapter)}。`;
    return `点击页面控件「${summaryTargetName(data)}」。`;
  }
  if (type === "ui_input" || type === "ui_change") {
    const action = type === "ui_input" ? "输入" : "修改";
    const value = summaryValueText(data);
    return `${action}页面控件「${summaryTargetName(data)}」${value ? `，${value}` : ""}。`;
  }
  if (type === "ui_keydown") {
    const key = data.key === "character" ? "字符键" : keyName(data.key || data.code || "");
    return `在页面控件「${summaryTargetName(data)}」使用 ${key} 键。`;
  }
  if (type === "ui_wheel") {
    const direction = Number(data.deltaY || 0) < 0 ? "向上滚动" : "向下滚动";
    return `在页面「${summaryTargetName(data, viewName(data.view || "learn"))}」${direction}。`;
  }
  if (type === "view_change") {
    return data.prev
      ? `页面从${viewName(data.prev)}切换到${viewName(data.view)}。`
      : `进入${viewName(data.view)}。`;
  }
  if (type === "switch_view") {
    if (data.to || data.from) return `从${viewName(data.from)}切换到${viewName(data.to)}。`;
    return `进入${viewName(data.view)}。`;
  }
  if (type === "select_chapter") {
    return `选择${chapterName(data.chapterId || data.chapterLabel)}。`;
  }
  if (type === "chapter_select") {
    return `从${chapterName(data.fromChapterId)}切换到${chapterName(data.toChapterId)}。`;
  }
  if (type === "jump_unit") {
    return `从资源列表跳转到${unitName(data.unitId)}。`;
  }
  if (type === "library_filter") {
    return `将资源库筛选为「${data.filter || "全部"}」。`;
  }
  if (type === "unit_enter" || type === "repeat_unit_enter" || type === "unit_open" || type === "open_unit") {
    const source = data.source ? `，来源：${sourceName(data.source)}` : "";
    const scene = interactionSceneMeta(payload, data);
    const target = knowledgeSceneName(
      payload.unitId || data.unitId || "",
      payload.unitLabel || data.unitLabel || "",
      scene.type,
      scene.label
    );
    return `${type === "repeat_unit_enter" ? "再次进入" : "进入"}${target}${source}。`;
  }
  if (type === "unit_complete" || type === "complete_unit" || type === "unit_review_complete") {
    return `${type === "unit_review_complete" ? "复习完成" : "完成"}${unitName(data.unitId)}。`;
  }
  if (type === "review_unit") {
    return `回看${unitName(data.unitId)}。`;
  }
  if (type === "time_on_unit") {
    const scene = interactionSceneMeta(payload, data);
    return `在${knowledgeSceneName(data.unitId || payload.unitId, data.unitLabel || payload.unitLabel || "", scene.type, scene.label)}停留学习了 ${durationText(data.seconds)}。`;
  }
  if (type === "unit_leave" || type === "leave_unit") {
    return `离开${unitName(data.unitId)}，本次停留 ${durationText(data.seconds)}。`;
  }
  if (type === "visibility") {
    return data.hidden ? "学习页面被切到后台或最小化。" : "学习页面重新回到前台。";
  }
  if (type === "heartbeat") {
    return `仍在线学习，当前停留在${viewName(data.view)}。`;
  }
  if (type === "online_period") {
    const range = data.startedAt || data.endedAt
      ? `（${shortDateTime(data.startedAt)} - ${shortDateTime(data.endedAt)}）`
      : "";
    const estimated = data.estimated ? "约 " : "";
    const effective = data.effective ? "有效 " : "";
    const merged = data.count ? `，合并 ${data.count} 条旧心跳` : "";
    const unit = data.unitId ? `，模块：${unitName(data.unitId)}` : "";
    return `${effective}在线学习 ${estimated}${durationText(data.seconds)}${range}，页面：${viewName(data.view)}${unit}${merged}。`;
  }
  if (type === "quiz_render") {
    return `打开测验「${moduleName(payload.unitId || data.unitId, payload.unitLabel || data.unitLabel || "")}」。`;
  }
  if (type === "slide_render") {
    return `打开讲解页「${moduleName(payload.unitId || data.unitId, payload.unitLabel || data.unitLabel || "")}」。`;
  }
  if (type === "knowledge_render") {
    return `打开知识点「${moduleName(payload.unitId || data.unitId, payload.unitLabel || data.unitLabel || "")}」。`;
  }
  if (type === "knowledge_scene_select" || type === "select_knowledge_scene") {
    const scene = interactionSceneMeta(payload, data);
    const target = knowledgeSceneName(
      payload.unitId || data.unitId || "",
      data.knowledgePoint || payload.unitLabel || data.unitLabel || "",
      scene.type,
      scene.label
    );
    return `选择${target}${scene.resourceTitle ? `，课件：${publicCourseText(scene.resourceTitle, "互动课件")}` : ""}。`;
  }
  if (type === "quiz_submission") {
    return `记录${unitName(data.unitId)}整份测验提交，共 ${data.questionCount || 0} 题；客观题答对 ${data.correct || 0} 题，答错 ${data.incorrect || 0} 题，待复核 ${data.pendingReview || 0} 题。`;
  }
  if (type === "quiz_result") {
    const result = data.isCorrect === true ? "答对" : data.isCorrect === false ? "答错" : "等待复核";
    return `记录「${interactionQuestionName(data)}」的单题结果：${result}。`;
  }
  if (type === "quiz_answer_revealed") {
    return `查看「${interactionQuestionName(data)}」的参考答案和解析。`;
  }
  if (type === "quiz_review_ready") {
    return `${unitName(data.unitId)}的评分已完成，错题复盘入口已就绪；答对 ${data.correct || 0} 题，答错 ${data.incorrect || 0} 题。`;
  }
  if (type === "quiz_resource_link_open") {
    return `从「${interactionQuestionName(data)}」打开${unitName(data.targetUnitId)}进行课件回看。`;
  }
  if (type === "quiz_resource_review_returned") {
    return `完成${unitName(data.fromUnitId)}回看并返回${unitName(data.targetUnitId)}。`;
  }
  if (type === "quiz_resource_review_abandoned") {
    return `回看${unitName(data.reviewedUnitId)}时转到${unitName(data.nextUnitId)}，本次返回原测验的上下文已结束。`;
  }
  if (type === "short_answer_regrade_requested") {
    return `请求重新批改「${interactionQuestionName(data)}」。`;
  }
  if (type === "short_answer_regrade_succeeded") {
    const score = data.score !== undefined ? `，新得分 ${data.score}` : "";
    return `「${interactionQuestionName(data)}」重新批改成功${score}。`;
  }
  if (type === "short_answer_regrade_failed") {
    return `「${interactionQuestionName(data)}」重新批改未完成，原因：${data.reason || "评分服务暂不可用"}。`;
  }
  if (type === "knowledge_assistant_open") {
    return "学生打开知点，准备围绕当前学习内容提问或复盘。";
  }
  if (type === "knowledge_assistant_close") {
    return "学生关闭知点面板。";
  }
  if (type === "knowledge_proactive_agent_decided") {
    return `知点根据「${proactiveSuggestionKindName(data.suggestionKind)}」信号决定主动介入，拟采用「${proactiveActionName(data.action)}」${data.fallback ? "（降级策略）" : ""}。`;
  }
  if (type === "knowledge_proactive_agent_silent") {
    return `知点检测到「${proactiveSuggestionKindName(data.suggestionKind)}」信号后决定保持安静，不打断学生。`;
  }
  if (type === "knowledge_proactive_fallback_silent") {
    return `知点因上下文暂不可用，对「${proactiveSuggestionKindName(data.suggestionKind)}」信号降级为保持安静。`;
  }
  if (type === "knowledge_proactive_suggestion_shown") {
    return `向学生显示一条关于「${proactiveSuggestionKindName(data.suggestionKind)}」的主动建议，并等待确认。`;
  }
  if (type === "knowledge_proactive_suggestion_accepted") {
    return `学生接受关于「${proactiveSuggestionKindName(data.suggestionKind)}」的主动建议，选择「${proactiveActionName(data.action)}」。`;
  }
  if (type === "knowledge_proactive_suggestion_dismissed") {
    return `学生关闭关于「${proactiveSuggestionKindName(data.suggestionKind)}」的主动建议；连续关闭 ${data.dismissStreak || 0} 次，冷却至 ${shortDateTime(data.cooldownUntil)}。`;
  }
  if (type === "knowledge_proactive_suggestion_ignored") {
    return `学生继续操作并隐式忽略关于「${proactiveSuggestionKindName(data.suggestionKind)}」的主动建议；连续忽略 ${data.dismissStreak || 0} 次。`;
  }
  if (type === "knowledge_proactive_budget_exhausted") {
    return `知点检测到「${proactiveSuggestionKindName(data.suggestionKind)}」信号，但本次主动介入预算已用尽。`;
  }
  if (type === "knowledge_proactive_reply_option_selected") {
    return `学生为「${proactiveActionName(data.action)}」选择了一个回答起点，内容只放入输入框，尚未自动发送。`;
  }
  if (type === "knowledge_proactive_reply_skipped") {
    return `学生跳过「${proactiveActionName(data.action)}」的预设回答，改为自由提问。`;
  }
  if (type === "knowledge_quiz_review_continue") {
    return `学生继续追问当前错题（第 ${Number(data.reviewIndex || 0) + 1} / ${data.reviewTotal || 0} 题）。`;
  }
  if (type === "knowledge_quiz_review_next") {
    return `学生确认进入下一道错题（第 ${Number(data.reviewIndex || 0) + 1} / ${data.reviewTotal || 0} 题）。`;
  }
  if (type === "knowledge_quiz_review_stopped") {
    return `学生主动停止本轮错题复盘，停在第 ${Number(data.reviewIndex || 0) + 1} / ${data.reviewTotal || 0} 题。`;
  }
  if (type === "knowledge_quiz_review_completed") {
    return `学生完成本轮 ${data.reviewTotal || 0} 道错题的知点复盘。`;
  }
  if (type === "knowledge_question_asked") {
    return `学生向知点提交问题，问题约 ${data.questionLength || 0} 个字符，上下文范围：${data.contextScope || "当前学习内容"}。`;
  }
  if (type === "knowledge_answer_received") {
    return `知点返回回答，约 ${data.answerLength || 0} 个字符${data.provider ? `，服务：${data.provider}` : ""}。`;
  }
  if (type === "knowledge_context_selected") {
    return `学生为知点选择了${data.contextScope === "quiz" ? "测验" : "课件"}上下文。`;
  }
  if (type === "knowledge_conversation_draft_started") {
    return "学生开始一段新的知点对话草稿，尚未发送。";
  }
  if (type === "knowledge_opening_draft_selected") {
    return `学生选择一个知点开场问题放入输入框，草稿约 ${data.questionLength || 0} 个字符。`;
  }
  if (type === "knowledge_followup_draft_selected") {
    return `学生选择「${data.assistantIntent || "继续追问"}」草稿放入输入框，尚未发送。`;
  }
  if (type === "knowledge_note_saved") {
    return `学生保存知点笔记${data.hasComment ? "并添加了批注" : ""}。`;
  }
  if (type === "knowledge_note_removed") {
    return "学生删除一条知点笔记。";
  }
  if (type === "knowledge_launcher_moved") {
    return "学生调整知点入口位置。";
  }
  if (type === "knowledge_panel_moved") {
    return "学生调整知点面板位置。";
  }
  if (type === "knowledge_panel_position_reset") {
    return "学生将知点面板恢复到默认位置。";
  }
  if (type === "interactive_render" || type === "interactive_ready") {
    const action = type === "interactive_render" ? "准备打开" : "已加载";
    return `${action}互动实验「${moduleName(payload.unitId || data.unitId, payload.unitLabel || data.unitLabel || "")}」。`;
  }
  if (type === "interactive_click" || type === "interactive_double_click" || type === "interactive_context_menu") {
    const target = summaryTargetName(data);
    const value = summaryValueText(data);
    const action = type === "interactive_double_click" ? "双击了" : type === "interactive_context_menu" ? "右键打开了" : "点击了";
    return `在「${interactionUnitName(payload, data)}」中${action}「${target}」${value ? `，${value}` : ""}。`;
  }
  if (/^(interactive_|canvas_).*(pointer|drag)/.test(type)) {
    const target = summaryTargetName(data, type.startsWith("canvas_") ? "画布" : "控件");
    const distance = data.distance ? `，移动约 ${data.distance}px` : "";
    const duration = data.durationMs ? `，持续 ${durationText(Math.max(1, Math.round(data.durationMs / 1000)))}` : "";
    const action = type.includes("drag_start")
      ? "开始拖动"
      : type.includes("drag_move")
        ? "正在拖动"
        : type.includes("drag_end")
          ? "完成拖动"
          : type.includes("cancel")
            ? "中断了一次指针操作"
            : type.includes("down")
              ? "按下"
              : "松开";
    return `在「${interactionUnitName(payload, data)}」中${action}「${target}」${distance}${duration}。`;
  }
  if (type === "parameter_change" || type === "parameter_commit") {
    const param = data.param || summaryTargetName(data, "参数");
    const value = summaryValueText(data);
    const action = type === "parameter_commit" ? "确认参数" : "调整参数";
    return `在「${interactionUnitName(payload, data)}」中${action}「${param}」${value ? `，${value}` : ""}。`;
  }
  if (type === "interactive_input" || type === "interactive_change") {
    const action = type === "interactive_input" ? "输入" : "确认修改";
    const target = summaryTargetName(data);
    const value = summaryValueText(data);
    return `在「${interactionUnitName(payload, data)}」中${action}「${target}」${value ? `，${value}` : ""}。`;
  }
  if (type === "interactive_keydown") {
    const target = summaryTargetName(data, "课件");
    const key = data.key === "character" ? "字符键" : keyName(data.key || data.code || "");
    return `在「${interactionUnitName(payload, data)}」中对「${target}」使用 ${key} 键。`;
  }
  if (type === "interactive_wheel" || type === "interactive_scroll") {
    const target = summaryTargetName(data, "课件");
    const direction = Number(data.deltaY || 0) < 0 ? "向上滚动或放大" : "向下滚动或缩小";
    const action = type === "interactive_scroll" ? "滚动查看" : direction;
    return `在「${interactionUnitName(payload, data)}」中对「${target}」${action}。`;
  }
  if (type === "interactive_submit") {
    return `在「${interactionUnitName(payload, data)}」中提交表单或答案。`;
  }
  if (type === "agentic_decision") {
    const action = AdminPresentation.coachActionLabel(data.action || data.plannerAction || "");
    const target = moduleName(data.targetId || "", data.targetLabel || "");
    return `在智能教练中选择「${action}」${target ? `，目标为「${target}」` : ""}。`;
  }
  if (type === "agentic_decision_executed") {
    const action = publicCourseText(
      data.selectedActionLabel,
      AdminPresentation.coachActionLabel(data.action || data.plannerAction || "")
    );
    const target = moduleName(
      data.targetId || data.nextUnitId || "",
      data.targetLabel || data.nextClusterLabel || ""
    );
    return `学生确认「${action || "智能教练建议"}」${target ? `，下一步进入「${target}」` : ""}。`;
  }
  if (type === "agentic_unlock") {
    return `智能教练解锁了${unitName(data.unitId)}。`;
  }
  if (type === "agentic_extension_chapter_unlocked") {
    return `智能教练从${chapterName(data.fromChapterId)}提出并解锁${chapterName(data.chapterId)}。`;
  }
  if (type === "feedback_submit") {
    const label = feedbackTypeLabels[data.feedbackType] || "问题反馈";
    const length = Number(data.contentLength || 0);
    return `提交${label}${length ? `，正文约 ${length} 个字符` : ""}。`;
  }
  if (type === "answer_select") {
    const selected = Array.isArray(data.values) ? data.values.join("、") : data.value || data.response || "";
    return `在「${interactionQuestionName(data)}」选择了${selected ? `「${selected}」` : "一个选项"}。`;
  }
  if (type === "short_answer_input") {
    return `在「${interactionQuestionName(data)}」输入了约 ${data.length || data.noteLength || 0} 个字符。`;
  }
  if (type === "question_visible") {
    return `浏览到「${interactionQuestionName(data)}」。`;
  }
  if (type === "quiz_submit_success") {
    return `提交${unitName(data.unitId)}，客观题答对 ${data.correct || 0} 题，答错 ${data.incorrect || 0} 题。`;
  }
  if (type === "quiz_submit_blocked") {
    const missing = data.missingQuestions || data.missing || [];
    const count = Array.isArray(missing) ? missing.length : data.missingCount || 0;
    return `尝试提交${unitName(data.unitId)}，还有 ${count} 道题未完成。`;
  }
  if (type === "quiz_review_shown") {
    return `查看${unitName(data.unitId)}的测验复盘。`;
  }
  if (type === "skip_units") {
    const skipped = Array.isArray(data.skippedUnitIds) ? data.skippedUnitIds.length : 0;
    const target = data.targetLabel || (data.targetId ? unitName(data.targetId) : "");
    return `根据智能教练建议跳过 ${skipped} 个已掌握模块${target ? `，下一步进入「${target}」` : ""}。`;
  }
  if (type === "skip_chapters") {
    const skipped = Array.isArray(data.skippedChapterIds) ? data.skippedChapterIds.length : 0;
    return `根据智能教练建议跳过 ${skipped} 个已掌握章节。`;
  }
  if (type === "reset_progress") {
    return `重置学习记录；重置前已完成 ${data.completedCount ?? data.completed ?? 0} 个模块，已有 ${data.quizResultCount ?? data.quizResults ?? 0} 条测验结果。`;
  }
  if (type === "reflection_save") {
    return `保存反思笔记，约 ${data.noteLength || 0} 个字符。`;
  }
  if (type === "resource_fullscreen" || type === "learning_fullscreen_toggle" || type === "fullscreen_change") {
    const entering = data.entering ?? data.active;
    return `${entering ? "进入" : "退出"}全屏学习状态。`;
  }
  if (type === "recommendation_toggle") {
    return `${data.collapsed ? "收起" : "展开"}推荐面板。`;
  }
  if (type === "supplement_render") {
    return `渲染补充资源「${moduleName(data.unitId || "", data.title || data.unitLabel || "")}」。`;
  }
  if (type === "supplement_open") {
    return `打开补充资源「${moduleName(data.unitId || "", data.title || data.unitLabel || "")}」。`;
  }
  if (type.startsWith("narration_")) {
    const label = data.segmentIndex !== undefined ? `第 ${Number(data.segmentIndex) + 1} 段` : "旁白";
    const action = {
      narration_toggle: data.collapsed ? "收起旁白面板" : "展开旁白面板",
      narration_play_click: "点击播放旁白",
      narration_pause_click: "点击暂停旁白",
      narration_stop_click: "点击停止旁白",
      narration_seek_input: "拖动旁白进度",
      narration_segment_play: `播放${label}`,
      narration_segment_end: `${label}播放结束`,
      narration_resume: "恢复旁白播放",
      narration_pause: "旁白暂停",
      narration_stop: "旁白停止",
      narration_seek: "拖动旁白进度",
      narration_complete: "完成本节旁白"
    }[type] || "操作旁白";
    return `${action}，关联模块：${unitName(data.unitId)}。`;
  }
  if (type === "iframe_event") {
    return `在互动实验里触发了${data.action || data.event || "一次操作"}。`;
  }
  if (payload.raw) return "记录到一条未分类学习行为，原始记录可在导出文件中追溯。";
  const pieces = [];
  if (data.view) pieces.push(`页面：${viewName(data.view)}`);
  if (data.unitId || data.unit) pieces.push(`模块：${unitName(data.unitId || data.unit)}`);
  if (data.text) pieces.push(`对象：「${data.text}」`);
  return pieces.length ? pieces.join("；") : `${interactionTypeName(type)}。`;
}

function interactionDetail(row) {
  const payload = parsePayload(row.payload);
  const data = payload.data || {};
  const type = payload.eventType || row.type || "unknown";
  const scene = interactionSceneMeta(payload, data);
  const unitId = payload.unitId || data.unitId || data.unit || "";
  const detail = [
    ["事件", interactionTypeName(type)],
    ["来源", sourceName(payload.source || data.source || "")],
    ["章节", publicCourseText(data.chapterLabel || payload.chapterLabel, chapterName(data.chapterId || payload.chapterId || ""))],
    ["知识点/模块", knowledgeSceneName(unitId, payload.unitLabel || data.unitLabel || data.title || "", scene.type, scene.label)],
    ["互动场景", scene.type || scene.label ? sceneTypeName(scene.type, scene.label) : ""],
    ["课件", publicCourseText(scene.resourceTitle, "")],
    ["对象", publicCourseText(data.label || data.text || data.name || data.tag || "", "")],
    ["数值", data.valueSummary || detailValue(data.value ?? payload.value)],
    ["位置", data.point ? `x=${data.point.x}, y=${data.point.y}` : ""],
    ["滚动", data.scrollTop !== undefined ? `top=${data.scrollTop}, left=${data.scrollLeft || 0}` : ""],
    ["时长", data.durationMs ? durationText(Math.max(1, Math.round(data.durationMs / 1000))) : ""],
    ["说明", humanInteractionSummary({ ...row, payload })]
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
  return detail.map(([key, value]) => `${key}：${value}`).join("；").slice(0, 800);
}

function sourceName(source = "") {
  return ({
    main: "主页面",
    iframe: "互动课件",
    quiz: "测验",
    narration: "旁白",
    heartbeat: "在线状态",
    library: "资源库",
    knowledge_assistant: "知点",
    courseware_bridge: "课件桥接"
  })[source] || (source ? "其它来源" : "未标注");
}

function detailValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "object") {
    if ("old" in value || "new" in value) return `从「${value.old ?? ""}」到「${value.new ?? ""}」`;
    return Object.entries(value)
      .slice(0, 6)
      .map(([key, item]) => `${detailKeyName(key)}=${item}`)
      .join("，");
  }
  return String(value);
}

function detailKeyName(key = "") {
  return ({
    old: "原值",
    new: "新值",
    min: "最小值",
    max: "最大值",
    x: "横坐标",
    y: "纵坐标",
    width: "宽度",
    height: "高度"
  })[key] || "字段";
}

function keyName(key = "") {
  return ({
    ArrowRight: "向右方向",
    ArrowLeft: "向左方向",
    ArrowUp: "向上方向",
    ArrowDown: "向下方向",
    Enter: "回车",
    Escape: "退出",
    Space: "空格",
    Tab: "制表",
    Backspace: "退格",
    Delete: "删除",
    Shift: "上档",
    Control: "控制",
    Alt: "换挡",
    Meta: "系统"
  })[key] || (key ? "功能" : "键盘");
}

function normalizeInteractionData(data) {
  const page = normalizePageData(data, interactionPageSize);
  return {
    ...page,
    detailMode: data?.detailMode === "all" ? "all" : interactionDetailMode
  };
}

function collapseHeartbeatRows(rows) {
  const heartbeatGapMs = 2 * 60 * 1000;
  const legacyHeartbeatSeconds = 30;
  const output = [];
  const groups = new Map();
  const flushGroup = (key) => {
    const group = groups.get(key);
    if (!group) return;
    const observedSeconds = Math.max(0, Math.round((group.lastAt - group.firstAt) / 1000));
    const seconds = Math.max(legacyHeartbeatSeconds, observedSeconds + legacyHeartbeatSeconds);
    output.push({
      ...group.lastRow,
      created_at: group.endedAt,
      payload: {
        eventType: "online_period",
        data: {
          startedAt: group.startedAt,
          endedAt: group.endedAt,
          seconds,
          view: group.view,
          count: group.count,
          estimated: true,
          source: "heartbeat"
        }
      }
    });
    groups.delete(key);
  };

  [...rows].reverse().forEach((row) => {
    const type = interactionEventType(row);
    if (type !== "heartbeat") {
      output.push(row);
      return;
    }
    const data = row.payload?.data || {};
    const at = new Date(row.created_at || "").getTime();
    if (!at) {
      output.push(row);
      return;
    }
    const key = `${row.user_id || row.nickname || ""}|${data.view || ""}`;
    const existing = groups.get(key);
    if (!existing || at - existing.lastAt > heartbeatGapMs) {
      if (existing) flushGroup(key);
      groups.set(key, {
        firstAt: at,
        lastAt: at,
        startedAt: row.created_at,
        endedAt: row.created_at,
        view: data.view || "",
        count: 1,
        lastRow: row
      });
      return;
    }
    existing.lastAt = at;
    existing.endedAt = row.created_at;
    existing.count += 1;
    existing.lastRow = row;
  });

  [...groups.keys()].forEach(flushGroup);
  return output.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function renderInteractionUserOptions(users = allUsers) {
  const select = document.getElementById("interaction-user-filter");
  if (!select) return;
  const current = interactionUserId;
  select.innerHTML = `<option value="">全部用户</option>` + users
    .map(u => `<option value="${esc(u.user_id || "")}">${esc(u.nickname || "未命名")} (${esc((u.user_id || "").slice(-6))})</option>`)
    .join("");
  select.value = current;
  document.getElementById("interaction-page-size").value = String(interactionPageSize);
  const detailSelect = document.getElementById("interaction-detail-filter");
  if (detailSelect) detailSelect.value = interactionDetailMode;
}

function updateInteractionPager(meta) {
  const status = document.getElementById("interaction-page-status");
  const prev = document.getElementById("interaction-prev-page");
  const next = document.getElementById("interaction-next-page");
  if (!status || !prev || !next) return;
  const total = Number(meta.total || 0);
  const limit = Math.max(1, Number(meta.limit || interactionPageSize));
  const offset = Math.max(0, Number(meta.offset || 0));
  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const scope = interactionDetailMode === "all" ? "原始记录" : "关键行为";
  status.textContent = total ? `${scope} · 第 ${page}/${pageCount} 页 · ${start}-${end} / ${total} 条` : `暂无${scope}`;
  prev.disabled = offset <= 0;
  next.disabled = offset + limit >= total;
}

function safeRows(data) {
  return Array.isArray(data) ? data : [];
}

function renderProactiveFunnel(data = {}) {
  const node = document.getElementById("proactive-funnel-metrics");
  if (!node) return;
  const cards = [
    ["决定介入", data.agentDecided || 0, "Agent 主动提出支持"],
    ["保持安静", data.agentSilent || 0, "主动沉默、降级或预算阻止"],
    ["建议展示", data.shown || 0, "学生实际看到"],
    ["接受", data.accepted || 0, `${data.acceptedUsers || 0} 名学生`],
    ["关闭", data.dismissed || 0, "明确选择先不用"],
    ["隐式忽略", data.ignored || 0, "继续操作触发 backoff"],
    ["复盘完成", data.quizReviewCompleted || 0, "完成一轮错题复盘"],
    ["接受率", `${data.acceptanceRate || 0}%`, `已解决建议中；解决率 ${data.resolutionRate || 0}%`]
  ];
  node.innerHTML = cards.map(([label, value, sub]) => `
    <div class="metric-card">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
      <div class="sub">${esc(sub)}</div>
    </div>
  `).join("");
}

function renderActionCoverage(data) {
  const summaryNode = document.getElementById("action-coverage-summary");
  const tbody = document.querySelector("#table-action-coverage tbody");
  if (!summaryNode || !tbody) return;
  const categories = safeRows(data?.categories);
  const types = safeRows(data?.types);
  summaryNode.innerHTML = categories.length
    ? categories.map((item) => `<span class="action-chip">${esc(actionCategoryName(item.category))}<span>${item.count || 0}</span></span>`).join("")
    : '<span class="action-chip">暂无课件动作<span>0</span></span>';
  tbody.innerHTML = types.length ? types.map((item) => `
    <tr>
      <td><span class="badge badge-blue">${esc(actionCategoryName(item.category))}</span></td>
      <td>${esc(interactionTypeName(item.event_type))}</td>
      <td>${item.count || 0}</td>
      <td>${item.users || 0}</td>
      <td>${item.units || 0}</td>
      <td style="max-width:260px;white-space:normal;">${esc(moduleName(item.sample_unit_id, item.sample_unit_label || ""))}</td>
      <td>${esc((item.last_at || "").slice(0, 16))}</td>
    </tr>
  `).join("") : "<tr><td colspan='7'>当前范围内还没有互动课件内部动作。</td></tr>";
  syncTableDensity(document.getElementById("table-action-coverage"));
}

function renderInteractionSummary(data) {
  if (!data) return;
  const typeRows = safeRows(data.byType);
  const topTypes = typeRows.slice(0, 4);
  const topRoles = safeRows(data.byRole).slice(0, 4);
  const breakdown = (rows, labelFor, emptyText) => rows.length
    ? `<div class="metric-breakdown">${rows.map((item) => `
        <span><b>${esc(labelFor(item))}</b><em>${item.count || 0}</em></span>
      `).join("")}</div>`
    : `<div class="metric-empty">${esc(emptyText)}</div>`;
  const node = document.getElementById("interaction-metrics");
  if (!node) return;
  node.innerHTML = `
    <div class="metric-card highlight"><div class="label">关键行为</div><div class="value">${data.total || 0}</div><div class="sub">当前范围内可解释的学习动作</div></div>
    <div class="metric-card good"><div class="label">涉及学生</div><div class="value">${data.activeUsers || 0}</div><div class="sub">至少产生一条行为记录</div></div>
    <div class="metric-card warn"><div class="label">已折叠低价值记录</div><div class="value">${data.hiddenLowValue || 0}</div><div class="sub">原始记录共 ${data.rawTotal ?? data.total ?? 0} 条</div></div>
    <div class="metric-card detail"><div class="label">高频行为</div>${breakdown(topTypes, (item) => interactionTypeName(item.event_type), "暂无关键行为")}</div>
    <div class="metric-card detail"><div class="label">学习环节</div>${breakdown(topRoles, (item) => moduleRoleName(item.module_role), "暂无学习环节数据")}</div>`;

  destroyChart("interactionTypes");
  const chartRows = typeRows.slice(0, 12);
  if (!setChartState("chart-interaction-types", chartRows.length > 0, "当前筛选范围内暂无关键交互记录。", {
    itemCount: chartRows.length,
    minHeight: 190,
    maxHeight: 320,
    perItem: 20
  })) return;
  const ctx = document.getElementById("chart-interaction-types")?.getContext("2d");
  if (!ctx) return;
  charts.interactionTypes = new Chart(ctx, {
    type: "bar",
    data: {
      labels: chartRows.map((item) => interactionTypeName(item.event_type)),
      datasets: [{
        label: "次数",
        data: chartRows.map((item) => item.count || 0),
        backgroundColor: "#0b8f8a",
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
}

function renderUnitEngagement(rows) {
  cachedUnitEngagementRows = safeRows(rows);
  renderUnitEngagementTable();
}

function unitEngagementValue(row, key) {
  if (key === "nickname") return String(row.nickname || "").toLowerCase();
  if (key === "chapter") return normalizedChapterName(row).toLowerCase();
  if (key === "unit") return moduleName(row.unit_id, row.unit_label || "").toLowerCase();
  if (key === "keyboard_wheel") return Number(row.keyboard_actions || 0) + Number(row.wheel_actions || 0);
  return Number(row[key] || 0);
}

function sortUnitEngagementRows(rows) {
  const { key, dir } = unitEngagementSort;
  const direction = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = unitEngagementValue(a, key);
    const bv = unitEngagementValue(b, key);
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv), "zh-CN") * direction;
    }
    return ((Number(av) || 0) - (Number(bv) || 0)) * direction;
  });
}

function syncUnitEngagementSortHeaders() {
  document.querySelectorAll("#table-unit-engagement th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === unitEngagementSort.key;
    th.classList.toggle("sorted-asc", active && unitEngagementSort.dir === "asc");
    th.classList.toggle("sorted-desc", active && unitEngagementSort.dir === "desc");
    th.setAttribute("aria-sort", active ? (unitEngagementSort.dir === "asc" ? "ascending" : "descending") : "none");
  });
}

function renderUnitEngagementTable() {
  const tbody = document.querySelector("#table-unit-engagement tbody");
  if (!tbody) return;
  const list = sortUnitEngagementRows(cachedUnitEngagementRows).slice(0, 150);
  syncUnitEngagementSortHeaders();
  tbody.innerHTML = list.length ? list.map((row) => `
    <tr>
      <td>${esc(row.nickname || "")}</td>
      <td>${esc(normalizedChapterName(row))}</td>
      <td>${esc(moduleName(row.unit_id, row.unit_label || ""))}</td>
      <td>${row.opens || 0}</td>
      <td>${row.completes || 0}</td>
      <td>${row.skips || 0}</td>
      <td>${row.repeats || 0}</td>
      <td>${durationText(row.seconds || 0)}</td>
      <td>${row.courseware_actions || 0}</td>
      <td>${row.clicks || 0}</td>
      <td>${row.parameter_changes || 0}</td>
      <td>${row.assessments || 0}</td>
      <td>${row.reflections || 0}</td>
      <td>${Number(row.keyboard_actions || 0) + Number(row.wheel_actions || 0)}</td>
    </tr>
  `).join("") : "<tr><td colspan='14'>暂无模块参与度数据。</td></tr>";
  syncTableDensity(document.getElementById("table-unit-engagement"));
}

function pathPreviewHtml(row) {
  const steps = safeRows(row.steps);
  const fallback = String(row.path_preview || "")
    .split(/\s*->\s*/)
    .filter(Boolean)
    .map((label) => ({ unit_label: label }));
  const allSteps = steps.length ? steps : fallback;
  const compactCount = 8;
  const list = allSteps.slice(0, compactCount);
  if (!list.length) return '<span class="muted">暂无路径预览</span>';
  const stepChip = (step, index, extraClass = "") => {
    const label = step.unit_id
      ? knowledgeSceneName(
          step.unit_id,
          step.unit_label || `模块 ${index + 1}`,
          step.scene_type || "",
          step.scene_label || ""
        )
      : publicCourseText(step.unit_label, `学习步骤 ${index + 1}`);
    const seconds = Number(step.seconds || 0);
    const time = seconds ? `<span>${durationText(seconds)}</span>` : "";
    return `<span class="path-step ${extraClass}"><b>${index + 1}</b>${esc(label)}${time}</span>`;
  };
  const visibleChips = list.map((step, index) => stepChip(step, index)).join("");
  const hiddenChips = allSteps
    .slice(compactCount)
    .map((step, index) => stepChip(step, compactCount + index, "path-extra is-collapsed"))
    .join("");
  const rest = allSteps.length - list.length;
  const toggle = rest > 0
    ? `<button class="path-toggle" type="button" data-path-toggle aria-expanded="false" data-collapsed-label="展开全部 ${allSteps.length} 步" data-expanded-label="收起路径">展开全部 ${allSteps.length} 步</button>`
    : "";
  return `<div class="path-preview">${visibleChips}${hiddenChips}${toggle}</div>`;
}

function renderPathAnalysis(rows, pathRule = { minSeconds: 10, maxSeconds: 1800 }) {
  const desc = document.getElementById("path-rule-desc");
  const minSeconds = Number(pathRule?.minSeconds || 10);
  const maxSeconds = Number(pathRule?.maxSeconds || 1800);
  if (desc) {
    desc.textContent = `连续停留少于 ${minSeconds} 秒不计入；单段最多按 ${durationText(maxSeconds).trim()}计入，避免页面长期未关闭放大路径时长。原始时长仍保留在导出数据中。`;
  }
  const tbody = document.querySelector("#table-path-analysis tbody");
  if (!tbody) return;
  const list = safeRows(rows).slice(0, 100);
  tbody.innerHTML = list.length ? list.map((row) => `
    <tr>
      <td>${esc(row.nickname || "")}</td>
      <td>${row.step_count || 0}</td>
      <td>${durationText(row.total_seconds || 0)}${row.capped_segments ? `<br><span class="muted">${row.capped_segments} 段已截尾</span>` : ""}</td>
      <td>${esc(shortDateTime(row.first_at))}<br><span class="muted">${esc(shortDateTime(row.last_at))}</span></td>
      <td>${pathPreviewHtml(row)}</td>
    </tr>
  `).join("") : "<tr><td colspan='5'>当前筛选范围内还没有形成有效停留路径。</td></tr>";
  syncTableDensity(document.getElementById("table-path-analysis"));
}

function agenticChoiceLatencyText(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  return durationText(Math.round(value / 1000));
}

function agenticCandidateSummaryHtml(actions) {
  if (!Array.isArray(actions) || !actions.length) return "";
  return actions.slice(0, 5).map((action) => {
    const labels = Array.isArray(action.unitLabels) && action.unitLabels.length
      ? action.unitLabels.map((label) => publicCourseText(label, ""))
      : Array.isArray(action.unitIds)
        ? action.unitIds.map((id) => moduleName(id, ""))
        : [];
    const target = labels.length ? labels.join(" / ") : publicCourseText(action.label, "");
    const role = action.primary ? "推荐" : "备选";
    const actionLabel = AdminPresentation.coachActionLabel(action.type || action.action || "");
    return `<span class="muted">${esc(role)} · ${esc(actionLabel)}${target ? `：${esc(target)}` : ""}</span>`;
  }).join("<br>");
}

function agenticCandidateSummaryText(actions) {
  if (!Array.isArray(actions) || !actions.length) return "";
  return actions.map((action) => {
    const labels = Array.isArray(action.unitLabels) && action.unitLabels.length
      ? action.unitLabels.map((label) => publicCourseText(label, ""))
      : Array.isArray(action.unitIds)
        ? action.unitIds.map((id) => moduleName(id, ""))
        : [];
    const role = action.primary ? "推荐" : "备选";
    const target = labels.join(" / ") || publicCourseText(action.label, "");
    return `${role} · ${AdminPresentation.coachActionLabel(action.type || action.action || "")}${target ? `：${target}` : ""}`;
  }).join(" | ");
}

function renderAgenticTrace(rows) {
  const page = normalizePageData(rows, 500);
  cachedAgenticTraceRows = page.rows;
  const tbody = document.querySelector("#table-agentic-trace tbody");
  const summary = document.getElementById("agentic-trace-summary");
  if (summary) {
    const chosen = cachedAgenticTraceRows.filter((row) => row.learner_action).length;
    const highRisk = cachedAgenticTraceRows.filter((row) => row.risk_level === "high").length;
    const loaded = page.total > cachedAgenticTraceRows.length ? ` · 当前加载 ${cachedAgenticTraceRows.length} 条` : "";
    const visible = cachedAgenticTraceRows.length > 200 ? " · 表格显示前 200 条" : "";
    summary.textContent = `共 ${page.total} 条智能教练计划${loaded}${visible} · 已选择 ${chosen} 条 · 高风险 ${highRisk} 条`;
  }
  if (!tbody) return;
  tbody.innerHTML = cachedAgenticTraceRows.length ? cachedAgenticTraceRows.slice(0, 200).map((row) => {
    const evidenceItems = [
      row.risk_level ? `风险等级：${AdminPresentation.riskLevelLabel(row.risk_level)}` : "",
      row.suggested_move ? `证据建议：${AdminPresentation.coachActionLabel(row.suggested_move)}` : "",
      row.friction_score !== "" ? `操作摩擦：${row.friction_score}` : "",
      row.engagement_score !== "" ? `参与度：${row.engagement_score}` : "",
      row.dwell_ms ? `停留：${durationText(Math.round(Number(row.dwell_ms || 0) / 1000))}` : "",
      row.repeat_count ? `重复进入：${row.repeat_count} 次` : "",
      row.answer_reveal_count ? `查看答案：${row.answer_reveal_count} 次` : "",
      row.short_answer_length ? `简答长度：${row.short_answer_length} 字` : ""
    ].filter(Boolean);
    const evidence = evidenceItems.length
      ? `<div class="decision-facts">${evidenceItems.map((item) => `<span>${esc(item)}</span>`).join("")}</div>`
      : '<span class="muted">无交互证据</span>';
    const outcome = row.outcome_quiz_count
      ? `${row.outcome_quiz_count} 次测验，正确率 ${row.outcome_accuracy ?? "-"}%<br><span class="muted">${row.outcome_score || 0}/${row.outcome_max_score || 0} 分</span>`
      : '<span class="muted">暂无后续测验</span>';
    const learnerActionLabel = AdminPresentation.coachActionLabel(row.learner_action);
    const learnerTarget = row.target_label || row.target_id
      ? publicCourseText(row.target_label, moduleName(row.target_id, ""))
      : "";
    const selectedActionLabel = publicCourseText(row.selected_action_label, "");
    const learner = row.learner_action
      ? `${esc(learnerActionLabel)}${learnerTarget ? `<br><span class="muted">目标：${esc(learnerTarget)}</span>` : ""}`
      : '<span class="muted">未选择/未记录</span>';
    const latency = agenticChoiceLatencyText(row.choice_latency_ms);
    const choiceMeta = [
      selectedActionLabel && selectedActionLabel !== learnerActionLabel && selectedActionLabel !== learnerTarget
        ? `学生确认：${selectedActionLabel}`
        : "",
      latency ? `选择耗时 ${latency}` : "",
      row.next_cluster_label ? `下一小节 ${publicCourseText(row.next_cluster_label, "")}` : ""
    ].filter(Boolean).join(" · ");
    const candidateLine = agenticCandidateSummaryHtml(row.candidate_actions);
    const plannerTarget = row.planner_target_label || row.planner_target_id
      ? publicCourseText(
          row.planner_target_label,
          moduleName(row.planner_target_id, "")
        )
      : "";
    const plannerLine = [
      row.planner_action ? `场景排序建议：${AdminPresentation.coachActionLabel(row.planner_action)}` : "",
      plannerTarget ? `首选：${plannerTarget}` : "",
      row.planner_top_reasons ? `排序依据：${AdminPresentation.plannerReasonsText(row.planner_top_reasons)}` : ""
    ].filter(Boolean).join(" · ");
    const coachSuggestion = AdminPresentation.coachActionLabel(row.suggested_action || row.suggested_move || "");
    const qaStatus = AdminPresentation.qaStatusLabel(row.qa_pass);
    return `<tr>
      <td style="white-space:nowrap;font-size:0.78rem;">${esc(shortDateTime(row.created_at))}</td>
      <td style="font-weight:600;">${esc(row.nickname || "")}</td>
      <td>${esc(moduleName(row.unit_id, row.unit_label || ""))}<br><span class="muted">${esc(publicCourseText(row.chapter_label, chapterName(row.chapter_id)))}</span></td>
      <td>${evidence}</td>
      <td>${esc(coachSuggestion)}<br><span class="muted">质量检查：${esc(qaStatus)}</span>${plannerLine ? `<br><span class="muted">${esc(plannerLine)}</span>` : ""}</td>
      <td>${learner}${choiceMeta ? `<br><span class="muted">${esc(choiceMeta)}</span>` : ""}${candidateLine ? `<br>${candidateLine}` : ""}</td>
      <td>${outcome}</td>
    </tr>`;
  }).join("") : "<tr><td colspan='7'>当前筛选范围内暂无智能教练决策证据链。</td></tr>";
}

document.addEventListener("click", (event) => {
  const genericSortHeader = event.target.closest("th.table-sortable");
  if (genericSortHeader) {
    const table = genericSortHeader.closest("table");
    const columnIndex = Number(genericSortHeader.dataset.tableSortIndex);
    const currentColumn = Number(table.dataset.sortColumn);
    const currentDirection = table.dataset.sortDirection || "asc";
    const direction = currentColumn === columnIndex && currentDirection === "asc" ? "desc" : "asc";
    applyTableSort(table, columnIndex, direction);
    return;
  }

  const sortHeader = event.target.closest("#table-unit-engagement th[data-sort]");
  if (sortHeader) {
    const key = sortHeader.dataset.sort;
    unitEngagementSort = {
      key,
      dir: unitEngagementSort.key === key && unitEngagementSort.dir === "desc" ? "asc" : "desc"
    };
    sessionStorage.setItem("cq_unit_engagement_sort_key", unitEngagementSort.key);
    sessionStorage.setItem("cq_unit_engagement_sort_dir", unitEngagementSort.dir);
    renderUnitEngagementTable();
    return;
  }

  const button = event.target.closest("[data-path-toggle]");
  if (!button) return;
  const preview = button.closest(".path-preview");
  if (!preview) return;
  const expanded = !preview.classList.contains("expanded");
  preview.classList.toggle("expanded", expanded);
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.textContent = expanded ? button.dataset.expandedLabel : button.dataset.collapsedLabel;
});

document.addEventListener("keydown", (event) => {
  const header = event.target.closest?.("th.table-sortable");
  if (!header || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  header.click();
});

// ---- Interaction Tracking ----
function renderInteractions(data) {
  const meta = normalizeInteractionData(data);
  const rows = meta.rows.map(d => ({ ...d, payload: parsePayload(d.payload) }));
  visibleInteractionRows = rows;
  updateInteractionPager(meta);
  if (!rows.length) {
    const tbody = document.querySelector("#table-interactions tbody");
    if (tbody) tbody.innerHTML = "<tr><td colspan='5'>当前筛选条件下暂无交互记录。</td></tr>";
    return;
  }
  // Recent interactions table
  const tbody = document.querySelector("#table-interactions tbody");
  if (tbody) {
    tbody.innerHTML = rows.map(d => {
      const eventType = interactionEventType(d);
      const summary = humanInteractionSummary(d);
      const detail = interactionDetail(d);
      return `<tr>
        <td style="white-space:nowrap;font-size:0.78rem;">${(d.created_at||"").slice(0,16)}</td>
        <td style="font-weight:600;">${esc(d.nickname || "")}</td>
        <td>${esc(interactionLearningLocation(d))}</td>
        <td><span class="badge badge-blue">${esc(interactionTypeName(eventType).slice(0,20))}</span></td>
        <td class="interaction-summary-cell" title="${esc(detail)}">${esc(summary)}</td>
      </tr>`;
    }).join("");
  }
}

// ---- Tab switching ----
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
    const target = document.getElementById("tab-" + tab.dataset.tab);
    if (target) target.classList.remove("hidden");
  });
});

// ---- Refresh with debounce + abort ----
function debouncedLoadAll() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (loadController) loadController.abort();
    loadController = new AbortController();
    loadAll(loadController.signal);
  }, 300);
}

document.getElementById("refresh-btn").addEventListener("click", debouncedLoadAll);

document.getElementById("interaction-user-filter").addEventListener("change", (event) => {
  interactionUserId = event.target.value;
  sessionStorage.setItem("cq_interaction_user", interactionUserId);
  resetInteractionPage();
  debouncedLoadAll();
});

document.getElementById("interaction-page-size").addEventListener("change", (event) => {
  interactionPageSize = Number(event.target.value || 100);
  sessionStorage.setItem("cq_interaction_page_size", String(interactionPageSize));
  resetInteractionPage();
  debouncedLoadAll();
});

document.getElementById("interaction-detail-filter").addEventListener("change", (event) => {
  interactionDetailMode = event.target.value === "all" ? "all" : "meaningful";
  sessionStorage.setItem("cq_interaction_detail", interactionDetailMode);
  resetInteractionPage();
  debouncedLoadAll();
});

document.getElementById("interaction-prev-page").addEventListener("click", () => {
  if (interactionPage <= 0) return;
  interactionPage -= 1;
  sessionStorage.setItem("cq_interaction_page", String(interactionPage));
  debouncedLoadAll();
});

document.getElementById("interaction-next-page").addEventListener("click", () => {
  interactionPage += 1;
  sessionStorage.setItem("cq_interaction_page", String(interactionPage));
  debouncedLoadAll();
});

// ---- Quick range buttons ----
function setRange(range) {
  currentRange = range;
  sessionStorage.setItem("cq_admin_range", range);
  document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
  const activeBtn = document.querySelector(`.range-btn[data-range="${range}"]`);
  if (activeBtn) activeBtn.classList.add("active");
  document.getElementById("date-start").value = "";
  document.getElementById("date-end").value = "";
  resetInteractionPage();
  destroyAllCharts();
  debouncedLoadAll();
}

document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => setRange(btn.dataset.range));
});

// ---- Date filter (manual) ----
document.getElementById("filter-apply-btn").addEventListener("click", () => {
  currentRange = "";
  sessionStorage.setItem("cq_admin_range", "");
  document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
  const allBtn = document.querySelector('.range-btn[data-range=""]');
  if (allBtn) allBtn.classList.add("active");
  resetInteractionPage();
  destroyAllCharts();
  debouncedLoadAll();
});

// Restore active range button on page load
if (currentRange) {
  const activeBtn = document.querySelector(`.range-btn[data-range="${currentRange}"]`);
  if (activeBtn) {
    document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
    activeBtn.classList.add("active");
  }
}

// ---- User search ----
document.getElementById("user-search-btn").addEventListener("click", () => {
  const q = document.getElementById("user-search-input").value.trim().toLowerCase();
  if (!q) { renderUserTable(allUsers); return; }
  const filtered = allUsers.filter(u => u.nickname.toLowerCase().includes(q) || (u.user_id || "").toLowerCase().includes(q));
  renderUserTable(filtered);
});
document.getElementById("user-search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("user-search-btn").click();
});

document.getElementById("feedback-type-filter")?.addEventListener("change", loadFeedbackDashboard);
document.getElementById("feedback-scope-filter")?.addEventListener("change", loadFeedbackDashboard);
document.getElementById("feedback-query-filter")?.addEventListener("input", debouncedLoadFeedbackDashboard);

// ---- Init ----
// ---- CSV Export (research) ----
function csvCell(value) {
  return AdminCsv.csvCell(value);
}

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;bom" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

function exportDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function pagedStatsParams(baseParams, limit, offset) {
  const params = new URLSearchParams(baseParams || "");
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return params.toString();
}

async function fetchAllStatsRows(endpoint, baseParams = "") {
  return AdminCsv.fetchAllRows(
    ({ limit, offset }) => fetchStats(endpoint, pagedStatsParams(baseParams, limit, offset)),
    { pageSize: 1000 }
  );
}

async function runCsvExport(button, task) {
  if (!button || button.disabled) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "正在导出…";
  try {
    const result = await task();
    if (!Array.isArray(result?.rows) || result.rows.length <= 1) {
      window.alert("当前筛选范围内没有可导出的数据。");
      return;
    }
    downloadCsv(result.filename, result.rows);
  } catch (error) {
    console.error("CSV export failed:", error);
    window.alert(`导出失败：${error?.message || "请刷新后重试。"}`);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = originalLabel;
  }
}

function userCsvRows(data) {
  const rows = [["昵称","用户ID","最后活跃","测验提交","测验覆盖单元","正确率%","总得分","总分"]];
  safeRows(data).forEach(u => {
    rows.push([
      u.nickname || "", u.user_id || "",
      (u.last_seen_at || "").slice(0,16),
      String(u.quiz_count || 0), String(u.units_attempted || 0),
      String(u.avg_accuracy || 0),
      String(u.total_score || 0), String(u.total_max || 0)
    ]);
  });
  return rows;
}

function feedbackCsvRows(data) {
  const rows = [[
    "时间", "学生", "用户ID", "类型", "目标范围", "章节", "学习位置", "章节ID", "模块ID",
    "单元ID", "知识点", "场景类型", "课件标题", "课件资源", "反馈正文"
  ]];
  safeRows(data).forEach((row) => {
    rows.push([
      row.created_at || "",
      row.nickname || "",
      row.user_id || "",
      feedbackTypeLabels[row.feedback_type] || row.feedback_type || "",
      row.target_scope || "",
      publicCourseText(row.chapter_label || chapterName(row.chapter_id), ""),
      moduleName(row.unit_id, row.knowledge_point || row.resource_title || ""),
      row.chapter_id || "",
      row.module_id || "",
      row.unit_id || "",
      row.knowledge_point || "",
      row.scene_type || "",
      row.resource_title || "",
      row.resource_file || "",
      row.content || ""
    ]);
  });
  return rows;
}

function interactionCsvRows(data) {
  const rows = [["时间", "学生", "用户ID", "学习位置", "事件类型", "动作类别", "行为摘要", "原始详情"]];
  safeRows(data).forEach((sourceRow) => {
    const row = { ...sourceRow, payload: parsePayload(sourceRow.payload) };
    const eventType = interactionEventType(row);
    rows.push([
      row.created_at || "",
      row.nickname || "",
      row.user_id || "",
      interactionLearningLocation(row),
      interactionTypeName(eventType),
      actionCategoryName(actionCategoryForType(eventType)),
      humanInteractionSummary(row),
      interactionDetail(row)
    ]);
  });
  return rows;
}

function agenticTraceCsvRows(data) {
  const rows = [[
    "时间", "学生", "用户ID", "章节", "触发模块", "风险等级", "证据建议",
    "操作摩擦分", "参与度", "停留毫秒", "重复进入", "查看答案", "简答长度",
    "智能教练建议", "质量检查", "学生选择", "选择标签", "目标模块", "选择时间",
    "选择耗时毫秒", "候选建议", "选中候选ID", "下一模块", "下一概念簇",
    "后续测验数", "后续正确率", "后续得分", "后续满分",
    "场景排序建议", "场景排序目标", "场景排序得分", "场景排序依据"
  ]];
  safeRows(data).forEach((row) => {
    rows.push([
      row.created_at || "",
      row.nickname || "",
      row.user_id || "",
      publicCourseText(row.chapter_label, chapterName(row.chapter_id)),
      moduleName(row.unit_id, row.unit_label || ""),
      AdminPresentation.riskLevelLabel(row.risk_level),
      AdminPresentation.coachActionLabel(row.suggested_move),
      row.friction_score ?? "",
      row.engagement_score ?? "",
      row.dwell_ms || 0,
      row.repeat_count || 0,
      row.answer_reveal_count || 0,
      row.short_answer_length || 0,
      AdminPresentation.coachActionLabel(row.suggested_action || row.suggested_move),
      AdminPresentation.qaStatusLabel(row.qa_pass),
      AdminPresentation.coachActionLabel(row.learner_action),
      publicCourseText(row.selected_action_label, ""),
      moduleName(row.target_id, row.target_label || ""),
      row.executed_at || "",
      row.choice_latency_ms ?? "",
      agenticCandidateSummaryText(row.candidate_actions),
      Array.isArray(row.selected_candidate_ids) ? row.selected_candidate_ids.join(" | ") : "",
      moduleName(row.next_unit_id, ""),
      publicCourseText(row.next_cluster_label, moduleName(row.next_cluster_id, "")),
      row.outcome_quiz_count || 0,
      row.outcome_accuracy ?? "",
      row.outcome_score || 0,
      row.outcome_max_score || 0,
      AdminPresentation.coachActionLabel(row.planner_action),
      moduleName(row.planner_target_id, row.planner_target_label || ""),
      row.planner_top_score ?? "",
      AdminPresentation.plannerReasonsText(row.planner_top_reasons)
    ]);
  });
  return rows;
}

function shortAnswerCsvRows(data) {
  const rows = [["学生","章节","单元","题目ID","答案","得分","满分","状态","时间"]];
  safeRows(data).forEach((row) => {
    rows.push([
      row.nickname || "",
      publicCourseText(row.chapter_label, chapterName(row.chapter_id)),
      moduleName(row.unit_id, row.unit_label || ""),
      AdminPresentation.questionDisplayLabel(row.question_id, row.phase),
      row.response || "",
      row.score ?? "",
      row.max_score ?? "",
      shortAnswerReviewState(row).label,
      row.created_at || ""
    ]);
  });
  return rows;
}

function regradeAuditCsvRows(data) {
  const rows = [["审计ID", "批次ID", "状态", "学生", "用户ID", "题目ID", "单元ID", "评分提供方", "评分模型", "原评分", "建议评分", "实际应用", "错误信息", "时间"]];
  safeRows(data).forEach((row) => rows.push([
    row.id || "",
    row.batch_id || "",
    row.status || "",
    row.nickname || "",
    row.user_id || "",
    row.question_id || "",
    row.unit_id || "",
    row.llm_provider || "",
    row.llm_model || "",
    row.previous_grade_json || "{}",
    row.proposed_grade_json || "{}",
    row.applied_grade_json || "{}",
    row.error_message || "",
    row.created_at || ""
  ]));
  return rows;
}

function phaseCsvRows(data) {
  const rows = [[
    "学生", "用户ID", "章节", "章节ID",
    "前测提交数", "前测题数", "前测正确数", "前测待复核", "前测正确率%", "前测得分", "前测满分",
    "形成性提交数", "形成性题数", "形成性正确数", "形成性待复核", "形成性正确率%", "形成性得分", "形成性满分",
    "后测提交数", "后测题数", "后测正确数", "后测待复核", "后测正确率%", "后测得分", "后测满分",
    "学习增益%"
  ]];
  safeRows(data).forEach((row) => {
    const gain = row.pre_count > 0 && row.post_count > 0
      ? Number(row.post_accuracy || 0) - Number(row.pre_accuracy || 0)
      : "";
    rows.push([
      row.nickname || "",
      row.user_id || "",
      publicCourseText(row.chapter_label, chapterName(row.chapter_id)),
      row.chapter_id || "",
      row.pre_submissions || 0,
      row.pre_count || 0,
      row.pre_correct || 0,
      row.pre_pending || 0,
      row.pre_accuracy ?? "",
      row.pre_score || 0,
      row.pre_max_score || 0,
      row.formative_submissions || 0,
      row.formative_count || 0,
      row.formative_correct || 0,
      row.formative_pending || 0,
      row.formative_accuracy ?? "",
      row.formative_score || 0,
      row.formative_max_score || 0,
      row.post_submissions || 0,
      row.post_count || 0,
      row.post_correct || 0,
      row.post_pending || 0,
      row.post_accuracy ?? "",
      row.post_score || 0,
      row.post_max_score || 0,
      gain
    ]);
  });
  return rows;
}

function userDetailCsvRows(detail = {}) {
  const rows = [[
    "记录类型", "学生", "用户ID", "学习代次", "章节", "阶段", "单元", "题目",
    "题型", "回答", "得分", "满分", "结果", "AI反馈", "AI错误类型", "时间",
    "有效停留秒数", "原始停留秒数", "是否截尾"
  ]];
  safeRows(detail.quizQuestionRows).forEach((row) => rows.push([
    "逐题作答",
    detail.user?.nickname || "",
    detail.user?.id || "",
    row.learning_generation || 1,
    publicCourseText(row.chapter_label, chapterName(row.chapter_id)),
    quizPhaseLabel(row.phase),
    moduleName(row.unit_id, row.unit_label || ""),
    AdminPresentation.questionDisplayLabel(row.question_id, row.phase),
    AdminPresentation.questionTypeLabel(row.question_type),
    quizResponseText(row.response),
    row.score || 0,
    row.max_score || 0,
    quizResultState(row).label,
    row.ai_feedback || "",
    row.ai_error_type || "",
    row.created_at || "",
    "",
    "",
    ""
  ]));
  safeRows(detail.effectivePath?.steps).forEach((step) => rows.push([
    "有效学习路径",
    detail.user?.nickname || "",
    detail.user?.id || "",
    "",
    chapterName(step.chapter_id),
    "",
    moduleName(step.unit_id, step.unit_label || ""),
    step.scene_label || AdminPresentation.sceneTypeLabel(step.scene_type),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    step.at || "",
    step.seconds || 0,
    step.raw_seconds || step.seconds || 0,
    step.capped ? "是" : "否"
  ]));
  return rows;
}

function pathCsvRows(data) {
  const rows = [["学生", "用户ID", "步骤数", "有效总秒数", "原始总秒数", "截尾片段数", "开始时间", "结束时间", "序号", "章节", "单元", "场景", "课件", "有效秒数", "原始秒数", "是否截尾"]];
  safeRows(data).forEach((path) => {
    safeRows(path.steps).forEach((step, index) => {
      rows.push([
        path.nickname || "",
        path.user_id || "",
        path.step_count || 0,
        path.total_seconds || 0,
        path.raw_total_seconds || path.total_seconds || 0,
        path.capped_segments || 0,
        path.first_at || "",
        path.last_at || "",
        index + 1,
        chapterName(step.chapter_id),
        moduleName(step.unit_id, step.unit_label || ""),
        step.scene_label || AdminPresentation.sceneTypeLabel(step.scene_type),
        step.resource_title || "",
        step.seconds || 0,
        step.raw_seconds || step.seconds || 0,
        step.capped ? "是" : "否"
      ]);
    });
  });
  return rows;
}

function engagementCsvRows(data) {
  const rows = [["学生", "用户ID", "章节", "单元", "打开", "完成", "跳过", "重复", "有效停留秒数", "课件动作", "点击/拖拽", "输入", "课件提交", "调参", "课件自检", "预测/反思", "提示支持", "互动证据", "键盘", "滚轮", "测验行为"]];
  safeRows(data).forEach((row) => rows.push([
    row.nickname || "",
    row.user_id || "",
    normalizedChapterName(row),
    moduleName(row.unit_id, row.unit_label || ""),
    row.opens || 0,
    row.completes || 0,
    row.skips || 0,
    row.repeats || 0,
    row.seconds || 0,
    row.courseware_actions || 0,
    row.clicks || 0,
    row.inputs || 0,
    row.submits || 0,
    row.parameter_changes || 0,
    row.assessments || 0,
    row.reflections || 0,
    row.support_actions || 0,
    row.completion_evidence || 0,
    row.keyboard_actions || 0,
    row.wheel_actions || 0,
    row.quiz_events || 0
  ]));
  return rows;
}

function coursewareCheckCsvRows(data) {
  const assessmentTypes = new Set([
    "courseware_pre_check_submitted",
    "courseware_formative_check_submitted",
    "courseware_exit_ticket_submitted",
    "courseware_challenge_result"
  ]);
  return interactionCsvRows(
    safeRows(data).filter((row) => {
      const payload = parsePayload(row.payload);
      return assessmentTypes.has(interactionEventType({ ...row, payload }));
    })
  );
}

function interactionExportParams() {
  const params = new URLSearchParams();
  if (interactionUserId) params.set("userId", interactionUserId);
  params.set("detail", interactionDetailMode);
  return params.toString();
}

function agenticTraceExportParams() {
  const params = new URLSearchParams();
  if (interactionUserId) params.set("userId", interactionUserId);
  return params.toString();
}

function coursewareCheckExportParams() {
  const params = new URLSearchParams();
  if (interactionUserId) params.set("userId", interactionUserId);
  params.set("detail", "all");
  return params.toString();
}

document.getElementById("export-users-csv").addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `用户学习进度-全部-${exportDateStamp()}.csv`,
    rows: userCsvRows(allUsers)
  }));
});

document.getElementById("export-feedback-csv")?.addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => {
    const data = await fetchAllStatsRows("feedback", feedbackFilterQueryParams());
    return {
      filename: `问题反馈-全部-${exportDateStamp()}.csv`,
      rows: feedbackCsvRows(data)
    };
  });
});

document.getElementById("export-interactions-csv").addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `交互记录-${interactionDetailMode === "all" ? "原始" : "关键"}-当前页-${exportDateStamp()}.csv`,
    rows: interactionCsvRows(visibleInteractionRows)
  }));
});

document.getElementById("export-interactions-all-csv").addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => {
    const data = await fetchAllStatsRows("interactions", interactionExportParams());
    return {
      filename: `交互记录-${interactionDetailMode === "all" ? "原始" : "关键"}-全部-${exportDateStamp()}.csv`,
      rows: interactionCsvRows(data)
    };
  });
});

document.getElementById("export-agentic-trace-csv").addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => {
    const data = await fetchAllStatsRows("agentic-decision-trace", agenticTraceExportParams());
    return {
      filename: `智能教练证据链-全部-${exportDateStamp()}.csv`,
      rows: agenticTraceCsvRows(data)
    };
  });
});

document.getElementById("export-shortanswers-csv").addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => {
    const data = await fetchAllStatsRows("short-answer-responses");
    return {
      filename: `简答题提交-全部-${exportDateStamp()}.csv`,
      rows: shortAnswerCsvRows(data)
    };
  });
});

document.getElementById("export-regrade-audits-csv")?.addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `AI评分重评审计-${exportDateStamp()}.csv`,
    rows: regradeAuditCsvRows(
      await adminApi("/api/admin/grading/regrade-audits?limit=1000")
    )
  }));
});

document.getElementById("export-phase-csv")?.addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `三阶段测验明细-${exportDateStamp()}.csv`,
    rows: phaseCsvRows(cachedPhaseData)
  }));
});

document.getElementById("export-user-detail-csv")?.addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `${cachedUserDetail?.user?.nickname || "学生"}-总体数据-${exportDateStamp()}.csv`,
    rows: userDetailCsvRows(cachedUserDetail || {})
  }));
});

document.getElementById("export-paths-csv")?.addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `有效学习路径-${exportDateStamp()}.csv`,
    rows: pathCsvRows(cachedPathRows)
  }));
});

document.getElementById("export-engagement-csv")?.addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `模块参与度-${exportDateStamp()}.csv`,
    rows: engagementCsvRows(cachedUnitEngagementRows)
  }));
});

document.getElementById("export-courseware-checks-csv")?.addEventListener("click", (event) => {
  runCsvExport(event.currentTarget, async () => ({
    filename: `课件自检记录-${exportDateStamp()}.csv`,
    rows: coursewareCheckCsvRows(await fetchAllStatsRows("interactions", coursewareCheckExportParams()))
  }));
});

document.getElementById("preview-regrade-btn")?.addEventListener("click", () => {
  loadRegradeCandidates();
});

document.getElementById("run-regrade-btn")?.addEventListener("click", () => {
  runSelectedRegrade();
});

document.getElementById("select-all-regrade")?.addEventListener("change", (event) => {
  regradeCandidateCheckboxes().forEach((input) => {
    input.checked = event.currentTarget.checked;
  });
  syncRegradeSelection();
});

checkAuth();

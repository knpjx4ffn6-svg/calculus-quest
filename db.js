const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");
const interactionPolicy = require("./lib/interaction-policy");
const activeTimePolicy = require("./lib/active-time-policy");

const WORKSPACE_ROOT = path.resolve(process.cwd());
const configuredDbPath = String(process.env.DB_PATH || "").trim();
const DB_PATH = path.resolve(configuredDbPath || path.join(WORKSPACE_ROOT, "data", "calculus-quest.db"));
const LEARNING_ROUTE_PATH = path.join(process.cwd(), "data", "multi-scene-learning-route.json");
const DB_LOCK_PATH = `${DB_PATH}.lock`;
const FAILED_AI_REVIEW_TYPES = [
  "api_error",
  "api_timeout",
  "parse_error",
  "empty_response",
  "mock_provider",
  "manual_fallback",
  "unknown"
];
const FAILED_AI_REVIEW_SUFFIX = "。已先按 0 分计入，不影响继续学习。";
const LEGACY_AI_REVIEW_FAILURE_PATTERNS = [
  "评分出错",
  "评分超时",
  "解析失败",
  "模型接口返回了空文本",
  "未启用真实大模型",
  "已先按 0 分计入"
];
const AI_REVIEW_CONFIDENCE_THRESHOLD = 0.7;
const EFFECTIVE_PATH_MIN_SECONDS = 10;
const EFFECTIVE_PATH_MAX_SECONDS = 30 * 60;

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertProductionDatabasePath() {
  if (process.env.NODE_ENV !== "production") return;
  if (!configuredDbPath) {
    throw new Error("Production startup requires DB_PATH to point to the persistent database outside the code repository.");
  }
  if (pathInside(WORKSPACE_ROOT, DB_PATH) && process.env.ALLOW_REPO_DB_PATH !== "true") {
    throw new Error("Production DB_PATH must be outside the code repository. Set ALLOW_REPO_DB_PATH=true only for an intentional exception.");
  }
}

assertProductionDatabasePath();

function loadOpenMaicRouteSync() {
  try {
    if (!fs.existsSync(LEARNING_ROUTE_PATH)) return null;
    return JSON.parse(fs.readFileSync(LEARNING_ROUTE_PATH, "utf8"));
  } catch {
    return null;
  }
}

const openMaicRoute = loadOpenMaicRouteSync();
const chapterOrder = openMaicRoute?.chapters?.length
  ? openMaicRoute.chapters.map((chapter) => chapter.id)
  : ["A1", "A2a", "A2b", "A3", "A4", "C1", "D1", "D2"];
const chapterLabels = openMaicRoute?.chapters?.length
  ? Object.fromEntries(openMaicRoute.chapters.map((chapter) => [chapter.id, chapter.title]))
  : {
      A1: "变化与斜率",
      A2a: "向量：方向与长度",
      A2b: "内积与投影",
      A3: "空间变换与局部线性",
      A4: "曲面与正定性",
      C1: "导数、梯度与驻点",
      D1: "梯度下降",
      D2: "凸性与全局最优"
    };
let courseLabelCache = null;

let db = null;
let saveTimer = null;
let dbLockFd = null;
let firstPendingSaveAt = 0;
const SAVE_DEBOUNCE_MS = 2000;
const SAVE_MAX_WAIT_MS = 10000;

function writeDatabaseAtomically() {
  if (!db) return;
  const data = db.export();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH + ".tmp", Buffer.from(data));
  fs.renameSync(DB_PATH + ".tmp", DB_PATH);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireWriteLock() {
  if (dbLockFd !== null) return;
  const dir = path.dirname(DB_LOCK_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(DB_LOCK_PATH)) {
    let lock = {};
    try { lock = JSON.parse(fs.readFileSync(DB_LOCK_PATH, "utf8")); } catch {}
    if (processIsAlive(Number(lock.pid))) {
      throw new Error(`Database is already locked by process ${lock.pid}. Stop the existing service before starting another writer.`);
    }
    fs.unlinkSync(DB_LOCK_PATH);
  }
  dbLockFd = fs.openSync(DB_LOCK_PATH, "wx");
  fs.writeFileSync(dbLockFd, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd()
  }));
}

function releaseWriteLock() {
  if (dbLockFd !== null) {
    try { fs.closeSync(dbLockFd); } catch {}
    dbLockFd = null;
  }
  try {
    if (fs.existsSync(DB_LOCK_PATH)) fs.unlinkSync(DB_LOCK_PATH);
  } catch {}
}

function databaseSafetyInfo() {
  return {
    path: DB_PATH,
    configured: Boolean(configuredDbPath),
    externalToWorkspace: !pathInside(WORKSPACE_ROOT, DB_PATH),
    production: process.env.NODE_ENV === "production",
    lockPath: DB_LOCK_PATH
  };
}

async function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  initSchema();
  return db;
}

function getDbSync() {
  if (!db) throw new Error("Database not initialized. Call await getDb() first.");
  return db;
}

function scheduleSave() {
  const now = Date.now();
  if (!firstPendingSaveAt) firstPendingSaveAt = now;
  const delay = Math.max(
    0,
    Math.min(SAVE_DEBOUNCE_MS, firstPendingSaveAt + SAVE_MAX_WAIT_MS - now)
  );
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    firstPendingSaveAt = 0;
    try {
      writeDatabaseAtomically();
    } catch (e) {
      console.error("Failed to save database:", e.message);
      scheduleSave();
    }
  }, delay);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  firstPendingSaveAt = 0;
  writeDatabaseAtomically();
}

function chapterDisplayLabel(chapterId, fallback = "") {
  const index = chapterOrder.indexOf(chapterId);
  const label = chapterLabels[chapterId] || fallback || chapterId || "";
  return index >= 0 ? `第${index + 1}章 ${label}` : label;
}

function compactTitle(title = "") {
  return String(title || "")
    .replace(/^.*?：/, "")
    .replace(/实验|挑战|游戏|探针|同步器|生成器|分类器|播放器|仪表盘|可视化|大作战|大比拼|闯关|扫描仪/g, "")
    .replace(/^\d+_/, "")
    .replace(/\.html$/, "")
    .slice(0, 12);
}

function sceneLabel(scene = {}, index = 0, quizIndex = 0, quizTotal = 0) {
  if (scene.type === "quiz") {
    if (quizIndex === 0) return "前测";
    if (quizIndex === quizTotal - 1) return "后测";
    return "形成性测验";
  }
  if (scene.type === "slide") {
    if (/地图|路线/.test(scene.title || "")) return "概念地图";
    if (/公式|桥/.test(scene.title || "")) return "公式桥";
    if (/复盘|兜底|检查/.test(scene.title || "")) return "复盘页";
    return "讲解页";
  }
  return `实验：${compactTitle(scene.title || `模块${index + 1}`)}`;
}

function addV14UnitLabel(labels, chapter, module, unitId, unitLabel, extra = {}) {
  labels.set(unitId, {
    chapter_id: chapter.id,
    chapter_label: chapterDisplayLabel(chapter.id, chapter.title),
    unit_id: unitId,
    unit_label: unitLabel,
    module_id: module?.id || "",
    module_label: module?.title || "",
    ...extra
  });
}

function addV14ModuleLabels(labels, chapter, module) {
  const knowledgePoints = module.knowledgePoints || [];
  const splitIndex = Math.max(1, Math.ceil(knowledgePoints.length / 2));
  const moduleTitle = module.title || chapter.title || "本节";
  addV14UnitLabel(labels, chapter, module, `${module.id}-pre`, `${moduleTitle} · 前测`, {
    unit_type: "quiz",
    module_role: "pretest"
  });
  knowledgePoints.forEach((kp, index) => {
    if (index === splitIndex) {
      addV14UnitLabel(labels, chapter, module, `${module.id}-formative`, `${moduleTitle} · 形成性测验`, {
        unit_type: "quiz",
        module_role: "formative_quiz"
      });
    }
    addV14UnitLabel(labels, chapter, module, kp.id, kp.name || `${moduleTitle} · 知识点`, {
      unit_type: "knowledge",
      module_role: "knowledge_point",
      knowledge_point: kp.name || `${moduleTitle} · 知识点`
    });
  });
  if (knowledgePoints.length <= splitIndex) {
    addV14UnitLabel(labels, chapter, module, `${module.id}-formative`, `${moduleTitle} · 形成性测验`, {
      unit_type: "quiz",
      module_role: "formative_quiz"
    });
  }
  addV14UnitLabel(labels, chapter, module, `${module.id}-review`, `${moduleTitle} · 全课整理`, {
    unit_type: "slide",
    module_role: "review"
  });
  addV14UnitLabel(labels, chapter, module, `${module.id}-post`, `${moduleTitle} · 后测`, {
    unit_type: "quiz",
    module_role: "posttest"
  });
}

function courseLabels() {
  if (courseLabelCache) return courseLabelCache;
  const labels = new Map();
  if (openMaicRoute?.chapters?.length) {
    openMaicRoute.chapters.forEach((chapter) => {
      addV14UnitLabel(labels, chapter, {}, `${chapter.id}-pre`, `${chapter.title} · 知识前测`, {
        unit_type: "quiz",
        module_role: "pretest"
      });
      addV14UnitLabel(labels, chapter, {}, `${chapter.id}-formative`, `${chapter.title} · 形成测验`, {
        unit_type: "quiz",
        module_role: "formative_quiz"
      });
      addV14UnitLabel(labels, chapter, {}, `${chapter.id}-post`, `${chapter.title} · 结业后测`, {
        unit_type: "quiz",
        module_role: "posttest"
      });
      (chapter.modules || []).forEach((module) => addV14ModuleLabels(labels, chapter, module));
    });
    courseLabelCache = labels;
    return labels;
  }
  chapterOrder.forEach((chapterId) => {
    try {
      const manifestPath = path.join(process.cwd(), "resources", "open-maic", chapterId, "manifest.json");
      if (!fs.existsSync(manifestPath)) return;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
      const quizTotal = scenes.filter((scene) => scene.type === "quiz").length;
      let quizIndex = 0;
      scenes.forEach((scene, index) => {
        const currentQuizIndex = scene.type === "quiz" ? quizIndex++ : -1;
        const unitId = `${chapterId}-scene-${scene.order || index + 1}`;
        labels.set(unitId, {
          chapter_id: chapterId,
          chapter_label: chapterDisplayLabel(chapterId),
          unit_id: unitId,
          unit_label: sceneLabel(scene, index, currentQuizIndex, quizTotal)
        });
      });
    } catch {
      // Label fallback is enough for admin statistics.
    }
  });
  courseLabelCache = labels;
  return labels;
}

function publicCourseLabel(value = "") {
  return String(value || "")
    .replace(/\bV\d+-[CX]\d+(?:-[A-Za-z0-9]+)*\b/gi, " ")
    .replace(/\bGH-\d+(?:-[A-Za-z0-9]+)*\b/gi, " ")
    .replace(/\b[A-Z]\d+[a-z]?-(?:scene-\d+|chapter)\b/gi, " ")
    .replace(/^[\s·|/\\,，;；:：_-]+|[\s·|/\\,，;；:：_-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unitFallbackLabel(unitId = "", fallback = {}) {
  const provided = publicCourseLabel(fallback.unit_label || fallback.unitLabel || "");
  if (provided) return provided;
  if (/-pre$/i.test(unitId)) return "前测";
  if (/-formative$/i.test(unitId)) return "形成性测验";
  if (/-post$/i.test(unitId)) return "后测";
  if (/-review$/i.test(unitId)) return "全课整理";
  if (/-chapter$/i.test(unitId)) return "整章";
  return "未命名模块";
}

function unitDisplayMeta(unitId = "", fallback = {}) {
  const fromCourse = courseLabels().get(unitId);
  if (fromCourse) return fromCourse;
  const chapterId = fallback.chapter_id || fallback.chapterId || String(unitId).split("-scene-")[0] || "";
  return {
    chapter_id: chapterId,
    chapter_label: chapterDisplayLabel(chapterId, fallback.chapter_label || fallback.chapterLabel || ""),
    unit_id: unitId,
    unit_label: unitFallbackLabel(unitId, fallback),
    unit_type: fallback.unit_type || fallback.unitType || "",
    module_role: fallback.module_role || fallback.moduleRole || "",
    knowledge_point: fallback.knowledge_point || fallback.knowledgePoint || "",
    module_id: fallback.module_id || fallback.moduleId || "",
    module_label: fallback.module_label || fallback.moduleLabel || ""
  };
}

function sceneDisplayLabel(sceneType = "", fallback = "") {
  const id = String(sceneType || "").trim();
  return ({
    simulation: "动手调一调",
    game: "找错并改正",
    mindMap: "知识怎么连",
    diagram: "知识怎么连",
    visualization3d: "换个角度看"
  })[id] || publicCourseLabel(fallback) || "";
}

function tableHasColumn(d, tableName, columnName) {
  const stmt = d.prepare(`PRAGMA table_info(${tableName})`);
  let found = false;
  while (stmt.step()) {
    if (stmt.getAsObject().name === columnName) {
      found = true;
      break;
    }
  }
  stmt.free();
  return found;
}

function ensureLearningGenerationColumn(d, tableName) {
  if (tableHasColumn(d, tableName, "learning_generation")) return;
  d.run(`ALTER TABLE ${tableName} ADD COLUMN learning_generation INTEGER NOT NULL DEFAULT 1`);
  d.run(
    `UPDATE ${tableName}
     SET learning_generation = COALESCE(
       (SELECT generation
        FROM learning_state_versions
        WHERE learning_state_versions.user_id = ${tableName}.user_id),
       1
     )`
  );
}

function migrateLegacyLearningAssistantMessages(d) {
  const groups = [];
  const stmt = d.prepare(`
    SELECT
      m.user_id,
      m.thread_key,
      m.learning_generation,
      MIN(m.id) AS first_message_id,
      MIN(m.chapter_id) AS chapter_id,
      MIN(m.unit_id) AS unit_id,
      MIN(m.knowledge_point_id) AS knowledge_point_id,
      MIN(m.created_at) AS created_at,
      MAX(m.created_at) AS updated_at,
      COALESCE((
        SELECT first_user.content
        FROM learning_assistant_messages first_user
        WHERE first_user.user_id = m.user_id
          AND first_user.thread_key = m.thread_key
          AND first_user.learning_generation = m.learning_generation
          AND COALESCE(first_user.conversation_id, '') = ''
          AND first_user.role = 'user'
        ORDER BY first_user.created_at ASC, first_user.id ASC
        LIMIT 1
      ), '历史对话') AS title
    FROM learning_assistant_messages m
    WHERE COALESCE(m.conversation_id, '') = ''
    GROUP BY m.user_id, m.thread_key, m.learning_generation
  `);
  while (stmt.step()) groups.push(stmt.getAsObject());
  stmt.free();

  for (const group of groups) {
    const conversationId = `legacy:${group.first_message_id}`;
    const title = String(group.title || "历史对话").replace(/\s+/g, " ").trim().slice(0, 80) || "历史对话";
    d.run(
      `INSERT OR IGNORE INTO learning_assistant_conversations
        (id, user_id, thread_key, chapter_id, unit_id, knowledge_point_id,
         title, learning_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationId,
        group.user_id,
        group.thread_key,
        group.chapter_id || "",
        group.unit_id || "",
        group.knowledge_point_id || "",
        title,
        Number(group.learning_generation || 1),
        group.created_at || new Date().toISOString(),
        group.updated_at || group.created_at || new Date().toISOString()
      ]
    );
    d.run(
      `UPDATE learning_assistant_messages
       SET conversation_id = ?
       WHERE user_id = ? AND thread_key = ?
         AND learning_generation = ?
         AND COALESCE(conversation_id, '') = ''`,
      [conversationId, group.user_id, group.thread_key, Number(group.learning_generation || 1)]
    );
  }
}

function initSchema() {
  const d = getDbSync();
  d.run("PRAGMA foreign_keys = ON");
  d.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    )
  `);
  d.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    )
  `);
  d.run(`
    CREATE TABLE IF NOT EXISTS quiz_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      chapter_id TEXT NOT NULL,
      chapter_label TEXT DEFAULT '',
      unit_id TEXT NOT NULL,
      unit_label TEXT DEFAULT '',
      question_id TEXT NOT NULL,
      question_type TEXT DEFAULT '',
      phase TEXT DEFAULT '',
      points REAL DEFAULT 0,
      response TEXT NOT NULL DEFAULT '',
      is_correct INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT '',
      score REAL DEFAULT 0,
      max_score REAL DEFAULT 0,
      learning_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_qr_user ON quiz_results(user_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_qr_chapter ON quiz_results(chapter_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_qr_unit ON quiz_results(unit_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_qr_created ON quiz_results(created_at)");
  d.run("CREATE INDEX IF NOT EXISTS idx_qr_correct ON quiz_results(is_correct)");

  d.run(`
    CREATE TABLE IF NOT EXISTS learning_assistant_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      thread_key TEXT NOT NULL,
      conversation_id TEXT DEFAULT '',
      chapter_id TEXT DEFAULT '',
      unit_id TEXT NOT NULL,
      knowledge_point_id TEXT DEFAULT '',
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context_json TEXT DEFAULT '{}',
      provider TEXT DEFAULT '',
      quiz_submitted INTEGER NOT NULL DEFAULT 0,
      learning_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);
  try { d.run("ALTER TABLE learning_assistant_messages ADD COLUMN conversation_id TEXT DEFAULT ''"); } catch {}
  d.run("CREATE INDEX IF NOT EXISTS idx_lam_user_thread ON learning_assistant_messages(user_id, thread_key, created_at)");
  d.run("CREATE INDEX IF NOT EXISTS idx_lam_user_unit ON learning_assistant_messages(user_id, unit_id, created_at)");
  d.run("CREATE INDEX IF NOT EXISTS idx_lam_conversation ON learning_assistant_messages(user_id, conversation_id, created_at)");

  d.run(`
    CREATE TABLE IF NOT EXISTS learning_assistant_conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      thread_key TEXT NOT NULL,
      chapter_id TEXT DEFAULT '',
      unit_id TEXT NOT NULL,
      knowledge_point_id TEXT DEFAULT '',
      title TEXT NOT NULL DEFAULT '新对话',
      archived_at TEXT DEFAULT '',
      learning_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  try { d.run("ALTER TABLE learning_assistant_conversations ADD COLUMN archived_at TEXT DEFAULT ''"); } catch {}
  d.run("CREATE INDEX IF NOT EXISTS idx_lac_user_thread ON learning_assistant_conversations(user_id, thread_key, updated_at)");

  d.run(`
    CREATE TABLE IF NOT EXISTS learning_assistant_daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id),
      usage_date TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      intervention_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, usage_date)
    )
  `);
  try { d.run("ALTER TABLE learning_assistant_daily_usage ADD COLUMN intervention_count INTEGER NOT NULL DEFAULT 0"); } catch {}

  d.run(`
    CREATE TABLE IF NOT EXISTS learning_notes (
      id TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL REFERENCES users(id),
      thread_key TEXT NOT NULL,
      chapter_id TEXT DEFAULT '',
      unit_id TEXT NOT NULL,
      excerpt TEXT DEFAULT '',
      note TEXT DEFAULT '',
      color TEXT NOT NULL DEFAULT 'amber',
      context_json TEXT DEFAULT '{}',
      locator_json TEXT DEFAULT '{}',
      learning_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    )
  `);
  try { d.run("ALTER TABLE learning_notes ADD COLUMN client_id TEXT NOT NULL DEFAULT ''"); } catch {}
  d.run("UPDATE learning_notes SET client_id = id WHERE COALESCE(client_id, '') = ''");
  d.run("CREATE INDEX IF NOT EXISTS idx_learning_notes_user_unit ON learning_notes(user_id, unit_id, updated_at)");

  d.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      learning_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_ev_user ON events(user_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_ev_type ON events(type)");
  d.run("CREATE INDEX IF NOT EXISTS idx_ev_created ON events(created_at)");

  d.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      reason TEXT DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      generation INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_snap_user ON snapshots(user_id)");

  d.run(`
    CREATE TABLE IF NOT EXISTS learning_state_versions (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      generation INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  d.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      feedback_type TEXT NOT NULL,
      content TEXT NOT NULL,
      target_scope TEXT NOT NULL DEFAULT 'global',
      chapter_id TEXT DEFAULT '',
      module_id TEXT DEFAULT '',
      unit_id TEXT DEFAULT '',
      knowledge_point TEXT DEFAULT '',
      scene_type TEXT DEFAULT '',
      resource_file TEXT DEFAULT '',
      resource_title TEXT DEFAULT '',
      current_view TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)");
  d.run("CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(feedback_type)");

  d.run(`
    CREATE TABLE IF NOT EXISTS agent_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      decision_type TEXT DEFAULT '',
      input_summary TEXT DEFAULT '{}',
      output_summary TEXT DEFAULT '{}',
      confidence REAL DEFAULT 0,
      llm_provider TEXT DEFAULT '',
      latency_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_ad_user ON agent_decisions(user_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_ad_type ON agent_decisions(agent_type)");

  d.run(`
    CREATE TABLE IF NOT EXISTS interaction_evidence_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_decision_id TEXT DEFAULT '',
      chapter_id TEXT DEFAULT '',
      unit_id TEXT DEFAULT '',
      evidence_scope TEXT DEFAULT 'current',
      risk_level TEXT DEFAULT '',
      suggested_move TEXT DEFAULT '',
      friction_score REAL DEFAULT 0,
      engagement_score REAL DEFAULT 0,
      dwell_ms INTEGER DEFAULT 0,
      repeat_count INTEGER DEFAULT 0,
      answer_reveal_count INTEGER DEFAULT 0,
      short_answer_length INTEGER DEFAULT 0,
      parameter_change_count INTEGER DEFAULT 0,
      evidence_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_ies_decision ON interaction_evidence_snapshots(agent_decision_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_ies_user ON interaction_evidence_snapshots(user_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_ies_unit ON interaction_evidence_snapshots(unit_id)");
  d.run("CREATE INDEX IF NOT EXISTS idx_ies_created ON interaction_evidence_snapshots(created_at)");

  d.run(`
    CREATE TABLE IF NOT EXISTS grading_regrade_audits (
      id TEXT PRIMARY KEY,
      batch_id TEXT DEFAULT '',
      quiz_result_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      unit_id TEXT DEFAULT '',
      trigger_source TEXT NOT NULL DEFAULT 'admin',
      status TEXT NOT NULL,
      previous_grade_json TEXT NOT NULL DEFAULT '{}',
      proposed_grade_json TEXT NOT NULL DEFAULT '{}',
      applied_grade_json TEXT NOT NULL DEFAULT '{}',
      llm_provider TEXT DEFAULT '',
      llm_model TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_gra_quiz_result ON grading_regrade_audits(quiz_result_id, created_at)");
  d.run("CREATE INDEX IF NOT EXISTS idx_gra_user ON grading_regrade_audits(user_id, created_at)");

  try { d.run("ALTER TABLE users ADD COLUMN nickname_norm TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE users ADD COLUMN email_norm TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE users ADD COLUMN password_updated_at TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE users ADD COLUMN profile_updated_at TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE sessions ADD COLUMN expires_at TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE sessions ADD COLUMN revoked_at TEXT DEFAULT ''"); } catch {}
  try {
    d.run("UPDATE users SET nickname_norm = lower(trim(nickname)) WHERE (nickname_norm IS NULL OR nickname_norm = '') AND nickname <> ''");
    d.run("UPDATE users SET email = '' WHERE email IS NULL");
    d.run("UPDATE users SET email_norm = '' WHERE email_norm IS NULL");
    d.run("UPDATE users SET password_hash = '' WHERE password_hash IS NULL");
    d.run("UPDATE users SET password_updated_at = '' WHERE password_updated_at IS NULL");
    d.run("UPDATE users SET profile_updated_at = '' WHERE profile_updated_at IS NULL");
  } catch {}
  try {
    d.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_norm_unique ON users(nickname_norm) WHERE nickname_norm IS NOT NULL AND nickname_norm <> ''");
  } catch (error) {
    console.warn("Skipping users.nickname_norm unique index because existing data contains duplicates:", error.message);
  }
  try {
    d.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_norm_unique ON users(email_norm) WHERE email_norm IS NOT NULL AND email_norm <> ''");
  } catch (error) {
    console.warn("Skipping users.email_norm unique index because existing data contains duplicates:", error.message);
  }
  d.run("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");

  try { d.run("ALTER TABLE quiz_results ADD COLUMN ai_score REAL"); } catch {}
  try { d.run("ALTER TABLE quiz_results ADD COLUMN ai_confidence REAL"); } catch {}
  try { d.run("ALTER TABLE quiz_results ADD COLUMN ai_feedback TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE quiz_results ADD COLUMN ai_error_type TEXT DEFAULT ''"); } catch {}
  try { d.run("ALTER TABLE grading_regrade_audits ADD COLUMN batch_id TEXT DEFAULT ''"); } catch {}
  d.run("CREATE INDEX IF NOT EXISTS idx_gra_batch ON grading_regrade_audits(batch_id, created_at)");
  ensureLearningGenerationColumn(d, "quiz_results");
  ensureLearningGenerationColumn(d, "learning_assistant_messages");
  ensureLearningGenerationColumn(d, "learning_assistant_conversations");
  ensureLearningGenerationColumn(d, "learning_notes");
  ensureLearningGenerationColumn(d, "events");
  try { d.run("ALTER TABLE snapshots ADD COLUMN generation INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { d.run("ALTER TABLE snapshots ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"); } catch {}
  migrateLegacyLearningAssistantMessages(d);
  d.run("CREATE INDEX IF NOT EXISTS idx_snap_user_version ON snapshots(user_id, generation, revision)");
  d.run("CREATE INDEX IF NOT EXISTS idx_qr_user_generation ON quiz_results(user_id, learning_generation)");
  d.run("CREATE INDEX IF NOT EXISTS idx_ev_user_generation ON events(user_id, learning_generation)");
  d.run("CREATE INDEX IF NOT EXISTS idx_lam_user_generation ON learning_assistant_messages(user_id, learning_generation)");
  d.run("CREATE INDEX IF NOT EXISTS idx_lac_user_generation ON learning_assistant_conversations(user_id, learning_generation)");
  d.run("CREATE INDEX IF NOT EXISTS idx_notes_user_generation ON learning_notes(user_id, learning_generation)");
  d.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_user_generation_client ON learning_notes(user_id, learning_generation, client_id)");

  scheduleSave();
}

function queryOne(sql, params = []) {
  const d = getDbSync();
  const stmt = d.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(sql, params = []) {
  const d = getDbSync();
  const stmt = d.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function execute(sql, params = []) {
  const d = getDbSync();
  d.run(sql, params);
  scheduleSave();
}

// ---- Users ----

function normalizeIdentity(value = "") {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function upsertUser(id, nickname, createdAt, lastSeenAt, options = {}) {
  const existing = queryOne("SELECT * FROM users WHERE id = ?", [id]);
  const finalNickname = options.nickname !== undefined
    ? options.nickname
    : nickname !== undefined
      ? nickname
      : existing?.nickname || "";
  const finalEmail = options.email !== undefined ? options.email : existing?.email || "";
  const finalNicknameNorm = options.nicknameNorm !== undefined
    ? options.nicknameNorm
    : normalizeIdentity(finalNickname);
  const finalEmailNorm = options.emailNorm !== undefined
    ? options.emailNorm
    : normalizeIdentity(finalEmail);
  const finalPasswordHash = options.passwordHash !== undefined
    ? options.passwordHash
    : existing?.password_hash || "";
  const finalPasswordUpdatedAt = options.passwordUpdatedAt !== undefined
    ? options.passwordUpdatedAt
    : existing?.password_updated_at || "";
  const finalProfileUpdatedAt = options.profileUpdatedAt !== undefined
    ? options.profileUpdatedAt
    : existing?.profile_updated_at || "";

  if (existing) {
    execute(
      `UPDATE users
       SET nickname = ?, nickname_norm = ?, email = ?, email_norm = ?,
           password_hash = ?, password_updated_at = ?, profile_updated_at = ?, last_seen_at = ?
       WHERE id = ?`,
      [
        finalNickname,
        finalNicknameNorm,
        finalEmail,
        finalEmailNorm,
        finalPasswordHash,
        finalPasswordUpdatedAt,
        finalProfileUpdatedAt,
        lastSeenAt,
        id
      ]
    );
    return;
  }
  execute(
    `INSERT INTO users
      (id, nickname, nickname_norm, email, email_norm, password_hash, password_updated_at, profile_updated_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      finalNickname,
      finalNicknameNorm,
      finalEmail,
      finalEmailNorm,
      finalPasswordHash,
      finalPasswordUpdatedAt,
      finalProfileUpdatedAt,
      createdAt,
      lastSeenAt
    ]
  );
}

function getUser(id) {
  return queryOne("SELECT * FROM users WHERE id = ?", [id]);
}

function getUserByNicknameNorm(nicknameNorm) {
  if (!nicknameNorm) return null;
  return queryOne("SELECT * FROM users WHERE nickname_norm = ?", [nicknameNorm]);
}

function getUsersByNicknameNorm(nicknameNorm) {
  if (!nicknameNorm) return [];
  return queryAll("SELECT * FROM users WHERE nickname_norm = ?", [nicknameNorm]);
}

function getUserByEmailNorm(emailNorm) {
  if (!emailNorm) return null;
  return queryOne("SELECT * FROM users WHERE email_norm = ?", [emailNorm]);
}

function getUsersByEmailNorm(emailNorm) {
  if (!emailNorm) return [];
  return queryAll("SELECT * FROM users WHERE email_norm = ?", [emailNorm]);
}

function updateUserProfile(id, fields = {}) {
  const existing = getUser(id);
  if (!existing) return null;
  upsertUser(id, existing.nickname || "", existing.created_at || "", fields.lastSeenAt || existing.last_seen_at || "", {
    nickname: fields.nickname !== undefined ? fields.nickname : existing.nickname || "",
    nicknameNorm: fields.nicknameNorm !== undefined ? fields.nicknameNorm : existing.nickname_norm || "",
    email: fields.email !== undefined ? fields.email : existing.email || "",
    emailNorm: fields.emailNorm !== undefined ? fields.emailNorm : existing.email_norm || "",
    passwordHash: fields.passwordHash !== undefined ? fields.passwordHash : existing.password_hash || "",
    passwordUpdatedAt: fields.passwordUpdatedAt !== undefined ? fields.passwordUpdatedAt : existing.password_updated_at || "",
    profileUpdatedAt: fields.profileUpdatedAt !== undefined ? fields.profileUpdatedAt : existing.profile_updated_at || ""
  });
  return getUser(id);
}

// ---- Sessions ----

function createSession(token, userId, createdAt, expiresAt = "") {
  execute(
    "INSERT OR REPLACE INTO sessions (token, user_id, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, '')",
    [token, userId, createdAt, createdAt, expiresAt]
  );
}

function getSession(token) {
  return queryOne("SELECT * FROM sessions WHERE token = ?", [token]);
}

function touchSession(token, timestamp) {
  execute("UPDATE sessions SET last_seen_at = ? WHERE token = ?", [timestamp, token]);
}

function revokeSession(token, timestamp) {
  execute("UPDATE sessions SET revoked_at = ?, last_seen_at = ? WHERE token = ?", [timestamp, timestamp, token]);
}

function currentLearningGeneration(userId, timestamp = new Date().toISOString()) {
  return Number(ensureLearningStateVersion(userId, timestamp).generation);
}

// ---- Quiz Results ----

function insertQuizResult(record) {
  const generation = Number(record.learning_generation || currentLearningGeneration(record.user_id, record.created_at));
  execute(
    `INSERT OR REPLACE INTO quiz_results
      (id, user_id, chapter_id, chapter_label, unit_id, unit_label,
       question_id, question_type, phase, points, response, is_correct,
       status, score, max_score, learning_generation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, record.user_id, record.chapter_id, record.chapter_label || "",
      record.unit_id, record.unit_label || "", record.question_id,
      record.question_type || "", record.phase || "", record.points || 0,
      typeof record.response === "string" ? record.response : JSON.stringify(record.response),
      typeof record.is_correct === "number" ? record.is_correct : (record.is_correct ? 1 : 0), record.status || "",
      record.score || 0, record.max_score || 0, generation, record.created_at
    ]
  );
}

function normalizedQuizResultResponse(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function finiteQuizValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function incomingQuizReviewIsGraded(record = {}) {
  const aiScore = record.ai_score ?? record.aiScore;
  const rawErrorType = String(record.ai_error_type ?? record.aiErrorType ?? "").trim().toLowerCase();
  const errorType = ["", "none", "no_error"].includes(rawErrorType) ? "" : rawErrorType;
  const feedback = String(record.ai_feedback ?? record.aiFeedback ?? "").trim();
  const status = String(record.status || "").trim().toLowerCase();
  return finiteQuizValue(aiScore) !== null
    || Boolean(errorType)
    || status === "ai_reviewed"
    || Boolean(record.fallbackScored)
    || feedback !== "";
}

function existingQuizResultNeedsReview(row = {}) {
  if (String(row.question_type || "").trim().toLowerCase() !== "short_answer") return false;
  const errorType = String(row.ai_error_type || "").trim().toLowerCase();
  const feedback = String(row.ai_feedback || "");
  return row.status === "pending_review"
    || Number(row.is_correct) === -1
    || FAILED_AI_REVIEW_TYPES.includes(errorType)
    || row.ai_score == null
    || row.ai_confidence == null
    || Number(row.ai_confidence) < AI_REVIEW_CONFIDENCE_THRESHOLD
    || LEGACY_AI_REVIEW_FAILURE_PATTERNS.some((pattern) => feedback.includes(pattern));
}

function reconciledQuizResultParams(record = {}) {
  const isCorrect = Number(record.is_correct);
  const aiScore = finiteQuizValue(record.ai_score);
  const aiConfidence = finiteQuizValue(record.ai_confidence);
  return [
    record.id,
    record.user_id,
    record.chapter_id || "",
    record.chapter_label || "",
    record.unit_id,
    record.unit_label || "",
    record.question_id,
    record.question_type || "",
    record.phase || "",
    finiteQuizValue(record.points) ?? 0,
    normalizedQuizResultResponse(record.response),
    isCorrect === -1 ? -1 : isCorrect === 1 ? 1 : 0,
    record.status || "",
    finiteQuizValue(record.score) ?? 0,
    finiteQuizValue(record.max_score) ?? finiteQuizValue(record.points) ?? 0,
    Number(record.learning_generation),
    record.created_at,
    aiScore,
    aiConfidence,
    String(record.ai_feedback || "").slice(0, 4000),
    String(record.ai_error_type || "").trim().toLowerCase()
  ];
}

function reconcileQuizResults(records = []) {
  const candidates = Array.isArray(records) ? records : [];
  const d = getDbSync();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set();
  d.run("BEGIN IMMEDIATE");
  try {
    for (const record of candidates) {
      const userId = String(record?.user_id || "").trim();
      const generation = Number(record?.learning_generation);
      const unitId = String(record?.unit_id || "").trim();
      const questionId = String(record?.question_id || "").trim();
      const id = String(record?.id || "").trim();
      const logicalKey = `${userId}\u001f${generation}\u001f${unitId}\u001f${questionId}`;
      if (
        !userId
        || !id
        || !Number.isInteger(generation)
        || generation < 1
        || !unitId
        || !questionId
        || !record?.created_at
        || seen.has(logicalKey)
      ) {
        skipped += 1;
        continue;
      }
      seen.add(logicalKey);

      const existing = queryOne(
        `SELECT * FROM quiz_results
         WHERE user_id = ? AND learning_generation = ? AND unit_id = ? AND question_id = ?
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        [userId, generation, unitId, questionId]
      );

      // The client id is not the logical identity of a result.  Never attach a
      // snapshot row to a different logical result just because its id collides.
      if (!existing && queryOne("SELECT id FROM quiz_results WHERE id = ?", [id])) {
        skipped += 1;
        continue;
      }

      if (!existing) {
        d.run(
          `INSERT INTO quiz_results
            (id, user_id, chapter_id, chapter_label, unit_id, unit_label,
             question_id, question_type, phase, points, response, is_correct,
             status, score, max_score, learning_generation, created_at,
             ai_score, ai_confidence, ai_feedback, ai_error_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          reconciledQuizResultParams(record)
        );
        inserted += 1;
        continue;
      }

      if (
        existingQuizResultNeedsReview(existing)
        && String(existing.question_type || record.question_type || "").trim().toLowerCase() === "short_answer"
        && incomingQuizReviewIsGraded(record)
      ) {
        const aiScore = finiteQuizValue(record.ai_score);
        const aiConfidence = finiteQuizValue(record.ai_confidence);
        const score = finiteQuizValue(record.score) ?? 0;
        const isCorrect = Number(record.is_correct) === 1 ? 1 : 0;
        const status = record.status || "ai_reviewed";
        const feedback = String(record.ai_feedback || "").slice(0, 4000);
        const errorType = String(record.ai_error_type || "").trim().toLowerCase();
        const unchanged = (existing.ai_score == null ? null : Number(existing.ai_score)) === aiScore
          && (existing.ai_confidence == null ? null : Number(existing.ai_confidence)) === aiConfidence
          && String(existing.ai_feedback || "") === feedback
          && String(existing.ai_error_type || "").trim().toLowerCase() === errorType
          && Number(existing.is_correct) === isCorrect
          && String(existing.status || "") === status
          && (existing.score == null ? 0 : Number(existing.score)) === score;
        if (unchanged) {
          skipped += 1;
          continue;
        }
        d.run(
          `UPDATE quiz_results
           SET ai_score = ?, ai_confidence = ?, ai_feedback = ?, ai_error_type = ?,
               is_correct = ?, status = ?, score = ?
           WHERE id = ?`,
          [
            aiScore,
            aiConfidence,
            feedback,
            errorType,
            isCorrect,
            status,
            score,
            existing.id
          ]
        );
        updated += 1;
      } else {
        skipped += 1;
      }
    }
    d.run("COMMIT");
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
  if (inserted || updated) scheduleSave();
  return { inserted, updated, skipped, total: candidates.length };
}

function getQuizResultsByUser(userId, limit = 200) {
  const generation = currentLearningGeneration(userId);
  return queryAll(
    `SELECT * FROM quiz_results
     WHERE user_id = ? AND learning_generation = ?
     ORDER BY created_at DESC LIMIT ?`,
    [userId, generation, limit]
  );
}

function getQuizResultsByUserUnit(userId, unitId) {
  const generation = currentLearningGeneration(userId);
  return queryAll(
    `SELECT * FROM quiz_results
     WHERE user_id = ? AND learning_generation = ? AND unit_id = ?
     ORDER BY created_at DESC`,
    [userId, generation, unitId]
  );
}

function getQuizResultById(id) {
  return queryOne("SELECT * FROM quiz_results WHERE id = ?", [id]);
}

// ---- Learning Assistant ----

const LEARNING_ASSISTANT_MESSAGE_INSERT = `INSERT INTO learning_assistant_messages
  (id, user_id, thread_key, conversation_id, chapter_id, unit_id,
   knowledge_point_id, role, content, context_json, provider,
   quiz_submitted, learning_generation, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const LEARNING_ASSISTANT_CONVERSATION_INSERT = `INSERT INTO learning_assistant_conversations
  (id, user_id, thread_key, chapter_id, unit_id, knowledge_point_id,
   title, learning_generation, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function learningAssistantMessageValues(record) {
  return [
    record.id,
    record.user_id,
    record.thread_key,
    record.conversation_id || "",
    record.chapter_id || "",
    record.unit_id,
    record.knowledge_point_id || "",
    record.role,
    record.content,
    JSON.stringify(record.context || {}),
    record.provider || "",
    record.quiz_submitted ? 1 : 0,
    Number(record.learning_generation || currentLearningGeneration(record.user_id, record.created_at)),
    record.created_at
  ];
}

function learningAssistantConversationValues(record) {
  return [
    record.id,
    record.user_id,
    record.thread_key,
    record.chapter_id || "",
    record.unit_id,
    record.knowledge_point_id || "",
    String(record.title || "新对话").slice(0, 80),
    Number(record.learning_generation || currentLearningGeneration(record.user_id, record.created_at)),
    record.created_at,
    record.updated_at || record.created_at
  ];
}

function getLearningAssistantMessages(userId, threadKey, limit = 80, conversationId = "") {
  const conversation = String(conversationId || "").trim();
  const generation = currentLearningGeneration(userId);
  const rows = queryAll(
    `SELECT * FROM learning_assistant_messages
     WHERE user_id = ? AND learning_generation = ? AND thread_key = ?
       ${conversation ? "AND conversation_id = ?" : ""}
     ORDER BY julianday(created_at) DESC, id DESC
     LIMIT ?`,
    [
      userId,
      generation,
      threadKey,
      ...(conversation ? [conversation] : []),
      Math.max(1, Math.min(Number(limit || 80), 200))
    ]
  );
  return rows.reverse();
}

function getLearningAssistantMessage(userId, messageId) {
  const generation = currentLearningGeneration(userId);
  return queryOne(
    `SELECT * FROM learning_assistant_messages
     WHERE user_id = ? AND learning_generation = ? AND id = ?`,
    [userId, generation, String(messageId || "").trim()]
  );
}

function updateLearningAssistantMessageContext(userId, messageId, context = {}) {
  const existing = getLearningAssistantMessage(userId, messageId);
  if (!existing) return null;
  execute(
    `UPDATE learning_assistant_messages
     SET context_json = ?
     WHERE user_id = ? AND learning_generation = ? AND id = ?`,
    [
      JSON.stringify(context && typeof context === "object" ? context : {}),
      userId,
      existing.learning_generation,
      messageId
    ]
  );
  return getLearningAssistantMessage(userId, messageId);
}

function saveLearningAssistantTurn({
  conversation,
  createConversation = false,
  userMessage,
  assistantMessage,
  title = "",
  updatedAt = new Date().toISOString()
}) {
  if (!conversation?.id || !userMessage?.content || !assistantMessage?.content) {
    throw new Error("A complete learning assistant turn is required before persistence.");
  }
  const d = getDbSync();
  d.run("BEGIN IMMEDIATE");
  try {
    if (createConversation) {
      d.run(
        LEARNING_ASSISTANT_CONVERSATION_INSERT,
        learningAssistantConversationValues(conversation)
      );
    }
    d.run(LEARNING_ASSISTANT_MESSAGE_INSERT, learningAssistantMessageValues(userMessage));
    d.run(LEARNING_ASSISTANT_MESSAGE_INSERT, learningAssistantMessageValues(assistantMessage));
    const safeTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 80);
    d.run(
      `UPDATE learning_assistant_conversations
       SET title = CASE WHEN ? <> '' THEN ? ELSE title END,
           updated_at = ?
       WHERE user_id = ? AND learning_generation = ? AND id = ?`,
      [
        safeTitle,
        safeTitle,
        updatedAt,
        conversation.user_id,
        Number(conversation.learning_generation || currentLearningGeneration(conversation.user_id, updatedAt)),
        conversation.id
      ]
    );
    d.run("COMMIT");
    scheduleSave();
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

function getLearningAssistantConversation(userId, conversationId) {
  const generation = currentLearningGeneration(userId);
  return queryOne(
    `SELECT c.*,
      (SELECT COUNT(*) FROM learning_assistant_messages m
       WHERE m.user_id = c.user_id
         AND m.learning_generation = c.learning_generation
         AND m.conversation_id = c.id) AS message_count
     FROM learning_assistant_conversations c
     WHERE c.user_id = ? AND c.learning_generation = ? AND c.id = ?`,
    [userId, generation, conversationId]
  );
}

function listLearningAssistantConversations(userId, threadKey, limit = 60, options = {}) {
  const archived = options.archived === true;
  const searchQuery = String(options.query || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const escapedSearch = searchQuery.replace(/[\\%_]/g, "\\$&");
  const generation = currentLearningGeneration(userId);
  const searchClause = escapedSearch
    ? `AND (
        c.title LIKE ? ESCAPE '\\'
        OR EXISTS (
           SELECT 1 FROM learning_assistant_messages search_message
           WHERE search_message.user_id = c.user_id
             AND search_message.learning_generation = c.learning_generation
             AND search_message.conversation_id = c.id
            AND search_message.content LIKE ? ESCAPE '\\'
        )
      )`
    : "";
  return queryAll(
    `SELECT c.*,
      (SELECT COUNT(*) FROM learning_assistant_messages m
       WHERE m.user_id = c.user_id
         AND m.learning_generation = c.learning_generation
         AND m.conversation_id = c.id) AS message_count
     FROM learning_assistant_conversations c
     WHERE c.user_id = ? AND c.learning_generation = ? AND c.thread_key = ?
       AND ${archived ? "COALESCE(c.archived_at, '') <> ''" : "COALESCE(c.archived_at, '') = ''"}
       ${searchClause}
     ORDER BY c.updated_at DESC, c.created_at DESC
     LIMIT ?`,
    [
      userId,
      generation,
      threadKey,
      ...(escapedSearch ? [`%${escapedSearch}%`, `%${escapedSearch}%`] : []),
      Math.max(1, Math.min(Number(limit || 60), 100))
    ]
  );
}

function renameLearningAssistantConversation(userId, conversationId, title, updatedAt) {
  const existing = getLearningAssistantConversation(userId, conversationId);
  if (!existing) return null;
  execute(
    `UPDATE learning_assistant_conversations
     SET title = ?, updated_at = ?
     WHERE user_id = ? AND learning_generation = ? AND id = ?`,
    [String(title || "").slice(0, 80), updatedAt, userId, existing.learning_generation, conversationId]
  );
  return getLearningAssistantConversation(userId, conversationId);
}

function setLearningAssistantConversationArchived(userId, conversationId, archivedAt, updatedAt) {
  const existing = getLearningAssistantConversation(userId, conversationId);
  if (!existing) return null;
  execute(
    `UPDATE learning_assistant_conversations
     SET archived_at = ?, updated_at = ?
     WHERE user_id = ? AND learning_generation = ? AND id = ?`,
    [archivedAt || "", updatedAt, userId, existing.learning_generation, conversationId]
  );
  return getLearningAssistantConversation(userId, conversationId);
}

function deleteLearningAssistantConversation(userId, conversationId) {
  const existing = getLearningAssistantConversation(userId, conversationId);
  if (!existing) return false;
  const d = getDbSync();
  d.run("BEGIN IMMEDIATE");
  try {
    d.run(
      `DELETE FROM learning_assistant_messages
       WHERE user_id = ? AND learning_generation = ? AND conversation_id = ?`,
      [userId, existing.learning_generation, conversationId]
    );
    d.run(
      `DELETE FROM learning_assistant_conversations
       WHERE user_id = ? AND learning_generation = ? AND id = ?`,
      [userId, existing.learning_generation, conversationId]
    );
    d.run("COMMIT");
    scheduleSave();
    return true;
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

function getLearningAssistantDailyUsage(userId, usageDate) {
  const row = queryOne(
    `SELECT request_count, intervention_count, updated_at
     FROM learning_assistant_daily_usage
     WHERE user_id = ? AND usage_date = ?`,
    [userId, usageDate]
  );
  return {
    requestCount: Number(row?.request_count || 0),
    interventionCount: Number(row?.intervention_count || 0),
    updatedAt: row?.updated_at || ""
  };
}

function consumeLearningAssistantDailyQuota(userId, usageDate, limit, updatedAt) {
  const safeLimit = Math.max(0, Number(limit || 0));
  const d = getDbSync();
  d.run("BEGIN IMMEDIATE");
  try {
    const current = getLearningAssistantDailyUsage(userId, usageDate);
    if (current.requestCount >= safeLimit) {
      d.run("ROLLBACK");
      return {
        ok: false,
        used: current.requestCount,
        remaining: 0,
        limit: safeLimit
      };
    }
    const nextCount = current.requestCount + 1;
    d.run(
      `INSERT INTO learning_assistant_daily_usage
        (user_id, usage_date, request_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, usage_date) DO UPDATE SET
         request_count = excluded.request_count,
         updated_at = excluded.updated_at`,
      [userId, usageDate, nextCount, updatedAt]
    );
    d.run("COMMIT");
    scheduleSave();
    return {
      ok: true,
      used: nextCount,
      remaining: Math.max(0, safeLimit - nextCount),
      limit: safeLimit
    };
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

function consumeLearningAssistantInterventionBudget(userId, usageDate, limit, updatedAt) {
  const safeLimit = Math.max(0, Number(limit || 0));
  const d = getDbSync();
  d.run("BEGIN IMMEDIATE");
  try {
    const current = getLearningAssistantDailyUsage(userId, usageDate);
    if (current.interventionCount >= safeLimit) {
      d.run("ROLLBACK");
      return {
        ok: false,
        used: current.interventionCount,
        remaining: 0,
        limit: safeLimit
      };
    }
    const nextCount = current.interventionCount + 1;
    d.run(
      `INSERT INTO learning_assistant_daily_usage
        (user_id, usage_date, request_count, intervention_count, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(user_id, usage_date) DO UPDATE SET
         intervention_count = excluded.intervention_count,
         updated_at = excluded.updated_at`,
      [userId, usageDate, nextCount, updatedAt]
    );
    d.run("COMMIT");
    scheduleSave();
    return {
      ok: true,
      used: nextCount,
      remaining: Math.max(0, safeLimit - nextCount),
      limit: safeLimit
    };
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

function releaseLearningAssistantDailyQuota(userId, usageDate, limit, updatedAt) {
  const safeLimit = Math.max(0, Number(limit || 0));
  const d = getDbSync();
  d.run("BEGIN IMMEDIATE");
  try {
    const current = getLearningAssistantDailyUsage(userId, usageDate);
    const nextCount = Math.max(0, current.requestCount - 1);
    if (current.requestCount > 0) {
      d.run(
        `UPDATE learning_assistant_daily_usage
         SET request_count = ?, updated_at = ?
         WHERE user_id = ? AND usage_date = ?`,
        [nextCount, updatedAt, userId, usageDate]
      );
    }
    d.run("COMMIT");
    scheduleSave();
    return {
      ok: true,
      used: nextCount,
      remaining: Math.max(0, safeLimit - nextCount),
      limit: safeLimit
    };
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

const LEARNING_NOTE_UPSERT = `INSERT INTO learning_notes
  (id, client_id, user_id, thread_key, chapter_id, unit_id, excerpt, note, color,
   context_json, locator_json, learning_generation, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, id) DO UPDATE SET
   client_id = excluded.client_id,
   thread_key = excluded.thread_key,
   chapter_id = excluded.chapter_id,
   unit_id = excluded.unit_id,
   excerpt = excluded.excerpt,
   note = excluded.note,
    color = excluded.color,
    context_json = excluded.context_json,
    locator_json = excluded.locator_json,
    learning_generation = excluded.learning_generation,
    updated_at = excluded.updated_at
 WHERE excluded.learning_generation = learning_notes.learning_generation
   AND excluded.updated_at >= learning_notes.updated_at`;

function learningNoteValues(record) {
  const generation = Number(record.learning_generation || currentLearningGeneration(record.user_id, record.updated_at));
  const clientId = String(record.client_id || record.id || "");
  const storageId = generation > 1 ? `g${generation}:${clientId}` : clientId;
  return [
    storageId,
    clientId,
    record.user_id,
    record.thread_key,
    record.chapter_id || "",
    record.unit_id,
    record.excerpt || "",
    record.note || "",
    record.color || "amber",
    JSON.stringify(record.context || {}),
    JSON.stringify(record.locator || {}),
    generation,
    record.created_at,
    record.updated_at
  ];
}

function getLearningNote(userId, noteId) {
  const generation = currentLearningGeneration(userId);
  return queryOne(
    `SELECT * FROM learning_notes
     WHERE user_id = ? AND learning_generation = ? AND client_id = ?`,
    [userId, generation, noteId]
  );
}

function listLearningNotes(userId, unitId = "", limit = 500) {
  const normalizedUnitId = String(unitId || "").trim();
  const generation = currentLearningGeneration(userId);
  return queryAll(
    `SELECT * FROM learning_notes
     WHERE user_id = ? AND learning_generation = ?
       ${normalizedUnitId ? "AND unit_id = ?" : ""}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT ?`,
    [
      userId,
      generation,
      ...(normalizedUnitId ? [normalizedUnitId] : []),
      Math.max(1, Math.min(Number(limit || 500), 500))
    ]
  );
}

function upsertLearningNote(record) {
  execute(LEARNING_NOTE_UPSERT, learningNoteValues(record));
  return getLearningNote(record.user_id, record.id);
}

function syncLearningNotes(userId, records = [], deletedIds = []) {
  const generation = currentLearningGeneration(userId);
  const d = getDbSync();
  d.run("BEGIN IMMEDIATE");
  try {
    records.forEach((record) => {
      if (record.user_id !== userId) throw new Error("Learning note owner mismatch.");
      d.run(LEARNING_NOTE_UPSERT, learningNoteValues({ ...record, learning_generation: generation }));
    });
    deletedIds.forEach((noteId) => {
      d.run(
        `DELETE FROM learning_notes
         WHERE user_id = ? AND learning_generation = ? AND client_id = ?`,
        [userId, generation, noteId]
      );
    });
    d.run("COMMIT");
    scheduleSave();
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

function deleteLearningNote(userId, noteId) {
  const existing = getLearningNote(userId, noteId);
  if (!existing) return false;
  execute(
    `DELETE FROM learning_notes
     WHERE user_id = ? AND learning_generation = ? AND client_id = ?`,
    [userId, existing.learning_generation, noteId]
  );
  return true;
}

// ---- Events ----

function insertEvent(record) {
  const generation = Number(record.learning_generation || currentLearningGeneration(record.user_id, record.created_at));
  execute(
    `INSERT OR IGNORE INTO events
      (id, user_id, type, payload, learning_generation, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.user_id,
      record.type,
      JSON.stringify(record.payload || {}),
      generation,
      record.created_at
    ]
  );
}

// ---- Agent Decisions ----

function insertAgentDecision(record) {
  execute(
    "INSERT OR REPLACE INTO agent_decisions (id, user_id, agent_type, decision_type, input_summary, output_summary, confidence, llm_provider, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [record.id, record.user_id, record.agent_type, record.decision_type || "", JSON.stringify(record.input_summary || {}), JSON.stringify(record.output_summary || {}), record.confidence || 0, record.llm_provider || "", record.latency_ms || 0, record.created_at]
  );
}

function insertInteractionEvidenceSnapshot(record) {
  const evidence = record.evidence && typeof record.evidence === "object" ? record.evidence : {};
  execute(
    `INSERT OR REPLACE INTO interaction_evidence_snapshots
      (id, user_id, agent_decision_id, chapter_id, unit_id, evidence_scope,
       risk_level, suggested_move, friction_score, engagement_score, dwell_ms,
       repeat_count, answer_reveal_count, short_answer_length, parameter_change_count,
       evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, record.user_id, record.agent_decision_id || "",
      record.chapter_id || evidence.chapterId || "", record.unit_id || evidence.unitId || "",
      record.evidence_scope || "current", evidence.riskLevel || "", evidence.suggestedMove || "",
      Number(evidence.frictionScore || 0), Number(evidence.engagementScore || 0),
      Math.round(Number(evidence.dwellMs || 0)), Number(evidence.repeatCount || 0),
      Number(evidence.answerRevealCount || 0), Number(evidence.shortAnswerLength || 0),
      Number(evidence.parameterChangeCount || 0), JSON.stringify(evidence), record.created_at
    ]
  );
}

function insertInteractionEvidenceBatch(userId, decisionId, chapterId, interactionEvidence, createdAt) {
  if (!userId || !interactionEvidence || typeof interactionEvidence !== "object") return;
  const current = interactionEvidence.current && typeof interactionEvidence.current === "object"
    ? [interactionEvidence.current]
    : [];
  const chapter = Array.isArray(interactionEvidence.chapter) ? interactionEvidence.chapter : [];
  const rows = [
    ...current.map((evidence) => ({ evidence, scope: "current" })),
    ...chapter.map((evidence) => ({ evidence, scope: "chapter" }))
  ];
  rows.forEach((row, index) => {
    insertInteractionEvidenceSnapshot({
      id: `${decisionId || createdAt}-${row.scope}-${index}`,
      user_id: userId,
      agent_decision_id: decisionId || "",
      chapter_id: chapterId || row.evidence?.chapterId || "",
      unit_id: row.evidence?.unitId || "",
      evidence_scope: row.scope,
      evidence: row.evidence,
      created_at: createdAt
    });
  });
}

function updateQuizResultAiGrading(questionId, userId, {
  aiScore,
  aiConfidence,
  aiFeedback,
  aiErrorType,
  unitId = "",
  learningGeneration
}) {
  const unitScope = unitId ? " AND unit_id = ?" : "";
  const unitParams = unitId ? [unitId] : [];
  const generation = Number(
    learningGeneration || currentLearningGeneration(userId)
  );
  const generationScope = " AND learning_generation = ?";
  const retryablePlaceholders = FAILED_AI_REVIEW_TYPES.map(() => "?").join(", ");
  const reviewableScope = `${generationScope} AND (is_correct = -1 OR lower(trim(COALESCE(ai_error_type, ''))) IN (${retryablePlaceholders}))`;
  const reviewableParams = [...unitParams, generation, ...FAILED_AI_REVIEW_TYPES];
  const normalizedErrorType = String(aiErrorType || "").trim().toLowerCase();
  let resolvedScore = aiScore;
  let resolvedFeedback = aiFeedback || "";

  if (resolvedScore == null && FAILED_AI_REVIEW_TYPES.includes(normalizedErrorType)) {
    resolvedScore = 0;
    if (!/已先按 0 分计入|可以继续学习/.test(resolvedFeedback)) {
      const feedbackPrefix = String(resolvedFeedback || "").replace(/[。.!！？?\s]+$/u, "");
      resolvedFeedback = feedbackPrefix
        ? `${feedbackPrefix}${FAILED_AI_REVIEW_SUFFIX}`
        : FAILED_AI_REVIEW_SUFFIX.slice(1);
    }
  }

  // Keep genuinely unresolved reviews pending when no explicit failure was reported.
  if (resolvedScore == null) {
    execute(
      `UPDATE quiz_results SET ai_confidence = ?, ai_feedback = ?, ai_error_type = ? WHERE question_id = ? AND user_id = ?${unitScope}${reviewableScope}`,
      [aiConfidence || 0, resolvedFeedback, normalizedErrorType, questionId, userId, ...reviewableParams]
    );
    return;
  }
  const existing = queryOne(
    `SELECT max_score FROM quiz_results WHERE question_id = ? AND user_id = ?${unitScope}${reviewableScope} ORDER BY created_at DESC LIMIT 1`,
    [questionId, userId, ...reviewableParams]
  );
  if (!existing) return;
  const maxScore = Number(existing?.max_score || 0);
  const rawScore = Number(resolvedScore);
  const earnedScore = maxScore
    ? Math.round(Math.max(0, Math.min(maxScore, rawScore)) * 10) / 10
    : rawScore;
  const passScore = maxScore ? maxScore * 0.6 : 60;
  execute(
    `UPDATE quiz_results SET ai_score = ?, ai_confidence = ?, ai_feedback = ?, ai_error_type = ?, is_correct = CASE WHEN ? >= ? THEN 1 ELSE 0 END, status = 'ai_reviewed', score = ? WHERE question_id = ? AND user_id = ?${unitScope}${reviewableScope}`,
    [resolvedScore, aiConfidence || 0, resolvedFeedback, normalizedErrorType, earnedScore, passScore, earnedScore, questionId, userId, ...reviewableParams]
  );
}

function failedAiReviewWhere(alias = "qr") {
  const prefix = alias ? `${alias}.` : "";
  const typePlaceholders = FAILED_AI_REVIEW_TYPES.map(() => "?").join(", ");
  const feedbackClauses = LEGACY_AI_REVIEW_FAILURE_PATTERNS
    .map(() => `${prefix}ai_feedback LIKE ?`)
    .join(" OR ");
  return {
    clause: `(
      ${prefix}status = 'pending_review'
      OR ${prefix}is_correct = -1
      OR lower(trim(COALESCE(${prefix}ai_error_type, ''))) IN (${typePlaceholders})
      OR ${prefix}ai_score IS NULL
      OR (
        ${prefix}ai_score IS NOT NULL
        AND (
          ${prefix}ai_confidence IS NULL
          OR ${prefix}ai_confidence < ?
        )
      )
      OR ${feedbackClauses}
    )`,
    params: [
      ...FAILED_AI_REVIEW_TYPES,
      AI_REVIEW_CONFIDENCE_THRESHOLD,
      ...LEGACY_AI_REVIEW_FAILURE_PATTERNS.map((pattern) => `%${pattern}%`)
    ]
  };
}

function gradingFailureReason(row = {}) {
  const errorType = String(row.ai_error_type || "").trim().toLowerCase();
  if (FAILED_AI_REVIEW_TYPES.includes(errorType)) return errorType;
  if (row.status === "pending_review" || Number(row.is_correct) === -1) return "pending_review";
  if (row.ai_score == null) return "missing_ai_score";
  if (
    row.ai_confidence == null
    || Number(row.ai_confidence) < AI_REVIEW_CONFIDENCE_THRESHOLD
  ) {
    return "low_confidence";
  }
  if (LEGACY_AI_REVIEW_FAILURE_PATTERNS.some((pattern) => String(row.ai_feedback || "").includes(pattern))) {
    return "legacy_failure";
  }
  return "";
}

function shortAnswerRegradeCandidates(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 50), 1000));
  const offset = Math.max(0, Number(options.offset || 0));
  const ids = Array.isArray(options.ids)
    ? Array.from(new Set(options.ids.map((id) => String(id || "").trim()).filter(Boolean))).slice(0, 50)
    : [];
  const failed = failedAiReviewWhere("qr");
  const idClause = ids.length ? ` AND qr.id IN (${ids.map(() => "?").join(", ")})` : "";
  const baseParams = [...failed.params, ...ids];
  const total = queryOne(
    `SELECT COUNT(*) AS c
     FROM quiz_results qr
     WHERE qr.question_type = 'short_answer'
       AND ${failed.clause}${idClause}`,
    baseParams
  )?.c || 0;
  const rows = queryAll(
    `SELECT qr.*, u.nickname
     FROM quiz_results qr
     JOIN users u ON u.id = qr.user_id
     WHERE qr.question_type = 'short_answer'
       AND ${failed.clause}${idClause}
     ORDER BY julianday(qr.created_at) ASC, qr.id ASC
     LIMIT ? OFFSET ?`,
    [...baseParams, limit, offset]
  ).map((row) => ({
    ...row,
    failure_reason: gradingFailureReason(row)
  }));
  const errorTypes = queryAll(
    `SELECT
       CASE
         WHEN lower(trim(COALESCE(qr.ai_error_type, ''))) IN (${FAILED_AI_REVIEW_TYPES.map(() => "?").join(", ")})
           THEN lower(trim(qr.ai_error_type))
         WHEN qr.status = 'pending_review' OR qr.is_correct = -1
           THEN 'pending_review'
         WHEN qr.ai_score IS NULL
           THEN 'missing_ai_score'
         WHEN qr.ai_confidence IS NULL OR qr.ai_confidence < ?
           THEN 'low_confidence'
         ELSE 'legacy_failure'
       END AS error_type,
       COUNT(*) AS count
     FROM quiz_results qr
     WHERE qr.question_type = 'short_answer'
       AND ${failed.clause}${idClause}
     GROUP BY error_type
     ORDER BY count DESC, error_type ASC`,
    [...FAILED_AI_REVIEW_TYPES, AI_REVIEW_CONFIDENCE_THRESHOLD, ...baseParams]
  );
  return { rows, total, limit, offset, errorTypes };
}

function gradingSnapshot(row = {}) {
  return {
    status: row.status || "",
    score: row.score == null ? null : Number(row.score),
    maxScore: row.max_score == null ? null : Number(row.max_score),
    isCorrect: row.is_correct == null ? null : Number(row.is_correct),
    aiScore: row.ai_score == null ? null : Number(row.ai_score),
    aiConfidence: row.ai_confidence == null ? null : Number(row.ai_confidence),
    aiFeedback: row.ai_feedback || "",
    aiErrorType: row.ai_error_type || ""
  };
}

function insertGradingRegradeAudit(record = {}) {
  const existing = record.quiz_result_id
    ? queryOne("SELECT * FROM quiz_results WHERE id = ?", [record.quiz_result_id])
    : null;
  execute(
    `INSERT INTO grading_regrade_audits
      (id, batch_id, quiz_result_id, user_id, question_id, unit_id,
       trigger_source, status, previous_grade_json, proposed_grade_json,
       applied_grade_json, llm_provider, llm_model, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.batch_id || "",
      record.quiz_result_id || "",
      record.user_id || "",
      record.question_id || "",
      record.unit_id || "",
      record.trigger_source || "admin",
      record.status || "",
      JSON.stringify(record.previous_grade || gradingSnapshot(existing || {})),
      JSON.stringify(record.proposed_grade || {}),
      JSON.stringify(record.applied_grade || {}),
      record.llm_provider || "",
      record.llm_model || "",
      String(record.error_message || "").slice(0, 1000),
      record.created_at
    ]
  );
}

function applyQuizResultRegrade(record = {}) {
  const quizResultId = String(record.quiz_result_id || "").trim();
  const existing = queryOne("SELECT * FROM quiz_results WHERE id = ?", [quizResultId]);
  if (!existing || existing.question_type !== "short_answer") {
    return { ok: false, code: "grading_target_not_found", row: existing || null };
  }
  const failureReason = gradingFailureReason(existing);
  if (!failureReason) {
    return { ok: false, code: "grading_target_no_longer_retryable", row: existing };
  }

  const proposed = record.proposed_grade || {};
  const rawScore = Number(proposed.score);
  if (!Number.isFinite(rawScore)) {
    return { ok: false, code: "grading_result_invalid", row: existing };
  }
  const maxScore = Math.max(0, Number(existing.max_score || existing.points || 0));
  const score = maxScore
    ? Math.round(Math.max(0, Math.min(maxScore, rawScore)) * 10) / 10
    : Math.max(0, Math.round(rawScore * 10) / 10);
  const confidence = Math.max(0, Math.min(1, Number(proposed.confidence || 0)));
  const passScore = maxScore ? maxScore * 0.6 : 60;
  const applied = {
    status: "ai_reviewed",
    score,
    maxScore,
    isCorrect: score >= passScore ? 1 : 0,
    aiScore: score,
    aiConfidence: confidence,
    aiFeedback: String(proposed.feedback || "").slice(0, 4000),
    aiErrorType: String(proposed.errorType || "none").trim().toLowerCase() || "none"
  };
  const d = getDbSync();
  try {
    d.run("BEGIN IMMEDIATE");
    d.run(
      `UPDATE quiz_results
       SET ai_score = ?, ai_confidence = ?, ai_feedback = ?, ai_error_type = ?,
           is_correct = ?, status = 'ai_reviewed', score = ?
       WHERE id = ?`,
      [
        applied.aiScore,
        applied.aiConfidence,
        applied.aiFeedback,
        applied.aiErrorType,
        applied.isCorrect,
        applied.score,
        quizResultId
      ]
    );
    d.run(
      `INSERT INTO grading_regrade_audits
        (id, batch_id, quiz_result_id, user_id, question_id, unit_id,
         trigger_source, status, previous_grade_json, proposed_grade_json,
         applied_grade_json, llm_provider, llm_model, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, '', ?)`,
      [
        record.id,
        record.batch_id || "",
        existing.id,
        existing.user_id,
        existing.question_id,
        existing.unit_id || "",
        record.trigger_source || "admin",
        JSON.stringify(gradingSnapshot(existing)),
        JSON.stringify(proposed),
        JSON.stringify(applied),
        record.llm_provider || "",
        record.llm_model || "",
        record.created_at
      ]
    );
    d.run("COMMIT");
    scheduleSave();
    return { ok: true, row: existing, applied };
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

function gradingRegradeAudits(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 1000));
  const batchId = String(options.batchId || "").trim();
  const batchClause = batchId ? " WHERE gra.batch_id = ?" : "";
  return queryAll(
    `SELECT gra.*, u.nickname
     FROM grading_regrade_audits gra
     LEFT JOIN users u ON u.id = gra.user_id
     ${batchClause}
     ORDER BY julianday(gra.created_at) DESC, gra.id DESC
     LIMIT ?`,
    [...(batchId ? [batchId] : []), limit]
  );
}

function normalizeFailedPendingQuizReviews() {
  const placeholders = FAILED_AI_REVIEW_TYPES.map(() => "?").join(", ");
  execute(
    `UPDATE quiz_results
     SET ai_score = 0,
         ai_confidence = COALESCE(ai_confidence, 0),
         ai_feedback = CASE
           WHEN trim(COALESCE(ai_feedback, '')) = '' THEN ?
           WHEN instr(ai_feedback, '已先按 0 分计入') > 0 OR instr(ai_feedback, '可以继续学习') > 0 THEN ai_feedback
           ELSE rtrim(ai_feedback, '。.!！？? ') || ?
         END,
         is_correct = 0,
         status = 'ai_reviewed',
         score = 0
     WHERE question_type = 'short_answer'
       AND (status = 'pending_review' OR is_correct = -1)
       AND lower(trim(COALESCE(ai_error_type, ''))) IN (${placeholders})`,
    [
      FAILED_AI_REVIEW_SUFFIX.slice(1),
      FAILED_AI_REVIEW_SUFFIX,
      ...FAILED_AI_REVIEW_TYPES
    ]
  );
  return getDbSync().getRowsModified();
}

function normalizeLegacyPendingShortAnswerFlags() {
  execute(
    `UPDATE quiz_results
     SET is_correct = -1
     WHERE question_type = 'short_answer'
       AND status = 'pending_review'
       AND is_correct = 1
       AND ai_score IS NULL`
  );
  return getDbSync().getRowsModified();
}

function normalizeReviewedShortAnswerFlags() {
  execute(
    `UPDATE quiz_results
     SET is_correct = CASE
       WHEN max_score > 0 AND ai_score >= max_score * 0.6 THEN 1
       WHEN max_score <= 0 AND ai_score >= 60 THEN 1
       ELSE 0
     END
     WHERE question_type = 'short_answer'
       AND status = 'ai_reviewed'
       AND is_correct = -1
       AND ai_score IS NOT NULL`
  );
  return getDbSync().getRowsModified();
}

// ---- Snapshots ----

function insertSnapshot(record) {
  execute(
    `INSERT OR REPLACE INTO snapshots
      (id, user_id, reason, data, generation, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.user_id,
      record.reason || "",
      JSON.stringify(normalizeLearningSnapshot(record.data || {})),
      Number(record.generation || 0),
      Number(record.revision || 0),
      record.created_at
    ]
  );
}

function getLatestSnapshot(userId) {
  return queryOne(
    `SELECT * FROM snapshots
     WHERE user_id = ?
     ORDER BY generation DESC, revision DESC, created_at DESC
     LIMIT 1`,
    [userId]
  );
}

function listLearningSnapshots(userId) {
  return queryAll(
    `SELECT * FROM snapshots
     WHERE user_id = ?
     ORDER BY generation ASC, revision ASC, created_at ASC, id ASC`,
    [userId]
  );
}

function parseSnapshotData(row) {
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.data || "{}");
    return normalizeLearningSnapshot(parsed);
  } catch {
    return {};
  }
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value)));
}

function normalizeLearningSnapshot(snapshot = {}) {
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : {};
  const quizResultIds = Array.isArray(source.quizResults)
    ? source.quizResults.map((item) => item?.unitId || item?.unit_id || "")
    : [];
  const quizAttemptIds = source.quizAttempts
    && typeof source.quizAttempts === "object"
    && !Array.isArray(source.quizAttempts)
    ? Object.keys(source.quizAttempts)
    : [];
  return {
    ...source,
    submittedQuizzes: uniqueStrings([
      ...(Array.isArray(source.submittedQuizzes) ? source.submittedQuizzes : []),
      ...quizResultIds,
      ...quizAttemptIds
    ])
  };
}

function mergeRecords(existing = [], incoming = [], keyFor) {
  const records = new Map();
  [...existing, ...incoming].forEach((record, index) => {
    if (!record || typeof record !== "object") return;
    const key = keyFor(record) || `record-${index}`;
    records.set(key, record);
  });
  return Array.from(records.values());
}

function mergeAnalytics(existing = {}, incoming = {}) {
  const left = existing && typeof existing === "object" ? existing : {};
  const right = incoming && typeof incoming === "object" ? incoming : {};
  return {
    ...left,
    ...right,
    visitedUnits: { ...(left.visitedUnits || {}), ...(right.visitedUnits || {}) },
    repeats: { ...(left.repeats || {}), ...(right.repeats || {}) },
    path: mergeRecords(left.path || [], right.path || [], (item) =>
      [item.unitId, item.at, item.reason].filter(Boolean).join("|")
    ),
    skips: mergeRecords(left.skips || [], right.skips || [], (item) =>
      [item.fromUnitId || item.fromChapterId, item.toUnitId || item.toChapterId, item.at]
        .filter(Boolean)
        .join("|")
    )
  };
}

function mergeAgenticPath(existing, incoming) {
  if (!existing || typeof existing !== "object") return incoming || null;
  if (!incoming || typeof incoming !== "object") return existing;
  const merged = { ...existing, ...incoming };
  ["unlocked", "visibleUnits", "unlockedExtensionChapters"].forEach((key) => {
    merged[key] = uniqueStrings([...(existing[key] || []), ...(incoming[key] || [])]);
  });
  merged.skipped = Object.prototype.hasOwnProperty.call(incoming, "skipped")
    ? { ...(incoming.skipped || {}) }
    : { ...(existing.skipped || {}) };
  merged.chapterAdvanceReady = {
    ...(existing.chapterAdvanceReady || {}),
    ...(incoming.chapterAdvanceReady || {})
  };
  merged.chapterAdvanceReasons = {
    ...(existing.chapterAdvanceReasons || {}),
    ...(incoming.chapterAdvanceReasons || {})
  };
  merged.decisions = mergeRecords(existing.decisions || [], incoming.decisions || [], (item) =>
    item.id || [item.fromUnitId, item.action, item.createdAt || item.at].filter(Boolean).join("|")
  );
  return merged;
}

function mergeLearningSnapshot(existing = {}, incoming = {}) {
  const left = normalizeLearningSnapshot(existing);
  const right = normalizeLearningSnapshot(incoming);
  const merged = { ...left, ...right };
  merged.completed = uniqueStrings([...(left.completed || []), ...(right.completed || [])]);
  merged.quizResults = mergeRecords(left.quizResults || [], right.quizResults || [], (item) =>
    item.id || [item.unitId || item.unit_id, item.questionId || item.question_id, item.timestamp || item.created_at]
      .filter(Boolean)
      .join("|")
  );
  merged.logs = uniqueStrings([...(right.logs || []), ...(left.logs || [])]).slice(0, 100);
  merged.quizDrafts = { ...(left.quizDrafts || {}), ...(right.quizDrafts || {}) };
  merged.quizAttempts = { ...(left.quizAttempts || {}), ...(right.quizAttempts || {}) };
  merged.selectedKnowledgeScenes = Object.prototype.hasOwnProperty.call(right, "selectedKnowledgeScenes")
    ? { ...(right.selectedKnowledgeScenes || {}) }
    : { ...(left.selectedKnowledgeScenes || {}) };
  merged.submittedQuizzes = normalizeLearningSnapshot(merged).submittedQuizzes;
  merged.analytics = mergeAnalytics(left.analytics, right.analytics);
  merged.agenticPath = mergeAgenticPath(left.agenticPath, right.agenticPath);
  if (!right.note && left.note) merged.note = left.note;
  if (!right.participant && left.participant) merged.participant = left.participant;
  return merged;
}

function ensureLearningStateVersion(userId, timestamp) {
  let version = queryOne(
    "SELECT * FROM learning_state_versions WHERE user_id = ?",
    [userId]
  );
  if (version) return version;
  execute(
    `INSERT OR IGNORE INTO learning_state_versions
      (user_id, generation, revision, updated_at)
     VALUES (?, 1, 0, ?)`,
    [userId, timestamp]
  );
  version = queryOne(
    "SELECT * FROM learning_state_versions WHERE user_id = ?",
    [userId]
  );
  return version;
}

function getLearningSnapshotState(userId, timestamp) {
  const version = ensureLearningStateVersion(userId, timestamp);
  const current = queryOne(
    `SELECT * FROM snapshots
     WHERE user_id = ? AND generation = ?
     ORDER BY revision DESC, created_at DESC
     LIMIT 1`,
    [userId, Number(version.generation)]
  );
  const legacy = current || queryOne(
    `SELECT * FROM snapshots
     WHERE user_id = ?
     ORDER BY generation DESC, revision DESC, created_at DESC
     LIMIT 1`,
    [userId]
  );
  return {
    generation: Number(version.generation),
    revision: Number(version.revision),
    snapshot: legacy
  };
}

function saveLearningSnapshot(record) {
  const version = ensureLearningStateVersion(record.user_id, record.created_at);
  const currentGeneration = Number(version.generation);
  const currentRevision = Number(version.revision);
  if (Number(record.generation) !== currentGeneration) {
    return {
      ok: false,
      conflict: "generation",
      generation: currentGeneration,
      revision: currentRevision
    };
  }
  if (Number(record.baseRevision) !== currentRevision) {
    return {
      ok: false,
      conflict: "revision",
      generation: currentGeneration,
      revision: currentRevision
    };
  }

  const current = queryOne(
    `SELECT * FROM snapshots
     WHERE user_id = ? AND generation = ?
     ORDER BY revision DESC, created_at DESC
     LIMIT 1`,
    [record.user_id, currentGeneration]
  ) || queryOne(
    `SELECT * FROM snapshots
     WHERE user_id = ?
     ORDER BY generation DESC, revision DESC, created_at DESC
     LIMIT 1`,
    [record.user_id]
  );
  const data = mergeLearningSnapshot(parseSnapshotData(current), record.data);
  const nextRevision = currentRevision + 1;
  const d = getDbSync();

  d.run("BEGIN");
  try {
    d.run(
      `INSERT INTO snapshots
        (id, user_id, reason, data, generation, revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.user_id,
        record.reason || "",
        JSON.stringify(normalizeLearningSnapshot(data)),
        currentGeneration,
        nextRevision,
        record.created_at
      ]
    );
    d.run(
      `UPDATE learning_state_versions
       SET revision = ?, updated_at = ?
       WHERE user_id = ?`,
      [nextRevision, record.created_at, record.user_id]
    );
    d.run("COMMIT");
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
  scheduleSave();
  return {
    ok: true,
    generation: currentGeneration,
    revision: nextRevision,
    data
  };
}

function resetLearningSnapshot(record) {
  const version = ensureLearningStateVersion(record.user_id, record.created_at);
  const currentGeneration = Number(version.generation);
  const currentRevision = Number(version.revision);
  if (Number(record.generation) !== currentGeneration) {
    return {
      ok: false,
      conflict: "generation",
      generation: currentGeneration,
      revision: currentRevision
    };
  }
  if (Number(record.baseRevision) !== currentRevision) {
    return {
      ok: false,
      conflict: "revision",
      generation: currentGeneration,
      revision: currentRevision
    };
  }

  const nextGeneration = currentGeneration + 1;
  const nextRevision = 1;
  const d = getDbSync();
  d.run("BEGIN");
  try {
    d.run(
      `UPDATE learning_state_versions
       SET generation = ?, revision = ?, updated_at = ?
       WHERE user_id = ?`,
      [nextGeneration, nextRevision, record.created_at, record.user_id]
    );
    d.run(
      `INSERT INTO snapshots
        (id, user_id, reason, data, generation, revision, created_at)
       VALUES (?, ?, 'reset', ?, ?, ?, ?)`,
      [
        record.id,
        record.user_id,
        JSON.stringify(normalizeLearningSnapshot(record.data || {})),
        nextGeneration,
        nextRevision,
        record.created_at
      ]
    );
    d.run("COMMIT");
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
  scheduleSave();
  return {
    ok: true,
    generation: nextGeneration,
    revision: nextRevision
  };
}

// ---- Feedback ----

function insertFeedback(record) {
  execute(
    `INSERT INTO feedback
      (id, user_id, feedback_type, content, target_scope, chapter_id, module_id,
       unit_id, knowledge_point, scene_type, resource_file, resource_title,
       current_view, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.user_id,
      record.feedback_type,
      record.content,
      record.target_scope || "global",
      record.chapter_id || "",
      record.module_id || "",
      record.unit_id || "",
      record.knowledge_point || "",
      record.scene_type || "",
      record.resource_file || "",
      record.resource_title || "",
      record.current_view || "",
      record.created_at
    ]
  );
}

function feedbackDashboard(filters = {}) {
  const df = dateFilter("f.created_at", filters);
  const where = [`1=1${df.clause}`];
  const params = [...df.params];
  const feedbackType = String(filters.feedbackType || "").trim();
  const targetScope = String(filters.targetScope || "").trim();
  const searchQuery = String(filters.query || "").trim();
  const limit = Math.max(1, Math.min(Number(filters.limit || 1000), 1000));
  const offset = Math.max(0, Number(filters.offset || 0));

  if (feedbackType) {
    where.push("f.feedback_type = ?");
    params.push(feedbackType);
  }
  if (targetScope) {
    where.push("f.target_scope = ?");
    params.push(targetScope);
  }
  if (searchQuery) {
    const like = `%${searchQuery}%`;
    where.push(`(
      COALESCE(u.nickname, '') LIKE ? OR f.content LIKE ? OR
      f.resource_title LIKE ? OR f.knowledge_point LIKE ?
    )`);
    params.push(like, like, like, like);
  }

  const whereSql = where.join(" AND ");
  const summaryRow = queryOne(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN f.feedback_type = 'courseware' THEN 1 ELSE 0 END) as courseware,
       COUNT(DISTINCT f.user_id) as users,
       COUNT(DISTINCT CASE
         WHEN f.target_scope = 'courseware'
         THEN COALESCE(NULLIF(f.resource_title, ''), NULLIF(f.unit_id, ''))
       END) as targets,
       SUM(CASE WHEN f.feedback_type = 'learning_content' THEN 1 ELSE 0 END) as learning_content,
       SUM(CASE WHEN f.feedback_type = 'platform' THEN 1 ELSE 0 END) as platform,
       SUM(CASE WHEN f.feedback_type = 'other' THEN 1 ELSE 0 END) as other,
       MAX(f.created_at) as last_at
     FROM feedback f
     LEFT JOIN users u ON u.id = f.user_id
     WHERE ${whereSql}`,
    params
  );
  const rows = queryAll(
    `SELECT f.*, COALESCE(u.nickname, '') as nickname
     FROM feedback f
     LEFT JOIN users u ON u.id = f.user_id
     WHERE ${whereSql}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  ).map((row) => {
    const labels = unitDisplayMeta(row.unit_id, {
      chapter_id: row.chapter_id,
      unit_label: row.knowledge_point || row.resource_title
    });
    return {
      ...row,
      chapter_label: labels.chapter_label,
      unit_label: row.knowledge_point || labels.unit_label
    };
  });

  return {
    summary: {
      total: Number(summaryRow?.total || 0),
      courseware: Number(summaryRow?.courseware || 0),
      users: Number(summaryRow?.users || 0),
      targets: Number(summaryRow?.targets || 0),
      lastAt: summaryRow?.last_at || "",
      byType: {
        learning_content: Number(summaryRow?.learning_content || 0),
        courseware: Number(summaryRow?.courseware || 0),
        platform: Number(summaryRow?.platform || 0),
        other: Number(summaryRow?.other || 0)
      }
    },
    rows,
    total: Number(summaryRow?.total || 0),
    limit,
    offset
  };
}

// ==================== Analytics Queries ====================

function dateFilter(prefix, dates) {
  if (!dates || (!dates.startDate && !dates.endDate)) return { clause: "", params: [] };
  const parts = [];
  const p = [];
  if (dates.startDate) { parts.push(`julianday(${prefix}) >= julianday(?)`); p.push(dates.startDate); }
  if (dates.endDate) { parts.push(`julianday(${prefix}) <= julianday(?)`); p.push(dates.endDate); }
  return { clause: parts.length ? " AND " + parts.join(" AND ") : "", params: p };
}

function beijingDateString(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function quizSubmissionCount(dates, prefix = "qr") {
  const filter = dateFilter(`${prefix}.created_at`, dates);
  return queryOne(
    `SELECT COUNT(*) as c
     FROM (
       SELECT ${prefix}.user_id, ${prefix}.unit_id, ${prefix}.created_at
       FROM quiz_results ${prefix}
       WHERE 1=1${filter.clause}
       GROUP BY ${prefix}.user_id, ${prefix}.unit_id, ${prefix}.created_at
     )`,
    filter.params
  ).c || 0;
}

function eventPayloadObject(row = {}) {
  try {
    return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload || {};
  } catch {
    return {};
  }
}

function quizSubmissionEventKey(row = {}, period = "") {
  const payload = eventPayloadObject(row);
  const unitId = String(payload.unitId || payload.unit_id || "").trim();
  if (!unitId) return `${row.type}:${row.id}`;
  return `${row.user_id}:${unitId}:${period}`;
}

function aggregateActivityEvents(rows = [], bucketFor) {
  const buckets = new Map();
  rows.forEach((row) => {
    const bucket = String(bucketFor(row));
    if (!buckets.has(bucket)) {
      buckets.set(bucket, {
        key: bucket,
        users: new Set(),
        quizSubmissions: new Set(),
        events_count: 0
      });
    }
    const entry = buckets.get(bucket);
    entry.events_count += 1;
    if (row.user_id) entry.users.add(row.user_id);
    if (row.type === "quiz_result" || row.type === "quiz_submission") {
      entry.quizSubmissions.add(quizSubmissionEventKey(row, bucket));
    }
  });
  return Array.from(buckets.values());
}

function statsOverview(dates) {
  const todayStart = `${beijingDateString()}T00:00:00.000+08:00`;
  const qrFilter = dateFilter("qr.created_at", dates);
  const evFilter = dateFilter("created_at", dates);
  const interactionFilter = dateFilter("e.created_at", dates);
  const feedbackFilter = dateFilter("created_at", dates);
  const decisionFilter = dateFilter("created_at", dates);
  const meaningfulFilter = interactionPolicy.sqlMeaningfulFilter("e");
  const hasFilter = !!(dates && (dates.startDate || dates.endDate));
  // activeInRange: count distinct users within the date filter (or today if no filter)
  const activeQuery = hasFilter
    ? `SELECT COUNT(DISTINCT user_id) as c FROM events WHERE 1=1${evFilter.clause}`
    : "SELECT COUNT(DISTINCT user_id) as c FROM events WHERE julianday(created_at) >= julianday(?)";
  const activeParams = hasFilter ? evFilter.params : [todayStart];
  const pairedPrePost = queryOne(
    `SELECT COUNT(DISTINCT user_id) as c
     FROM (
       SELECT qr.user_id, qr.chapter_id
       FROM quiz_results qr
       WHERE qr.phase IN ('pre', 'post')${qrFilter.clause}
       GROUP BY qr.user_id, qr.chapter_id
       HAVING SUM(CASE WHEN qr.phase = 'pre' THEN 1 ELSE 0 END) > 0
          AND SUM(CASE WHEN qr.phase = 'post' THEN 1 ELSE 0 END) > 0
     )`,
    qrFilter.params
  ).c || 0;
  const rawInteractionEvents = queryOne(
    `SELECT COUNT(*) as c FROM events e WHERE e.type = 'interaction'${interactionFilter.clause}`,
    interactionFilter.params
  ).c || 0;
  const meaningfulInteractions = queryOne(
    `SELECT COUNT(*) as c
     FROM events e
     WHERE e.type = 'interaction'${interactionFilter.clause}${meaningfulFilter.clause}`,
    [...interactionFilter.params, ...meaningfulFilter.params]
  ).c || 0;
  return {
    totalUsers: queryOne("SELECT COUNT(*) as c FROM users").c,
    totalQuizResults: quizSubmissionCount(dates),
    totalEvents: queryOne(`SELECT COUNT(*) as c FROM events WHERE 1=1${evFilter.clause}`, evFilter.params).c,
    rawInteractionEvents,
    meaningfulInteractions,
    activeToday: queryOne(
      "SELECT COUNT(DISTINCT user_id) as c FROM events WHERE julianday(created_at) >= julianday(?)",
      [todayStart]
    ).c,
    activeInRange: queryOne(activeQuery, activeParams).c,
    avgAccuracy: queryOne(`SELECT ROUND(AVG(CAST(qr.is_correct AS REAL)) * 100, 1) as c FROM quiz_results qr WHERE qr.is_correct >= 0${qrFilter.clause}`, qrFilter.params).c || 0,
    usersWithQuiz: queryOne(`SELECT COUNT(DISTINCT qr.user_id) as c FROM quiz_results qr WHERE 1=1${qrFilter.clause}`, qrFilter.params).c || 0,
    usersWithInteractions: queryOne(`SELECT COUNT(DISTINCT user_id) as c FROM events WHERE type = 'interaction'${evFilter.clause}`, evFilter.params).c || 0,
    usersWithFeedback: queryOne(`SELECT COUNT(DISTINCT user_id) as c FROM feedback WHERE 1=1${feedbackFilter.clause}`, feedbackFilter.params).c || 0,
    pairedPrePostUsers: pairedPrePost,
    feedbackCount: queryOne(`SELECT COUNT(*) as c FROM feedback WHERE 1=1${feedbackFilter.clause}`, feedbackFilter.params).c || 0,
    agentDecisionCount: queryOne(`SELECT COUNT(*) as c FROM agent_decisions WHERE 1=1${decisionFilter.clause}`, decisionFilter.params).c || 0,
    activeDays: queryOne(`SELECT COUNT(DISTINCT substr(created_at, 1, 10)) as c FROM events WHERE 1=1${evFilter.clause}`, evFilter.params).c || 0
  };
}

function chapterAccuracy(dates) {
  const df = dateFilter("qr.created_at", dates);
  return queryAll(`
    SELECT u.nickname, qr.user_id, qr.chapter_id, qr.chapter_label,
           ROUND(AVG(CASE WHEN qr.is_correct >= 0 THEN CAST(qr.is_correct AS REAL) END) * 100, 1) as accuracy,
           COUNT(*) as total
    FROM quiz_results qr
    JOIN users u ON u.id = qr.user_id
    WHERE 1=1${df.clause}
    GROUP BY qr.user_id, qr.chapter_id
    ORDER BY qr.user_id, qr.chapter_id
  `, df.params);
}

function questionErrors(dates) {
  const df = dateFilter("created_at", dates);
  return queryAll(`
    SELECT question_id, unit_id, unit_label, chapter_id, chapter_label, question_type, phase,
           COUNT(*) as attempts,
           ROUND((1 - AVG(CASE WHEN is_correct >= 0 THEN CAST(is_correct AS REAL) END)) * 100, 1) as error_rate,
           ROUND(AVG(score), 1) as avg_score,
           ROUND(AVG(max_score), 1) as avg_max
    FROM quiz_results
    WHERE 1=1${df.clause}
    GROUP BY question_id, unit_id, phase
    ORDER BY error_rate DESC
  `, df.params);
}

function userProgress(dates) {
  const df = dateFilter("qr.created_at", dates);
  const evDf = dateFilter("e.created_at", dates);
  const feedbackDf = dateFilter("f.created_at", dates);
  const decisionDf = dateFilter("ad.created_at", dates);
  return queryAll(`
    SELECT u.id as user_id, u.nickname, u.created_at, u.last_seen_at,
           COUNT(DISTINCT qr.unit_id) as units_attempted,
           COUNT(DISTINCT CASE
             WHEN qr.id IS NOT NULL
             THEN qr.user_id || char(31) || qr.unit_id || char(31) || qr.created_at
           END) as quiz_count,
           ROUND(AVG(CASE WHEN qr.is_correct >= 0 THEN CAST(qr.is_correct AS REAL) END) * 100, 1) as avg_accuracy,
           ROUND(SUM(qr.score), 0) as total_score,
           ROUND(SUM(qr.max_score), 0) as total_max,
           (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id${evDf.clause}) as event_count,
           (SELECT COUNT(DISTINCT substr(e.created_at, 1, 10)) FROM events e WHERE e.user_id = u.id${evDf.clause}) as active_days,
           (SELECT COUNT(*) FROM feedback f WHERE f.user_id = u.id${feedbackDf.clause}) as feedback_count,
           (SELECT COUNT(*) FROM agent_decisions ad WHERE ad.user_id = u.id${decisionDf.clause}) as agent_decision_count
    FROM users u
    LEFT JOIN quiz_results qr ON qr.user_id = u.id${df.clause}
    GROUP BY u.id
    ORDER BY quiz_count DESC
  `, [
    ...evDf.params,
    ...evDf.params,
    ...feedbackDf.params,
    ...decisionDf.params,
    ...df.params
  ]);
}

function dailyActivity(days = 30, dates) {
  const df = dateFilter("created_at", dates);
  const fallbackStart = `${beijingDateString(new Date(Date.now() - days * 86400000))}T00:00:00.000+08:00`;
  const rows = queryAll(
    `SELECT id, user_id, type, payload, created_at
     FROM events
     WHERE julianday(created_at) >= julianday(?)${df.clause}
     ORDER BY julianday(created_at), id`,
    [fallbackStart, ...df.params]
  );
  return aggregateActivityEvents(rows, (row) => String(row.created_at || "").slice(0, 10))
    .map((entry) => ({
      date: entry.key,
      active_users: entry.users.size,
      events_count: entry.events_count,
      quiz_submissions: entry.quizSubmissions.size
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function phaseComparison(dates) {
  const df = dateFilter("qr.created_at", dates);
  return queryAll(`
    SELECT u.nickname, qr.user_id, qr.chapter_id, qr.chapter_label,
           ROUND(AVG(CASE WHEN qr.phase = 'pre' AND qr.is_correct >= 0 THEN CAST(qr.is_correct AS REAL) END) * 100, 1) as pre_accuracy,
           COUNT(CASE WHEN qr.phase = 'pre' THEN 1 END) as pre_count,
           COUNT(DISTINCT CASE WHEN qr.phase = 'pre' THEN qr.learning_generation || char(31) || qr.unit_id || char(31) || qr.created_at END) as pre_submissions,
           SUM(CASE WHEN qr.phase = 'pre' THEN qr.score ELSE 0 END) as pre_score,
           SUM(CASE WHEN qr.phase = 'pre' THEN qr.max_score ELSE 0 END) as pre_max_score,
           SUM(CASE WHEN qr.phase = 'pre' AND qr.is_correct = 1 THEN 1 ELSE 0 END) as pre_correct,
           SUM(CASE WHEN qr.phase = 'pre' AND qr.is_correct < 0 THEN 1 ELSE 0 END) as pre_pending,
           ROUND(AVG(CASE WHEN qr.phase = 'formative' AND qr.is_correct >= 0 THEN CAST(qr.is_correct AS REAL) END) * 100, 1) as formative_accuracy,
           COUNT(CASE WHEN qr.phase = 'formative' THEN 1 END) as formative_count,
           COUNT(DISTINCT CASE WHEN qr.phase = 'formative' THEN qr.learning_generation || char(31) || qr.unit_id || char(31) || qr.created_at END) as formative_submissions,
           SUM(CASE WHEN qr.phase = 'formative' THEN qr.score ELSE 0 END) as formative_score,
           SUM(CASE WHEN qr.phase = 'formative' THEN qr.max_score ELSE 0 END) as formative_max_score,
           SUM(CASE WHEN qr.phase = 'formative' AND qr.is_correct = 1 THEN 1 ELSE 0 END) as formative_correct,
           SUM(CASE WHEN qr.phase = 'formative' AND qr.is_correct < 0 THEN 1 ELSE 0 END) as formative_pending,
           ROUND(AVG(CASE WHEN qr.phase = 'post' AND qr.is_correct >= 0 THEN CAST(qr.is_correct AS REAL) END) * 100, 1) as post_accuracy,
           COUNT(CASE WHEN qr.phase = 'post' THEN 1 END) as post_count,
           COUNT(DISTINCT CASE WHEN qr.phase = 'post' THEN qr.learning_generation || char(31) || qr.unit_id || char(31) || qr.created_at END) as post_submissions,
           SUM(CASE WHEN qr.phase = 'post' THEN qr.score ELSE 0 END) as post_score,
           SUM(CASE WHEN qr.phase = 'post' THEN qr.max_score ELSE 0 END) as post_max_score,
           SUM(CASE WHEN qr.phase = 'post' AND qr.is_correct = 1 THEN 1 ELSE 0 END) as post_correct,
           SUM(CASE WHEN qr.phase = 'post' AND qr.is_correct < 0 THEN 1 ELSE 0 END) as post_pending
    FROM quiz_results qr
    JOIN users u ON u.id = qr.user_id
    WHERE qr.phase IN ('pre', 'formative', 'post')${df.clause}
    GROUP BY qr.user_id, qr.chapter_id
    HAVING pre_count > 0 OR formative_count > 0 OR post_count > 0
    ORDER BY qr.user_id, qr.chapter_id
  `, df.params);
}

function researchSummaryForUser(eventRows, feedbackCount, agentDecisionCount) {
  const activeDays = new Set();
  const sessions = new Set();
  const units = new Set();
  const completedUnits = new Set();
  let interactionCount = 0;
  let estimatedOnlineSeconds = 0;
  let unitStudySeconds = 0;
  let repeatVisits = 0;
  let coursewareActions = 0;
  let latestEnvironment = null;
  let latestEnvironmentAt = "";

  eventRows.forEach((row) => {
    if (row.created_at) activeDays.add(String(row.created_at).slice(0, 10));
    let payload = {};
    try { payload = typeof row.payload === "string" ? JSON.parse(row.payload || "{}") : row.payload || {}; } catch { payload = {}; }
    const data = payload.data || {};
    const eventType = row.type === "interaction"
      ? payload.eventType || data.eventType || "interaction"
      : row.type || "";
    if (row.type === "interaction") interactionCount += 1;
    if (payload.sessionId) sessions.add(payload.sessionId);
    const unitId = payload.unitId || data.unitId || data.unit || "";
    if (unitId) units.add(unitId);
    if (["unit_complete", "complete_unit", "unit_review_complete"].includes(eventType) && unitId) {
      completedUnits.add(unitId);
    }
    if (eventType === "repeat_unit_enter") repeatVisits += 1;
    if (
      payload.source === "iframe"
      || payload.source === "courseware_semantic"
      || eventType.startsWith("courseware_")
      || eventType.startsWith("interactive_")
      || eventType.startsWith("canvas_")
      || eventType === "parameter_change"
      || eventType === "parameter_commit"
    ) {
      coursewareActions += 1;
    }
    if (eventType === "session_start" && data.environment && row.created_at >= latestEnvironmentAt) {
      latestEnvironment = data.environment;
      latestEnvironmentAt = row.created_at;
    }
  });
  const onlineTime = activeTimePolicy.summarizeOnlinePeriods(eventRows);
  estimatedOnlineSeconds = onlineTime.effectiveSeconds;
  const durationSamples = effectiveUnitDurationSamples(
    eventRows
      .filter((row) => row.type === "interaction")
      .map((row) => ({
        ...row,
        payload: eventPayloadObject(row)
      }))
  ).filter(({ seconds }) => seconds >= EFFECTIVE_PATH_MIN_SECONDS);
  const rawUnitStudySeconds = durationSamples.reduce(
    (total, sample) => total + sample.seconds,
    0
  );
  unitStudySeconds = durationSamples.reduce(
    (total, sample) => total + Math.min(sample.seconds, EFFECTIVE_PATH_MAX_SECONDS),
    0
  );
  const cappedStudySegments = durationSamples.filter(
    ({ seconds }) => seconds > EFFECTIVE_PATH_MAX_SECONDS
  ).length;

  return {
    activeDays: activeDays.size,
    sessions: sessions.size,
    interactionCount,
    unitsVisited: units.size,
    completedUnits: completedUnits.size,
    repeatVisits,
    coursewareActions,
    estimatedOnlineSeconds,
    rawEstimatedOnlineSeconds: onlineTime.rawTotalSeconds,
    excludedIdleSeconds: onlineTime.excludedIdleSeconds,
    idleExcludedSegments: onlineTime.idleExcludedSegments,
    activeTimeIdleTimeoutMs: onlineTime.idleTimeoutMs,
    unitStudySeconds,
    rawUnitStudySeconds,
    cappedStudySegments,
    feedbackCount: Number(feedbackCount || 0),
    agentDecisionCount: Number(agentDecisionCount || 0),
    latestEnvironment
  };
}

function recentMeaningfulEvents(rows, limit = 80) {
  const dedupeFamilies = {
    login: "login",
    login_success: "login",
    register: "register",
    register_success: "register",
    select_chapter: "chapter_select",
    chapter_select: "chapter_select",
    open_unit: "unit_open",
    unit_open: "unit_open",
    unit_enter: "unit_open",
    repeat_unit_enter: "unit_open",
    complete_unit: "unit_complete",
    unit_complete: "unit_complete"
  };
  const lastFamilyAt = new Map();
  const result = [];

  for (const row of rows) {
    let payload = {};
    try { payload = JSON.parse(row.payload || "{}"); } catch {}
    const data = payload.data || {};
    const eventType = row.type === "interaction"
      ? interactionPolicy.eventType(payload, row.type)
      : String(row.type || "");
    if (!interactionPolicy.isMeaningfulEventType(eventType)) continue;

    const family = dedupeFamilies[eventType];
    if (family) {
      const target = family === "login" || family === "register"
        ? ""
        : family === "chapter_select"
          ? data.toChapterId || data.chapterId || payload.chapterId || ""
          : payload.unitId || data.unitId || data.unit || "";
      const key = `${family}|${target}`;
      const currentAt = new Date(row.created_at || 0).getTime();
      const previousAt = lastFamilyAt.get(key);
      const dedupeWindowMs = family === "login" || family === "register" ? 10000 : 2000;
      if (
        Number.isFinite(currentAt)
        && Number.isFinite(previousAt)
        && Math.abs(previousAt - currentAt) <= dedupeWindowMs
      ) {
        lastFamilyAt.set(key, currentAt);
        continue;
      }
      if (Number.isFinite(currentAt)) lastFamilyAt.set(key, currentAt);
    }

    result.push(row);
    if (result.length >= limit) break;
  }
  return result;
}

function userDetail(userId, dates) {
  const user = queryOne("SELECT * FROM users WHERE id = ?", [userId]);
  if (!user) return null;
  const qrDf = dateFilter("created_at", dates);
  const evDf = dateFilter("created_at", dates);
  const feedbackDf = dateFilter("created_at", dates);
  const decisionDf = dateFilter("created_at", dates);
  const quizQuestionTotal = queryOne(
    `SELECT COUNT(*) as count
     FROM quiz_results
     WHERE user_id = ?${qrDf.clause}`,
    [userId, ...qrDf.params]
  ).count || 0;
  const quizQuestionRows = queryAll(
    `SELECT id, user_id, chapter_id, chapter_label, unit_id, unit_label,
            question_id, question_type, phase, response, is_correct, status,
            score, max_score, ai_score, ai_confidence, ai_feedback,
            ai_error_type, learning_generation, created_at
     FROM quiz_results
     WHERE user_id = ?${qrDf.clause}
     ORDER BY julianday(created_at) DESC, id DESC
     LIMIT 5000`,
    [userId, ...qrDf.params]
  );
  const quizResults = quizQuestionRows;
  const events = recentMeaningfulEvents(queryAll(
    `SELECT * FROM events WHERE user_id = ?${evDf.clause} ORDER BY created_at DESC LIMIT 2000`,
    [userId, ...evDf.params]
  ));
  const eventCount = queryOne(
    `SELECT COUNT(*) as count FROM events WHERE user_id = ?${evDf.clause}`,
    [userId, ...evDf.params]
  ).count || 0;
  const researchEvents = queryAll(
    `SELECT id, user_id, type, payload, created_at
     FROM events
     WHERE user_id = ?${evDf.clause}
     ORDER BY created_at DESC
     LIMIT 100000`,
    [userId, ...evDf.params]
  );
  const feedbackCount = queryOne(
    `SELECT COUNT(*) as count FROM feedback WHERE user_id = ?${feedbackDf.clause}`,
    [userId, ...feedbackDf.params]
  ).count || 0;
  const agentDecisionCount = queryOne(
    `SELECT COUNT(*) as count FROM agent_decisions WHERE user_id = ?${decisionDf.clause}`,
    [userId, ...decisionDf.params]
  ).count || 0;
  const feedbackRows = queryAll(
    `SELECT *
     FROM feedback
     WHERE user_id = ?${feedbackDf.clause}
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId, ...feedbackDf.params]
  ).map((row) => {
    const labels = unitDisplayMeta(row.unit_id, {
      chapter_id: row.chapter_id,
      unit_label: row.knowledge_point || row.resource_title
    });
    return {
      ...row,
      chapter_label: labels.chapter_label,
      unit_label: row.knowledge_point || labels.unit_label
    };
  });
  const chapterSummary = queryAll(`
    SELECT chapter_id, chapter_label,
           COUNT(*) as total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
           ROUND(AVG(CASE WHEN is_correct >= 0 THEN CAST(is_correct AS REAL) END) * 100, 1) as accuracy,
           ROUND(AVG(score), 1) as avg_score
    FROM quiz_results WHERE user_id = ?${qrDf.clause} GROUP BY chapter_id ORDER BY chapter_id
  `, [userId, ...qrDf.params]);
  const quizOverallRow = queryOne(`
    SELECT
      COUNT(*) as questions,
      COUNT(DISTINCT learning_generation || char(31) || unit_id || char(31) || created_at) as submissions,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
      SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) as incorrect,
      SUM(CASE WHEN is_correct < 0 THEN 1 ELSE 0 END) as pending,
      ROUND(
        100.0 * SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN is_correct >= 0 THEN 1 ELSE 0 END), 0),
        1
      ) as accuracy,
      ROUND(SUM(score), 1) as total_score,
      ROUND(SUM(max_score), 1) as total_max_score,
      ROUND(100.0 * SUM(score) / NULLIF(SUM(max_score), 0), 1) as score_rate,
      COUNT(DISTINCT learning_generation) as generation_count,
      MIN(created_at) as first_at,
      MAX(created_at) as last_at
    FROM quiz_results
    WHERE user_id = ?${qrDf.clause}
  `, [userId, ...qrDf.params]) || {};
  const currentGenerationRow = queryOne(
    "SELECT generation FROM learning_state_versions WHERE user_id = ?",
    [userId]
  );
  const phaseOrder = { pre: 0, formative: 1, post: 2 };
  const quizPhaseSummary = queryAll(`
    SELECT
      phase,
      COUNT(*) as questions,
      COUNT(DISTINCT learning_generation || char(31) || unit_id || char(31) || created_at) as submissions,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
      SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) as incorrect,
      SUM(CASE WHEN is_correct < 0 THEN 1 ELSE 0 END) as pending,
      ROUND(
        100.0 * SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN is_correct >= 0 THEN 1 ELSE 0 END), 0),
        1
      ) as accuracy,
      ROUND(SUM(score), 1) as total_score,
      ROUND(SUM(max_score), 1) as total_max_score,
      ROUND(100.0 * SUM(score) / NULLIF(SUM(max_score), 0), 1) as score_rate,
      MIN(created_at) as first_at,
      MAX(created_at) as last_at
    FROM quiz_results
    WHERE user_id = ? AND phase IN ('pre', 'formative', 'post')${qrDf.clause}
    GROUP BY phase
  `, [userId, ...qrDf.params]).sort(
    (left, right) => (phaseOrder[left.phase] ?? 99) - (phaseOrder[right.phase] ?? 99)
  );
  const chapterPhaseSummary = queryAll(`
    SELECT
      chapter_id,
      chapter_label,
      phase,
      COUNT(*) as questions,
      COUNT(DISTINCT learning_generation || char(31) || unit_id || char(31) || created_at) as submissions,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
      SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) as incorrect,
      SUM(CASE WHEN is_correct < 0 THEN 1 ELSE 0 END) as pending,
      ROUND(
        100.0 * SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN is_correct >= 0 THEN 1 ELSE 0 END), 0),
        1
      ) as accuracy,
      ROUND(SUM(score), 1) as total_score,
      ROUND(SUM(max_score), 1) as total_max_score,
      ROUND(100.0 * SUM(score) / NULLIF(SUM(max_score), 0), 1) as score_rate,
      MIN(created_at) as first_at,
      MAX(created_at) as last_at
    FROM quiz_results
    WHERE user_id = ? AND phase IN ('pre', 'formative', 'post')${qrDf.clause}
    GROUP BY chapter_id, phase
    ORDER BY chapter_id,
      CASE phase WHEN 'pre' THEN 0 WHEN 'formative' THEN 1 WHEN 'post' THEN 2 ELSE 3 END
  `, [userId, ...qrDf.params]);
  const parsedInteractionRows = researchEvents
    .filter((row) => row.type === "interaction")
    .map((row) => ({
      ...row,
      nickname: user.nickname || "",
      payload: eventPayloadObject(row)
    }));
  const effectivePath = pathAnalysis(parsedInteractionRows)[0] || {
    user_id: userId,
    nickname: user.nickname || "",
    steps: [],
    step_count: 0,
    total_seconds: 0,
    raw_total_seconds: 0,
    capped_segments: 0,
    first_at: "",
    last_at: ""
  };
  const scopeAllHistory = !(dates?.startDate || dates?.endDate);
  return {
    user,
    quizResults,
    quizQuestionRows,
    quizQuestionTotal: Number(quizQuestionTotal || 0),
    quizQuestionLimit: 5000,
    quizOverall: {
      submissions: Number(quizOverallRow.submissions || 0),
      questions: Number(quizOverallRow.questions || 0),
      correct: Number(quizOverallRow.correct || 0),
      incorrect: Number(quizOverallRow.incorrect || 0),
      pending: Number(quizOverallRow.pending || 0),
      accuracy: Number(quizOverallRow.accuracy || 0),
      totalScore: Number(quizOverallRow.total_score || 0),
      totalMaxScore: Number(quizOverallRow.total_max_score || 0),
      scoreRate: Number(quizOverallRow.score_rate || 0),
      generationCount: Number(quizOverallRow.generation_count || 0),
      currentGeneration: Number(
        currentGenerationRow?.generation
        || quizQuestionRows[0]?.learning_generation
        || 1
      ),
      firstAt: quizOverallRow.first_at || "",
      lastAt: quizOverallRow.last_at || ""
    },
    quizPhaseSummary,
    chapterPhaseSummary,
    events,
    eventCount,
    chapterSummary,
    feedbackRows,
    researchSummary: researchSummaryForUser(researchEvents, feedbackCount, agentDecisionCount),
    effectivePath,
    proactiveSummary: proactiveFunnel(parsedInteractionRows),
    scope: {
      allHistory: scopeAllHistory,
      startDate: dates?.startDate || "",
      endDate: dates?.endDate || "",
      eventRowsTruncated: researchEvents.length >= 100000,
      quizRowsTruncated: Number(quizQuestionTotal || 0) > 5000
    }
  };
}

function listUsers() {
  return queryAll(`
    SELECT u.*,
           (
             SELECT COUNT(*)
             FROM (
               SELECT qr.unit_id, qr.created_at
               FROM quiz_results qr
               WHERE qr.user_id = u.id
               GROUP BY qr.unit_id, qr.created_at
             )
           ) as quiz_count
    FROM users u
    ORDER BY u.last_seen_at DESC
  `);
}

function questionTypeAccuracy(dates) {
  const df = dateFilter("created_at", dates);
  return queryAll(`
    SELECT question_type,
           COUNT(*) as total,
           ROUND(AVG(CASE WHEN is_correct >= 0 THEN CAST(is_correct AS REAL) END) * 100, 1) as accuracy,
           ROUND(AVG(score), 1) as avg_score,
           ROUND(AVG(max_score), 1) as avg_max
    FROM quiz_results
    WHERE question_type != ''${df.clause}
    GROUP BY question_type
    ORDER BY accuracy
  `, df.params);
}

function scoreDistribution(dates) {
  const df = dateFilter("created_at", dates);
  return queryAll(`
    SELECT
      CASE
        WHEN CAST(total_score AS REAL) / NULLIF(total_max, 0) >= 1.0 THEN '满分 (100%)'
        WHEN CAST(total_score AS REAL) / NULLIF(total_max, 0) >= 0.8 THEN '80-99%'
        WHEN CAST(total_score AS REAL) / NULLIF(total_max, 0) >= 0.6 THEN '60-79%'
        WHEN CAST(total_score AS REAL) / NULLIF(total_max, 0) >= 0.4 THEN '40-59%'
        WHEN CAST(total_score AS REAL) / NULLIF(total_max, 0) >= 0.2 THEN '20-39%'
        ELSE '0-19%'
      END as bucket,
      COUNT(*) as count,
      MIN(CAST(total_score AS REAL) / NULLIF(total_max, 0)) as min_ratio
    FROM (
      SELECT user_id, unit_id, created_at,
             SUM(score) as total_score,
             SUM(max_score) as total_max
      FROM quiz_results
      WHERE max_score > 0${df.clause}
      GROUP BY user_id, unit_id, created_at
    )
    WHERE total_max > 0
    GROUP BY bucket
    ORDER BY min_ratio
  `, df.params);
}

function hourlyActivity(days = 30, dates) {
  const df = dateFilter("created_at", dates);
  const fallbackStart = `${beijingDateString(new Date(Date.now() - days * 86400000))}T00:00:00.000+08:00`;
  const rows = queryAll(
    `SELECT id, user_id, type, payload, created_at
     FROM events
     WHERE julianday(created_at) >= julianday(?)${df.clause}
     ORDER BY julianday(created_at), id`,
    [fallbackStart, ...df.params]
  );
  return aggregateActivityEvents(rows, (row) => Number(String(row.created_at || "").slice(11, 13)) || 0)
    .map((entry) => ({
      hour: Number(entry.key),
      events_count: entry.events_count,
      active_users: entry.users.size,
      quiz_submissions: entry.quizSubmissions.size
    }))
    .sort((a, b) => a.hour - b.hour);
}

function shortAnswerResponses(options = {}) {
  const df = dateFilter("qr.created_at", options);
  const limit = Math.max(1, Math.min(Number(options.limit || 500), 1000));
  const offset = Math.max(0, Number(options.offset || 0));
  const total = queryOne(
    `SELECT COUNT(*) as c
     FROM quiz_results qr
     WHERE qr.question_type = 'short_answer'${df.clause}`,
    df.params
  ).c;
  const rows = queryAll(`
    SELECT qr.id, u.nickname, qr.user_id, qr.chapter_id, qr.chapter_label, qr.unit_id, qr.unit_label,
           qr.question_id, qr.response, qr.score, qr.max_score,
           qr.is_correct, qr.status, qr.phase, qr.created_at,
           qr.ai_score, qr.ai_confidence, qr.ai_feedback, qr.ai_error_type
    FROM quiz_results qr
    JOIN users u ON u.id = qr.user_id
    WHERE qr.question_type = 'short_answer'${df.clause}
    ORDER BY qr.created_at DESC, qr.id DESC
    LIMIT ? OFFSET ?
  `, [...df.params, limit, offset]);
  return { rows, total, limit, offset };
}

function getEventsByType(type, limitOrOptions = 500, dates) {
  const options = typeof limitOrOptions === "object"
    ? limitOrOptions
    : { limit: limitOrOptions, dates };
  const limit = Math.max(1, Math.min(Number(options.limit || 500), 1000));
  const offset = Math.max(0, Number(options.offset || 0));
  const userId = String(options.userId || "").trim();
  const detailMode = type === "interaction" && options.detailMode !== "all"
    ? "meaningful"
    : "all";
  const range = options.dates || dates;
  const df = dateFilter("e.created_at", range);
  const userClause = userId ? " AND e.user_id = ?" : "";
  const detailFilter = detailMode === "meaningful"
    ? interactionPolicy.sqlMeaningfulFilter("e")
    : { clause: "", params: [] };
  const params = [
    type,
    ...df.params,
    ...(userId ? [userId] : []),
    ...detailFilter.params
  ];
  const total = queryOne(
    `SELECT COUNT(*) as c
     FROM events e
     JOIN users u ON u.id = e.user_id
     WHERE e.type = ?${df.clause}${userClause}${detailFilter.clause}`,
    params
  ).c;
  const rows = queryAll(
    `SELECT e.*, u.nickname
     FROM events e
     JOIN users u ON u.id = e.user_id
     WHERE e.type = ?${df.clause}${userClause}${detailFilter.clause}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { rows, total, limit, offset, detailMode };
}

function interactionRows(filter = {}, limit = 20000) {
  const df = dateFilter("e.created_at", filter);
  const userId = String(filter?.userId || "").trim();
  const userClause = userId ? " AND e.user_id = ?" : "";
  return queryAll(
    `SELECT e.*, u.nickname
     FROM events e
     JOIN users u ON u.id = e.user_id
     WHERE e.type = 'interaction'${df.clause}${userClause}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ?`,
    [...df.params, ...(userId ? [userId] : []), limit]
  ).map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload || "{}"); } catch { payload = {}; }
    return { ...row, payload };
  });
}

function interactionSourceRows(source) {
  return Array.isArray(source) ? source : interactionRows(source);
}

function meaningfulInteractionRows(source) {
  return interactionSourceRows(source).filter((row) =>
    interactionPolicy.isMeaningfulInteraction(row.payload || {}, row.type || "interaction")
  );
}

function interactionPayloadType(payload) {
  return payload.eventType || payload.data?.eventType || "interaction";
}

function interactionPayloadData(payload) {
  return payload.data || {};
}

function interactionMeta(row) {
  const payload = row.payload || {};
  const data = interactionPayloadData(payload);
  const unitId = payload.unitId || data.unitId || data.unit || "";
  const labels = unitDisplayMeta(unitId, {
    chapter_id: payload.chapterId || data.chapterId || "",
    chapter_label: payload.chapterLabel || data.chapterLabel || "",
    unit_label: payload.unitLabel || data.unitLabel || "",
    unit_type: payload.unitType || data.unitType || "",
    module_role: payload.moduleRole || data.moduleRole || ""
  });
  return {
    eventType: interactionPayloadType(payload),
    source: payload.source || data.source || "",
    userId: row.user_id,
    nickname: row.nickname || "",
    chapterId: labels.chapter_id || payload.chapterId || data.chapterId || "",
    chapterLabel: labels.chapter_label || payload.chapterLabel || data.chapterLabel || "",
    unitId,
    unitLabel: labels.unit_label || payload.unitLabel || data.unitLabel || "",
    unitType: payload.unitType || data.unitType || labels.unit_type || "",
    moduleRole: payload.moduleRole || data.moduleRole || labels.module_role || (/^实验[:：]/.test(payload.unitLabel || data.unitLabel || "") ? "experiment" : ""),
    knowledgePoint: payload.knowledgePoint || data.knowledgePoint || labels.knowledge_point || "",
    sceneType: payload.sceneType || data.sceneType || data.selectedSceneType || "",
    sceneLabel: payload.sceneLabel || data.sceneLabel || "",
    resourceTitle: payload.resourceTitle || data.resourceTitle || "",
    durationMs: payload.timing?.durationMs || data.durationMs || 0,
    sessionId: payload.sessionId || "",
    sequenceIndex: Number(payload.sequenceIndex || 0),
    clientAt: payload.timing?.clientAt || row.created_at,
    createdAt: row.created_at,
    data
  };
}

function isParameterOperation(meta) {
  if (meta.eventType === "parameter_commit") return true;
  const id = meta.data.param || meta.data.id || meta.data.name || "";
  const inputType = String(meta.data.type || "").toLowerCase();
  return meta.eventType === "interactive_change" && (inputType === "range" || /slider/i.test(id));
}

function interactionActionCategory(eventType = "") {
  if (eventType === "courseware_page_loaded" || eventType === "courseware_page_summary_shown") return "ready";
  if (eventType === "courseware_hint_used") return "support";
  if (
    eventType === "courseware_prediction_made"
    || eventType === "courseware_confidence_submitted"
    || eventType === "courseware_reflection_submitted"
    || eventType === "courseware_short_explanation_submitted"
  ) return "reflection";
  if (
    eventType === "courseware_pre_check_submitted"
    || eventType === "courseware_formative_check_submitted"
    || eventType === "courseware_exit_ticket_submitted"
    || eventType === "courseware_challenge_result"
  ) return "assessment";
  if (
    eventType === "courseware_interaction_complete"
    || eventType === "courseware_observable_evidence_captured"
    || eventType === "courseware_interaction_change"
  ) return "completion";
  if (eventType === "interactive_ready" || eventType === "interactive_render") return "ready";
  if (eventType === "interactive_submit") return "submit";
  if (eventType === "parameter_change" || eventType === "parameter_commit") return "parameter";
  if (eventType === "interactive_input" || eventType === "interactive_change") return "input";
  if (eventType === "interactive_keydown") return "keyboard";
  if (eventType === "interactive_wheel" || eventType === "interactive_scroll") return "wheel";
  if (eventType === "interactive_click" || eventType === "interactive_double_click" || eventType === "interactive_context_menu") return "click";
  if (/^(interactive_|canvas_).*(pointer|drag)/.test(eventType)) return "gesture";
  if (eventType.startsWith("interactive_") || eventType.startsWith("canvas_")) return "other";
  return "";
}

function isCoursewareAction(meta) {
  return meta.source === "iframe"
    || meta.source === "courseware_semantic"
    || Boolean(interactionActionCategory(meta.eventType));
}

function coursewareActionCoverage(dates) {
  const rows = meaningfulInteractionRows(dates);
  const byType = new Map();
  const byCategory = new Map();
  let total = 0;

  rows.forEach((row) => {
    const meta = interactionMeta(row);
    if (!isCoursewareAction(meta)) return;
    const category = interactionActionCategory(meta.eventType) || "other";
    total += 1;

    const typeItem = byType.get(meta.eventType) || {
      event_type: meta.eventType,
      category,
      count: 0,
      users: new Set(),
      units: new Set(),
      sample_unit_id: "",
      sample_unit_label: "",
      last_at: ""
    };
    typeItem.count += 1;
    typeItem.users.add(meta.userId);
    if (meta.unitId) typeItem.units.add(meta.unitId);
    if (!typeItem.sample_unit_label && (meta.unitLabel || meta.unitId)) {
      const labels = unitDisplayMeta(meta.unitId, meta);
      typeItem.sample_unit_id = labels.unit_id || meta.unitId;
      typeItem.sample_unit_label = labels.unit_label || meta.unitLabel || meta.unitId;
    }
    if (!typeItem.last_at || meta.createdAt > typeItem.last_at) typeItem.last_at = meta.createdAt;
    byType.set(meta.eventType, typeItem);

    const catItem = byCategory.get(category) || {
      category,
      count: 0,
      users: new Set(),
      units: new Set()
    };
    catItem.count += 1;
    catItem.users.add(meta.userId);
    if (meta.unitId) catItem.units.add(meta.unitId);
    byCategory.set(category, catItem);
  });

  const serialize = (item) => ({
    ...item,
    users: item.users.size,
    units: item.units.size
  });

  return {
    total,
    categories: Array.from(byCategory.values()).map(serialize).sort((a, b) => b.count - a.count),
    types: Array.from(byType.values()).map(serialize).sort((a, b) => b.count - a.count)
  };
}

function interactionSummary(dates) {
  const rawRows = interactionSourceRows(dates);
  const rows = meaningfulInteractionRows(rawRows);
  const byType = new Map();
  const byRole = new Map();
  const activeUsers = new Set();
  rows.forEach((row) => {
    const meta = interactionMeta(row);
    activeUsers.add(meta.userId);
    byType.set(meta.eventType, (byType.get(meta.eventType) || 0) + 1);
    if (meta.moduleRole) byRole.set(meta.moduleRole, (byRole.get(meta.moduleRole) || 0) + 1);
  });
  return {
    total: rows.length,
    rawTotal: rawRows.length,
    hiddenLowValue: Math.max(0, rawRows.length - rows.length),
    activeUsers: activeUsers.size,
    byType: Array.from(byType, ([event_type, count]) => ({ event_type, count })).sort((a, b) => b.count - a.count),
    byRole: Array.from(byRole, ([module_role, count]) => ({ module_role, count })).sort((a, b) => b.count - a.count)
  };
}

function effectiveUnitDurationSamples(source) {
  const candidates = interactionSourceRows(source)
    .map((row) => {
      const meta = interactionMeta(row);
      const seconds = interactionDurationSeconds(meta);
      return { row, meta, seconds };
    })
    .filter(({ meta, seconds }) =>
      seconds > 0
      && meta.unitId
      && ["time_on_unit", "unit_leave", "leave_unit"].includes(meta.eventType)
    );
  const primaryByKey = new Map();

  candidates.forEach((candidate) => {
    if (candidate.meta.eventType !== "time_on_unit") return;
    const key = [
      candidate.meta.userId,
      candidate.meta.sessionId,
      candidate.meta.unitId,
      candidate.seconds
    ].join("|");
    const list = primaryByKey.get(key) || [];
    list.push(candidate);
    primaryByKey.set(key, list);
  });

  return candidates.filter((candidate) => {
    if (candidate.meta.eventType === "time_on_unit") return true;
    const key = [
      candidate.meta.userId,
      candidate.meta.sessionId,
      candidate.meta.unitId,
      candidate.seconds
    ].join("|");
    return !(primaryByKey.get(key) || []).some((primary) => {
      if (primary.meta.createdAt === candidate.meta.createdAt) return true;
      if (
        primary.meta.sequenceIndex
        && candidate.meta.sequenceIndex
        && Math.abs(primary.meta.sequenceIndex - candidate.meta.sequenceIndex) <= 2
      ) {
        return true;
      }
      const primaryAt = new Date(primary.meta.clientAt || 0).getTime();
      const candidateAt = new Date(candidate.meta.clientAt || 0).getTime();
      return primaryAt && candidateAt && Math.abs(primaryAt - candidateAt) <= 1500;
    });
  });
}

function unitEngagement(dates) {
  const rows = interactionSourceRows(dates);
  const durationByUnit = new Map();
  effectiveUnitDurationSamples(rows).forEach(({ meta, seconds }) => {
    const key = `${meta.unitId}|${meta.userId}`;
    durationByUnit.set(
      key,
      (durationByUnit.get(key) || 0) + Math.min(seconds, EFFECTIVE_PATH_MAX_SECONDS)
    );
  });
  const units = new Map();
  const ensureItem = (meta, unitId = meta.unitId, fallback = {}) => {
    if (!unitId) return null;
    const labels = unitDisplayMeta(unitId, { ...meta, ...fallback });
    const key = `${labels.unit_id || unitId}|${meta.userId}`;
    const item = units.get(key) || {
      user_id: meta.userId,
      nickname: meta.nickname,
      chapter_id: labels.chapter_id || meta.chapterId,
      chapter_label: labels.chapter_label || meta.chapterLabel,
      unit_id: labels.unit_id || unitId,
      unit_label: labels.unit_label || fallback.unit_label || meta.unitLabel,
      unit_type: meta.unitType,
      module_role: meta.moduleRole,
      opens: 0,
      completes: 0,
      skips: 0,
      repeats: 0,
      seconds: 0,
      clicks: 0,
      gestures: 0,
      inputs: 0,
      submits: 0,
      assessments: 0,
      reflections: 0,
      support_actions: 0,
      completion_evidence: 0,
      keyboard_actions: 0,
      wheel_actions: 0,
      courseware_actions: 0,
      parameter_changes: 0,
      quiz_events: 0,
      last_at: meta.createdAt
    };
    if (meta.createdAt > item.last_at) item.last_at = meta.createdAt;
    units.set(key, item);
    return item;
  };
  rows.forEach((row) => {
    const meta = interactionMeta(row);
    if (meta.eventType === "skip_units") {
      const skippedIds = Array.isArray(meta.data.skippedUnitIds) ? meta.data.skippedUnitIds : [];
      skippedIds.forEach((unitId) => {
        const item = ensureItem(meta, unitId);
        if (item) item.skips += 1;
      });
    }
    if (meta.eventType === "skip_chapters") {
      const skippedChapterIds = Array.isArray(meta.data.skippedChapterIds) ? meta.data.skippedChapterIds : [];
      skippedChapterIds.forEach((chapterId) => {
        const item = ensureItem(meta, `${chapterId}-chapter`, {
          chapter_id: chapterId,
          chapter_label: chapterDisplayLabel(chapterId),
          unit_label: "整章"
        });
        if (item) item.skips += 1;
      });
    }
    if (!meta.unitId) return;
    const item = ensureItem(meta);
    if (!item) return;
    const isUnitOpen = ["unit_enter", "repeat_unit_enter", "unit_open"].includes(meta.eventType)
      || (meta.eventType === "click" && Boolean(meta.data.unit));
    if (isUnitOpen) item.opens += 1;
    if (["unit_complete", "complete_unit"].includes(meta.eventType)) item.completes += 1;
    if (meta.eventType === "repeat_unit_enter") item.repeats += 1;
    if (/click|pointer|drag/.test(meta.eventType)) item.clicks += 1;
    if (isParameterOperation(meta)) item.parameter_changes += 1;
    if (isCoursewareAction(meta)) item.courseware_actions += 1;
    const actionCategory = interactionActionCategory(meta.eventType);
    if (actionCategory === "gesture") item.gestures += 1;
    if (actionCategory === "input") item.inputs += 1;
    if (actionCategory === "submit") item.submits += 1;
    if (actionCategory === "assessment") item.assessments += 1;
    if (actionCategory === "reflection") item.reflections += 1;
    if (actionCategory === "support") item.support_actions += 1;
    if (actionCategory === "completion") item.completion_evidence += 1;
    if (actionCategory === "keyboard") item.keyboard_actions += 1;
    if (actionCategory === "wheel") item.wheel_actions += 1;
    if (/quiz|answer|question|short_answer/.test(meta.eventType)) item.quiz_events += 1;
    if (meta.createdAt > item.last_at) item.last_at = meta.createdAt;
  });
  return Array.from(units.values()).map((item) => {
    const labels = unitDisplayMeta(item.unit_id, item);
    return {
      ...item,
      chapter_label: labels.chapter_label,
      unit_label: labels.unit_label,
      seconds: durationByUnit.get(`${item.unit_id}|${item.user_id}`) || 0
    };
  }).sort((a, b) => (b.seconds - a.seconds) || b.opens - a.opens).slice(0, 1000);
}

function skipRepeatStats(dates) {
  const rows = interactionSourceRows(dates);
  const modules = new Map();
  const ensureModule = (unitId, fallback = {}) => {
    const labels = unitDisplayMeta(unitId, fallback);
    const key = labels.unit_id || unitId || "unknown";
    const item = modules.get(key) || {
      chapter_id: labels.chapter_id,
      chapter_label: labels.chapter_label,
      unit_id: labels.unit_id || unitId,
      unit_label: labels.unit_label || unitId || "未知模块",
      skipped: 0,
      repeated: 0,
      users: new Set(),
      last_at: ""
    };
    modules.set(key, item);
    return item;
  };
  rows.forEach((row) => {
    const meta = interactionMeta(row);
    if (meta.eventType === "skip_units") {
      const skippedIds = Array.isArray(meta.data.skippedUnitIds) ? meta.data.skippedUnitIds : [];
      skippedIds.forEach((unitId) => {
        const item = ensureModule(unitId, meta);
        item.skipped += 1;
        item.users.add(meta.userId);
        if (!item.last_at || meta.createdAt > item.last_at) item.last_at = meta.createdAt;
      });
    }
    if (meta.eventType === "skip_chapters") {
      const skippedChapterIds = Array.isArray(meta.data.skippedChapterIds) ? meta.data.skippedChapterIds : [];
      skippedChapterIds.forEach((chapterId) => {
        const item = ensureModule(`${chapterId}-chapter`, {
          chapter_id: chapterId,
          chapter_label: chapterDisplayLabel(chapterId),
          unit_label: "整章"
        });
        item.skipped += 1;
        item.users.add(meta.userId);
        if (!item.last_at || meta.createdAt > item.last_at) item.last_at = meta.createdAt;
      });
    }
    if (meta.eventType === "repeat_unit_enter") {
      const item = ensureModule(meta.unitId, meta);
      item.repeated += 1;
      item.users.add(meta.userId);
      if (meta.createdAt > item.last_at) item.last_at = meta.createdAt;
    }
  });
  const resultRows = Array.from(modules.values()).map((item) => ({
    ...item,
    users: item.users.size,
    total: item.skipped + item.repeated
  })).sort((a, b) => b.total - a.total || b.skipped - a.skipped || String(b.last_at).localeCompare(String(a.last_at))).slice(0, 500);
  return { rows: resultRows };
}

function parameterChangeStats(dates) {
  const rows = interactionSourceRows(dates);
  const params = new Map();
  const users = new Set();
  const units = new Set();
  let operations = 0;
  rows.forEach((row) => {
    const meta = interactionMeta(row);
    if (!isParameterOperation(meta)) return;
    const param = meta.data.param || meta.data.name || meta.data.id || meta.data.label || "unknown";
    const key = `${meta.unitId}|${param}`;
    const item = params.get(key) || {
      chapter_id: meta.chapterId,
      unit_id: meta.unitId,
      unit_label: meta.unitLabel,
      module_role: meta.moduleRole,
      param,
      changes: 0,
      users: new Set()
    };
    item.changes += 1;
    item.users.add(meta.userId);
    users.add(meta.userId);
    if (meta.unitId) units.add(meta.unitId);
    operations += 1;
    params.set(key, item);
  });
  return {
    summary: {
      users: users.size,
      operations,
      experiments: units.size
    },
    rows: Array.from(params.values()).map((item) => ({
      ...item,
      users: item.users.size
    })).sort((a, b) => b.changes - a.changes).slice(0, 500)
  };
}

function interactionDurationSeconds(meta) {
  const durationMs = Number(meta.durationMs || meta.data.durationMs || 0);
  const seconds = Number(meta.data.seconds || 0);
  return Math.max(0, Math.round(seconds || durationMs / 1000));
}

function interactionSceneEvidenceIndex(source) {
  const evidenceByContext = new Map();
  interactionSourceRows(source).forEach((row) => {
    const meta = interactionMeta(row);
    if (!meta.userId || !meta.sessionId || !meta.unitId || !meta.sceneType) return;
    const at = new Date(meta.clientAt || meta.createdAt || 0).getTime();
    const key = `${meta.userId}|${meta.sessionId}|${meta.unitId}`;
    const list = evidenceByContext.get(key) || [];
    list.push({
      scene_type: String(meta.sceneType),
      scene_label: sceneDisplayLabel(meta.sceneType, meta.sceneLabel),
      resource_title: meta.resourceTitle || "",
      at: Number.isFinite(at) ? at : 0,
      sequence_index: Number(meta.sequenceIndex || 0)
    });
    evidenceByContext.set(key, list);
  });
  evidenceByContext.forEach((list) => {
    list.sort((left, right) =>
      (left.at - right.at) || (left.sequence_index - right.sequence_index)
    );
  });
  return evidenceByContext;
}

function resolvedInteractionScene(meta, evidenceByContext) {
  if (meta.sceneType) {
    return {
      scene_type: String(meta.sceneType),
      scene_label: sceneDisplayLabel(meta.sceneType, meta.sceneLabel),
      resource_title: meta.resourceTitle || ""
    };
  }
  if (!meta.userId || !meta.sessionId || !meta.unitId) return null;
  const key = `${meta.userId}|${meta.sessionId}|${meta.unitId}`;
  const candidates = evidenceByContext.get(key) || [];
  const targetAt = new Date(meta.clientAt || meta.createdAt || 0).getTime();
  const targetSequence = Number(meta.sequenceIndex || 0);
  let resolved = null;
  for (const candidate of candidates) {
    if (candidate.at > targetAt) break;
    if (
      candidate.at === targetAt
      && candidate.sequence_index
      && targetSequence
      && candidate.sequence_index > targetSequence
    ) {
      break;
    }
    resolved = candidate;
  }
  return resolved;
}

function pathAnalysis(dates) {
  const rows = interactionSourceRows(dates);
  const sceneEvidence = interactionSceneEvidenceIndex(rows);
  const samples = effectiveUnitDurationSamples(rows).sort((left, right) => {
    const leftAt = new Date(left.meta.clientAt || left.meta.createdAt || 0).getTime();
    const rightAt = new Date(right.meta.clientAt || right.meta.createdAt || 0).getTime();
    return leftAt - rightAt;
  });
  const paths = new Map();
  samples.forEach(({ meta, seconds: rawSeconds }) => {
    if (rawSeconds < EFFECTIVE_PATH_MIN_SECONDS) return;
    const effectiveSeconds = Math.min(rawSeconds, EFFECTIVE_PATH_MAX_SECONDS);
    const capped = rawSeconds > EFFECTIVE_PATH_MAX_SECONDS;
    const item = paths.get(meta.userId) || {
      user_id: meta.userId,
      nickname: meta.nickname,
      steps: [],
      first_at: meta.createdAt,
      last_at: meta.createdAt,
      total_seconds: 0,
      raw_total_seconds: 0,
      capped_segments: 0
    };
    item.total_seconds += effectiveSeconds;
    item.raw_total_seconds += rawSeconds;
    if (capped) item.capped_segments += 1;
    const lastStep = item.steps[item.steps.length - 1];
    const labels = unitDisplayMeta(meta.unitId, meta);
    const isKnowledgePoint = (labels.unit_type || meta.unitType) === "knowledge"
      || /^(?:GH|EXT)-\d+-K\d+$/i.test(meta.unitId || "");
    const resolvedScene = isKnowledgePoint
      ? resolvedInteractionScene(meta, sceneEvidence)
      : null;
    const sceneType = resolvedScene?.scene_type || "";
    const sceneLabel = isKnowledgePoint
      ? resolvedScene?.scene_label || "历史记录未包含场景"
      : "";
    if (lastStep?.unit_id === meta.unitId && lastStep?.scene_type === sceneType) {
      lastStep.seconds += effectiveSeconds;
      lastStep.raw_seconds += rawSeconds;
      lastStep.capped = lastStep.capped || capped;
      lastStep.events += 1;
      lastStep.last_at = meta.createdAt;
    } else {
      item.steps.push({
        chapter_id: labels.chapter_id,
        unit_id: meta.unitId,
        unit_label: labels.unit_label,
        unit_type: labels.unit_type || meta.unitType,
        module_role: labels.module_role || meta.moduleRole,
        knowledge_point: labels.knowledge_point || meta.knowledgePoint || "",
        scene_type: sceneType,
        scene_label: sceneLabel,
        resource_title: resolvedScene?.resource_title || meta.resourceTitle || "",
        display_label: sceneLabel ? `${labels.unit_label} · ${sceneLabel}` : labels.unit_label,
        at: meta.createdAt,
        last_at: meta.createdAt,
        seconds: effectiveSeconds,
        raw_seconds: rawSeconds,
        capped,
        events: 1
      });
    }
    item.last_at = meta.createdAt;
    paths.set(meta.userId, item);
  });
  return Array.from(paths.values()).filter((item) => item.steps.length > 0).map((item) => ({
    ...item,
    step_count: item.steps.length,
    path_preview: item.steps.slice(0, 20).map((step) => step.display_label || step.unit_label || step.unit_id).join(" -> ")
  })).sort((a, b) => b.total_seconds - a.total_seconds || b.step_count - a.step_count);
}

function proactiveFunnel(source) {
  const rows = interactionSourceRows(source);
  const counts = new Map();
  const acceptedUsers = new Set();
  rows.forEach((row) => {
    const type = interactionPayloadType(row.payload || {});
    if (!type.startsWith("knowledge_proactive_") && !type.startsWith("knowledge_quiz_review_")) return;
    counts.set(type, Number(counts.get(type) || 0) + 1);
    if (type === "knowledge_proactive_suggestion_accepted" && row.user_id) {
      acceptedUsers.add(row.user_id);
    }
  });
  const count = (type) => Number(counts.get(type) || 0);
  const accepted = count("knowledge_proactive_suggestion_accepted");
  const dismissed = count("knowledge_proactive_suggestion_dismissed");
  const ignored = count("knowledge_proactive_suggestion_ignored");
  const resolved = accepted + dismissed + ignored;
  const shown = count("knowledge_proactive_suggestion_shown");
  return {
    agentDecided: count("knowledge_proactive_agent_decided"),
    agentSilent: count("knowledge_proactive_agent_silent")
      + count("knowledge_proactive_fallback_silent")
      + count("knowledge_proactive_budget_exhausted"),
    shown,
    accepted,
    dismissed,
    ignored,
    quizReviewCompleted: count("knowledge_quiz_review_completed"),
    acceptedUsers: acceptedUsers.size,
    acceptanceRate: resolved ? Math.round((accepted / resolved) * 1000) / 10 : 0,
    resolutionRate: shown ? Math.min(100, Math.round((resolved / shown) * 1000) / 10) : 0
  };
}

function interactionDashboard(dates) {
  const rows = interactionRows(dates);
  return {
    summary: interactionSummary(rows),
    proactiveFunnel: proactiveFunnel(rows),
    actionCoverage: coursewareActionCoverage(rows),
    pathRule: {
      minSeconds: EFFECTIVE_PATH_MIN_SECONDS,
      maxSeconds: EFFECTIVE_PATH_MAX_SECONDS,
      label: `单次模块停留计入 ${EFFECTIVE_PATH_MIN_SECONDS}-${EFFECTIVE_PATH_MAX_SECONDS} 秒`
    },
    unitEngagement: unitEngagement(rows),
    skipRepeat: skipRepeatStats(rows),
    parameterChanges: parameterChangeStats(rows),
    pathAnalysis: pathAnalysis(rows)
  };
}

function parseJsonField(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function agenticDecisionTrace(dates = {}) {
  const df = dateFilter("ad.created_at", dates);
  const userId = String(dates?.userId || "").trim();
  const userClause = userId ? " AND ad.user_id = ?" : "";
  const limit = Math.max(1, Math.min(Number(dates.limit || 500), 1000));
  const offset = Math.max(0, Number(dates.offset || 0));
  const params = [...df.params, ...(userId ? [userId] : [])];
  const total = queryOne(
    `SELECT COUNT(*) as c
     FROM agent_decisions ad
     WHERE ad.agent_type = 'orchestrator'${df.clause}${userClause}`,
    params
  ).c;
  const rows = queryAll(
    `SELECT ad.*, u.nickname
     FROM agent_decisions ad
     LEFT JOIN users u ON u.id = ad.user_id
     WHERE ad.agent_type = 'orchestrator'${df.clause}${userClause}
     ORDER BY julianday(ad.created_at) DESC, ad.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const tracedRows = rows.map((row) => {
    const input = parseJsonField(row.input_summary);
    const output = parseJsonField(row.output_summary);
    const planner = output.planner || {};
    const plannerTop = planner.recommendedResource
      || (Array.isArray(planner.rankedResourceChoices) ? planner.rankedResourceChoices[0] || {} : {})
      || (Array.isArray(planner.rankedSceneChoices) ? planner.rankedSceneChoices[0] || {} : {});
    const snapshot = queryOne(
      `SELECT * FROM interaction_evidence_snapshots
       WHERE agent_decision_id = ? AND evidence_scope = 'current'
       ORDER BY julianday(created_at) DESC LIMIT 1`,
      [row.id]
    );
    const snapshotEvidence = snapshot ? parseJsonField(snapshot.evidence_json) : {};
    const evidence = Object.keys(snapshotEvidence).length ? snapshotEvidence : (output.interactionEvidence?.current || {});
    const unitId = input.currentUnitId || evidence.unitId || "";
    const unitMeta = unitDisplayMeta(unitId, { chapter_id: input.chapterId || evidence.chapterId || "" });
    const executedEvents = queryAll(
      `SELECT e.created_at, e.payload
       FROM events e
       WHERE e.user_id = ? AND e.type = 'interaction'
         AND julianday(e.created_at) >= julianday(?)
       ORDER BY julianday(e.created_at) ASC, e.id ASC
       LIMIT 80`,
      [row.user_id, row.created_at]
    ).map((eventRow) => {
      const payload = parseJsonField(eventRow.payload);
      return { created_at: eventRow.created_at, payload };
    });
    const executed = executedEvents.find((eventRow) => {
      const data = eventRow.payload?.data || {};
      const eventType = eventRow.payload?.eventType || data.eventType || "";
      return eventType === "agentic_decision_executed" && data.sourceAgentDecisionId === row.id;
    }) || executedEvents.find((eventRow) => {
      const payload = eventRow.payload || {};
      const data = payload.data || {};
      const eventType = payload.eventType || payload.data?.eventType || "";
      return eventType === "agentic_decision_executed" && !data.sourceAgentDecisionId && (!unitId || data.fromUnitId === unitId);
    });
    const executedData = executed?.payload?.data || {};
    const outcome = unitId ? queryOne(
      `SELECT COUNT(DISTINCT unit_id || char(31) || created_at) as quiz_count,
              ROUND(AVG(CASE WHEN is_correct >= 0 THEN CAST(is_correct AS REAL) END) * 100, 1) as accuracy,
              SUM(score) as score,
              SUM(max_score) as max_score,
              MAX(created_at) as last_quiz_at
       FROM quiz_results
       WHERE user_id = ? AND julianday(created_at) >= julianday(?) AND chapter_id = ?`,
      [row.user_id, row.created_at, input.chapterId || unitMeta.chapter_id || ""]
    ) : {};
    return {
      id: row.id,
      user_id: row.user_id,
      nickname: row.nickname || "",
      created_at: row.created_at,
      chapter_id: input.chapterId || unitMeta.chapter_id || evidence.chapterId || "",
      chapter_label: unitMeta.chapter_label,
      unit_id: unitId,
      unit_label: unitMeta.unit_label,
      suggested_action: output.action || "",
      qa_pass: output.qa?.approved ?? output.qa?.pass ?? output.qa?.ok ?? null,
      evidence_snapshot_id: snapshot?.id || "",
      planner_strategy: planner.strategy || "",
      planner_action: planner.recommendedPath?.action || "",
      planner_target_id: plannerTop.id || planner.recommendedPath?.targetId || "",
      planner_target_label: plannerTop.title || plannerTop.typeId || planner.recommendedPath?.targetLabel || "",
      planner_top_score: plannerTop.score ?? "",
      planner_top_reasons: Array.isArray(plannerTop.reasons) ? plannerTop.reasons.join(";") : "",
      risk_level: evidence.riskLevel || "",
      suggested_move: evidence.suggestedMove || "",
      friction_score: evidence.frictionScore ?? "",
      engagement_score: evidence.engagementScore ?? "",
      dwell_ms: evidence.dwellMs || 0,
      repeat_count: evidence.repeatCount || 0,
      answer_reveal_count: evidence.answerRevealCount || 0,
      short_answer_length: evidence.shortAnswerLength || 0,
      learner_action: executedData.action || "",
      target_id: executedData.targetId || "",
      target_label: executedData.targetLabel || unitDisplayMeta(executedData.targetId || "").unit_label || "",
      executed_at: executed?.created_at || "",
      source_agent_decision_id: executedData.sourceAgentDecisionId || "",
      recommendation_created_at: executedData.recommendationCreatedAt || "",
      choice_latency_ms: executedData.choiceLatencyMs ?? "",
      candidate_actions: Array.isArray(executedData.candidateActions) ? executedData.candidateActions : [],
      selected_action_label: executedData.selectedActionLabel || "",
      selected_candidate_ids: Array.isArray(executedData.selectedCandidateIds) ? executedData.selectedCandidateIds : [],
      selected_scene_id: executedData.selectedSceneId || "",
      selected_scenario_type: executedData.selectedScenarioType || "",
      next_unit_id: executedData.nextUnitId || "",
      next_cluster_id: executedData.nextClusterId || "",
      next_cluster_label: executedData.nextClusterLabel || "",
      outcome_quiz_count: outcome?.quiz_count || 0,
      outcome_accuracy: outcome?.accuracy ?? null,
      outcome_score: outcome?.score || 0,
      outcome_max_score: outcome?.max_score || 0,
      outcome_last_quiz_at: outcome?.last_quiz_at || ""
    };
  });
  return { rows: tracedRows, total, limit, offset };
}

function interactionEvidenceSnapshots(dates = {}) {
  const df = dateFilter("ies.created_at", dates);
  const userId = String(dates?.userId || "").trim();
  const userClause = userId ? " AND ies.user_id = ?" : "";
  return queryAll(
    `SELECT ies.*, u.nickname
     FROM interaction_evidence_snapshots ies
     LEFT JOIN users u ON u.id = ies.user_id
     WHERE 1=1${df.clause}${userClause}
     ORDER BY julianday(ies.created_at) DESC, ies.id DESC
     LIMIT 1000`,
    [...df.params, ...(userId ? [userId] : [])]
  );
}

module.exports = {
  getDb,
  getDbSync,
  saveNow,
  normalizeLearningSnapshot,
  acquireWriteLock,
  releaseWriteLock,
  databaseSafetyInfo,
  upsertUser,
  getUser,
  getUserByNicknameNorm,
  getUsersByNicknameNorm,
  getUserByEmailNorm,
  getUsersByEmailNorm,
  updateUserProfile,
  createSession,
  getSession,
  touchSession,
  revokeSession,
  currentLearningGeneration,
  insertQuizResult,
  reconcileQuizResults,
  getQuizResultsByUser,
  getQuizResultsByUserUnit,
  getQuizResultById,
  getLearningAssistantMessages,
  getLearningAssistantMessage,
  updateLearningAssistantMessageContext,
  saveLearningAssistantTurn,
  getLearningAssistantConversation,
  listLearningAssistantConversations,
  renameLearningAssistantConversation,
  setLearningAssistantConversationArchived,
  deleteLearningAssistantConversation,
  getLearningAssistantDailyUsage,
  consumeLearningAssistantInterventionBudget,
  consumeLearningAssistantDailyQuota,
  releaseLearningAssistantDailyQuota,
  getLearningNote,
  listLearningNotes,
  upsertLearningNote,
  syncLearningNotes,
  deleteLearningNote,
  insertEvent,
  insertSnapshot,
  getLatestSnapshot,
  listLearningSnapshots,
  getLearningSnapshotState,
  saveLearningSnapshot,
  resetLearningSnapshot,
  insertFeedback,
  feedbackDashboard,
  statsOverview,
  chapterAccuracy,
  questionErrors,
  userProgress,
  dailyActivity,
  phaseComparison,
  userDetail,
  listUsers,
  questionTypeAccuracy,
  scoreDistribution,
  hourlyActivity,
  getEventsByType,
  shortAnswerResponses,
  shortAnswerRegradeCandidates,
  insertGradingRegradeAudit,
  applyQuizResultRegrade,
  gradingRegradeAudits,
  interactionSummary,
  unitEngagement,
  skipRepeatStats,
  parameterChangeStats,
  pathAnalysis,
  interactionDashboard,
  agenticDecisionTrace,
  interactionEvidenceSnapshots,
  insertAgentDecision,
  insertInteractionEvidenceBatch,
  insertInteractionEvidenceSnapshot,
  updateQuizResultAiGrading,
  normalizeFailedPendingQuizReviews,
  normalizeLegacyPendingShortAnswerFlags,
  normalizeReviewedShortAnswerFlags,
  interactionRows
};

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
// Load .env (if present) so LLM_PROVIDER / OPENAI_COMPATIBLE_API_KEY etc. can be configured without a process manager.
(function loadEnvFile() {
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      const first = val.charCodeAt(0);
      const last = val.charCodeAt(val.length - 1);
      if (val.length >= 2 && first === last && (first === 34 || first === 39)) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    console.warn(".env load skipped:", e.message);
  }
})();

const db = require("./db");
const courseAssessment = require("./lib/course-assessment");
const learningAssistant = require("./lib/learning-assistant");
const llm = require("./lib/llm");
const kg = require("./lib/kg");
const coach = require("./lib/agentic-coach");
const orchestrator = require("./lib/agent-orchestrator");
const gradingRegrade = require("./lib/grading-regrade");
const feedback = require("./lib/feedback");
const systemAnnouncementApi = require("./lib/system-announcement-api");
const root = process.cwd();
let coursewareBridgeScript = "";
try {
  coursewareBridgeScript = fs.readFileSync(
    path.join(root, "app", "main", "courseware-bridge.js"),
    "utf8"
  );
} catch (error) {
  console.warn("Courseware context bridge load skipped:", error.message);
}
const learningRoutePath = path.join(root, "data", "multi-scene-learning-route.json");
const learningRouteApiPaths = new Set([
  "/api/course/multi-scene-learning-route",
  // Cached clients from the previous release may still request this alias.
  "/api/course/openmaic-v14-route"
]);
const flowTestRouteApiPath = "/api/course/flow-test-route";
let learningRoute = null;
let publicLearningRouteJson = "";
let flowTestRouteJson = "";
let assessmentIndex = new Map();
let assistantContextIndex = { routeVersion: "", units: new Map(), questions: new Map() };
try {
  learningRoute = JSON.parse(fs.readFileSync(learningRoutePath, "utf8"));
  publicLearningRouteJson = JSON.stringify(courseAssessment.buildPublicLearningRoute(learningRoute));
  flowTestRouteJson = JSON.stringify(learningRoute);
  assessmentIndex = courseAssessment.buildAssessmentIndex(learningRoute);
  assistantContextIndex = learningAssistant.buildCourseContextIndex(learningRoute);
} catch (error) {
  console.warn("Multi-scene learning route load skipped:", error.message);
}
const coursewareFeedbackTargetLookup = feedback.buildCoursewareFeedbackTargetLookup(
  learningRoute,
  kg.nodeById
);
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const port = Number(process.argv[2] || process.env.PORT || 8765);
const host = process.env.HOST || "127.0.0.1";
const configuredBasePath = String(process.env.BASE_PATH || "").trim();
const gradingRegradeInFlightIds = new Set();
const normalizedBasePath = configuredBasePath.replace(/^\/+|\/+$/g, "");
const basePath = normalizedBasePath ? `/${normalizedBasePath}` : "";
const researchConfig = {
  appVersion: String(process.env.APP_VERSION || packageInfo.version || "").slice(0, 80),
  experimentId: String(process.env.EXPERIMENT_ID || "").slice(0, 120),
  condition: String(process.env.EXPERIMENT_CONDITION || "").slice(0, 120),
  cohort: String(process.env.EXPERIMENT_COHORT || "").slice(0, 120)
};
const maxBodyBytes = 1024 * 1024;
const maxBufferedStaticBytes = 512 * 1024;
const maxGzipBytes = 256 * 1024;
const gzipCache = new Map();
const maxGzipCacheEntries = 32;
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
const authAttemptWindowMs = 15 * 60 * 1000;
const maxFailedAuthAttempts = 8;
const authAttemptMap = new Map();
const assistantRateLimitMap = new Map();
const assistantInterventionRegistry = new Map();
const assistantRateLimitWindowMs = 60 * 1000;
const assistantRateLimitMax = 20;
const assistantInterventionTtlMs = 15 * 60 * 1000;
const assistantInterventionRegistryLimit = 5000;
const assistantHistoryMessageLimit = 60;
const assistantConversationTurnLimit = 30;
const assistantDailyQuotaLimit = Math.max(
  1,
  Math.min(10000, Number(process.env.LEARNING_ASSISTANT_DAILY_QUOTA || 30) || 30)
);
const assistantDailyInterventionLimit = Math.max(
  0,
  Math.min(100, Number(process.env.LEARNING_ASSISTANT_DAILY_INTERVENTIONS || 10) || 10)
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};
const publicRootFiles = new Set([
  "index.html",
  "admin.html",
  "flow-test.html",
  "styles.css",
  "favicon.ico"
]);
const publicFlowTestFiles = new Set([
  "app/flow-test/flow-test.css",
  "app/flow-test/flow-test.js",
  "data/knowledge-graph.json"
]);
const publicLearningRouteStaticPath = "/data/multi-scene-learning-route.json";
const publicLibFiles = new Set([
  "lib/katex.min.css",
  "lib/katex.min.js",
  "lib/chart.umd.min.js",
  "lib/interaction-policy.js",
  "lib/active-time-policy.js",
  "lib/quiz-question-order.js"
]);
const publicResourceExtensions = new Set([
  ".html",
  ".htm",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4"
]);
const publicAssetExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico"
]);
const publicFontExtensions = new Set([".woff", ".woff2", ".ttf"]);

function send(res, status, body, type = "text/plain; charset=utf-8", extraHeaders = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function shouldCompress(req, type, size) {
  if (!/\btext\/|javascript|json|svg|xml/.test(type)) return false;
  if (!/\bgzip\b/.test(req.headers["accept-encoding"] || "")) return false;
  return size > 1024 && size <= maxGzipBytes;
}

function cacheControlFor(filePath, url) {
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
  const ext = path.extname(filePath).toLowerCase();
  if (
    relative === "index.html"
    || relative === "admin.html"
    || relative === "flow-test.html"
    || publicFlowTestFiles.has(relative)
  ) return "no-store, max-age=0, no-transform";
  if (
    relative.startsWith("resources/open-maic/")
    && (ext === ".html" || ext === ".htm")
    && url?.searchParams.has("cqContextBridge")
  ) return "no-store, max-age=0, no-transform";
  // Versioned assets (cache-busted with ?v= param) can be cached aggressively.
  if (url && url.searchParams.has("v") && (ext === ".js" || ext === ".css")) return "public, max-age=604800, immutable";
  if (ext === ".js" || ext === ".css") return "no-store, max-age=0";
  if (relative.startsWith("resources/") && ext === ".json") return "public, max-age=3600";
  if (relative.startsWith("resources/")) return "public, max-age=86400";
  return "public, max-age=3600";
}

function contentSecurityPolicyFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".html") return null;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' data: https://cdn.jsdelivr.net",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: about:",
    "media-src 'self' data: blob: https:",
    "frame-src 'self' http://localhost:3000 http://127.0.0.1:3000 http://localhost:3001 http://127.0.0.1:3001 http://localhost:8765 http://127.0.0.1:8765",
    "child-src 'self' http://localhost:3000 http://127.0.0.1:3000 http://localhost:3001 http://127.0.0.1:3001 http://localhost:8765 http://127.0.0.1:8765",
    "worker-src 'self' blob:",
    "connect-src 'self'"
  ].join("; ");
}

function staticHeaders(filePath, url, extraHeaders = {}) {
  const headers = {
    "Cache-Control": cacheControlFor(filePath, url),
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  };
  const csp = contentSecurityPolicyFor(filePath);
  if (csp) headers["Content-Security-Policy"] = csp;
  return headers;
}

function gzipCacheKey(filePath, data) {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.mtimeMs}:${data.length}`;
  } catch {
    return `${filePath}:${data.length}`;
  }
}

function rememberGzip(key, value) {
  if (value.length > maxGzipBytes) return;
  gzipCache.set(key, value);
  if (gzipCache.size <= maxGzipCacheEntries) return;
  const oldest = gzipCache.keys().next().value;
  if (oldest) gzipCache.delete(oldest);
}

function isBlockedStaticResource(filePath) {
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
  return /^resources\/open-maic\/.+\/manifest\.json$/.test(relative);
}

function isCoursewareHtml(filePath) {
  if (!coursewareBridgeScript || path.extname(filePath).toLowerCase() !== ".html") return false;
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
  return /^resources\/open-maic\/.+\.html$/i.test(relative);
}

function injectCoursewareBridge(data) {
  if (!coursewareBridgeScript) return data;
  const source = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
  if (/data-cq-context-bridge/i.test(source)) return Buffer.from(source, "utf8");
  const safeScript = coursewareBridgeScript.replace(/<\/script/gi, "<\\/script");
  const injection = `\n<script data-cq-context-bridge="1">\n${safeScript}\n</script>\n`;
  const closeBodyAt = source.toLowerCase().lastIndexOf("</body>");
  const html = closeBodyAt >= 0
    ? `${source.slice(0, closeBodyAt)}${injection}${source.slice(closeBodyAt)}`
    : `${source}${injection}`;
  return Buffer.from(html, "utf8");
}


function streamStaticFile(req, res, filePath, type, url, stat) {
  const headers = staticHeaders(filePath, url, {
    "Content-Length": String(stat.size)
  });
  res.writeHead(200, {
    "Content-Type": type,
    ...headers
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", (error) => {
    console.error("Static stream error:", error.message);
    if (!res.headersSent) send(res, 500, "服务器内部错误。");
    else res.destroy(error);
  });
  stream.pipe(res);
}

function getDateRange(url) {
  const range = url.searchParams.get("range") || "";
  if (range) {
    const now = new Date();
    const fmt = (date) => new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const startOfDay = (date) => `${fmt(date)}T00:00:00.000+08:00`;
    const endOfDay = (date) => `${fmt(date)}T23:59:59.999+08:00`;
    let start, end;
    switch (range) {
      case "today":
        start = startOfDay(now); end = endOfDay(now);
        break;
      case "yesterday": {
        const y = new Date(now.getTime() - 86400000);
        start = startOfDay(y); end = endOfDay(y);
        break;
      }
      case "24h":
        start = beijingIso(new Date(now.getTime() - 86400000));
        end = beijingIso(now);
        break;
      case "14d": {
        const d = new Date(now.getTime() - 14 * 86400000);
        start = startOfDay(d); end = endOfDay(now);
        break;
      }
      case "30d": {
        const d = new Date(now.getTime() - 30 * 86400000);
        start = startOfDay(d); end = endOfDay(now);
        break;
      }
      case "month": {
        start = `${fmt(now).slice(0, 7)}-01T00:00:00.000+08:00`;
        end = endOfDay(now);
        break;
      }
      default:
        start = ""; end = "";
    }
    return { startDate: start, endDate: end };
  }
  const start = url.searchParams.get("start_date") || "";
  const end = url.searchParams.get("end_date") || "";
  const startInclusive = start ? `${start}T00:00:00.000+08:00` : "";
  const endInclusive = end ? `${end}T23:59:59.999+08:00` : "";
  return { startDate: startInclusive, endDate: endInclusive };
}

function beijingIso(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, -1) + "+08:00";
}

function nowIso() {
  return beijingIso();
}

function futureIso(msFromNow) {
  return beijingIso(new Date(Date.now() + msFromNow));
}

function trustedClientEventTime(item = {}, receivedAt = new Date()) {
  const candidate = item?.payload?.timing?.clientAt;
  const parsed = Date.parse(String(candidate || ""));
  if (!Number.isFinite(parsed)) return receivedAt.getTime();
  const delta = parsed - receivedAt.getTime();
  const maxPastSkewMs = 7 * 24 * 60 * 60 * 1000;
  const maxFutureSkewMs = 10 * 60 * 1000;
  return delta >= -maxPastSkewMs && delta <= maxFutureSkewMs
    ? parsed
    : receivedAt.getTime();
}

function clientEventId(userId = "", item = {}) {
  const raw = String(item.eventId || item.payload?.eventId || "").trim();
  if (!raw || raw.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(raw)) {
    return crypto.randomUUID();
  }
  return `${userId}:${raw}`;
}

function cleanNickname(value = "") {
  return String(value).trim().replace(/\s+/g, " ").slice(0, 24);
}

function isValidNickname(value = "") {
  return !value || (Array.from(String(value)).length >= 2 && Array.from(String(value)).length <= 24);
}

function cleanEmail(value = "") {
  return String(value).trim().toLowerCase().slice(0, 254);
}

function normalizeIdentity(value = "") {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeEmail(value = "") {
  return cleanEmail(value).normalize("NFKC");
}

function isValidEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanLoginIdentifier(value = "") {
  return String(value).trim().replace(/\s+/g, " ").slice(0, 254);
}

function participantIdFor(nickname) {
  return `participant-${crypto.createHash("sha256").update(nickname).digest("hex").slice(0, 12)}`;
}

function participantIdForIdentity(nicknameNorm, emailNorm) {
  return participantIdFor(nicknameNorm || emailNorm || crypto.randomUUID());
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const params = { N: 16384, r: 8, p: 1, keylen: 64 };
  const hash = crypto.scryptSync(String(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 32 * 1024 * 1024
  }).toString("hex");
  return `scrypt$${params.N}$${params.r}$${params.p}$${params.keylen}$${salt}$${hash}`;
}

function verifyPassword(password, stored = "") {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt") return false;
    const [, n, r, p, keylen, salt, expectedHex] = parts;
    const params = {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      keylen: Number(keylen)
    };
    if (!params.N || !params.r || !params.p || !params.keylen || params.keylen > 128) return false;
    if (!/^[a-f0-9]+$/i.test(expectedHex) || expectedHex.length !== params.keylen * 2) return false;
    const expected = Buffer.from(expectedHex, "hex");
    const actual = crypto.scryptSync(String(password), salt, params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 32 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function isUsablePassword(password = "") {
  const value = String(password || "");
  return value.length >= 8 && value.length <= 72;
}

function publicDisplayName(row) {
  return row?.nickname || row?.email || "未命名用户";
}

function safePublicParticipant(row) {
  if (!row) return null;
  return {
    participantId: row.id,
    loginMode: "password",
    nickname: row.nickname || "",
    email: row.email || "",
    displayName: publicDisplayName(row),
    profileUpdatedAt: row.profile_updated_at || "",
    canEditProfile: !row.profile_updated_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

function summaryFromData(data) {
  if (!data) return {};
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return {
    completed: Array.isArray(parsed.completed) ? parsed.completed.length : 0,
    quizResults: Array.isArray(parsed.quizResults) ? parsed.quizResults.length : 0,
    logs: Array.isArray(parsed.logs) ? parsed.logs.length : 0,
    currentChapterId: parsed.currentChapterId || "",
    currentUnitId: parsed.currentUnitId || "",
    hasNote: Boolean(parsed.note)
  };
}

// Simple in-memory rate limiter for API routes.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = Math.max(
  100,
  Number(process.env.RATE_LIMIT_WINDOW_MS || 60000) || 60000
);
const RATE_LIMIT_MAX = Math.max(
  1,
  Number(process.env.RATE_LIMIT_MAX || 120) || 120
);

function checkRateLimit(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;

 // Cleanup stale entries periodically
 if (rateLimitMap.size > 5000) {
   for (const [key, val] of rateLimitMap) {
     if (now >= val.resetAt) rateLimitMap.delete(key);
   }
 }
  return true;
}

function checkAssistantRateLimit(userId = "") {
  const key = String(userId || "unknown");
  const now = Date.now();
  let entry = assistantRateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + assistantRateLimitWindowMs };
    assistantRateLimitMap.set(key, entry);
  }
  entry.count += 1;
  if (assistantRateLimitMap.size > 5000) {
    for (const [itemKey, item] of assistantRateLimitMap) {
      if (now > item.resetAt) assistantRateLimitMap.delete(itemKey);
    }
  }
  return {
    ok: entry.count <= assistantRateLimitMax,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  };
}

function authAttemptKey(req, identifier = "") {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  return `${ip}|${normalizeIdentity(identifier) || "unknown"}`;
}

function authAttemptEntry(req, identifier = "") {
  const key = authAttemptKey(req, identifier);
  const now = Date.now();
  let entry = authAttemptMap.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + authAttemptWindowMs };
    authAttemptMap.set(key, entry);
  }
  if (authAttemptMap.size > 5000) {
    for (const [itemKey, item] of authAttemptMap) {
      if (now > item.resetAt) authAttemptMap.delete(itemKey);
    }
  }
  return { key, entry, now };
}

function checkAuthAttemptLimit(req, identifier = "") {
  const { entry, now } = authAttemptEntry(req, identifier);
  if (entry.count < maxFailedAuthAttempts) return { ok: true, retryAfterSeconds: 0 };
  return {
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  };
}

function recordFailedAuthAttempt(req, identifier = "") {
  const { entry } = authAttemptEntry(req, identifier);
  entry.count += 1;
}

function clearAuthAttemptLimit(req, identifier = "") {
  authAttemptMap.delete(authAttemptKey(req, identifier));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req, body = {}) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return String(body.token || "").trim();
}

const sessionTouchIntervalMs = 60 * 1000;

function authenticate(req, body = {}) {
  const token = bearerToken(req, body);
  if (!token) return null;
  const session = db.getSession(token);
  if (!session) return null;
  const ts = nowIso();
  if (session.revoked_at) return null;
  if (session.expires_at && session.expires_at < ts) return null;
  const participant = db.getUser(session.user_id);
  if (!participant) return null;
  const lastSeenMs = Date.parse(session.last_seen_at || "");
  if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs >= sessionTouchIntervalMs) {
    db.touchSession(token, ts);
    db.upsertUser(participant.id, participant.nickname || "", participant.created_at, ts, {
      nicknameNorm: participant.nickname_norm || normalizeIdentity(participant.nickname || ""),
      email: participant.email || "",
      emailNorm: participant.email_norm || normalizeEmail(participant.email || ""),
      passwordHash: participant.password_hash || "",
      passwordUpdatedAt: participant.password_updated_at || "",
      profileUpdatedAt: participant.profile_updated_at || ""
    });
  }
  return { participant, token };
}

function findUserByIdentifier(identifier = "") {
  const cleaned = cleanLoginIdentifier(identifier);
  if (!cleaned) return null;
  const emailNorm = normalizeEmail(cleaned);
  if (isValidEmail(emailNorm)) {
    const byEmail = db.getUserByEmailNorm(emailNorm);
    if (byEmail) return byEmail;
  }
  return db.getUserByNicknameNorm(normalizeIdentity(cleaned));
}

function uniqueUsers(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row?.id || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

function usersForIdentity(nicknameNorm = "", emailNorm = "") {
  return {
    nicknameOwners: uniqueUsers(nicknameNorm ? db.getUsersByNicknameNorm(nicknameNorm) : []),
    emailOwners: uniqueUsers(emailNorm ? db.getUsersByEmailNorm(emailNorm) : [])
  };
}

function firstOtherUser(rows = [], existingId = "") {
  return rows.find((row) => row?.id && row.id !== existingId) || null;
}

function profileConflict(nicknameNorm = "", emailNorm = "", existingId = "") {
  const { nicknameOwners, emailOwners } = usersForIdentity(nicknameNorm, emailNorm);
  const nicknameOwner = firstOtherUser(nicknameOwners, existingId);
  const emailOwner = firstOtherUser(emailOwners, existingId);
  if (nicknameOwner) return { field: "nickname", message: "这个昵称已经被使用。" };
  if (emailOwner) return { field: "email", message: "这个邮箱已经被使用。" };
  return null;
}

function registrationOwnerConflict(nicknameOwners = [], emailOwners = []) {
  const owners = uniqueUsers([...nicknameOwners, ...emailOwners]);
  if (owners.length > 1) {
    const sharedNickname = nicknameOwners.length > 1;
    const sharedEmail = emailOwners.length > 1;
    if (sharedNickname && sharedEmail) return { field: "identity", message: "昵称和邮箱已经被其他账号使用，请换一组账号信息。" };
    if (sharedNickname) return { field: "nickname", message: "这个昵称已经被使用。" };
    if (sharedEmail) return { field: "email", message: "这个邮箱已经被使用。" };
    return { field: "identity", message: "昵称和邮箱分别属于不同账号，请换一个。" };
  }
  const owner = owners[0] || null;
  if (!owner?.password_hash) return { owner };
  const nicknameOwned = nicknameOwners.some((row) => row.id === owner.id);
  return {
    owner,
    field: nicknameOwned ? "nickname" : "email",
    message: nicknameOwned ? "这个昵称已经被使用。" : "这个邮箱已经被使用。"
  };
}

function sendIdentityConstraintError(res, error) {
  const message = String(error?.message || "");
  if (!/UNIQUE constraint failed/i.test(message)) return false;
  const field = message.includes("users.nickname_norm") ? "nickname"
    : message.includes("users.email_norm") ? "email"
      : "identity";
  sendJson(res, 409, {
    ok: false,
    field,
    message: field === "nickname"
      ? "这个昵称已经被使用。"
      : field === "email"
        ? "这个邮箱已经被使用。"
        : "账号信息已经被使用。"
  });
  return true;
}

function issueSession(participantId, timestamp) {
  const token = crypto.randomBytes(32).toString("hex");
  db.createSession(token, participantId, timestamp, futureIso(sessionTtlMs));
  return token;
}

function persistGradingResults(participant, results = []) {
  if (!participant || !Array.isArray(results)) return;
  results.forEach((gr) => {
    if (!gr?.questionId) return;
    db.updateQuizResultAiGrading(gr.questionId, participant.id, {
      unitId: gr.unitId || gr.unit_id || "",
      aiScore: gr.score,
      aiConfidence: gr.confidence,
      aiFeedback: gr.feedback,
      aiErrorType: gr.errorType
    });
    db.insertAgentDecision({
      id: crypto.randomUUID(),
      user_id: participant.id,
      agent_type: "grading",
      decision_type: "grade",
      input_summary: { questionId: gr.questionId },
      output_summary: { score: gr.score, confidence: gr.confidence, errorType: gr.errorType },
      confidence: gr.confidence,
      llm_provider: gr.provider || "",
      latency_ms: 0,
      created_at: nowIso()
    });
  });
}

function gradingRuntimeInfo() {
  const provider = String(
    process.env.GRADING_LLM_PROVIDER
    || llm.provider()
  ).toLowerCase();
  return {
    provider,
    model: String(
      process.env.GRADING_MODEL
      || process.env.OPENAI_COMPATIBLE_MODEL
      || process.env.INNOSPARK_MODEL
      || ""
    ).slice(0, 120),
    liveConfigured: Boolean(
      process.env.GRADING_API_KEY
      || process.env.OPENAI_COMPATIBLE_API_KEY
      || process.env.INNOSPARK_API_KEY
    )
  };
}

function getAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  try {
    const tokenFile = path.join(root, "data", "admin-token.txt");
    if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, "utf8").trim();
  } catch (e) {
    console.error("Failed to read admin-token.txt:", e.message);
  }
  return "";
}

function checkAdmin(req) {
  const configuredToken = getAdminToken();
  if (!configuredToken) return false;
  const requestedToken = bearerToken(req) || "";
  return requestedToken === configuredToken;
}

function safeStaticPath(urlPath) {
  let decoded = "/";
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (e) {
    console.error("Failed to decode URL path:", urlPath, e.message);
    return null;
  }
  const publicPath =
    decoded === "/" ? "index.html"
    : decoded === "/admin" ? "admin.html"
    : decoded === "/flow-test" ? "flow-test.html"
    : decoded.replace(/^\/+/, "");
  const normalized = publicPath.replaceAll("\\", "/");
  const extension = path.extname(normalized).toLowerCase();
  const isManifest = /^resources\/open-maic\/.+\/manifest\.json$/.test(normalized);
  const isPublicResource = normalized.startsWith("resources/open-maic/")
    && !/^resources\/open-maic\/(?:prompts|versions)(?:\/|$)/.test(normalized)
    && (
      normalized === "resources/open-maic/course-index.json"
      || publicResourceExtensions.has(extension)
    );
  const allowed = publicRootFiles.has(normalized)
    || publicFlowTestFiles.has(normalized)
    || normalized.startsWith("app/") && (extension === ".js" || extension === ".css")
    || normalized.startsWith("admin/") && (extension === ".js" || extension === ".css")
    || normalized.startsWith("assets/") && publicAssetExtensions.has(extension)
    || publicLibFiles.has(normalized)
    || normalized.startsWith("lib/fonts/") && publicFontExtensions.has(extension)
    || isManifest
    || isPublicResource;
  if (!allowed || normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const filePath = path.resolve(root, publicPath);
  return filePath === root || filePath.startsWith(root + path.sep) ? filePath : null;
}

function snapshotVersion(body = {}) {
  const generation = Number(body.generation);
  const baseRevision = Number(body.baseRevision);
  return {
    generation,
    baseRevision,
    validGeneration: Number.isInteger(generation) && generation > 0,
    validBaseRevision: Number.isInteger(baseRevision) && baseRevision >= 0
  };
}

function sendSnapshotConflict(res, result) {
  const generationConflict = result.conflict === "generation";
  sendJson(res, 409, {
    ok: false,
    code: generationConflict ? "snapshot_generation_conflict" : "snapshot_revision_conflict",
    message: generationConflict
      ? "学习记录已在其他页面重置或更新，请刷新后继续。"
      : "学习记录已在其他页面更新，已拒绝当前页面的旧版本覆盖。",
    generation: result.generation,
    revision: result.revision
  });
}

function assistantProviderInfo() {
  const id = llm.provider();
  const live = ["openai-compatible", "innospark", "openai"].includes(id);
  return {
    id,
    live,
    label: live ? "AI 助教" : "本地引导"
  };
}

function beijingDateKey(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function assistantQuotaInfo(userId, date = new Date()) {
  const usageDate = beijingDateKey(date);
  const used = db.getLearningAssistantDailyUsage(userId, usageDate).requestCount;
  return {
    usageDate,
    limit: assistantDailyQuotaLimit,
    used,
    remaining: Math.max(0, assistantDailyQuotaLimit - used)
  };
}

function sendAssistantQuizLocked(res, userId) {
  sendJson(res, 403, {
    ok: false,
    code: "assistant_quiz_locked_until_submit",
    message: "提交本次测验后即可使用知点复盘。",
    quizSubmitted: false,
    quota: assistantQuotaInfo(userId)
  });
}

function assistantRequestConsumesQuota(providerInfo = assistantProviderInfo()) {
  return Boolean(
    providerInfo.live
    || process.env.LEARNING_ASSISTANT_COUNT_MOCK_USAGE === "true"
  );
}

function consumeAssistantQuota(userId, date = new Date()) {
  const usageDate = beijingDateKey(date);
  return {
    usageDate,
    ...db.consumeLearningAssistantDailyQuota(
      userId,
      usageDate,
      assistantDailyQuotaLimit,
      date.toISOString()
    )
  };
}

function releaseAssistantQuota(userId, date = new Date()) {
  const usageDate = beijingDateKey(date);
  return {
    usageDate,
    ...db.releaseLearningAssistantDailyQuota(
      userId,
      usageDate,
      assistantDailyQuotaLimit,
      new Date().toISOString()
    )
  };
}

function consumeAssistantInterventionBudget(userId, date = new Date()) {
  const usageDate = beijingDateKey(date);
  return {
    usageDate,
    ...db.consumeLearningAssistantInterventionBudget(
      userId,
      usageDate,
      assistantDailyInterventionLimit,
      date.toISOString()
    )
  };
}

function publicAssistantConversation(row = {}) {
  return {
    id: row.id || "",
    threadKey: row.thread_key || "",
    chapterId: row.chapter_id || "",
    unitId: row.unit_id || "",
    knowledgePointId: row.knowledge_point_id || "",
    title: String(row.title || "新对话"),
    archivedAt: row.archived_at || "",
    messageCount: Number(row.message_count || 0),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || row.created_at || ""
  };
}

function buildAssistantConversation(userId, resolved, timestamp, title = "新对话") {
  return {
    id: crypto.randomUUID(),
    user_id: userId,
    thread_key: resolved.threadKey,
    chapter_id: resolved.unit.chapterId,
    unit_id: resolved.unit.id,
    knowledge_point_id: resolved.unit.knowledgePointId || "",
    title: String(title || "新对话").replace(/\s+/g, " ").trim().slice(0, 42) || "新对话",
    created_at: timestamp,
    updated_at: timestamp
  };
}

function assistantConversationForRequest(userId, resolved, conversationId = "", timestamp = nowIso()) {
  const requestedId = String(conversationId || "").trim();
  if (requestedId) {
    const existing = db.getLearningAssistantConversation(userId, requestedId);
    if (!existing || existing.thread_key !== resolved.threadKey) {
      const error = new Error("当前对话不存在，或不属于这个学习位置。");
      error.code = "assistant_conversation_not_found";
      error.status = 404;
      throw error;
    }
    return {
      conversation: publicAssistantConversation(existing),
      record: existing,
      createConversation: false
    };
  }
  const record = buildAssistantConversation(userId, resolved, timestamp);
  return {
    conversation: publicAssistantConversation({ ...record, message_count: 0 }),
    record,
    createConversation: true
  };
}

function parseAssistantContextJson(value = "") {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicAssistantMessage(row = {}) {
  const storedContext = parseAssistantContextJson(row.context_json || row.context);
  const {
    assistantGuidance,
    assistantIntent,
    proactivePrompt,
    proactivePromptVisible,
    ...contextRef
  } = storedContext;
  return {
    id: row.id || "",
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content || ""),
    contextRef,
    guidance: assistantGuidance || null,
    assistantIntent: assistantIntent || "",
    proactivePrompt: row.role === "user" ? boundedLearningText(proactivePrompt, 500, true) : "",
    proactivePromptVisible: proactivePromptVisible !== false,
    provider: row.provider || "",
    quizSubmitted: Number(row.quiz_submitted || 0) === 1,
    createdAt: row.created_at || ""
  };
}

function boundedLearningText(value = "", limit = 1200, multiline = false) {
  const source = String(value ?? "").replace(/\u0000/g, "");
  return (multiline ? source.replace(/\r\n?/g, "\n") : source.replace(/\s+/g, " "))
    .trim()
    .slice(0, limit);
}

function pruneAssistantInterventions(now = Date.now()) {
  for (const [id, record] of assistantInterventionRegistry) {
    if (Number(record?.expiresAt || 0) <= now) assistantInterventionRegistry.delete(id);
  }
  while (assistantInterventionRegistry.size > assistantInterventionRegistryLimit) {
    const oldest = assistantInterventionRegistry.keys().next().value;
    if (!oldest) break;
    assistantInterventionRegistry.delete(oldest);
  }
}

function issueAssistantIntervention(userId, resolved, decision = {}, now = Date.now()) {
  const assistantPrompt = boundedLearningText(decision.assistantPrompt, 500, true);
  if (!assistantPrompt || decision.interactionMode !== "student_reply") return "";
  pruneAssistantInterventions(now);
  const id = crypto.randomUUID();
  assistantInterventionRegistry.set(id, {
    id,
    userId,
    unitId: resolved.unit.id,
    threadKey: resolved.threadKey,
    action: boundedLearningText(decision.action, 40),
    assistantPrompt,
    reviewIndex: Math.max(0, Math.trunc(Number(decision.reviewIndex || 0))),
    reviewTotal: Math.max(0, Math.trunc(Number(decision.reviewTotal || 0))),
    questionId: boundedLearningText(decision.questionId, 180),
    promptVisible: decision.promptVisible !== false,
    sourceMessageId: boundedLearningText(decision.sourceMessageId, 180),
    reviewAction: ["continue", "next"].includes(String(decision.reviewAction || ""))
      ? String(decision.reviewAction)
      : "",
    createdAt: now,
    expiresAt: now + assistantInterventionTtlMs
  });
  return id;
}

function getAssistantIntervention(
  userId,
  unitId,
  interventionId = "",
  { consume = false, now = Date.now() } = {}
) {
  const id = boundedLearningText(interventionId, 180);
  if (!id) return null;
  pruneAssistantInterventions(now);
  const record = assistantInterventionRegistry.get(id);
  if (
    !record
    || record.userId !== userId
    || record.unitId !== unitId
    || record.expiresAt <= now
  ) return null;
  if (consume) assistantInterventionRegistry.delete(id);
  return record;
}

function normalizeAssistantQuizReviewProgress(progress = {}) {
  const source = progress && typeof progress === "object" && !Array.isArray(progress)
    ? progress
    : {};
  const status = [
    "awaiting_choice",
    "awaiting_reply",
    "answered",
    "stopped",
    "completed"
  ].includes(String(source.status || ""))
    ? String(source.status)
    : "";
  const reviewTotal = Math.max(0, Math.min(30, Math.trunc(Number(source.reviewTotal || 0))));
  const reviewIndex = Math.max(
    0,
    Math.min(Math.max(0, reviewTotal - 1), Math.trunc(Number(source.reviewIndex || 0)))
  );
  const targetReviewIndex = Math.max(
    0,
    Math.min(Math.max(0, reviewTotal - 1), Math.trunc(Number(source.targetReviewIndex ?? reviewIndex)))
  );
  return {
    status,
    done: status === "completed" || source.done === true,
    reviewIndex,
    reviewTotal,
    questionId: boundedLearningText(source.questionId, 180),
    action: ["continue", "next"].includes(String(source.action || "")) ? String(source.action) : "",
    targetReviewIndex,
    targetQuestionId: boundedLearningText(source.targetQuestionId, 180),
    completionMessage: boundedLearningText(source.completionMessage, 220, true)
  };
}

function assistantQuizReviewProgress(row = {}) {
  const storedContext = parseAssistantContextJson(row.context_json || row.context);
  return normalizeAssistantQuizReviewProgress(
    storedContext?.assistantGuidance?.quizReviewProgress
  );
}

function updateAssistantQuizReviewProgress(row = {}, progress = {}) {
  if (!row?.user_id || !row?.id) return null;
  const storedContext = parseAssistantContextJson(row.context_json || row.context);
  const assistantGuidance = storedContext.assistantGuidance
    && typeof storedContext.assistantGuidance === "object"
    && !Array.isArray(storedContext.assistantGuidance)
    ? storedContext.assistantGuidance
    : {};
  return db.updateLearningAssistantMessageContext(row.user_id, row.id, {
    ...storedContext,
    assistantGuidance: {
      ...assistantGuidance,
      quizReviewProgress: normalizeAssistantQuizReviewProgress(progress)
    }
  });
}

function quizReviewIndexFromProgress(resolved, progress = {}, { target = false } = {}) {
  const incorrectItems = Array.isArray(resolved?.quizAttempt?.incorrectItems)
    ? resolved.quizAttempt.incorrectItems
    : [];
  if (!incorrectItems.length) return -1;
  const questionId = boundedLearningText(
    target ? progress.targetQuestionId : progress.questionId,
    180
  );
  if (questionId) {
    const matchedIndex = incorrectItems.findIndex((item) => item.questionId === questionId);
    if (matchedIndex >= 0) return matchedIndex;
  }
  const numericIndex = Math.trunc(Number(
    target ? progress.targetReviewIndex : progress.reviewIndex
  ));
  return numericIndex >= 0 && numericIndex < incorrectItems.length ? numericIndex : -1;
}

function quizReviewDecisionForIndex(resolved, reviewIndex) {
  const continuation = learningAssistant.quizReviewContinuation({
    resolved,
    completedIndex: Math.trunc(Number(reviewIndex || 0)) - 1
  });
  return continuation.done ? null : continuation.decision;
}

function publicQuizReviewPrompt({
  resolved,
  sceneType = "",
  decision,
  interventionId,
  sourceMessageId = "",
  reviewAction = "",
  visible = true
} = {}) {
  if (!decision?.assistantPrompt || !interventionId) return null;
  return {
    id: `quiz-review-${interventionId}`,
    content: decision.assistantPrompt,
    action: decision.action,
    unitId: resolved.unit.id,
    sceneType: boundedLearningText(sceneType, 80),
    interventionId,
    sourceMessageId: boundedLearningText(sourceMessageId, 180),
    reviewAction: ["continue", "next"].includes(reviewAction) ? reviewAction : "",
    visible: visible !== false,
    contextSummary: decision.contextSummary || "",
    replyOptions: decision.replyOptions || []
  };
}

function assistantRecentConversation(userId, resolved, limit = 4) {
  const latest = db.listLearningAssistantConversations(userId, resolved.threadKey, 1)[0];
  if (!latest) return [];
  return db.getLearningAssistantMessages(
    userId,
    resolved.threadKey,
    Math.max(1, Math.min(Number(limit || 4), 8)),
    latest.id
  ).map((row) => ({
    role: row.role,
    content: row.content
  }));
}

function attachAssistantQuizAttempt(resolved, quizResults = []) {
  if (!resolved?.isQuiz) return null;
  resolved.quizAttempt = learningAssistant.buildQuizAttemptSummary({
    resolved,
    results: quizResults
  });
  return resolved.quizAttempt;
}

function sendAssistantSignalMismatch(res, message) {
  sendJson(res, 400, {
    ok: false,
    code: "assistant_intervention_signal_mismatch",
    message
  });
}

function assistantMinimumDwellSeconds(resolved, sceneType = "") {
  const normalizedSceneType = boundedLearningText(
    sceneType || resolved?.scene?.type || resolved?.contextRef?.sceneType,
    80
  );
  const readingScene = resolved?.unit?.type === "slide" || normalizedSceneType === "slide";
  return readingScene ? 150 : 90;
}

function learningNoteError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sanitizeLearningNoteInput(userId, input = {}, noteIdOverride = "") {
  const noteId = boundedLearningText(noteIdOverride || input.id, 180);
  if (!/^[A-Za-z0-9:_-]{1,180}$/.test(noteId)) {
    throw learningNoteError("learning_note_id_invalid", "笔记标识无效。");
  }
  const unitId = boundedLearningText(input.unitId || input.contextRef?.unitId, 180);
  const unit = assistantContextIndex.units.get(unitId);
  if (!unit) throw learningNoteError("learning_note_unit_invalid", "这条笔记对应的学习位置不存在。");
  const sanitizedContext = learningAssistant.sanitizeClientContext(input.contextRef);
  const locatorSource = input.locator && typeof input.locator === "object" ? input.locator : {};
  const createdAt = Number.isFinite(Date.parse(input.createdAt || ""))
    ? new Date(input.createdAt).toISOString()
    : nowIso();
  const updatedAt = Number.isFinite(Date.parse(input.updatedAt || ""))
    ? new Date(input.updatedAt).toISOString()
    : nowIso();
  return {
    id: noteId,
    user_id: userId,
    thread_key: unit.knowledgePointId ? `knowledge:${unit.knowledgePointId}` : `unit:${unit.id}`,
    chapter_id: unit.chapterId || "",
    unit_id: unit.id,
    excerpt: boundedLearningText(input.excerpt || sanitizedContext.excerpt, 900, true),
    note: boundedLearningText(input.note, 1200, true),
    color: ["amber", "mint", "blue", "pink"].includes(input.color) ? input.color : "amber",
    context: {
      ...sanitizedContext,
      chapterId: unit.chapterId || "",
      unitId: unit.id,
      unitLabel: unit.unitLabel || "",
      knowledgePointId: unit.knowledgePointId || "",
      knowledgePointLabel: unit.knowledgePointLabel || "",
      resourceFingerprint: boundedLearningText(input.contextRef?.resourceFingerprint, 120)
    },
    locator: {
      source: locatorSource.source === "iframe" ? "iframe" : "document",
      semanticId: boundedLearningText(locatorSource.semanticId, 180),
      exact: boundedLearningText(locatorSource.exact, 900, true),
      prefix: boundedLearningText(locatorSource.prefix, 80, true),
      suffix: boundedLearningText(locatorSource.suffix, 80, true),
      startOffset: Number.isInteger(locatorSource.startOffset) && locatorSource.startOffset >= 0
        ? locatorSource.startOffset
        : -1,
      endOffset: Number.isInteger(locatorSource.endOffset) && locatorSource.endOffset >= 0
        ? locatorSource.endOffset
        : -1
    },
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function publicLearningNote(row = {}) {
  return {
    id: row.client_id || row.id || "",
    ownerKey: row.user_id || "",
    threadKey: row.thread_key || "",
    chapterId: row.chapter_id || "",
    unitId: row.unit_id || "",
    excerpt: row.excerpt || "",
    note: row.note || "",
    color: row.color || "amber",
    contextRef: parseAssistantContextJson(row.context_json),
    locator: parseAssistantContextJson(row.locator_json),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || row.created_at || ""
  };
}

function writeNdjson(res, payload) {
  if (!res.writableEnded && !res.destroyed) {
    res.write(`${JSON.stringify(payload)}\n`);
  }
}

async function generateAssistantTurn({
  resolved,
  question,
  history,
  quizSubmitted,
  assistantIntent = "",
  proactivePrompt = ""
}) {
  const prompt = learningAssistant.buildAssistantPrompt({
    resolved,
    question,
    history,
    quizSubmitted,
    assistantIntent,
    proactivePrompt
  });
  const providerInfo = assistantProviderInfo();
  if (!providerInfo.live) {
    return {
      provider: providerInfo.id,
      text: learningAssistant.mockAssistantAnswer({
        resolved,
        question,
        quizSubmitted,
        assistantIntent,
        proactivePrompt
      }),
      policy: prompt.policy,
      guidance: prompt.guidance,
      fallback: false
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const result = await llm.completeChat({
      system: prompt.system,
      user: prompt.user,
      maxTokens: 700,
      model: String(
        process.env.LEARNING_ASSISTANT_MODEL
        || process.env.OPENAI_COMPATIBLE_MODEL
        || ""
      ).trim() || undefined,
      signal: controller.signal
    });
    const text = learningAssistant.enforceQuizSafety(result.text, {
      isQuiz: resolved.isQuiz,
      quizSubmitted,
      resolved
    });
    return {
      provider: result.provider || providerInfo.id,
      text: text || learningAssistant.mockAssistantAnswer({
        resolved,
        question,
        quizSubmitted,
        assistantIntent,
        proactivePrompt
      }),
      policy: prompt.policy,
      guidance: prompt.guidance,
      fallback: !text
    };
  } catch (error) {
    console.warn("Learning assistant provider fallback:", error.message);
    return {
      provider: "fallback",
      text: learningAssistant.mockAssistantAnswer({
        resolved,
        question,
        quizSubmitted,
        assistantIntent,
        proactivePrompt
      }),
      policy: prompt.policy,
      guidance: prompt.guidance,
      fallback: true
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateInterventionDecision({ resolved, signal, history = [] }) {
  const providerInfo = assistantProviderInfo();
  const fallback = () => learningAssistant.deterministicInterventionDecision({ resolved, signal });
  if (!providerInfo.live) {
    return { provider: providerInfo.id, decision: fallback(), fallback: false };
  }
  const prompt = learningAssistant.buildInterventionPrompt({ resolved, signal, history });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const result = await llm.completeChat({
      system: prompt.system,
      user: prompt.user,
      jsonHint: true,
      maxTokens: 340,
      model: String(
        process.env.LEARNING_ASSISTANT_MODEL
        || process.env.OPENAI_COMPATIBLE_MODEL
        || ""
      ).trim() || undefined,
      signal: controller.signal
    });
    return {
      provider: result.provider || providerInfo.id,
      decision: learningAssistant.parseInterventionDecision(result.text, { resolved, signal }),
      fallback: false
    };
  } catch (error) {
    console.warn("Learning assistant intervention fallback:", error.message);
    return { provider: "fallback", decision: fallback(), fallback: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleApi(req, res, url) {
  if (!checkRateLimit(req)) {
    sendJson(res, 429, { ok: false, message: "请求过于频繁，请稍后再试。" });
    return;
  }
  try {
    // ---- Auth ----
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        time: nowIso(),
        appVersion: researchConfig.appVersion,
        basePath
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/research/config") {
      const courseVersion = String(learningRoute?.versionId || "").slice(0, 120);
      sendJson(res, 200, { ok: true, data: { ...researchConfig, courseVersion } });
      return;
    }

    if (await systemAnnouncementApi.handle({
      req,
      res,
      url,
      db,
      authenticate,
      checkAdmin,
      readJsonBody,
      sendJson
    })) return;

    if (req.method === "GET" && learningRouteApiPaths.has(url.pathname)) {
      if (!publicLearningRouteJson) {
        sendJson(res, 404, { ok: false, message: "未找到多场景自适应学习路线。" });
        return;
      }
      send(res, 200, publicLearningRouteJson, "application/json; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname === flowTestRouteApiPath) {
      if (!checkAdmin(req)) {
        sendJson(res, 403, { ok: false, message: "需要管理员密码。" });
        return;
      }
      if (!flowTestRouteJson) {
        sendJson(res, 404, { ok: false, message: "未找到课件检视路线。" });
        return;
      }
      send(res, 200, flowTestRouteJson, "application/json; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/course/openmaic-audio-map") {
      const resourceRoot = String(url.searchParams.get("root") || "").replace(/^resources[\\/]/, "").replace(/\\/g, "/");
      if (!/^open-maic\/[^/]+$/.test(resourceRoot)) {
        sendJson(res, 400, { ok: false, message: "资源路径不正确。" });
        return;
      }
      const manifestPath = path.join(root, "resources", resourceRoot, "manifest.json");
      const resolved = path.resolve(manifestPath);
      const openMaicRoot = path.resolve(root, "resources", "open-maic");
      if (!resolved.startsWith(openMaicRoot + path.sep) || !fs.existsSync(resolved)) {
        sendJson(res, 404, { ok: false, message: "未找到音频映射。" });
        return;
      }
      const manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
      const scenes = (manifest.scenes || []).map((scene) => ({
        order: scene.order,
        title: scene.title || "",
        actions: (scene.actions || [])
          .filter((action) => action.audioRef)
          .map((action) => ({
            type: action.type || "speech",
            text: action.text || action.prompt || "",
            prompt: action.prompt || "",
            audioRef: action.audioRef
          }))
      })).filter((scene) => scene.actions.length);
      sendJson(res, 200, { ok: true, resourceRoot, scenes });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readJsonBody(req);
      const nickname = cleanNickname(body.nickname);
      const email = cleanEmail(body.email);
      const password = String(body.password || "");
      if (!nickname && !email) {
        sendJson(res, 400, { ok: false, message: "请至少填写昵称或邮箱。", field: "identity" });
        return;
      }
      if (!isValidNickname(nickname)) {
        sendJson(res, 400, { ok: false, message: "昵称需要 2-24 个字符。", field: "nickname" });
        return;
      }
      if (email && !isValidEmail(email)) {
        sendJson(res, 400, { ok: false, message: "邮箱格式不正确。", field: "email" });
        return;
      }
      if (!isUsablePassword(password)) {
        sendJson(res, 400, { ok: false, message: "密码需要 8-72 个字符。", field: "password" });
        return;
      }
      const timestamp = nowIso();
      const nicknameNorm = normalizeIdentity(nickname);
      const emailNorm = normalizeEmail(email);
      const { nicknameOwners, emailOwners } = usersForIdentity(nicknameNorm, emailNorm);
      const ownerConflict = registrationOwnerConflict(nicknameOwners, emailOwners);
      if (ownerConflict?.message) {
        sendJson(res, 409, { ok: false, message: ownerConflict.message, field: ownerConflict.field || "identity" });
        return;
      }
      const legacyAccount = ownerConflict?.owner || null;
      const participantId = legacyAccount?.id || participantIdForIdentity(nicknameNorm, emailNorm);
      try {
        db.upsertUser(participantId, nickname, legacyAccount?.created_at || timestamp, timestamp, {
          nickname,
          nicknameNorm,
          email,
          emailNorm,
          passwordHash: hashPassword(password),
          passwordUpdatedAt: timestamp,
          profileUpdatedAt: legacyAccount?.profile_updated_at || ""
        });
      } catch (error) {
        if (sendIdentityConstraintError(res, error)) return;
        throw error;
      }
      const token = issueSession(participantId, timestamp);
      db.insertEvent({
        id: crypto.randomUUID(),
        user_id: participantId,
        type: legacyAccount ? "register_upgrade" : "register",
        payload: { nickname, hasEmail: Boolean(email) },
        created_at: timestamp
      });
      const user = db.getUser(participantId);
      db.saveNow();
      sendJson(res, 200, { ok: true, participant: safePublicParticipant(user), token });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(req);
      const identifier = cleanLoginIdentifier(body.identifier || body.nickname || body.email);
      const password = String(body.password || "");
      if (!identifier || !password) {
        sendJson(res, 400, { ok: false, message: "请填写昵称或邮箱，并输入密码。", field: !identifier ? "identifier" : "password" });
        return;
      }
      const authLimit = checkAuthAttemptLimit(req, identifier);
      if (!authLimit.ok) {
        sendJson(res, 429, {
          ok: false,
          message: "尝试次数过多，请稍后再试。",
          retryAfterSeconds: authLimit.retryAfterSeconds
        });
        return;
      }
      const timestamp = nowIso();
      const user = findUserByIdentifier(identifier);
      if (!user) {
        recordFailedAuthAttempt(req, identifier);
        sendJson(res, 404, {
          ok: false,
          code: "account_not_found",
          field: "identifier",
          message: "没有找到这个账号，请检查昵称或邮箱，或先注册账号。"
        });
        return;
      }
      if (!user.password_hash) {
        recordFailedAuthAttempt(req, identifier);
        sendJson(res, 409, {
          ok: false,
          code: "password_not_set",
          field: "identifier",
          message: "这个历史账号尚未设置密码。请切换到“注册”，使用同一昵称设置密码，原有学习记录会保留。"
        });
        return;
      }
      if (!verifyPassword(password, user.password_hash)) {
        recordFailedAuthAttempt(req, identifier);
        sendJson(res, 401, {
          ok: false,
          code: "password_incorrect",
          field: "password",
          message: "密码不正确，请重新输入。"
        });
        return;
      }
      clearAuthAttemptLimit(req, identifier);
      db.upsertUser(user.id, user.nickname || "", user.created_at || timestamp, timestamp, {
        nickname: user.nickname || "",
        nicknameNorm: user.nickname_norm || normalizeIdentity(user.nickname || ""),
        email: user.email || "",
        emailNorm: user.email_norm || normalizeEmail(user.email || ""),
        passwordHash: user.password_hash || "",
        passwordUpdatedAt: user.password_updated_at || "",
        profileUpdatedAt: user.profile_updated_at || ""
      });
      const token = issueSession(user.id, timestamp);
      db.insertEvent({
        id: crypto.randomUUID(),
        user_id: user.id,
        type: "login",
        payload: { via: isValidEmail(normalizeEmail(identifier)) ? "email" : "nickname" },
        created_at: timestamp
      });
      const updated = db.getUser(user.id);
      sendJson(res, 200, { ok: true, participant: safePublicParticipant(updated), token });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/profile") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const nickname = cleanNickname(body.nickname);
      const email = cleanEmail(body.email);
      const currentNickname = auth.participant.nickname || "";
      const currentEmail = auth.participant.email || "";
      const noChange = nickname === currentNickname && email === currentEmail;
      if (noChange) {
        sendJson(res, 200, { ok: true, participant: safePublicParticipant(db.getUser(auth.participant.id)) });
        return;
      }
      if (auth.participant.profile_updated_at) {
        sendJson(res, 403, {
          ok: false,
          field: "profile",
          message: "账号信息只能修改一次，已不能再次修改。"
        });
        return;
      }
      if (!nickname && !email) {
        sendJson(res, 400, { ok: false, message: "昵称和邮箱至少保留一个。", field: "identity" });
        return;
      }
      if (!isValidNickname(nickname)) {
        sendJson(res, 400, { ok: false, message: "昵称需要 2-24 个字符。", field: "nickname" });
        return;
      }
      if (email && !isValidEmail(email)) {
        sendJson(res, 400, { ok: false, message: "邮箱格式不正确。", field: "email" });
        return;
      }
      const nicknameNorm = normalizeIdentity(nickname);
      const emailNorm = normalizeEmail(email);
      const conflict = profileConflict(nicknameNorm, emailNorm, auth.participant.id);
      if (conflict) {
        sendJson(res, 409, { ok: false, message: conflict.message, field: conflict.field });
        return;
      }
      const timestamp = nowIso();
      let updated = null;
      try {
        updated = db.updateUserProfile(auth.participant.id, {
          nickname,
          nicknameNorm,
          email,
          emailNorm,
          profileUpdatedAt: timestamp,
          lastSeenAt: timestamp
        });
      } catch (error) {
        if (sendIdentityConstraintError(res, error)) return;
        throw error;
      }
      if (!updated) {
        sendJson(res, 404, { ok: false, message: "账号不存在，请重新登录。" });
        return;
      }
      db.insertEvent({
        id: crypto.randomUUID(),
        user_id: auth.participant.id,
        type: "profile_update",
        payload: { hasNickname: Boolean(nickname), hasEmail: Boolean(email) },
        created_at: timestamp
      });
      sendJson(res, 200, { ok: true, participant: safePublicParticipant(updated) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (auth) db.revokeSession(auth.token, nowIso());
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/me") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      sendJson(res, 200, { ok: true, participant: safePublicParticipant(auth.participant) });
      return;
    }

    // ---- Learning Feedback ----
    if (req.method === "POST" && url.pathname === "/api/learning/feedback") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) {
        sendJson(res, 401, { ok: false, message: "请先登录。" });
        return;
      }
      const normalized = feedback.normalizeFeedbackInput(body);
      if (!normalized.ok) {
        sendJson(res, 400, normalized);
        return;
      }
      const validatedTarget = feedback.validateCoursewareFeedbackTarget(
        normalized.value,
        coursewareFeedbackTargetLookup
      );
      if (!validatedTarget.ok) {
        sendJson(res, 400, validatedTarget);
        return;
      }
      const feedbackValue = validatedTarget.value;
      const feedbackId = crypto.randomUUID();
      const timestamp = nowIso();
      db.insertFeedback({
        id: feedbackId,
        user_id: auth.participant.id,
        ...feedbackValue,
        created_at: timestamp
      });
      db.insertEvent({
        id: crypto.randomUUID(),
        user_id: auth.participant.id,
        type: "feedback_submit",
        payload: {
          feedbackId,
          feedbackType: feedbackValue.feedback_type,
          targetScope: feedbackValue.target_scope,
          contentLength: feedbackValue.content.length
        },
        created_at: timestamp
      });
      sendJson(res, 200, { ok: true, feedbackId, createdAt: timestamp });
      return;
    }

    // ---- Learning Events ----
    if (req.method === "POST" && url.pathname === "/api/learning/event") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const eventId = crypto.randomUUID();
      const timestamp = nowIso();
      const eventType = String(body.type || "event").slice(0, 80);

      db.insertEvent({
        id: eventId,
        user_id: auth.participant.id,
        type: eventType,
        payload: body.payload || {},
        created_at: timestamp
      });
      db.saveNow();

      sendJson(res, 200, { ok: true, eventId });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/events") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
      const eventIds = [];
      const receivedAt = new Date();
      let previousEventTime = 0;

      events.forEach((item) => {
        const eventId = clientEventId(auth.participant.id, item);
        const requestedEventTime = trustedClientEventTime(item, receivedAt);
        const eventTime = Math.max(requestedEventTime, previousEventTime + 1);
        previousEventTime = eventTime;
        eventIds.push(eventId);
        db.insertEvent({
          id: eventId,
          user_id: auth.participant.id,
          type: String(item.type || "event").slice(0, 80),
          payload: item.payload || {},
          created_at: beijingIso(new Date(eventTime))
        });
      });
      db.saveNow();

      sendJson(res, 200, { ok: true, eventIds });
      return;
    }

    // ---- Learning Snapshot ----
    if (req.method === "GET" && url.pathname === "/api/learning/snapshot") {
      const auth = authenticate(req);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const state = db.getLearningSnapshotState(auth.participant.id, nowIso());
      const snap = state.snapshot;
      if (!snap) {
        sendJson(res, 200, {
          ok: true,
          snapshot: null,
          generation: state.generation,
          revision: state.revision
        });
        return;
      }
      let data = {};
      try { data = JSON.parse(snap.data); } catch { /* use empty */ }
      data = db.normalizeLearningSnapshot(data);
      sendJson(res, 200, {
        ok: true,
        snapshot: {
          ...data,
          clientCapturedAt: data.capturedAt || "",
          capturedAt: snap.created_at
        },
        generation: state.generation,
        revision: state.revision
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/snapshot") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const version = snapshotVersion(body);
      if (!version.validGeneration || !version.validBaseRevision) {
        const state = db.getLearningSnapshotState(auth.participant.id, nowIso());
        sendJson(res, 409, {
          ok: false,
          code: "snapshot_version_required",
          message: "当前页面版本过旧，请刷新页面后继续学习。",
          generation: state.generation,
          revision: state.revision
        });
        return;
      }
      const timestamp = nowIso();
      const snapshotData = body.snapshot || {};
      const snapshotId = crypto.randomUUID();

      const result = db.saveLearningSnapshot({
        id: snapshotId,
        user_id: auth.participant.id,
        reason: String(body.reason || "manual").slice(0, 80),
        data: snapshotData,
        generation: version.generation,
        baseRevision: version.baseRevision,
        created_at: timestamp
      });
      if (!result.ok) {
        sendSnapshotConflict(res, result);
        return;
      }

      db.upsertUser(auth.participant.id, auth.participant.nickname, auth.participant.created_at, timestamp);
      sendJson(res, 200, {
        ok: true,
        snapshotId,
        generation: result.generation,
        revision: result.revision
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/reset") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const version = snapshotVersion(body);
      if (!version.validGeneration || !version.validBaseRevision) {
        const state = db.getLearningSnapshotState(auth.participant.id, nowIso());
        sendJson(res, 409, {
          ok: false,
          code: "snapshot_version_required",
          message: "当前页面版本过旧，请刷新页面后再重置学习记录。",
          generation: state.generation,
          revision: state.revision
        });
        return;
      }
      const timestamp = nowIso();
      const snapshotData = body.snapshot || {};
      const snapshotId = crypto.randomUUID();

      const result = db.resetLearningSnapshot({
        id: snapshotId,
        user_id: auth.participant.id,
        data: snapshotData,
        generation: version.generation,
        baseRevision: version.baseRevision,
        created_at: timestamp
      });
      if (!result.ok) {
        sendSnapshotConflict(res, result);
        return;
      }
      db.upsertUser(auth.participant.id, auth.participant.nickname, auth.participant.created_at, timestamp);

      sendJson(res, 200, {
        ok: true,
        snapshotId,
        cleared: true,
        generation: result.generation,
        revision: result.revision
      });
      return;
    }

    // ---- 知点：上下文学习侧栏 ----
    if (req.method === "GET" && url.pathname === "/api/learning/assistant/status") {
      const auth = authenticate(req);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      sendJson(res, 200, {
        ok: true,
        provider: assistantProviderInfo(),
        courseVersion: assistantContextIndex.routeVersion || "",
        conversationTurnLimit: assistantConversationTurnLimit,
        quota: assistantQuotaInfo(auth.participant.id)
      });
      return;
    }

    if (
      ["GET", "POST"].includes(req.method)
      && url.pathname === "/api/learning/assistant/conversations"
    ) {
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const unitId = String(
        req.method === "GET" ? url.searchParams.get("unitId") || "" : body.unitId || ""
      ).trim();
      const chapterId = String(
        req.method === "GET" ? url.searchParams.get("chapterId") || "" : body.chapterId || ""
      ).trim();
      const sceneType = String(
        req.method === "GET" ? url.searchParams.get("sceneType") || "" : body.sceneType || ""
      ).trim();
      const quizSubmitted = Boolean(
        unitId && db.getQuizResultsByUserUnit(auth.participant.id, unitId).length
      );
      let resolved;
      try {
        resolved = learningAssistant.resolveAssistantContext({
          index: assistantContextIndex,
          chapterId,
          unitId,
          sceneType,
          contextRef: {
            kind: "unit",
            scope: unitId.endsWith("-pre") || unitId.endsWith("-formative") || unitId.endsWith("-post")
              ? "quiz"
              : "lesson"
          },
          quizSubmitted
        });
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "assistant_context_error",
          message: error.message
        });
        return;
      }
      if (resolved.isQuiz && !quizSubmitted) {
        sendAssistantQuizLocked(res, auth.participant.id);
        return;
      }
      if (req.method === "POST") {
        sendJson(res, 200, {
          ok: true,
          threadKey: resolved.threadKey,
          draft: true,
          conversation: null,
          quota: assistantQuotaInfo(auth.participant.id)
        });
        return;
      }
      const conversations = db.listLearningAssistantConversations(
        auth.participant.id,
        resolved.threadKey,
        80,
        {
          query: url.searchParams.get("q") || "",
          archived: url.searchParams.get("archived") === "1"
        }
      ).map(publicAssistantConversation);
      sendJson(res, 200, {
        ok: true,
        threadKey: resolved.threadKey,
        provider: assistantProviderInfo(),
        quota: assistantQuotaInfo(auth.participant.id),
        conversations
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/assistant/intervention") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const unitId = boundedLearningText(body.unitId, 180);
      const chapterId = boundedLearningText(body.chapterId, 180);
      const sceneType = boundedLearningText(body.sceneType, 80);
      const signal = body.signal && typeof body.signal === "object" && !Array.isArray(body.signal)
        ? body.signal
        : {};
      if (!["repeated_parameter", "quiz_review", "quiet_dwell"].includes(String(signal.kind || ""))) {
        sendJson(res, 400, {
          ok: false,
          code: "assistant_intervention_signal_invalid",
          message: "这次学习信号不足以进行判断。"
        });
        return;
      }
      const quizResults = unitId
        ? db.getQuizResultsByUserUnit(auth.participant.id, unitId)
        : [];
      const quizSubmitted = Boolean(quizResults.length);
      let resolved;
      try {
        resolved = learningAssistant.resolveAssistantContext({
          index: assistantContextIndex,
          chapterId,
          unitId,
          sceneType,
          contextRef: body.contextRef || {
            kind: signal.kind === "repeated_parameter" ? "interaction" : "unit",
            scope: signal.kind === "quiz_review" ? "quiz" : "lesson"
          },
          quizSubmitted
        });
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "assistant_context_error",
          message: error.message
        });
        return;
      }
      if (resolved.isQuiz && !quizSubmitted) {
        sendAssistantQuizLocked(res, auth.participant.id);
        return;
      }
      const quizAttempt = attachAssistantQuizAttempt(resolved, quizResults);
      let verifiedSignal = signal;
      if (signal.kind === "quiz_review") {
        if (!resolved.isQuiz || !quizAttempt || quizAttempt.incorrect <= 0) {
          sendAssistantSignalMismatch(res, "当前没有已确认的错题可供主动复盘。");
          return;
        }
        if (quizAttempt.pendingReview > 0) {
          sendAssistantSignalMismatch(res, "简答题仍在批改，完成后再开始完整错题复盘。");
          return;
        }
        verifiedSignal = {
          ...signal,
          incorrect: quizAttempt.incorrect,
          pendingReview: quizAttempt.pendingReview,
          questionCount: quizAttempt.total,
          reviewIndex: 0
        };
      } else if (signal.kind === "repeated_parameter") {
        if (
          resolved.isQuiz
          || !resolved.scene
          || (
            resolved.contextRef.kind !== "interaction"
            && resolved.contextRef.scope !== "interactive"
          )
          || !boundedLearningText(signal.parameter, 120)
          || signal.newValue === undefined
          || signal.newValue === null
          || boundedLearningText(signal.newValue, 80) === ""
        ) {
          sendAssistantSignalMismatch(res, "当前学习位置没有可信的连续调参证据。");
          return;
        }
      } else if (
        signal.kind === "quiet_dwell"
        && (
          resolved.isQuiz
          || Number(signal.dwellSeconds || 0) < assistantMinimumDwellSeconds(resolved, sceneType)
        )
      ) {
        sendAssistantSignalMismatch(res, "当前学习状态不足以判断为有效停留。");
        return;
      }
      const interventionBudget = consumeAssistantInterventionBudget(auth.participant.id, new Date());
      if (!interventionBudget.ok) {
        sendJson(res, 429, {
          ok: false,
          code: "assistant_intervention_budget_exhausted",
          message: "知点今天已经减少主动打扰，仍可由你主动提问。",
          interventionBudget,
          quota: assistantQuotaInfo(auth.participant.id)
        });
        return;
      }
      const history = assistantRecentConversation(auth.participant.id, resolved, 4);
      const generated = await generateInterventionDecision({
        resolved,
        signal: verifiedSignal,
        history
      });
      const interventionId = issueAssistantIntervention(
        auth.participant.id,
        resolved,
        generated.decision
      );
      sendJson(res, 200, {
        ok: true,
        provider: generated.provider,
        fallback: generated.fallback,
        decision: generated.decision,
        interventionId,
        interventionBudget,
        quota: assistantQuotaInfo(auth.participant.id)
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/learning/notes") {
      const auth = authenticate(req);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const unitId = boundedLearningText(url.searchParams.get("unitId") || "", 180);
      if (unitId && !assistantContextIndex.units.has(unitId)) {
        sendJson(res, 400, { ok: false, code: "learning_note_unit_invalid", message: "学习位置不存在。" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        notes: db.listLearningNotes(auth.participant.id, unitId, 500).map(publicLearningNote)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/notes/sync") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const incoming = Array.isArray(body.notes) ? body.notes.slice(0, 500) : [];
      try {
        const records = incoming.map((note) => sanitizeLearningNoteInput(auth.participant.id, note));
        const deletedIds = (Array.isArray(body.deletedIds) ? body.deletedIds : [])
          .slice(0, 500)
          .map((noteId) => boundedLearningText(noteId, 180))
          .filter((noteId) => /^[A-Za-z0-9:_-]{1,180}$/.test(noteId));
        db.syncLearningNotes(auth.participant.id, records, deletedIds);
        const unitId = boundedLearningText(body.unitId || "", 180);
        sendJson(res, 200, {
          ok: true,
          notes: db.listLearningNotes(auth.participant.id, unitId, 500).map(publicLearningNote)
        });
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "learning_note_sync_failed",
          message: error.message || "笔记同步失败。"
        });
      }
      return;
    }

    const learningNoteMatch = url.pathname.match(/^\/api\/learning\/notes\/([^/]+)$/);
    if (learningNoteMatch && ["PUT", "DELETE"].includes(req.method)) {
      const body = req.method === "PUT" ? await readJsonBody(req) : {};
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const noteId = decodeURIComponent(learningNoteMatch[1]);
      if (req.method === "DELETE") {
        const deleted = db.deleteLearningNote(auth.participant.id, noteId);
        if (!deleted) {
          sendJson(res, 404, { ok: false, code: "learning_note_not_found", message: "这条笔记不存在或已删除。" });
          return;
        }
        sendJson(res, 200, { ok: true, deleted: true, noteId });
        return;
      }
      try {
        const record = sanitizeLearningNoteInput(auth.participant.id, body, noteId);
        const saved = db.upsertLearningNote(record);
        sendJson(res, 200, { ok: true, note: publicLearningNote(saved) });
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "learning_note_save_failed",
          message: error.message || "笔记保存失败。"
        });
      }
      return;
    }

    const assistantConversationMatch = url.pathname.match(
      /^\/api\/learning\/assistant\/conversations\/([^/]+)$/
    );
    if (assistantConversationMatch && ["PATCH", "DELETE"].includes(req.method)) {
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const conversationId = decodeURIComponent(assistantConversationMatch[1]);
      const existing = db.getLearningAssistantConversation(auth.participant.id, conversationId);
      if (!existing) {
        sendJson(res, 404, {
          ok: false,
          code: "assistant_conversation_not_found",
          message: "这段对话不存在或已被删除。"
        });
        return;
      }
      if (req.method === "DELETE") {
        db.deleteLearningAssistantConversation(auth.participant.id, conversationId);
        sendJson(res, 200, { ok: true, deleted: true, conversationId });
        return;
      }

      const action = String(body.action || "").trim();
      const updatedAt = nowIso();
      let updated = null;
      if (action === "rename") {
        const title = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!title) {
          sendJson(res, 400, {
            ok: false,
            code: "assistant_conversation_title_required",
            message: "请输入对话名称。"
          });
          return;
        }
        updated = db.renameLearningAssistantConversation(
          auth.participant.id,
          conversationId,
          title,
          updatedAt
        );
      } else if (["archive", "restore"].includes(action)) {
        updated = db.setLearningAssistantConversationArchived(
          auth.participant.id,
          conversationId,
          action === "archive" ? updatedAt : "",
          updatedAt
        );
      } else {
        sendJson(res, 400, {
          ok: false,
          code: "assistant_conversation_action_invalid",
          message: "无法识别这项会话操作。"
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        conversation: publicAssistantConversation(updated)
      });
      return;
    }

    if (
      req.method === "POST"
      && url.pathname === "/api/learning/assistant/quiz-review/action"
    ) {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const action = String(body.action || "").trim();
      if (!["continue", "next", "stop"].includes(action)) {
        sendJson(res, 400, {
          ok: false,
          code: "assistant_quiz_review_action_invalid",
          message: "无法识别这项错题复盘操作。"
        });
        return;
      }
      const conversationId = boundedLearningText(body.conversationId, 180);
      const assistantMessageId = boundedLearningText(body.assistantMessageId, 180);
      const unitId = boundedLearningText(body.unitId, 180);
      const chapterId = boundedLearningText(body.chapterId, 180);
      const sceneType = boundedLearningText(body.sceneType, 80);
      const conversation = db.getLearningAssistantConversation(
        auth.participant.id,
        conversationId
      );
      const sourceMessage = db.getLearningAssistantMessage(
        auth.participant.id,
        assistantMessageId
      );
      if (
        !conversation
        || !sourceMessage
        || sourceMessage.role !== "assistant"
        || sourceMessage.conversation_id !== conversation.id
        || sourceMessage.unit_id !== unitId
      ) {
        sendJson(res, 404, {
          ok: false,
          code: "assistant_quiz_review_state_not_found",
          message: "这段错题复盘已不在当前对话中，请重新开始。"
        });
        return;
      }
      const latestMessage = db.getLearningAssistantMessages(
        auth.participant.id,
        conversation.thread_key,
        1,
        conversation.id
      )[0];
      if (!latestMessage || latestMessage.id !== sourceMessage.id) {
        sendJson(res, 409, {
          ok: false,
          code: "assistant_quiz_review_state_stale",
          message: "这不是当前对话最新的复盘步骤，请从最新回答继续。"
        });
        return;
      }
      const quizResults = db.getQuizResultsByUserUnit(auth.participant.id, unitId);
      const quizSubmitted = Boolean(quizResults.length);
      let resolved;
      try {
        resolved = learningAssistant.resolveAssistantContext({
          index: assistantContextIndex,
          chapterId,
          unitId,
          sceneType,
          contextRef: { kind: "unit", scope: "quiz" },
          quizSubmitted
        });
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "assistant_context_error",
          message: error.message
        });
        return;
      }
      if (!resolved.isQuiz || !quizSubmitted) {
        sendAssistantQuizLocked(res, auth.participant.id);
        return;
      }
      const quizAttempt = attachAssistantQuizAttempt(resolved, quizResults);
      const progress = assistantQuizReviewProgress(sourceMessage);
      if (
        !quizAttempt
        || quizAttempt.pendingReview > 0
        || quizAttempt.incorrect <= 0
        || !["awaiting_choice", "awaiting_reply"].includes(progress.status)
      ) {
        sendJson(res, 409, {
          ok: false,
          code: "assistant_quiz_review_state_unavailable",
          message: "当前没有可继续的错题复盘步骤，请重新开始复盘。"
        });
        return;
      }
      if (action === "stop") {
        const stopped = {
          ...progress,
          status: "stopped",
          done: false,
          action: "",
          completionMessage: "已结束本轮错题复盘。"
        };
        updateAssistantQuizReviewProgress(sourceMessage, stopped);
        sendJson(res, 200, {
          ok: true,
          done: false,
          progress: normalizeAssistantQuizReviewProgress(stopped)
        });
        return;
      }
      if (progress.status !== "awaiting_choice") {
        sendJson(res, 409, {
          ok: false,
          code: "assistant_quiz_review_reply_pending",
          message: "上一步复盘问题正在等待你的回答。"
        });
        return;
      }
      const currentIndex = quizReviewIndexFromProgress(resolved, progress);
      if (currentIndex < 0) {
        sendJson(res, 409, {
          ok: false,
          code: "assistant_quiz_review_attempt_changed",
          message: "测验结果已经更新，请重新开始本轮复盘。"
        });
        return;
      }
      const targetReviewIndex = action === "continue" ? currentIndex : currentIndex + 1;
      if (targetReviewIndex >= quizAttempt.incorrectItems.length) {
        const completionMessage = `本轮 ${quizAttempt.incorrectItems.length} 道错题已复盘完成。`;
        const completed = {
          ...progress,
          status: "completed",
          done: true,
          action: "",
          completionMessage
        };
        updateAssistantQuizReviewProgress(sourceMessage, completed);
        sendJson(res, 200, {
          ok: true,
          done: true,
          progress: normalizeAssistantQuizReviewProgress(completed),
          completionMessage
        });
        return;
      }
      const decision = quizReviewDecisionForIndex(resolved, targetReviewIndex);
      if (!decision || decision.action !== "review_mistake") {
        sendJson(res, 409, {
          ok: false,
          code: "assistant_quiz_review_target_unavailable",
          message: "下一步错题复盘暂时不可用，请稍后再试。"
        });
        return;
      }
      const visible = action === "next";
      const pendingProgress = {
        ...progress,
        status: "awaiting_reply",
        done: false,
        action,
        targetReviewIndex,
        targetQuestionId: decision.questionId || ""
      };
      updateAssistantQuizReviewProgress(sourceMessage, pendingProgress);
      const interventionId = issueAssistantIntervention(
        auth.participant.id,
        resolved,
        {
          ...decision,
          promptVisible: visible,
          sourceMessageId: sourceMessage.id,
          reviewAction: action
        }
      );
      sendJson(res, 200, {
        ok: true,
        done: false,
        progress: normalizeAssistantQuizReviewProgress(pendingProgress),
        prompt: publicQuizReviewPrompt({
          resolved,
          sceneType,
          decision,
          interventionId,
          sourceMessageId: sourceMessage.id,
          reviewAction: action,
          visible
        })
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/learning/assistant/history") {
      const auth = authenticate(req);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const unitId = String(url.searchParams.get("unitId") || "").trim();
      const chapterId = String(url.searchParams.get("chapterId") || "").trim();
      const sceneType = String(url.searchParams.get("sceneType") || "").trim();
      const conversationId = String(url.searchParams.get("conversationId") || "").trim();
      const quizResults = unitId
        ? db.getQuizResultsByUserUnit(auth.participant.id, unitId)
        : [];
      const quizSubmitted = Boolean(quizResults.length);
      let resolved;
      try {
        resolved = learningAssistant.resolveAssistantContext({
          index: assistantContextIndex,
          chapterId,
          unitId,
          sceneType,
          contextRef: {
            kind: "unit",
            scope: unitId.endsWith("-pre") || unitId.endsWith("-formative") || unitId.endsWith("-post")
              ? "quiz"
              : "lesson"
          },
          quizSubmitted
        });
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "assistant_context_error",
          message: error.message
        });
        return;
      }
      if (resolved.isQuiz && !quizSubmitted) {
        sendAssistantQuizLocked(res, auth.participant.id);
        return;
      }
      if (resolved.isQuiz) attachAssistantQuizAttempt(resolved, quizResults);
      let conversation = null;
      if (conversationId) {
        const found = db.getLearningAssistantConversation(auth.participant.id, conversationId);
        if (!found || found.thread_key !== resolved.threadKey) {
          sendJson(res, 404, {
            ok: false,
            code: "assistant_conversation_not_found",
            message: "这段历史对话不存在，或不属于当前学习位置。"
          });
          return;
        }
        conversation = publicAssistantConversation(found);
      } else {
        const latest = db.listLearningAssistantConversations(
          auth.participant.id,
          resolved.threadKey,
          1
        )[0];
        conversation = latest ? publicAssistantConversation(latest) : null;
      }
      const messages = conversation
        ? db.getLearningAssistantMessages(
            auth.participant.id,
            resolved.threadKey,
            assistantHistoryMessageLimit,
            conversation.id
          ).filter((row) => quizSubmitted || Number(row.quiz_submitted || 0) !== 1)
        : [];
      let pendingQuizReviewPrompt = null;
      const latestAssistantMessage = [...messages].reverse().find((row) => row.role === "assistant");
      if (resolved.isQuiz && latestAssistantMessage) {
        const progress = assistantQuizReviewProgress(latestAssistantMessage);
        if (progress.status === "awaiting_reply") {
          const targetReviewIndex = quizReviewIndexFromProgress(
            resolved,
            progress,
            { target: true }
          );
          const decision = targetReviewIndex >= 0
            ? quizReviewDecisionForIndex(resolved, targetReviewIndex)
            : null;
          if (
            decision?.action === "review_mistake"
            && (!progress.targetQuestionId || decision.questionId === progress.targetQuestionId)
          ) {
            const visible = progress.action === "next";
            const interventionId = issueAssistantIntervention(
              auth.participant.id,
              resolved,
              {
                ...decision,
                promptVisible: visible,
                sourceMessageId: latestAssistantMessage.id,
                reviewAction: progress.action
              }
            );
            pendingQuizReviewPrompt = publicQuizReviewPrompt({
              resolved,
              sceneType,
              decision,
              interventionId,
              sourceMessageId: latestAssistantMessage.id,
              reviewAction: progress.action,
              visible
            });
          }
        }
      }
      sendJson(res, 200, {
        ok: true,
        threadKey: resolved.threadKey,
        conversation,
        conversationTurnLimit: assistantConversationTurnLimit,
        conversationTurns: Math.floor(Number(conversation?.messageCount || 0) / 2),
        contextRef: resolved.contextRef,
        quizSubmitted,
        provider: assistantProviderInfo(),
        quota: assistantQuotaInfo(auth.participant.id),
        pendingQuizReviewPrompt,
        messages: messages.map(publicAssistantMessage)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/assistant/ask") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const question = String(body.question || "").replace(/\u0000/g, "").trim().slice(0, 1200);
      const assistantIntent = ["self_check", "rephrase", "practice"].includes(String(body.assistantIntent || "").trim())
        ? String(body.assistantIntent).trim()
        : "";
      const proactiveInterventionId = boundedLearningText(body.proactiveInterventionId, 180);
      const unitId = String(body.unitId || "").trim();
      const chapterId = String(body.chapterId || "").trim();
      const sceneType = String(body.sceneType || "").trim();
      if (!question || !unitId) {
        sendJson(res, 400, { ok: false, message: "请输入问题，并保持当前学习单元有效。" });
        return;
      }
      const quizResults = db.getQuizResultsByUserUnit(auth.participant.id, unitId);
      const quizSubmitted = Boolean(quizResults.length);
      let resolved;
      try {
        resolved = learningAssistant.resolveAssistantContext({
          index: assistantContextIndex,
          chapterId,
          unitId,
          sceneType,
          contextRef: body.contextRef,
          quizSubmitted
        });
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "assistant_context_error",
          message: error.message
        });
        return;
      }
      if (resolved.isQuiz && !quizSubmitted) {
        sendAssistantQuizLocked(res, auth.participant.id);
        return;
      }
      attachAssistantQuizAttempt(resolved, quizResults);
      const proactiveIntervention = proactiveInterventionId
        ? getAssistantIntervention(auth.participant.id, unitId, proactiveInterventionId)
        : null;
      if (proactiveInterventionId && !proactiveIntervention) {
        sendJson(res, 409, {
          ok: false,
          code: "assistant_intervention_expired",
          message: "这次复盘提示已失效，请重新开始复盘。",
          quota: assistantQuotaInfo(auth.participant.id)
        });
        return;
      }
      let proactiveReviewSourceMessage = null;
      const proactivePrompt = proactiveIntervention?.assistantPrompt || "";
      if (proactiveIntervention?.action === "review_mistake") {
        resolved.quizReviewIndex = Math.max(
          0,
          Math.trunc(Number(proactiveIntervention.reviewIndex || 0))
        );
      }
      const rate = checkAssistantRateLimit(auth.participant.id);
      if (!rate.ok) {
        sendJson(res, 429, {
          ok: false,
          code: "assistant_rate_limited",
          message: "提问有点密集，先观察一下课件，稍后再继续。",
          retryAfterSeconds: rate.retryAfterSeconds
        });
        return;
      }

      const requestedAt = new Date();
      const providerInfo = assistantProviderInfo();
      let quota = assistantQuotaInfo(auth.participant.id, requestedAt);
      let quotaReserved = false;
      let conversationState;
      try {
        conversationState = assistantConversationForRequest(
          auth.participant.id,
          resolved,
          body.conversationId,
          requestedAt.toISOString()
        );
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          code: error.code || "assistant_conversation_error",
          message: error.message,
          quota
        });
        return;
      }
      const { conversation } = conversationState;
      if (proactiveIntervention?.sourceMessageId) {
        const sourceMessage = db.getLearningAssistantMessage(
          auth.participant.id,
          proactiveIntervention.sourceMessageId
        );
        const sourceProgress = assistantQuizReviewProgress(sourceMessage);
        const targetReviewIndex = quizReviewIndexFromProgress(
          resolved,
          sourceProgress,
          { target: true }
        );
        if (
          !sourceMessage
          || sourceMessage.role !== "assistant"
          || sourceMessage.conversation_id !== conversation.id
          || sourceMessage.unit_id !== unitId
          || sourceProgress.status !== "awaiting_reply"
          || targetReviewIndex !== proactiveIntervention.reviewIndex
          || (
            proactiveIntervention.questionId
            && sourceProgress.targetQuestionId
            && proactiveIntervention.questionId !== sourceProgress.targetQuestionId
          )
        ) {
          sendJson(res, 409, {
            ok: false,
            code: "assistant_intervention_expired",
            message: "这次复盘步骤已被更新，请从最新回答继续。",
            quota
          });
          return;
        }
        proactiveReviewSourceMessage = sourceMessage;
      }
      const conversationTurns = Math.floor(Number(conversation.messageCount || 0) / 2);
      if (conversationTurns >= assistantConversationTurnLimit) {
        sendJson(res, 409, {
          ok: false,
          code: "assistant_conversation_turn_limit",
          message: `这段对话已达到 ${assistantConversationTurnLimit} 轮，请新建对话继续。`,
          conversationTurnLimit: assistantConversationTurnLimit,
          conversationTurns,
          quota
        });
        return;
      }
      if (assistantRequestConsumesQuota(providerInfo)) {
        quota = consumeAssistantQuota(auth.participant.id, requestedAt);
        if (!quota.ok) {
          sendJson(res, 429, {
            ok: false,
            code: "assistant_daily_quota_exhausted",
            message: "今天的知点额度已用完，明天可以继续提问。",
            quota
          });
          return;
        }
        quotaReserved = true;
      }
      const historyRows = conversationState.createConversation
        ? []
        : db.getLearningAssistantMessages(
            auth.participant.id,
            resolved.threadKey,
            assistantHistoryMessageLimit,
            conversation.id
          ).filter((row) => quizSubmitted || Number(row.quiz_submitted || 0) !== 1);
      const history = historyRows.map((row) => ({
        role: row.role,
        content: row.content
      }));
      const askedAt = requestedAt.toISOString();
      const userMessageId = crypto.randomUUID();

      if (proactiveIntervention) {
        getAssistantIntervention(
          auth.participant.id,
          unitId,
          proactiveInterventionId,
          { consume: true }
        );
      }
      const generated = await generateAssistantTurn({
        resolved,
        question,
        history,
        quizSubmitted,
        assistantIntent,
        proactivePrompt
      });
      if (generated.fallback && quotaReserved) {
        quota = releaseAssistantQuota(auth.participant.id, requestedAt);
        quotaReserved = false;
      }
      const answer = learningAssistant.enforceQuizSafety(generated.text, {
        isQuiz: resolved.isQuiz,
        quizSubmitted,
        resolved
      });
      const assistantMessageId = crypto.randomUUID();
      const answeredAt = nowIso();
      let quizReviewFollowUp = null;
      if (proactiveIntervention?.action === "review_mistake") {
        const incorrectItems = Array.isArray(resolved?.quizAttempt?.incorrectItems)
          ? resolved.quizAttempt.incorrectItems
          : [];
        const matchedIndex = proactiveIntervention.questionId
          ? incorrectItems.findIndex((item) => item.questionId === proactiveIntervention.questionId)
          : -1;
        const reviewIndex = matchedIndex >= 0
          ? matchedIndex
          : Math.max(
              0,
              Math.min(
                Math.max(0, incorrectItems.length - 1),
                Math.trunc(Number(proactiveIntervention.reviewIndex || 0))
              )
            );
        quizReviewFollowUp = {
          status: "awaiting_choice",
          done: false,
          reviewIndex,
          reviewTotal: incorrectItems.length,
          questionId: incorrectItems[reviewIndex]?.questionId || proactiveIntervention.questionId || "",
          completionMessage: "",
          actions: ["continue", "next", "stop"],
          sourceMessageId: assistantMessageId
        };
      }
      const assistantGuidance = quizReviewFollowUp
        ? {
            ...generated.guidance,
            quizReviewProgress: normalizeAssistantQuizReviewProgress(quizReviewFollowUp)
          }
        : generated.guidance;
      const messageBase = {
        user_id: auth.participant.id,
        thread_key: resolved.threadKey,
        conversation_id: conversation.id,
        chapter_id: resolved.unit.chapterId,
        unit_id: resolved.unit.id,
        knowledge_point_id: resolved.unit.knowledgePointId || "",
        context: {
          ...resolved.contextRef,
          assistantGuidance,
          assistantIntent,
          proactivePrompt,
          proactivePromptVisible: proactiveIntervention?.promptVisible !== false
        },
        quiz_submitted: quizSubmitted
      };
      db.saveLearningAssistantTurn({
        conversation: conversationState.record,
        createConversation: conversationState.createConversation,
        userMessage: {
          ...messageBase,
          id: userMessageId,
          role: "user",
          content: question,
          provider: "",
          created_at: askedAt
        },
        assistantMessage: {
          ...messageBase,
          id: assistantMessageId,
          role: "assistant",
          content: answer,
          provider: generated.provider,
          created_at: answeredAt
        },
        title: conversation.messageCount === 0 ? question : "",
        updatedAt: answeredAt
      });
      if (proactiveReviewSourceMessage) {
        const sourceProgress = assistantQuizReviewProgress(proactiveReviewSourceMessage);
        updateAssistantQuizReviewProgress(proactiveReviewSourceMessage, {
          ...sourceProgress,
          status: "answered",
          done: false,
          action: ""
        });
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no"
      });
      res.flushHeaders?.();
      writeNdjson(res, {
        type: "meta",
        threadKey: resolved.threadKey,
        conversationId: conversation.id,
        conversationTurnLimit: assistantConversationTurnLimit,
        conversationTurns: conversationTurns + 1,
        userMessageId,
        contextRef: resolved.contextRef,
        quizSubmitted,
        provider: providerInfo,
        quota
      });
      for (const delta of learningAssistant.responseChunks(answer)) {
        writeNdjson(res, { type: "delta", delta });
      }
      writeNdjson(res, {
        type: "done",
        message: {
          id: assistantMessageId,
          role: "assistant",
          content: answer,
          contextRef: resolved.contextRef,
          guidance: assistantGuidance,
          assistantIntent,
          proactivePrompt: "",
          provider: generated.provider,
          quizSubmitted,
          createdAt: answeredAt
        },
        policy: generated.policy,
        guidance: assistantGuidance,
        quizReviewFollowUp,
        fallback: generated.fallback,
        conversation: {
          ...conversation,
          title: conversation.messageCount === 0 ? question.slice(0, 42) : conversation.title,
          messageCount: conversation.messageCount + 2,
          turnCount: conversationTurns + 1,
          updatedAt: answeredAt
        },
        quota
      });
      res.end();
      return;
    }

    // ---- Learning Quiz Results (server-scored authoritative source) ----
    if (req.method === "POST" && url.pathname === "/api/learning/quiz/submit") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const unitId = String(body.unitId || "").trim();
      const chapterId = String(body.chapterId || "").trim();
      const phase = String(body.phase || "").trim();
      const answers = Array.isArray(body.answers) ? body.answers.slice(0, 50) : [];
      if (!unitId || !chapterId || !phase || !answers.length) {
        sendJson(res, 400, { ok: false, message: "测验提交信息不完整。" });
        return;
      }
      const expectedEntries = courseAssessment.assessmentEntriesForUnit(assessmentIndex, {
        chapterId,
        unitId,
        phase
      });
      const submittedQuestionIds = new Set(
        answers.map((answer) => String(answer?.questionId || "").trim()).filter(Boolean)
      );
      if (
        !expectedEntries.length
        || submittedQuestionIds.size !== answers.length
        || submittedQuestionIds.size !== expectedEntries.length
        || expectedEntries.some((entry) => !submittedQuestionIds.has(entry.question.id))
      ) {
        sendJson(res, 400, {
          ok: false,
          code: "quiz_question_set_mismatch",
          message: "提交题目与当前测验不完整或不匹配。"
        });
        return;
      }
      if (db.getQuizResultsByUserUnit(auth.participant.id, unitId).length) {
        sendJson(res, 409, { ok: false, code: "quiz_already_submitted", message: "这份测验已经提交，不能重复覆盖成绩。" });
        return;
      }

      const seen = new Set();
      const timestamp = nowIso();
      const learningGeneration = db.currentLearningGeneration(auth.participant.id, timestamp);
      const prepared = [];
      for (const submitted of answers) {
        const questionId = String(submitted?.questionId || "").trim();
        if (!questionId || seen.has(questionId)) {
          sendJson(res, 400, { ok: false, message: "测验题目无效或重复。" });
          return;
        }
        seen.add(questionId);
        const entry = courseAssessment.assessmentEntry(assessmentIndex, {
          questionId,
          chapterId,
          unitId,
          phase
        });
        if (!entry) {
          sendJson(res, 400, { ok: false, message: "测验题目与当前章节不匹配。" });
          return;
        }
        const question = entry.question;
        let response = submitted.response;
        if (question.type === "multiple") {
          response = Array.isArray(response)
            ? Array.from(new Set(response.map((value) => String(value).trim()).filter(Boolean))).slice(0, 30)
            : [];
        } else {
          response = String(response ?? "").trim().slice(0, 12000);
        }
        if (question.type === "multiple" ? !response.length : !response) {
          sendJson(res, 400, { ok: false, message: "请完成全部题目后再提交。" });
          return;
        }

        const maxScore = Math.max(0, Number(question.points || 0));
        const scored = question.type === "short_answer"
          ? { isCorrect: null, score: 0, maxScore, status: "pending_review" }
          : courseAssessment.scoreObjectiveQuestion(question, response);
        prepared.push({
          id: `${auth.participant.id}-g${learningGeneration}-${unitId}-${question.id}`,
          unitId,
          chapterId,
          questionId: question.id,
          questionType: question.type,
          points: maxScore,
          phase,
          timestamp,
          response,
          ...scored,
          ...courseAssessment.publicReviewFields(question),
          entry
        });
      }

      prepared.forEach((result) => {
        db.insertQuizResult({
          id: result.id,
          user_id: auth.participant.id,
          chapter_id: result.chapterId,
          chapter_label: result.entry.chapterLabel || "",
          unit_id: result.unitId,
          unit_label: result.entry.unitLabel || "",
          question_id: result.questionId,
          question_type: result.questionType,
          phase: result.phase,
          points: result.points,
          response: result.response,
          is_correct: result.isCorrect === true ? 1 : result.isCorrect === false ? 0 : -1,
          status: result.status,
          score: result.score,
          max_score: result.maxScore,
          learning_generation: learningGeneration,
          created_at: result.timestamp
        });
      });
      db.saveNow();

      sendJson(res, 200, {
        ok: true,
        results: prepared.map(({ entry, ...result }) => result)
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/learning/quiz-results") {
      const auth = authenticate(req);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const results = db.getQuizResultsByUser(auth.participant.id, 500).map((row) => {
        const entry = courseAssessment.assessmentEntry(assessmentIndex, row);
        return entry ? { ...row, ...courseAssessment.publicReviewFields(entry.question) } : row;
      });
      sendJson(res, 200, { ok: true, data: results });
      return;
    }

    // ---- Admin: Export raw data (backward compat) ----
    if (req.method === "GET" && url.pathname === "/api/admin/export") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const d = db.getDbSync();
      const users = [];
      const us = d.prepare("SELECT * FROM users");
      while (us.step()) users.push(us.getAsObject());
      us.free();

      const participants = {};
      for (const u of users) {
        const snap = db.getLatestSnapshot(u.id);
        participants[u.id] = {
          participantId: u.id, loginMode: u.password_hash ? "password" : "nickname", nickname: u.nickname || "", email: u.email || "", displayName: publicDisplayName(u),
          createdAt: u.created_at, updatedAt: u.last_seen_at, lastSeenAt: u.last_seen_at,
          stats: snap ? summaryFromData(snap.data) : {}
        };
      }
      const qrs = [];
      const qs = d.prepare("SELECT * FROM quiz_results");
      while (qs.step()) qrs.push(qs.getAsObject());
      qs.free();
      sendJson(res, 200, { ok: true, data: { version: 2, participants, quizResults: qrs } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/shutdown") {
      if (!checkAdmin(req)) {
        sendJson(res, 403, { ok: false, message: "需要管理员密码。" });
        return;
      }
      sendJson(res, 202, { ok: true, message: "服务正在保存数据库并安全停止。" });
      setTimeout(() => shutdown("ADMIN_SHUTDOWN"), 50);
      return;
    }

    // ---- Admin Stats APIs ----
    if (req.method === "GET" && url.pathname === "/api/admin/stats/overview") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.statsOverview(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/feedback") {
      if (!checkAdmin(req)) {
        sendJson(res, 403, { ok: false, message: "需要管理员密码。" });
        return;
      }
      const dates = getDateRange(url);
      sendJson(res, 200, {
        ok: true,
        data: db.feedbackDashboard({
          ...dates,
          feedbackType: url.searchParams.get("type") || "",
          targetScope: url.searchParams.get("scope") || "",
          query: url.searchParams.get("q") || "",
          limit: Math.max(1, Math.min(Number(url.searchParams.get("limit") || 1000), 1000)),
          offset: Math.max(0, Number(url.searchParams.get("offset") || 0))
        })
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/chapter-accuracy") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.chapterAccuracy(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/question-errors") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.questionErrors(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/user-progress") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.userProgress(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/daily-activity") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.dailyActivity(30, dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/phase-comparison") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.phaseComparison(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/user-detail") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const userId = url.searchParams.get("userId") || "";
      if (!userId) { sendJson(res, 400, { ok: false, message: "userId required." }); return; }
      const dates = getDateRange(url);
      const detail = db.userDetail(userId, dates);
      if (!detail) { sendJson(res, 404, { ok: false, message: "User not found." }); return; }
      sendJson(res, 200, { ok: true, data: detail });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/users") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      sendJson(res, 200, { ok: true, data: db.listUsers() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/question-type-accuracy") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.questionTypeAccuracy(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/score-distribution") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.scoreDistribution(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/hourly-activity") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      sendJson(res, 200, { ok: true, data: db.hourlyActivity(30, dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/short-answer-responses") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 500), 1000));
      dates.offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      sendJson(res, 200, { ok: true, data: db.shortAnswerResponses(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/grading/regrade-candidates") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 20), 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const candidates = db.shortAnswerRegradeCandidates({ limit, offset });
      sendJson(res, 200, {
        ok: true,
        data: {
          ...candidates,
          runtime: gradingRuntimeInfo()
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/grading/regrade-audits") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      sendJson(res, 200, {
        ok: true,
        data: db.gradingRegradeAudits({
          batchId: url.searchParams.get("batchId") || "",
          limit: Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 1000))
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/grading/regrade") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const body = await readJsonBody(req);
      if (body.confirm !== "REVIEW_AND_REGRADING") {
        sendJson(res, 400, {
          ok: false,
          code: "grading_regrade_confirmation_required",
          message: "请先预览候选，并显式确认本次重新评分。"
        });
        return;
      }
      const requestedIds = Array.from(new Set(
        (Array.isArray(body.ids) ? body.ids : [])
          .map((id) => String(id || "").trim())
          .filter(Boolean)
      ));
      const batchSize = Math.max(1, Math.min(Number(body.limit || 5), 5));
      if (!requestedIds.length || requestedIds.length > batchSize) {
        sendJson(res, 400, {
          ok: false,
          code: "grading_regrade_batch_invalid",
          message: `每批必须选择 1 到 ${batchSize} 条具体记录。`
        });
        return;
      }
      const busyIds = requestedIds.filter((id) => gradingRegradeInFlightIds.has(id));
      if (busyIds.length) {
        sendJson(res, 409, {
          ok: false,
          code: "grading_regrade_in_progress",
          message: "选中的记录正在另一批重评中，请等待当前评分完成后刷新候选。",
          ids: busyIds
        });
        return;
      }
      const runtime = gradingRuntimeInfo();
      if (!runtime.liveConfigured || !["openai-compatible", "innospark", "openai"].includes(runtime.provider)) {
        sendJson(res, 503, {
          ok: false,
          code: "grading_provider_not_configured",
          message: "服务器尚未配置真实评分模型，已停止重评，原评分未改变。",
          runtime
        });
        return;
      }
      requestedIds.forEach((id) => gradingRegradeInFlightIds.add(id));
      try {
        const batch = await gradingRegrade.runRegradeBatch({
          db,
          courseAssessment,
          assessmentIndex,
          gradeOnly: (questions) => orchestrator.gradeOnly(questions),
          requestedIds,
          runtime,
          nowIso,
          randomUUID: () => crypto.randomUUID()
        });
        db.saveNow();
        sendJson(res, 200, {
          ok: true,
          data: batch
        });
      } finally {
        requestedIds.forEach((id) => gradingRegradeInFlightIds.delete(id));
      }
      return;
    }
    
    // ---- Admin: Interactions tracking ----
    if (req.method === "GET" && url.pathname === "/api/admin/stats/interactions") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 1000));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const userId = url.searchParams.get("userId") || "";
      const detailMode = url.searchParams.get("detail") === "all" ? "all" : "meaningful";
      const data = db.getEventsByType("interaction", {
        limit,
        offset,
        userId,
        detailMode,
        dates
      });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    // ---- Learning KG plan + agentic narration ----
    if (req.method === "GET" && url.pathname === "/api/learning/kg") {
      sendJson(res, 200, { ok: true, kg: kg.getKg() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/grade") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const requestedUnitId = String(body.unitId || "").trim();
      const fallbackToZero = body.fallbackToZero === true;
      const requestedIds = new Set(
        (Array.isArray(body.questions) ? body.questions : [])
          .map((question) => String(question?.questionId || "").trim())
          .filter(Boolean)
      );
      const storedRows = db.getQuizResultsByUser(auth.participant.id, 500);
      const latest = new Map();
      storedRows.forEach((row) => {
        const key = `${row.unit_id || ""}:${row.question_id || ""}`;
        if (
          !latest.has(key)
          && (!requestedUnitId || row.unit_id === requestedUnitId)
          && (!requestedIds.size || requestedIds.has(row.question_id))
        ) {
          latest.set(key, row);
        }
      });
      const questions = courseAssessment.authoritativeGradingQuestions(
        assessmentIndex,
        Array.from(latest.values())
      ).slice(0, 50);
      if (!requestedIds.size || !questions.length) {
        sendJson(res, 400, {
          ok: false,
          code: "grading_target_not_found",
          message: "没有找到可重新批改的简答题。"
        });
        return;
      }
      if (fallbackToZero) {
        const fallbackQuestions = questions.filter((question) => {
          const row = latest.get(`${question.unitId || ""}:${question.questionId || ""}`) || {};
          return row.status === "pending_review" || row.is_correct === -1;
        });
        if (!requestedIds.size || !fallbackQuestions.length) {
          sendJson(res, 400, { ok: false, message: "没有可处理的简答题。" });
          return;
        }
        const results = fallbackQuestions.map((question) => {
          const row = latest.get(`${question.unitId || ""}:${question.questionId || ""}`) || {};
          const existingFeedback = String(row.ai_feedback || "").trim();
          const feedback = /已先按 0 分计入|可以继续学习/.test(existingFeedback)
            ? existingFeedback
            : `${existingFeedback ? `${existingFeedback.replace(/[。.!！？?\s]+$/u, "")}。` : ""}你选择先按 0 分继续学习，后续仍可重新评分或人工复核。`;
          return {
            questionId: question.questionId,
            unitId: question.unitId,
            chapterId: question.chapterId,
            score: 0,
            isCorrect: false,
            confidence: 0,
            errorType: "manual_fallback",
            weakConcepts: [],
            feedback,
            reasoning: "学生选择先按 0 分继续学习。",
            needsReview: true,
            provider: "manual-fallback"
          };
        });
        persistGradingResults(auth.participant, results);
        sendJson(res, 200, { ok: true, results, provider: "manual-fallback" });
        return;
      }
      try {
        const results = await orchestrator.gradeOnly(questions);
        persistGradingResults(auth.participant, results);
        sendJson(res, 200, { ok: true, results });
      } catch (err) {
        sendJson(res, 500, { ok: false, message: err.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning/kg/plan") {
      const body = await readJsonBody(req);
      const auth = authenticate(req, body);
      if (!auth) { sendJson(res, 401, { ok: false, message: "请先登录。" }); return; }
      const chapterId = String(body.chapterId || "").trim();
      const currentUnitId = String(body.currentUnitId || "").trim();
      if (!chapterId) { sendJson(res, 400, { ok: false, message: "chapterId required." }); return; }
      const sourceResults = db.getQuizResultsByUser(auth.participant.id, 500);
      const filtered = sourceResults.filter((row) => {
        const unitId = row.unit_id || row.unitId || "";
        const cid = row.chapter_id || row.chapterId || unitId.split("-scene-")[0];
        return cid === chapterId;
      });
      try {
        // Fetch recent interaction events from DB (client queue is flushed and cleared)
        const recentEvents = db.interactionRows({ userId: auth.participant.id }, 200)
          .map(row => { try { return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload; } catch { return {}; } })
          .slice(-80);
        const result = await orchestrator.orchestrate({
          chapterId, currentUnitId, quizResults: filtered,
          quizQuestions: courseAssessment.authoritativeGradingQuestions(
            assessmentIndex,
            filtered,
            { retryableOnly: true }
          ),
          interactionEvidence: body.interactionEvidence && typeof body.interactionEvidence === "object" ? body.interactionEvidence : null,
          interactionEvents: recentEvents,
          completedUnitIds: Array.isArray(body.completedUnitIds) ? body.completedUnitIds.slice(0, 500) : [],
          studentName: auth.participant.nickname || "同学"
        });
        persistGradingResults(auth.participant, result.gradingResults);
        const decisionId = crypto.randomUUID();
        const decisionCreatedAt = nowIso();
        db.insertAgentDecision({
          id: decisionId, user_id: auth.participant.id, agent_type: "orchestrator",
          decision_type: "plan", input_summary: { chapterId, currentUnitId },
          output_summary: { action: coach.recommendedAction(result.plan), qa: result.qa, planner: result.planner, interactionEvidence: result.interactionEvidence },
          confidence: result.assessment?.confidenceLevel || 0, llm_provider: result.provider,
          latency_ms: result.latencyMs || 0, created_at: decisionCreatedAt
        });
        db.insertInteractionEvidenceBatch(auth.participant.id, decisionId, chapterId, result.interactionEvidence, decisionCreatedAt);
        sendJson(res, 200, { ok: true, decisionId, decisionCreatedAt, plan: result.plan, narration: result.narration, provider: result.provider, gradingResults: result.gradingResults, assessment: result.assessment, analytics: result.analytics, planner: result.planner, interactionEvidence: result.interactionEvidence });
      } catch (err) {
        const summary = kg.summariseQuizResults(filtered);
        const planResult = coach.plan({ chapterId, currentUnitId, quizSummary: summary });
        let narration = "", provider = "fallback";
        try { const out = await coach.explain(planResult, { studentName: auth.participant.nickname || "同学" }); narration = out.narration; provider = out.provider; } catch { narration = "（AI 助教暂时离线，下面是基于规则的建议。）"; }
        const fallbackEvidence = body.interactionEvidence && typeof body.interactionEvidence === "object" ? body.interactionEvidence : null;
        let decisionId = "";
        let decisionCreatedAt = "";
        if (fallbackEvidence) {
          decisionId = crypto.randomUUID();
          decisionCreatedAt = nowIso();
          db.insertAgentDecision({
            id: decisionId, user_id: auth.participant.id, agent_type: "orchestrator",
            decision_type: "plan_fallback", input_summary: { chapterId, currentUnitId },
            output_summary: { action: coach.recommendedAction(planResult), error: err.message, interactionEvidence: fallbackEvidence },
            confidence: 0, llm_provider: provider, latency_ms: 0, created_at: decisionCreatedAt
          });
          db.insertInteractionEvidenceBatch(auth.participant.id, decisionId, chapterId, fallbackEvidence, decisionCreatedAt);
        }
        sendJson(res, 200, { ok: true, decisionId, decisionCreatedAt, plan: planResult, narration, provider });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/interaction-dashboard") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      sendJson(res, 200, { ok: true, data: db.interactionDashboard(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/agentic-decision-trace") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      dates.limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 500), 1000));
      dates.offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      sendJson(res, 200, { ok: true, data: db.agenticDecisionTrace(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/interaction-evidence-snapshots") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      sendJson(res, 200, { ok: true, data: db.interactionEvidenceSnapshots(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/interaction-summary") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      sendJson(res, 200, { ok: true, data: db.interactionSummary(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/unit-engagement") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      sendJson(res, 200, { ok: true, data: db.unitEngagement(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/skip-repeat") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      sendJson(res, 200, { ok: true, data: db.skipRepeatStats(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/parameter-changes") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      sendJson(res, 200, { ok: true, data: db.parameterChangeStats(dates) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats/path-analysis") {
      if (!checkAdmin(req)) { sendJson(res, 403, { ok: false, message: "需要管理员密码。" }); return; }
      const dates = getDateRange(url);
      dates.userId = url.searchParams.get("userId") || "";
      sendJson(res, 200, { ok: true, data: db.pathAnalysis(dates) });
      return;
    }

    sendJson(res, 404, { ok: false, message: "接口不存在。" });
  } catch (error) {
    const explicitStatus = Number(error.status || 0);
    const status = explicitStatus >= 400 && explicitStatus <= 599 ? explicitStatus
      : error.message === "Request body is too large" ? 413
        : error.message === "Invalid JSON body" ? 400
          : 500;
    if (status >= 500) console.error("API error:", error);
    const message = status === 500 ? "服务器内部错误。"
      : error.message === "Request body is too large" ? "请求内容过大。"
        : error.message === "Invalid JSON body" ? "请求格式不正确。"
          : error.message;
    sendJson(res, status, {
      ok: false,
      ...(error.code ? { code: error.code } : {}),
      message
    });
  }
}

const server = http.createServer((req, res) => {
  // Security headers (defense-in-depth)
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Strip sub-path prefix when behind reverse proxy at e.g. /calculus_quest/
  let rawUrl = req.url || "/";
  const hasBasePath = basePath && (
    rawUrl === basePath
    || rawUrl.startsWith(basePath + "/")
    || rawUrl.startsWith(basePath + "?")
  );
  if (hasBasePath) {
    const rest = rawUrl.slice(basePath.length);
    // 不带尾斜杠访问 BASE_PATH 时补斜杠重定向，否则页面里的相对路径资源会丢失前缀
    if (rest === "" || rest.startsWith("?")) {
      res.writeHead(301, { Location: basePath + "/" + rest });
      res.end();
      return;
    }
    rawUrl = rest || "/";
  }
  const url = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      console.error("Unhandled API failure:", error);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { ok: false, message: "服务器内部错误。" });
          return;
        } catch {}
      }
      try { res.destroy(); } catch {}
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
    return;
  }

  if (url.pathname === publicLearningRouteStaticPath) {
    if (!publicLearningRouteJson) {
      send(res, 404, "Not found");
      return;
    }
    const headers = {
      "Cache-Control": "no-store, max-age=0, no-transform",
      "Content-Length": String(Buffer.byteLength(publicLearningRouteJson))
    };
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        ...headers
      });
      res.end();
      return;
    }
    send(res, 200, publicLearningRouteJson, "application/json; charset=utf-8", headers);
    return;
  }

  const filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    send(res, 403, "禁止访问");
    return;
  }
  if (isBlockedStaticResource(filePath)) {
    send(res, 410, "Full manifests are disabled. Use the lightweight index.json files.");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      send(res, 404, "Not found");
      return;
    }

    const type = types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const bridgeCourseware = isCoursewareHtml(filePath);
    if (!bridgeCourseware && (stat.size > maxBufferedStaticBytes || req.method === "HEAD")) {
      streamStaticFile(req, res, filePath, type, url, stat);
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        send(res, 404, "Not found");
        return;
      }

      const responseData = bridgeCourseware ? injectCoursewareBridge(data) : data;
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Type": type,
          ...staticHeaders(filePath, url, {
            "Content-Length": String(responseData.length)
          })
        });
        res.end();
        return;
      }

      if (shouldCompress(req, type, responseData.length)) {
        const cacheKey = gzipCacheKey(filePath, responseData);
        const cached = gzipCache.get(cacheKey);
        if (cached) {
          send(res, 200, cached, type, staticHeaders(filePath, url, {
            "Content-Encoding": "gzip",
            Vary: "Accept-Encoding"
          }));
          return;
        }
        zlib.gzip(responseData, (gzipError, compressed) => {
          if (gzipError) {
            send(res, 200, responseData, type, staticHeaders(filePath, url));
            return;
          }
          rememberGzip(cacheKey, compressed);
          send(res, 200, compressed, type, staticHeaders(filePath, url, {
            "Content-Encoding": "gzip",
            Vary: "Accept-Encoding"
          }));
        });
        return;
      }
      send(res, 200, responseData, type, staticHeaders(filePath, url));
    });
  });
});

function shutdown(signal) {
  console.log(`${signal} received. Saving database before shutdown...`);
  systemAnnouncementApi.closeStreams();
  try {
    db.saveNow();
  } catch (error) {
    console.error("Final database save failed:", error.message);
  }
  server.close(() => {
    db.releaseWriteLock();
    process.exit(0);
  });
  setTimeout(() => {
    db.releaseWriteLock();
    process.exit(0);
  }, 3000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

let emergencyExitStarted = false;

function emergencyExit(kind, error) {
  if (emergencyExitStarted) return;
  emergencyExitStarted = true;
  console.error(`${kind}:`, error);
  try {
    db.saveNow();
  } catch (saveError) {
    console.error("Emergency database save failed:", saveError.message);
  }
  try { db.releaseWriteLock(); } catch {}
  process.exit(1);
}

process.on("uncaughtException", (error) => emergencyExit("Uncaught exception", error));
process.on("unhandledRejection", (reason) => emergencyExit("Unhandled rejection", reason));

// Initialize database on startup, then start server
try {
  db.acquireWriteLock();
} catch (error) {
  console.error("Database writer lock failed:", error.message);
  process.exit(1);
}

db.getDb().then(() => {
 console.log("Database initialized.");
  systemAnnouncementApi.ensureSchema(db.getDbSync());
  db.saveNow();
  // Migration: fix existing is_correct bug where pending short answers (-1) were stored as 1
 try {
    const fixedCount = db.normalizeLegacyPendingShortAnswerFlags();
    if (fixedCount > 0) {
     db.saveNow();
      console.log(`Data migration: fixed ${fixedCount} short answer is_correct values.`);
   }
  } catch (e) {
   console.warn("Migration skipped:", e.message);
  }
  try {
    const restoredCount = db.normalizeReviewedShortAnswerFlags();
    if (restoredCount > 0) {
      db.saveNow();
      console.log(`Data migration: restored ${restoredCount} reviewed short answer flags.`);
    }
  } catch (e) {
    console.warn("Reviewed short answer flag migration skipped:", e.message);
  }
  try {
    const recoveredCount = db.normalizeFailedPendingQuizReviews();
    if (recoveredCount > 0) {
      db.saveNow();
      console.log(`Data migration: recovered ${recoveredCount} failed short answer reviews.`);
    }
  } catch (e) {
    console.warn("Failed short answer recovery migration skipped:", e.message);
  }
 server.listen(port, host, () => {
    console.log(`Calculus Quest running at http://${host}:${port}/`);
    console.log(`Admin dashboard: http://${host}:${port}/admin.html`);
  });
}).catch((err) => {
  db.releaseWriteLock();
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

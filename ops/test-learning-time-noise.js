const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const policy = require("../lib/active-time-policy");

function iso(ms) {
  return new Date(ms).toISOString();
}

function interaction(eventType, at, data = {}, sequenceIndex = 1) {
  return {
    id: `event-${sequenceIndex}-${eventType}`,
    user_id: "time-noise-user",
    type: "interaction",
    created_at: iso(at),
    payload: {
      eventType,
      sessionId: "time-noise-session",
      sequenceIndex,
      timing: { clientAt: iso(at) },
      data
    }
  };
}

function onlinePeriod(start, end, sequenceIndex) {
  return interaction(
    "online_period",
    end,
    {
      startedAt: iso(start),
      endedAt: iso(end),
      seconds: Math.round((end - start) / 1000)
    },
    sequenceIndex
  );
}

async function main() {
  const start = Date.parse("2026-08-18T00:00:00.000Z");
  assert.equal(policy.IDLE_TIMEOUT_MS, 5 * 60 * 1000);
  assert.equal(policy.isActivityEvent("ui_click"), true);
  assert.equal(policy.isActivityEvent("heartbeat"), false);
  assert.equal(policy.isActivityEvent("online_period"), false);
  assert.equal(
    policy.effectiveEndMs(start, start + 60 * 60 * 1000, start, policy.IDLE_TIMEOUT_MS),
    start + 5 * 60 * 1000
  );
  assert.equal(policy.isIdle(start + 5 * 60 * 1000, start, policy.IDLE_TIMEOUT_MS), true);
  assert.equal(policy.isIdle(start + 5 * 60 * 1000 - 1, start, policy.IDLE_TIMEOUT_MS), false);

  const rows = [
    interaction("session_start", start, {}, 1),
    onlinePeriod(start, start + 60 * 60 * 1000, 2),
    interaction("ui_click", start + 2 * 60 * 1000, {}, 3),
    interaction("ui_click", start + 20 * 60 * 1000, {}, 4),
    onlinePeriod(start + 15 * 60 * 1000, start + 30 * 60 * 1000, 5)
  ];
  const summary = policy.summarizeOnlinePeriods(rows);
  assert.equal(summary.rawTotalSeconds, 4500);
  assert.equal(summary.effectiveSeconds, 720, "only the two five-minute activity windows should count");
  assert.equal(summary.excludedIdleSeconds, 3780);
  assert.equal(summary.idleExcludedSegments, 2);

  const analyticsSource = fs.readFileSync(path.join(__dirname, "../app/main/analytics.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const policyScript = indexSource.indexOf("lib/active-time-policy.js");
  const analyticsScript = indexSource.indexOf("app/main/analytics.js");
  assert.ok(policyScript >= 0 && policyScript < analyticsScript, "active-time policy must load before analytics");
  assert.match(analyticsSource, /analyticsMarkActivity/);
  assert.match(analyticsSource, /idle_timeout/);
  assert.match(analyticsSource, /pageOpenSeconds: Math\.max\(0, Math\.round\(analyticsParticipantActiveMs/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-active-time-"));
  process.env.DB_PATH = path.join(tmpDir, "active-time.db");
  const db = require("../db");
  try {
    await db.getDb();
    db.upsertUser(
      "time-noise-user",
      "时长噪声测试",
      iso(start),
      iso(start)
    );
    rows.forEach((row) => db.insertEvent(row));
    const detail = db.userDetail("time-noise-user", {});
    assert.equal(detail.researchSummary.rawEstimatedOnlineSeconds, 4500);
    assert.equal(detail.researchSummary.estimatedOnlineSeconds, 720);
    assert.equal(detail.researchSummary.excludedIdleSeconds, 3780);
    assert.equal(detail.researchSummary.activeTimeIdleTimeoutMs, 5 * 60 * 1000);
    console.log("learning time noise tests passed");
  } finally {
    try { db.saveNow(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

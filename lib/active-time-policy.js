(function attachActiveTimePolicy(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CQActiveTimePolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createActiveTimePolicy() {
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const DEFAULT_TIMEOUT_MS = IDLE_TIMEOUT_MS;
  const passiveEventTypes = Object.freeze([
    "session_start",
    "session_end",
    "heartbeat",
    "online_period",
    "visibility",
    "view_change",
    "switch_view",
    "time_on_unit",
    "unit_leave",
    "leave_unit",
    "quiz_render",
    "slide_render",
    "knowledge_render",
    "interactive_render",
    "question_visible",
    "quiz_review_ready",
    "quiz_review_shown",
    "narration_complete",
    "narration_segment_end",
    "agentic_decision",
    "agentic_unlock",
    "agentic_extension_chapter_unlocked"
  ]);
  const passiveEventSet = new Set(passiveEventTypes);

  function numberOrNull(value) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function timestampMs(value) {
    if (value instanceof Date) return value.getTime();
    const number = numberOrNull(value);
    if (number !== null && number > 0) return number;
    if (!value) return null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function payloadObject(row) {
    if (!row) return {};
    if (typeof row === "object" && row.payload !== undefined) {
      if (typeof row.payload === "string") {
        try { return JSON.parse(row.payload || "{}"); } catch { return {}; }
      }
      return row.payload || {};
    }
    if (typeof row === "string") {
      try { return JSON.parse(row || "{}"); } catch { return {}; }
    }
    return row;
  }

  function eventType(event) {
    if (typeof event === "string") return event;
    const payload = payloadObject(event);
    const data = payload.data || {};
    return String(payload.eventType || data.eventType || event?.type || "");
  }

  function eventTimestamp(event) {
    const payload = payloadObject(event);
    return timestampMs(payload.timing?.clientAt)
      || timestampMs(event?.created_at)
      || timestampMs(event?.createdAt);
  }

  function sessionKey(event) {
    const payload = payloadObject(event);
    const userId = String(event?.user_id || payload.userId || "anonymous");
    const sessionId = String(payload.sessionId || payload.session_id || "legacy");
    return userId + "|" + sessionId;
  }

  function isActivityEvent(event) {
    const type = eventType(event);
    if (!type || type === "interaction" || passiveEventSet.has(type)) return false;
    return true;
  }

  function isIdle(nowMs, lastActivityMs, idleTimeoutMs) {
    const now = timestampMs(nowMs);
    const last = timestampMs(lastActivityMs);
    const timeout = numberOrNull(idleTimeoutMs) || DEFAULT_TIMEOUT_MS;
    return now === null || last === null || now - last >= timeout;
  }

  function effectiveEndMs(startMs, endMs, lastActivityMs, idleTimeoutMs) {
    const start = timestampMs(startMs);
    const end = timestampMs(endMs);
    if (start === null || end === null || end <= start) return start === null ? null : start;
    const timeout = numberOrNull(idleTimeoutMs) || DEFAULT_TIMEOUT_MS;
    const last = timestampMs(lastActivityMs);
    const activityLimit = last === null ? start + timeout : last + timeout;
    return Math.max(start, Math.min(end, activityLimit));
  }

  function mergeIntervals(intervals) {
    const sorted = intervals
      .filter((item) => Array.isArray(item) && item.length >= 2 && item[1] > item[0])
      .map((item) => [item[0], item[1]])
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged = [];
    sorted.forEach((interval) => {
      const previous = merged[merged.length - 1];
      if (!previous || interval[0] > previous[1]) merged.push(interval);
      else previous[1] = Math.max(previous[1], interval[1]);
    });
    return merged;
  }

  function intervalDurationMs(intervals) {
    return intervals.reduce((total, interval) => total + Math.max(0, interval[1] - interval[0]), 0);
  }

  function normalizePeriod(row) {
    const payload = payloadObject(row);
    const data = payload.data || {};
    const eventAt = eventTimestamp(row);
    const reportedSeconds = Math.max(
      0,
      Number(data.seconds || payload.timing?.durationMs / 1000 || 0)
    );
    let start = timestampMs(data.startedAt);
    let end = timestampMs(data.endedAt);
    const hasExplicitRange = start !== null && end !== null;
    if (start === null && end !== null && reportedSeconds > 0) start = end - reportedSeconds * 1000;
    if (end === null && start !== null && reportedSeconds > 0) end = start + reportedSeconds * 1000;
    if (start === null && eventAt !== null) start = eventAt - reportedSeconds * 1000;
    if (end === null && eventAt !== null) end = eventAt;
    if (start === null || end === null) return null;
    if (end < start) {
      const swap = start;
      start = end;
      end = swap;
    }
    const rawMs = hasExplicitRange
      ? Math.max(0, end - start)
      : Math.max(0, reportedSeconds * 1000, end - start);
    return {
      row,
      session: sessionKey(row),
      start,
      end: Math.max(end, start + rawMs),
      rawMs,
      rawSeconds: Math.round(rawMs / 1000),
      effectiveMs: 0,
      effectiveSeconds: 0
    };
  }

  function summarizeOnlinePeriods(rows, options = {}) {
    const timeout = numberOrNull(options.idleTimeoutMs) || DEFAULT_TIMEOUT_MS;
    const activityBySession = new Map();
    const periods = [];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const type = eventType(row);
      const session = sessionKey(row);
      const at = eventTimestamp(row);
      if (type === "online_period") {
        const period = normalizePeriod(row);
        if (period) periods.push(period);
      }
      if ((type === "session_start" || isActivityEvent(row)) && at !== null) {
        const list = activityBySession.get(session) || [];
        list.push(at);
        activityBySession.set(session, list);
      }
    });

    activityBySession.forEach((list, key) => {
      activityBySession.set(key, Array.from(new Set(list)).sort((left, right) => left - right));
    });
    periods.sort((left, right) => left.start - right.start || left.end - right.end);
    const intervalsBySession = new Map();
    const firstPeriodBySession = new Set();
    periods.forEach((period) => {
      const activities = activityBySession.get(period.session) || [];
      const localIntervals = [];
      activities.forEach((activityAt) => {
        const activeEnd = activityAt + timeout;
        if (activeEnd <= period.start || activityAt >= period.end) return;
        localIntervals.push([
          Math.max(period.start, activityAt),
          Math.min(period.end, activeEnd)
        ]);
      });
      if (!localIntervals.length && !activities.length && !firstPeriodBySession.has(period.session)) {
        firstPeriodBySession.add(period.session);
        localIntervals.push([
          period.start,
          Math.min(period.end, period.start + timeout)
        ]);
      }
      const mergedLocal = mergeIntervals(localIntervals);
      period.effectiveMs = intervalDurationMs(mergedLocal);
      period.effectiveSeconds = Math.round(period.effectiveMs / 1000);
      period.idleExcludedSeconds = Math.max(0, period.rawSeconds - period.effectiveSeconds);
      const sessionIntervals = intervalsBySession.get(period.session) || [];
      sessionIntervals.push(...mergedLocal);
      intervalsBySession.set(period.session, sessionIntervals);
    });

    let effectiveMs = 0;
    intervalsBySession.forEach((intervals) => {
      effectiveMs += intervalDurationMs(mergeIntervals(intervals));
    });
    const rawTotalSeconds = periods.reduce((total, period) => total + period.rawSeconds, 0);
    const effectiveSeconds = Math.round(effectiveMs / 1000);
    return {
      idleTimeoutMs: timeout,
      periods,
      rawTotalSeconds,
      effectiveSeconds,
      excludedIdleSeconds: Math.max(0, rawTotalSeconds - effectiveSeconds),
      idleExcludedSegments: periods.filter((period) => period.idleExcludedSeconds > 0).length,
      countedSegments: periods.filter((period) => period.effectiveSeconds > 0).length
    };
  }

  return {
    IDLE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    passiveEventTypes,
    eventType,
    eventTimestamp,
    isActivityEvent,
    isIdle,
    effectiveEndMs,
    mergeIntervals,
    summarizeOnlinePeriods
  };
});

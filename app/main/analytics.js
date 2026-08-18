// Unified analytics collection for navigation, learning paths, quizzes, and iframe interactions.
const ANALYTICS_SESSION_KEY = "calculus-quest-analytics-session-v1";
const ANALYTICS_SESSION_OWNER_KEY = "calculus-quest-analytics-session-owner-v1";
const ANALYTICS_SEQUENCE_KEY = "cq_analytics_sequence";
const analyticsQueue = [];
const analyticsInFlightGroups = new Map();
const analyticsOnlinePeriodFlushMs = 5 * 60 * 1000;
const analyticsMinOnlinePeriodSeconds = 60;
const analyticsMinUnitSeconds = 5;
const analyticsActiveTimePolicy = typeof CQActiveTimePolicy !== "undefined" ? CQActiveTimePolicy : null;
const analyticsIdleTimeoutMs = Number(analyticsActiveTimePolicy?.IDLE_TIMEOUT_MS || 5 * 60 * 1000);
const analyticsMaxDeliveryAttempts = 3;
const analyticsRetryDelayMs = 5000;
let analyticsFlushTimer = null;
let analyticsFlushChain = Promise.resolve();
let analyticsSequence = 0;
let analyticsTrackingReady = false;
let analyticsViewTimer = null;
let analyticsHeartbeat = null;
let analyticsOnlinePeriodStart = null;
let analyticsActiveUnit = null;
let analyticsUnitStart = null;
let analyticsLastEventAt = Date.now();
let analyticsLastActiveAt = Date.now();
let analyticsLastTrackedView = "";
let analyticsCoachRefreshTimer = null;
let analyticsCoachLastRefreshAt = 0;
let analyticsParticipantSessionStartedAt = 0;
let analyticsParticipantActiveMs = 0;
let analyticsParticipantSessionActive = false;
let analyticsDeliverySequence = 0;
let analyticsResearchContext = {
  appVersion: "",
  courseVersion: "",
  experimentId: "",
  condition: "",
  cohort: ""
};

function analyticsIsIdle(now = Date.now()) {
  if (analyticsActiveTimePolicy?.isIdle) {
    return analyticsActiveTimePolicy.isIdle(now, analyticsLastActiveAt, analyticsIdleTimeoutMs);
  }
  return now - analyticsLastActiveAt >= analyticsIdleTimeoutMs;
}

function analyticsEffectiveEnd(startMs, endMs = Date.now()) {
  if (analyticsActiveTimePolicy?.effectiveEndMs) {
    return analyticsActiveTimePolicy.effectiveEndMs(
      startMs,
      endMs,
      analyticsLastActiveAt,
      analyticsIdleTimeoutMs
    );
  }
  return Math.max(
    startMs,
    Math.min(endMs, analyticsLastActiveAt + analyticsIdleTimeoutMs)
  );
}

function analyticsEventCountsAsActivity(eventType) {
  if (analyticsActiveTimePolicy?.isActivityEvent) {
    return analyticsActiveTimePolicy.isActivityEvent(eventType);
  }
  return ![
    "session_start",
    "session_end",
    "heartbeat",
    "online_period",
    "visibility",
    "view_change",
    "switch_view",
    "time_on_unit",
    "unit_leave",
    "leave_unit"
  ].includes(String(eventType || ""));
}

fetch("api/research/config")
  .then((response) => response.ok ? response.json() : null)
  .then((payload) => {
    if (payload?.ok && payload.data) {
      analyticsResearchContext = {
        ...analyticsResearchContext,
        ...payload.data
      };
    }
  })
  .catch(() => {});

const analyticsCoachEvidenceEvents = new Set([
  "quiz_answer_revealed",
  "short_answer_input",
  "answer_select",
  "question_visible",
  "time_on_unit",
  "resource_fullscreen",
  "ui_wheel",
  "ui_input",
  "parameter_commit",
  "parameter_change",
  "interactive_click",
  "interactive_input",
  "interactive_change",
  "interactive_drag_end",
  "interactive_scroll",
  "interactive_wheel",
  "narration_play_click",
  "narration_pause_click",
  "narration_seek"
]);

function analyticsParticipantScope() {
  if (typeof isSignedIn === "function" && isSignedIn()) {
    return `participant:${state.participant.participantId}`;
  }
  return "guest";
}

function syncAnalyticsSessionScope() {
  const nextScope = analyticsParticipantScope();
  const storedScope = sessionStorage.getItem(ANALYTICS_SESSION_OWNER_KEY) || "";
  if (storedScope !== nextScope) {
    sessionStorage.removeItem(ANALYTICS_SESSION_KEY);
    sessionStorage.setItem(ANALYTICS_SESSION_OWNER_KEY, nextScope);
    sessionStorage.setItem(ANALYTICS_SEQUENCE_KEY, "0");
    analyticsSequence = 0;
    return;
  }
  analyticsSequence = Number(sessionStorage.getItem(ANALYTICS_SEQUENCE_KEY) || 0);
}

function analyticsSessionId() {
  let id = sessionStorage.getItem(ANALYTICS_SESSION_KEY);
  if (!id) {
    id = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(ANALYTICS_SESSION_KEY, id);
  }
  return id;
}

syncAnalyticsSessionScope();
window.addEventListener("cq:participant-change", (event) => {
  syncAnalyticsSessionScope();
  if (!event.detail?.participantId) analyticsResetParticipantSession();
});

function ensureAnalyticsState() {
  state.analytics = state.analytics || {};
  state.analytics.visitedUnits = state.analytics.visitedUnits || {};
  state.analytics.path = state.analytics.path || [];
  state.analytics.repeats = state.analytics.repeats || {};
  state.analytics.skips = state.analytics.skips || [];
  state.analytics.interactionEvidence = state.analytics.interactionEvidence || {};
  return state.analytics;
}

function analyticsEvidenceBucket(unitId, event = {}) {
  if (!unitId) return null;
  const analytics = ensureAnalyticsState();
  const bucket = analytics.interactionEvidence[unitId] || {
    unitId,
    chapterId: event.chapterId || "",
    unitType: event.unitType || "",
    moduleRole: event.moduleRole || "",
    events: 0,
    dwellMs: 0,
    repeatCount: 0,
    answerRevealCount: 0,
    questionVisibleCount: 0,
    choiceChangeCount: 0,
    shortAnswerLength: 0,
    resourceFullscreenCount: 0,
    narrationPlayCount: 0,
    narrationPauseCount: 0,
    narrationSeekCount: 0,
    uiWheelCount: 0,
    uiInputCount: 0,
    parameterChangeCount: 0,
    experiencedSceneTypes: [],
    firstAt: event.timing?.clientAt || new Date().toISOString(),
    lastAt: ""
  };
  bucket.chapterId = bucket.chapterId || event.chapterId || "";
  bucket.unitType = bucket.unitType || event.unitType || "";
  bucket.moduleRole = bucket.moduleRole || event.moduleRole || "";
  analytics.interactionEvidence[unitId] = bucket;
  return bucket;
}

function analyticsRememberInteractionEvidence(event) {
  const unitId = event?.unitId || event?.data?.unitId || "";
  const bucket = analyticsEvidenceBucket(unitId, event);
  if (!bucket) return;
  const type = event.eventType || "";
  bucket.events += 1;
  bucket.repeatCount = Math.max(bucket.repeatCount || 0, state.analytics?.visitedUnits?.[unitId] || 0);
  bucket.lastAt = event.timing?.clientAt || new Date().toISOString();
  if (type === "time_on_unit") {
    bucket.dwellMs += Math.max(
      Number(event.timing?.durationMs || 0),
      Math.max(0, Number(event.data?.seconds || 0)) * 1000
    );
  }
  if (type === "quiz_answer_revealed") bucket.answerRevealCount += 1;
  if (type === "question_visible") bucket.questionVisibleCount += 1;
  if (type === "answer_select") bucket.choiceChangeCount += 1;
  if (type === "short_answer_input") bucket.shortAnswerLength = Math.max(bucket.shortAnswerLength || 0, Number(event.data?.length || 0));
  if (type === "resource_fullscreen") bucket.resourceFullscreenCount += 1;
  if (["narration_play_click", "narration_resume", "narration_segment_play"].includes(type)) bucket.narrationPlayCount += 1;
  if (["narration_pause_click", "narration_pause", "narration_stop_click", "narration_stop"].includes(type)) bucket.narrationPauseCount += 1;
  if (["narration_seek", "narration_seek_input"].includes(type)) bucket.narrationSeekCount += 1;
  if (["ui_wheel", "interactive_wheel", "interactive_scroll"].includes(type)) bucket.uiWheelCount += 1;
  if (["ui_input", "interactive_input", "interactive_change"].includes(type)) bucket.uiInputCount += 1;
  if (["parameter_commit", "parameter_change"].includes(type)) bucket.parameterChangeCount += 1;
  const sceneType = event.sceneType || event.data?.sceneType || event.data?.selectedSceneType || "";
  if (
    sceneType
    && [
      "time_on_unit",
      "resource_fullscreen",
      "ui_wheel",
      "interactive_wheel",
      "interactive_scroll",
      "ui_input",
      "interactive_input",
      "interactive_change",
      "parameter_commit",
      "parameter_change"
    ].includes(type)
  ) {
    bucket.experiencedSceneTypes = Array.from(new Set([
      ...(bucket.experiencedSceneTypes || []),
      sceneType
    ]));
  }
}

function analyticsScheduleCoachEvidenceRefresh(event) {
  if (!event || !analyticsCoachEvidenceEvents.has(event.eventType || "")) return;
  if (typeof renderAgenticCoachPanel !== "function") return;
  if (event.unitId && event.unitId !== currentUnitId) return;
  if (currentAnalyticsView() !== "learn") return;
  if (typeof agenticIsCurrentPending === "function" && agenticIsCurrentPending(currentUnitId)) return;

  const now = Date.now();
  const elapsed = now - analyticsCoachLastRefreshAt;
  const delay = elapsed > 2500 ? 350 : 2500 - elapsed;
  clearTimeout(analyticsCoachRefreshTimer);
  analyticsCoachRefreshTimer = setTimeout(() => {
    analyticsCoachRefreshTimer = null;
    if (currentAnalyticsView() !== "learn") return;
    if (typeof agenticIsCurrentPending === "function" && agenticIsCurrentPending(currentUnitId)) return;
    analyticsCoachLastRefreshAt = Date.now();
    renderAgenticCoachPanel();
  }, delay);
}

function currentAnalyticsView() {
  return document.querySelector(".view.active")?.id?.replace(/-view$/, "") || currentView || "";
}

function currentAnalyticsUnit() {
  return getUnit?.(currentUnitId) || null;
}

function moduleRoleForUnit(unit) {
  if (!unit) return "";
  if (unit.type === "quiz") {
    if (unit.assessmentPhase === "pre") return "pretest";
    if (unit.assessmentPhase === "post") return "posttest";
    return "formative_quiz";
  }
  const title = String(unit.label || "");
  if (/知识地图|学习路线|概念地图/.test(title)) return "concept_map";
  if (/公式|桥梁|代数/.test(title)) return "formula_bridge";
  if (/复盘|总结|回顾/.test(title)) return "review";
  if (unit.type === "knowledge") return "knowledge_point";
  if (unit.type === "interactive") return "experiment";
  if (unit.type === "slide") return "instruction";
  return unit.type || "";
}

function analyticsKnowledgeSceneMeta(unit) {
  if (!unit || unit.type !== "knowledge") {
    return { sceneType: "", sceneLabel: "", resourceTitle: "" };
  }
  const types = typeof knowledgeInteractionTypes === "function" ? knowledgeInteractionTypes(unit) : [];
  const selectedType = state.selectedKnowledgeScenes?.[unit.id] || "";
  const selected = types.find((type) => type.id === selectedType);
  if (!selected) {
    return {
      sceneType: "",
      sceneLabel: "互动场景未选择",
      resourceTitle: ""
    };
  }
  const candidate = typeof knowledgeResourceCandidate === "function"
    ? knowledgeResourceCandidate(unit, selectedType)
    : null;
  return {
    sceneType: selectedType,
    sceneLabel: typeof knowledgeSceneDisplayLabel === "function"
      ? knowledgeSceneDisplayLabel(selected)
      : selected.title || selected.label || selectedType,
    resourceTitle: candidate?.title || ""
  };
}

function analyticsUnitMeta(unit = currentAnalyticsUnit()) {
  if (!unit) {
    return {
      view: currentAnalyticsView(),
      chapterId: currentChapterId || "",
      chapterLabel: getChapter?.(currentChapterId)?.label || "",
      unitId: currentUnitId || "",
      unitLabel: "",
      unitType: "",
      moduleRole: "",
      sceneType: "",
      sceneLabel: "",
      resourceTitle: ""
    };
  }
  const chapter = getChapter?.(unit.chapterId);
  return {
    view: currentAnalyticsView(),
    chapterId: unit.chapterId || "",
    chapterLabel: chapter?.label || unit.chapterLabel || "",
    unitId: unit.id || "",
    unitLabel: unit.label || "",
    unitType: unit.type || unit.kind || "",
    moduleRole: moduleRoleForUnit(unit),
    ...analyticsKnowledgeSceneMeta(unit)
  };
}

function compactAnalyticsText(value = "", limit = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function analyticsElementTarget(element, event) {
  if (!element) return null;
  const rect = element.getBoundingClientRect?.();
  const point =
    rect && event && typeof event.clientX === "number"
      ? {
          x: Math.round(event.clientX - rect.left),
          y: Math.round(event.clientY - rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      : null;
  return {
    tag: element.tagName?.toLowerCase() || "",
    id: element.id || "",
    className: compactAnalyticsText(element.className || "", 80),
    role: element.getAttribute?.("role") || "",
    label: compactAnalyticsText(
      element.getAttribute?.("aria-label") ||
        element.getAttribute?.("title") ||
        element.textContent ||
        element.value ||
        element.getAttribute?.("name") ||
        element.id ||
        ""
    ),
    dataset: {
      view: element.dataset?.view || "",
      chapter: element.dataset?.chapter || "",
      unit: element.dataset?.unit || "",
      jumpUnit: element.dataset?.jumpUnit || ""
    },
    point
  };
}

function analyticsControlValue(element) {
  if (!element) return null;
  const tag = element.tagName?.toLowerCase() || "";
  const type = String(element.getAttribute?.("type") || "").toLowerCase();
  const isEditable = element.isContentEditable || element.matches?.("[contenteditable='true']");
  if (type === "password") {
    return { inputType: type, valueSummary: element.value ? "已输入" : "空", textLength: element.value?.length || 0 };
  }
  if (type === "checkbox" || type === "radio") {
    return { inputType: type, valueSummary: element.checked ? "选中" : "未选中", checked: Boolean(element.checked) };
  }
  if (tag === "select") {
    return {
      inputType: "select",
      valueSummary: compactAnalyticsText(element.selectedOptions?.[0]?.textContent || element.value || "", 80)
    };
  }
  if (["range", "number", "color", "date", "time", "month", "week"].includes(type)) {
    return { inputType: type, valueSummary: compactAnalyticsText(element.value || "", 80), value: element.value || "" };
  }
  if (tag === "textarea" || isEditable || ["text", "search", "email", "url", "tel"].includes(type)) {
    const text = isEditable ? element.textContent || "" : element.value || "";
    return { inputType: type || tag || "text", valueSummary: `已输入 ${text.length} 个字符`, textLength: text.length };
  }
  if ("value" in element) {
    return { inputType: type || tag, valueSummary: compactAnalyticsText(element.value || "", 80), value: element.value || "" };
  }
  return null;
}

function analyticsControlData(element, event) {
  const valueInfo = analyticsControlValue(element);
  return {
    text: compactAnalyticsText(element?.textContent || element?.getAttribute?.("aria-label") || element?.getAttribute?.("title") || "", 80),
    label: compactAnalyticsText(
      element?.getAttribute?.("aria-label") ||
        element?.getAttribute?.("title") ||
        element?.textContent ||
        element?.getAttribute?.("name") ||
        element?.id ||
        "",
      80
    ),
    name: element?.getAttribute?.("name") || "",
    id: element?.id || "",
    tag: element?.tagName?.toLowerCase() || "",
    role: element?.getAttribute?.("role") || "",
    inputType: valueInfo?.inputType || element?.getAttribute?.("type") || "",
    valueSummary: valueInfo?.valueSummary || "",
    textLength: valueInfo?.textLength || 0,
    checked: valueInfo?.checked,
    view: element?.dataset?.view || "",
    chapter: element?.dataset?.chapter || "",
    unit: element?.dataset?.unit || element?.dataset?.jumpUnit || "",
    key: event?.key || "",
    code: event?.code || "",
    deltaX: typeof event?.deltaX === "number" ? Math.round(event.deltaX) : undefined,
    deltaY: typeof event?.deltaY === "number" ? Math.round(event.deltaY) : undefined
  };
}

function analyticsTrack(eventType, payload = {}) {
  if (
    !isSignedIn()
    || (
      typeof authTransitionInProgress !== "undefined"
      && authTransitionInProgress
      && payload.allowDuringAuthTransition !== true
    )
  ) return;
  const persist = payload.persist !== false;
  const now = Date.now();
  if (analyticsEventCountsAsActivity(eventType)) analyticsMarkActivity(now);
  const unit = payload.unitId ? getUnit?.(payload.unitId) : currentAnalyticsUnit();
  const meta = analyticsUnitMeta(unit);
  const sequenceIndex = ++analyticsSequence;
  sessionStorage.setItem(ANALYTICS_SEQUENCE_KEY, String(analyticsSequence));
  const sinceLastEventMs = now - analyticsLastEventAt;
  analyticsLastEventAt = now;

  const event = {
    schemaVersion: 1,
    sessionId: analyticsSessionId(),
    sequenceIndex,
    eventType,
    source: payload.source || "main",
    research: { ...analyticsResearchContext },
    ...meta,
    target: payload.target || null,
    value: payload.value || null,
    timing: {
      clientAt: new Date(now).toISOString(),
      sinceLastEventMs,
      sinceUnitEnterMs: analyticsUnitStart ? now - analyticsUnitStart : 0,
      durationMs: payload.durationMs || 0,
      activeMs: payload.activeMs || 0,
      visibleMs: payload.visibleMs || 0,
      ...(payload.timing || {})
    },
    context: {
      completedBefore: unit?.id ? state.completed.includes(unit.id) : false,
      isRepeatVisit: unit?.id ? Boolean((state.analytics?.visitedUnits || {})[unit.id]) : false,
      pathIndex: state.analytics?.path?.length || 0,
      ...(payload.context || {})
    },
    data: payload.data || {}
  };
  event.eventId = `${event.sessionId}:${sequenceIndex}`;
  if (eventType === "switch_view" && event.data?.to) {
    analyticsLastTrackedView = String(event.data.to);
  }

  analyticsRememberInteractionEvidence(event);
  analyticsScheduleCoachEvidenceRefresh(event);
  window.dispatchEvent(new CustomEvent("cq:learning-signal", {
    detail: { event }
  }));
  if (!persist) return;
  analyticsQueue.push({
    token: state.authToken,
    participantId: state.participant?.participantId || "",
    attempts: 0,
    event
  });
  if (analyticsQueue.length >= 50) analyticsFlush();
  else if (!analyticsFlushTimer) analyticsFlushTimer = setTimeout(analyticsFlush, 5000);
}

function analyticsEnvironment() {
  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches || false;
  return {
    deviceType: width < 700 ? "手机" : width < 1100 ? "平板/小屏电脑" : "桌面电脑",
    viewport: { width, height },
    screen: {
      width: window.screen?.width || 0,
      height: window.screen?.height || 0
    },
    pixelRatio: Number(window.devicePixelRatio || 1),
    language: navigator.language || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    touch: Number(navigator.maxTouchPoints || 0) > 0 || coarsePointer,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false,
    connection: navigator.connection?.effectiveType || "",
    referrerHost: (() => {
      try { return document.referrer ? new URL(document.referrer).host : ""; } catch { return ""; }
    })()
  };
}

function trackInteraction(eventType, data = {}) {
  analyticsTrack(eventType, {
    persist: data.persist,
    source: data.source || "main",
    target: data.target || null,
    value: data.value || null,
    timing: data.timing || {},
    context: data.context || {},
    data
  });
}

function analyticsBatchGroups(batch = []) {
  const groups = new Map();
  batch.forEach((entry) => {
    const token = String(entry?.token || "");
    if (!token || !entry?.event) return;
    const participantId = String(entry.participantId || "");
    const key = `${participantId}\n${token}`;
    if (!groups.has(key)) groups.set(key, { token, participantId, entries: [], events: [] });
    groups.get(key).entries.push(entry);
    groups.get(key).events.push(entry.event);
  });
  return Array.from(groups.values());
}

function analyticsDeliveryRetryable(error = {}) {
  const status = Number(error.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

function analyticsRequeueFailedGroup(group, error) {
  if (!analyticsDeliveryRetryable(error)) return;
  const retryEntries = (group.entries || [])
    .map((entry) => ({ ...entry, attempts: Number(entry.attempts || 0) + 1 }))
    .filter((entry) => entry.attempts < analyticsMaxDeliveryAttempts);
  if (!retryEntries.length) return;
  analyticsQueue.unshift(...retryEntries);
  const retryAfterMs = Math.max(0, Number(error.retryAfterSeconds || 0) * 1000);
  const delayMs = Math.max(analyticsRetryDelayMs, retryAfterMs) + Math.round(Math.random() * 750);
  if (!analyticsFlushTimer) analyticsFlushTimer = setTimeout(analyticsFlush, delayMs);
}

function analyticsFlush() {
  clearTimeout(analyticsFlushTimer);
  analyticsFlushTimer = null;
  if (!analyticsQueue.length) return analyticsFlushChain;
  const batch = analyticsQueue.splice(0);
  const groups = analyticsBatchGroups(batch);
  const flushGroups = async () => {
    for (const group of groups) {
      const deliveryId = ++analyticsDeliverySequence;
      analyticsInFlightGroups.set(deliveryId, group);
      try {
        await apiRequest("api/learning/events", {
          token: group.token,
          events: group.events.map((event) => ({
            eventId: event.eventId,
            type: "interaction",
            payload: event
          }))
        }, { timeoutMs: 10000 });
      } catch (error) {
        analyticsRequeueFailedGroup(group, error);
      } finally {
        analyticsInFlightGroups.delete(deliveryId);
      }
    }
  };
  analyticsFlushChain = analyticsFlushChain.then(flushGroups, flushGroups);
  return analyticsFlushChain;
}

async function analyticsFlushUntilSettled(maxWaitMs = 20000) {
  const deadline = Date.now() + Math.max(1000, Number(maxWaitMs || 0));
  do {
    clearTimeout(analyticsFlushTimer);
    analyticsFlushTimer = null;
    await analyticsFlush();
    if (!analyticsQueue.length && !analyticsInFlightGroups.size) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  } while (Date.now() < deadline);
  return !analyticsQueue.length && !analyticsInFlightGroups.size;
}

function analyticsFlushBeforeUnload() {
  clearTimeout(analyticsFlushTimer);
  analyticsFlushTimer = null;
  const pending = [
    ...analyticsQueue.splice(0),
    ...Array.from(analyticsInFlightGroups.values()).flatMap((group) => group.entries || [])
  ];
  if (!pending.length) return;
  const seen = new Set();
  const batch = pending.filter((entry) => {
    const key = [
      entry?.participantId || "",
      entry?.token || "",
      entry?.event?.eventId || ""
    ].join("\n");
    if (!entry?.event || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  analyticsBatchGroups(batch).forEach((group) => {
    const body = JSON.stringify({
      token: group.token,
      events: group.events.map((event) => ({
        eventId: event.eventId,
        type: "interaction",
        payload: event
      }))
    });

    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("api/learning/events", blob)) return;
    }

    fetch("api/learning/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true
    }).catch(() => {});
  });
}

function analyticsRecordPath(unit, reason = "open") {
  if (!unit) return;
  const analytics = ensureAnalyticsState();
  const visitCount = (analytics.visitedUnits[unit.id] || 0) + 1;
  analytics.visitedUnits[unit.id] = visitCount;
  if (visitCount > 1) analytics.repeats[unit.id] = visitCount;
  analytics.path.push({
    unitId: unit.id,
    chapterId: unit.chapterId,
    unitType: unit.type,
    moduleRole: moduleRoleForUnit(unit),
    reason,
    at: beijingNow()
  });
  analytics.path = analytics.path.slice(-500);
}

function analyticsDetectSkips(prevUnit, nextUnit) {
  if (!prevUnit || !nextUnit || prevUnit.id === nextUnit.id) return;
  const analytics = ensureAnalyticsState();
  if (prevUnit.chapterId === nextUnit.chapterId) {
    const chapter = getChapter(prevUnit.chapterId);
    const units = chapter?.units || [];
    const from = units.findIndex((item) => item.id === prevUnit.id);
    const to = units.findIndex((item) => item.id === nextUnit.id);
    if (from >= 0 && to > from + 1) {
      const skippedUnitIds = units.slice(from + 1, to).filter((item) => !state.completed.includes(item.id)).map((item) => item.id);
      if (skippedUnitIds.length) {
        const record = { fromUnitId: prevUnit.id, toUnitId: nextUnit.id, skippedUnitIds, at: beijingNow() };
        analytics.skips.push(record);
        analyticsTrack("skip_units", { context: record, data: record });
      }
    }
    return;
  }

  const fromChapter = curriculum.findIndex((item) => item.id === prevUnit.chapterId);
  const toChapter = curriculum.findIndex((item) => item.id === nextUnit.chapterId);
  if (fromChapter >= 0 && toChapter > fromChapter + 1) {
    const skippedChapterIds = curriculum.slice(fromChapter + 1, toChapter).map((item) => item.id);
    const record = { fromChapterId: prevUnit.chapterId, toChapterId: nextUnit.chapterId, skippedChapterIds, at: beijingNow() };
    analytics.skips.push(record);
    analyticsTrack("skip_chapters", { context: record, data: record });
  }
}

function analyticsEnterUnit(unit, reason = "open") {
  if (!unit) return;
  const prevUnit = analyticsActiveUnit ? getUnit?.(analyticsActiveUnit) : null;
  if (analyticsActiveUnit && analyticsActiveUnit !== unit.id) analyticsLeaveUnit("switch_unit");
  analyticsDetectSkips(prevUnit, unit);
  analyticsRecordPath(unit, reason);
  const repeatCount = state.analytics?.visitedUnits?.[unit.id] || 1;
  analyticsActiveUnit = unit.id;
  analyticsUnitStart = analyticsParticipantSessionActive && !document.hidden && !analyticsIsIdle()
    ? Date.now()
    : null;
  analyticsTrack(repeatCount > 1 || state.completed.includes(unit.id) ? "repeat_unit_enter" : "unit_enter", {
    data: {
      reason,
      repeatCount,
      completedBefore: state.completed.includes(unit.id)
    }
  });
}

function analyticsLeaveUnit(reason = "leave", options = {}) {
  const unitId = analyticsActiveUnit;
  const start = analyticsUnitStart;
  const end = Number(options.endMs || Date.now());
  if (unitId && start) {
    const effectiveEnd = analyticsEffectiveEnd(start, end);
    const seconds = Math.max(0, Math.round((effectiveEnd - start) / 1000));
    if (seconds >= analyticsMinUnitSeconds) {
      analyticsTrack("time_on_unit", {
        allowDuringAuthTransition: options.allowDuringAuthTransition === true,
        unitId,
        durationMs: seconds * 1000,
        data: {
          unitId,
          seconds,
          reason,
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(effectiveEnd).toISOString(),
          idleTimeoutMs: analyticsIdleTimeoutMs,
          effective: true
        }
      });
    }
  }
  analyticsUnitStart = null;
  if (options.keepActiveUnit !== true) analyticsActiveUnit = null;
}

function analyticsResumeUnitTimer(unit) {
  if (
    !unit
    || !isSignedIn()
    || document.hidden
    || currentAnalyticsView() !== "learn"
    || currentUnitId !== unit.id
  ) {
    return;
  }
  if (analyticsIsIdle()) return;
  analyticsActiveUnit = unit.id;
  analyticsUnitStart = Date.now();
}

function analyticsTrackTarget(eventType, element, event, extra = {}) {
  analyticsTrack(eventType, {
    ...extra,
    target: analyticsElementTarget(element, event)
  });
}

function analyticsTrackOnlinePeriod(reason = "interval", options = {}) {
  if (!isSignedIn() || !analyticsOnlinePeriodStart) return;
  const start = analyticsOnlinePeriodStart;
  const now = Number(options.endMs || Date.now());
  const effectiveEnd = analyticsEffectiveEnd(start, now);
  const activeMs = Math.max(0, effectiveEnd - start);
  const seconds = Math.round(activeMs / 1000);
  analyticsParticipantActiveMs += activeMs;
  if (seconds >= analyticsMinOnlinePeriodSeconds) {
    analyticsTrack("online_period", {
      allowDuringAuthTransition: options.allowDuringAuthTransition === true,
      data: {
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(effectiveEnd).toISOString(),
        seconds,
        view: currentAnalyticsView(),
        unitId: currentAnalyticsUnit()?.id || currentUnitId || "",
        reason,
        idleTimeoutMs: analyticsIdleTimeoutMs,
        effective: true
      },
      durationMs: seconds * 1000
    });
  }
  analyticsOnlinePeriodStart = options.forcePause === true || document.hidden || analyticsIsIdle(now)
    ? null
    : now;
}

function analyticsMarkActivity(now = Date.now()) {
  const wasIdle = analyticsIsIdle(now);
  if (analyticsParticipantSessionActive && wasIdle) {
    const idleEnd = analyticsLastActiveAt + analyticsIdleTimeoutMs;
    analyticsLeaveUnit("idle_timeout", { endMs: idleEnd, keepActiveUnit: true });
    analyticsTrackOnlinePeriod("idle_timeout", {
      endMs: idleEnd,
      forcePause: true,
      allowDuringAuthTransition: true
    });
  }
  analyticsLastActiveAt = now;
  if (!analyticsParticipantSessionActive || document.hidden) return;
  if (!analyticsOnlinePeriodStart) analyticsOnlinePeriodStart = now;
  if (
    analyticsActiveUnit
    && !analyticsUnitStart
    && currentAnalyticsView() === "learn"
    && currentUnitId === analyticsActiveUnit
  ) {
    analyticsUnitStart = now;
  }
}

function analyticsResetParticipantSession() {
  analyticsParticipantSessionActive = false;
  analyticsParticipantSessionStartedAt = 0;
  analyticsParticipantActiveMs = 0;
  analyticsOnlinePeriodStart = null;
  analyticsActiveUnit = null;
  analyticsUnitStart = null;
  analyticsLastEventAt = Date.now();
  analyticsLastActiveAt = analyticsLastEventAt;
  analyticsLastTrackedView = "";
  clearTimeout(analyticsCoachRefreshTimer);
  analyticsCoachRefreshTimer = null;
  analyticsCoachLastRefreshAt = 0;
}

function analyticsBeginParticipantSession() {
  if (!isSignedIn() || analyticsParticipantSessionActive) return false;
  syncAnalyticsSessionScope();
  const now = Date.now();
  analyticsParticipantSessionActive = true;
  analyticsParticipantSessionStartedAt = now;
  analyticsParticipantActiveMs = 0;
  analyticsOnlinePeriodStart = document.hidden ? null : now;
  analyticsLastEventAt = now;
  analyticsLastActiveAt = now;
  analyticsLastTrackedView = currentAnalyticsView();
  analyticsTrack("session_start", {
    source: "system",
    data: {
      environment: analyticsEnvironment()
    }
  });
  return true;
}

function analyticsEndParticipantSession(reason = "logout") {
  if (!analyticsParticipantSessionActive || !isSignedIn()) {
    analyticsResetParticipantSession();
    return false;
  }
  analyticsLeaveUnit(reason, { allowDuringAuthTransition: true });
  analyticsTrackOnlinePeriod(reason, { allowDuringAuthTransition: true });
  analyticsTrack("session_end", {
    source: "system",
    allowDuringAuthTransition: true,
    data: {
      reason,
      pageOpenSeconds: Math.max(0, Math.round(analyticsParticipantActiveMs / 1000)),
      idleTimeoutMs: analyticsIdleTimeoutMs,
      effective: true
    }
  });
  analyticsResetParticipantSession();
  return true;
}

function setupInteractionTracking() {
  if (!isSignedIn()) return;
  analyticsBeginParticipantSession();
  if (analyticsTrackingReady) return;
  analyticsTrackingReady = true;

  const uiActionSelector = [
    "button",
    "a",
    "input",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='tab']",
    "[role='switch']",
    "[role='menuitem']",
    "[contenteditable='true']",
    "[data-view]",
    "[data-unit]",
    "[data-chapter]",
    "[data-jump-unit]",
    "[data-agentic-action]",
    "[data-filter]",
    "[data-submit-quiz]",
    "[data-resource-fullscreen]",
    "[data-play-narration]",
    "[data-pause-narration]",
    "[data-stop-narration]",
    "[data-toggle-narration]"
  ].join(",");
  const semanticClickSelector = [
    "[data-view]",
    "[data-unit]",
    "[data-chapter]",
    "[data-jump-unit]",
    ".chapter-card",
    ".lesson-card",
    ".nav-button"
  ].join(",");
  const uiInputSelector = "input, select, textarea, [contenteditable='true']";

  document.addEventListener("click", (event) => {
    const el = event.target.closest(semanticClickSelector);
    if (!el) return;
    analyticsTrackTarget("click", el, event, {
      data: {
        text: compactAnalyticsText(el.textContent || "", 60),
        view: el.dataset.view || "",
        chapter: el.dataset.chapter || "",
        unit: el.dataset.unit || el.dataset.jumpUnit || ""
      }
    });
  });

  document.addEventListener(
    "click",
    (event) => {
      if (event.target.closest(semanticClickSelector)) return;
      const el = event.target.closest(uiActionSelector);
      if (!el) return;
      analyticsTrackTarget("ui_click", el, event, {
        data: analyticsControlData(el, event)
      });
    },
    true
  );

  document.addEventListener(
    "change",
    (event) => {
      const el = event.target.closest(uiInputSelector);
      if (!el) return;
      const valueInfo = analyticsControlValue(el);
      analyticsTrackTarget("ui_change", el, event, {
        value: valueInfo,
        data: analyticsControlData(el, event)
      });
    },
    true
  );

  clearInterval(analyticsViewTimer);
  analyticsViewTimer = setInterval(() => {
    const active = currentAnalyticsView();
    if (active && active !== analyticsLastTrackedView) {
      analyticsTrack("view_change", { data: { view: active, prev: analyticsLastTrackedView } });
      analyticsLastTrackedView = active;
    }
  }, 500);

  ["pointerdown", "keydown", "input", "change", "scroll", "wheel", "touchstart"].forEach((type) => {
    document.addEventListener(type, () => {
      analyticsMarkActivity();
    }, { passive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      analyticsLeaveUnit("hidden", { keepActiveUnit: true });
      analyticsTrackOnlinePeriod("hidden", { forcePause: true });
      analyticsTrack("visibility", { data: { hidden: true } });
    } else {
      analyticsTrack("visibility", { data: { hidden: false } });
    }
  });

  clearInterval(analyticsHeartbeat);
  analyticsHeartbeat = setInterval(() => {
    if (!document.hidden) analyticsTrackOnlinePeriod("interval");
  }, analyticsOnlinePeriodFlushMs);

  let unloadHandled = false;
  const endForUnload = () => {
    if (unloadHandled) return;
    unloadHandled = true;
    analyticsEndParticipantSession("unload");
    analyticsFlushBeforeUnload();
  };
  window.addEventListener("pagehide", endForUnload);
  window.addEventListener("beforeunload", endForUnload);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    unloadHandled = false;
    analyticsBeginParticipantSession();
    if (currentAnalyticsView() === "learn" && currentAnalyticsUnit()) {
      analyticsResumeUnitTimer(currentAnalyticsUnit());
    }
  });
}

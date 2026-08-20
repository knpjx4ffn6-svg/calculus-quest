// View, chapter, unit, completion, and activity-log navigation.
let completionNavigationInFlight = "";
function renderAll() {
  applyView(currentView);
  renderAuth();
  renderMetrics();
  renderChapters();
  renderLessons();
  renderPlayer();
  renderLibrary();
  renderProgress();
  if (typeof renderFeedbackPage === "function") renderFeedbackPage();
  window.dispatchEvent(new CustomEvent("cq:lesson-rendered", {
    detail: {
      view: currentView,
      chapterId: currentChapterId,
      unitId: currentUnitId
    }
  }));
}

function applyView(view) {
  const nextView = validViews.has(view) ? view : "home";
  currentView = nextView;
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === `${nextView}-view`));
  document.querySelectorAll("[data-view]").forEach((node) => {
    if (node.classList.contains("nav-button")) node.classList.toggle("active", node.dataset.view === nextView);
  });
}

function captureLastLearningContext() {
  if (currentView !== "learn" || !currentUnitId || typeof ReturnContext === "undefined") return;
  state.lastLearningContext = ReturnContext.captureLearningContext({
    chapterId: currentChapterId,
    unitId: currentUnitId,
    sceneType: state.selectedKnowledgeScenes?.[currentUnitId] || ""
  });
}

function switchView(view) {
  const nextView = validViews.has(view) ? view : "home";
  if (typeof ReturnContext !== "undefined" && ReturnContext.shouldReturnToLearning(nextView)) {
    captureLastLearningContext();
  }
  analyticsTrack("switch_view", { data: { from: currentView, to: nextView } });
  currentView = nextView;
  applyView(currentView);
  if (currentView === "feedback" && typeof renderFeedbackPage === "function") renderFeedbackPage();
  saveState();
  window.scrollTo({ top: 0, behavior: "smooth" });
  trackLearningEvent("switch_view", { view: currentView });
}

async function returnToLearningCourseware() {
  const fallback = typeof ReturnContext === "undefined"
    ? { chapterId: currentChapterId, unitId: currentUnitId, sceneType: "" }
    : ReturnContext.captureLearningContext({
        chapterId: currentChapterId,
        unitId: currentUnitId,
        sceneType: state.selectedKnowledgeScenes?.[currentUnitId] || ""
      });
  const context = typeof ReturnContext === "undefined"
    ? fallback
    : ReturnContext.resolveLearningContext(state.lastLearningContext, fallback);

  currentChapterId = context.chapterId || currentChapterId;
  currentUnitId = context.unitId || currentUnitId;
  if (context.sceneType && currentUnitId && typeof setKnowledgeSceneType === "function") {
    setKnowledgeSceneType(currentUnitId, context.sceneType);
  }
  switchView("learn");
  renderAll();

  if (currentChapterId && (!currentUnitId || !getUnit(currentUnitId)) && typeof ensureChapterLoaded === "function") {
    try {
      await ensureChapterLoaded(currentChapterId);
    } catch {
      // Keep the current course context even if the chapter reload fails.
    }
    renderAll();
  }

  const playerTop = document.querySelector(".player-top");
  if (playerTop) {
    window.scrollTo({ top: playerTop.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
  }
}

function returnToQuizFromCourseware(unitId = currentUnitId) {
  const context = typeof quizResourceReviewContext === "function"
    ? quizResourceReviewContext(unitId)
    : null;
  if (!context?.quizUnit) return false;
  const questionId = context.questionId || "";
  state.returnToQuiz = null;
  if (typeof analyticsTrack === "function") {
    analyticsTrack("quiz_resource_review_returned", {
      source: "quiz",
      data: {
        fromUnitId: unitId,
        targetUnitId: context.quizUnit.id,
        questionId
      }
    });
  }
  currentChapterId = context.quizUnit.chapterId;
  currentUnitId = context.quizUnit.id;
  switchView("learn");
  renderAll();
  window.setTimeout(() => {
    if (!questionId) return;
    const safeQuestionId = typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(questionId)
      : String(questionId).replace(/"/g, '\\"');
    const card = document.querySelector(`[data-question="${safeQuestionId}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 80);
  return true;
}

function retireQuizReturnContext(nextUnitId = "") {
  const context = state.returnToQuiz;
  if (!context?.targetUnitId || !nextUnitId || nextUnitId === context.targetUnitId) return false;
  state.returnToQuiz = null;
  if (typeof saveState === "function") saveState();
  if (typeof trackLearningEvent === "function") {
    trackLearningEvent("quiz_resource_review_abandoned", {
      fromQuizUnitId: context.unitId || "",
      reviewedUnitId: context.targetUnitId,
      nextUnitId,
      questionId: context.questionId || ""
    }, false);
  }
  if (typeof analyticsTrack === "function") {
    analyticsTrack("quiz_resource_review_abandoned", {
      source: "quiz",
      data: {
        fromQuizUnitId: context.unitId || "",
        reviewedUnitId: context.targetUnitId,
        nextUnitId,
        questionId: context.questionId || ""
      }
    });
  }
  return true;
}

async function selectChapter(chapterId) {
  const targetChapter = getChapter(chapterId);
  if (!targetChapter) return false;
  const previousChapterId = currentChapterId;
  const previousUnitId = currentUnitId;
  const previousReturnToQuiz = state.returnToQuiz;
  analyticsTrack("chapter_select", {
    data: {
      fromChapterId: previousChapterId,
      toChapterId: chapterId
    }
  });
  currentChapterId = chapterId;
  const chapter = getChapter(chapterId);
  const chapterPathUnits = typeof agenticDisplayUnitsForChapter === "function"
    ? agenticDisplayUnitsForChapter(chapter)
    : chapter.units;
  const firstVisible = chapterPathUnits[0] || chapter.units?.[0] || null;
  retireQuizReturnContext(firstVisible?.id || "");
  currentUnitId = firstVisible?.id || "";
  trackLearningEvent("select_chapter", { chapterId, chapterLabel: chapter.label });
  if (!chapter.loaded) {
    renderAll();
    try {
      const loaded = await ensureChapterLoaded(chapterId);
      if (loaded === false) throw new Error("chapter_load_rejected");
      const loadedChapter = getChapter(chapterId);
      const loadedPathUnits = typeof agenticDisplayUnitsForChapter === "function"
        ? agenticDisplayUnitsForChapter(loadedChapter)
        : loadedChapter.units;
      const loadedFirst = loadedPathUnits[0] || loadedChapter.units?.[0] || null;
      retireQuizReturnContext(loadedFirst?.id || "");
      currentUnitId = loadedFirst?.id || "";
      preloadChapterResources(chapterId);
    } catch {
      // Chapter load failed; stay on current chapter view
      currentChapterId = previousChapterId;
      currentUnitId = previousUnitId;
      state.returnToQuiz = previousReturnToQuiz;
      renderAll();
      return false;
    }
  }
  if (typeof agenticConsumeCompletedExtensionResume === "function") {
    agenticConsumeCompletedExtensionResume(currentUnitId);
  }
  renderAll();
  const playerTop = document.querySelector(".player-top");
  if (playerTop) {
      window.scrollTo({ top: playerTop.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
  }
  return true;
}

function selectUnit(unitId) {
  const unit = getUnit(unitId);
  if (!unit) return false;
  if (typeof agenticGuardNavigation === "function" && !agenticGuardNavigation(unitId, { allowPrevious: true })) return false;
  const previousUnit = getUnit(currentUnitId);
  retireQuizReturnContext(unit.id);
  currentChapterId = unit.chapterId;
  currentUnitId = unit.id;
  if (typeof agenticConsumeCompletedExtensionResume === "function") {
    agenticConsumeCompletedExtensionResume(unit.id);
  }
  if (previousUnit?.id !== unit.id) analyticsEnterUnit(unit, "select_unit");
  trackLearningEvent("open_unit", {
    unitId: unit.id,
    chapterId: unit.chapterId,
    kind: unit.kind,
    type: unit.type,
    label: unit.label
  });
  renderAll();
  const playerTop = document.querySelector(".player-top");
  if (playerTop) {
    window.scrollTo({ top: playerTop.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
  }
  return true;
}

function completeCurrentUnit() {
  const unit = getUnit();
  if (!unit) return false;
  if (typeof quizResourceReviewContext === "function" && quizResourceReviewContext(unit.id)) {
    return false;
  }
  if (
    typeof agenticUnitCompletionAllowed === "function"
    && !agenticUnitCompletionAllowed(unit.id)
  ) {
    addLog(`「${unit.label}」当前仅供预览；接受学习建议后才能完成本节。`);
    return false;
  }
  if (typeof agenticGuardNavigation === "function" && !agenticGuardNavigation(unit.id, { allowPrevious: true, silent: true })) return false;
  if (!state.completed.includes(unit.id)) {
    state.completed.push(unit.id);
    addLog(`完成「${getChapter(unit.chapterId).label}」中的「${unit.label}」。`);
    trackLearningEvent("complete_unit", {
      unitId: unit.id,
      chapterId: unit.chapterId,
      kind: unit.kind,
      type: unit.type,
      label: unit.label
    });
    analyticsTrack("unit_complete", {
      data: {
        unitId: unit.id,
        chapterId: unit.chapterId,
        kind: unit.kind,
        type: unit.type,
        moduleRole: moduleRoleForUnit(unit),
        label: unit.label
      }
    });
  } else {
    addLog(`复习「${unit.label}」。`);
    trackLearningEvent("review_unit", {
      unitId: unit.id,
      chapterId: unit.chapterId,
      kind: unit.kind,
      type: unit.type,
      label: unit.label
    });
    analyticsTrack("unit_review_complete", {
      data: {
        unitId: unit.id,
        chapterId: unit.chapterId,
        kind: unit.kind,
        type: unit.type,
        moduleRole: moduleRoleForUnit(unit),
        label: unit.label
      }
    });
  }
  saveState();
  renderAll();
  return true;
}

function focusQuizSubmitPanel(unit) {
  const submitButton = document.querySelector(`[data-submit-quiz="${unit?.id || ""}"]`);
  const target = submitButton?.closest(".quiz-submit-panel") || submitButton;
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => submitButton?.focus({ preventScroll: true }), 320);
  return true;
}

async function completeAndAdvanceCurrentUnit(event) {
  event?.preventDefault?.();
  const unit = getUnit();
  if (!unit) return false;

  if (
    typeof quizResourceReviewContext === "function"
    && quizResourceReviewContext(unit.id)
    && typeof returnToQuizFromCourseware === "function"
  ) {
    return returnToQuizFromCourseware(unit.id);
  }

  if (unit.type === "knowledge" && !selectedKnowledgeSceneType(unit)) {
    addLog("请先选择一个互动场景，再完成本节。");
    if (typeof focusKnowledgeSceneChoicePanel === "function") focusKnowledgeSceneChoicePanel();
    return false;
  }

  if (unit.type === "quiz" && !unit.placeholderQuiz && !(state.submittedQuizzes || []).includes(unit.id)) {
    addLog("测验需要先提交，系统才能根据证据解锁下一步。");
    focusQuizSubmitPanel(unit);
    return false;
  }

  if (typeof agenticIsCurrentPending === "function" && agenticIsCurrentPending(unit.id)) {
    addLog("学习建议已给出下一步，请先确认路径。");
    if (typeof focusAgenticCoachPanel === "function") focusAgenticCoachPanel();
    else if (typeof renderAgenticCoachPanel === "function") renderAgenticCoachPanel();
    return false;
  }

  if (
    unit.type === "quiz"
    && typeof agenticQuizPathReady === "function"
    && !agenticQuizPathReady(unit)
  ) {
    addLog("学习建议正在生成，请稍候片刻。");
    if (typeof focusAgenticCoachPanel === "function") focusAgenticCoachPanel();
    return false;
  }

  if (completionNavigationInFlight) {
    if (typeof analyticsTrack === "function") {
      analyticsTrack("navigation_duplicate_blocked", {
        source: "completion",
        data: { unitId: unit.id, inFlightUnitId: completionNavigationInFlight }
      });
    }
    return false;
  }

  completionNavigationInFlight = unit.id;
  try {
    const completionCta = typeof agenticCompletionCta === "function"
      ? agenticCompletionCta(unit)
      : null;
    if (completionCta?.disabled) return false;

    const nextFromCompletion = typeof agenticOnUnitCompleted === "function"
      ? agenticOnUnitCompleted(unit)
      : null;
    if (completeCurrentUnit() === false) return false;

    if (typeof agenticIsCurrentPending === "function" && agenticIsCurrentPending(unit.id)) {
      if (typeof focusAgenticCoachPanel === "function") focusAgenticCoachPanel();
      else if (typeof renderAgenticCoachPanel === "function") renderAgenticCoachPanel();
      return true;
    }

    const next = nextFromCompletion?.id
      ? nextFromCompletion
      : typeof agenticNextUnlockedUnitAfter === "function"
        ? agenticNextUnlockedUnitAfter(unit.id)
        : null;
    if (next?.id && typeof agenticOpenUnit === "function") {
      const opened = await agenticOpenUnit(next.id, { source: "completion" });
      return opened === true;
    }

    const chapter = getChapter(unit.chapterId);
    const isExtension = typeof agenticIsExtensionChapter === "function" && agenticIsExtensionChapter(chapter);
    addLog(isExtension
      ? "当前扩展学习已完成，可从章节栏返回主线。"
      : "你已到达当前课程路线的最后一步。");
    renderAll();
    return true;
  } finally {
    completionNavigationInFlight = "";
  }
}

function addLog(text) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  state.logs.unshift(`${time} · ${text}`);
  state.logs = state.logs.slice(0, 18);
  saveState();
}

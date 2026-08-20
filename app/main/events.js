// User input, click, change, and fullscreen event wiring.
document.addEventListener("click", (event) => {
  const brandBackButton = event.target.closest(".brand[data-view]");
  if (
    brandBackButton
    && typeof ReturnContext !== "undefined"
    && ReturnContext.shouldReturnToLearning(currentView)
  ) {
    returnToLearningCourseware().catch((error) => {
      console.warn("Return to learning failed:", error.message);
      switchView("learn");
    });
    return;
  }

  if (
    brandBackButton
    && typeof returnToQuizFromCourseware === "function"
    && returnToQuizFromCourseware(currentUnitId)
  ) {
    return;
  }

  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    switchView(viewButton.dataset.view);
    return;
  }

  const quizResourceLink = event.target.closest("[data-quiz-resource-link]");
  if (quizResourceLink) {
    const targetUnitId = quizResourceLink.dataset.quizResourceLink || "";
    const sceneType = quizResourceLink.dataset.quizResourceScene || "";
    const sourceUnit = getUnit();
    const targetUnit = getUnit(targetUnitId);
    const questionCard = quizResourceLink.closest("[data-question]");
    const accessible = targetUnit && (
      typeof quizResourceTargetAccessible !== "function"
      || quizResourceTargetAccessible(targetUnitId)
    );
    if (!accessible) {
      addLog(sourceUnit?.assessmentPhase === "pre"
        ? "前测只用于定位基础；请先完成前测后的学习路径选择，再进入对应课件。"
        : "对应课件尚未解锁，请先完成当前学习建议。");
      if (typeof renderAgenticCoachPanel === "function") renderAgenticCoachPanel();
      return;
    }
    if (sourceUnit?.type === "quiz") {
      state.returnToQuiz = {
        unitId: sourceUnit.id,
        questionId: questionCard?.dataset.question || "",
        targetUnitId: targetUnit?.id || targetUnitId,
        createdAt: beijingNow()
      };
      saveState();
    }
    if (sceneType && typeof setKnowledgeSceneType === "function") setKnowledgeSceneType(targetUnitId, sceneType);
    if (targetUnit) {
      currentChapterId = targetUnit.chapterId;
      currentUnitId = targetUnit.id;
      if (typeof analyticsEnterUnit === "function") analyticsEnterUnit(targetUnit, "quiz_resource_link");
      trackLearningEvent("quiz_resource_link_open", {
        fromUnitId: sourceUnit?.id || "",
        targetUnitId,
        sceneType,
        questionId: questionCard?.dataset.question || ""
      }, false);
      analyticsTrack("quiz_resource_link_open", {
        source: "quiz",
        data: {
          fromUnitId: sourceUnit?.id || "",
          targetUnitId,
          sceneType,
          questionId: questionCard?.dataset.question || ""
        }
      });
      switchView("learn");
      renderAll();
      window.setTimeout(() => {
        const playerTop = document.querySelector(".player-top");
        if (playerTop) window.scrollTo({ top: playerTop.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
      }, 80);
    }
    return;
  }

  const chapterButton = event.target.closest("[data-chapter]");
  if (chapterButton) {
    const cid = chapterButton.dataset.chapter;
    selectChapter(cid)
      .then((selected) => {
        if (selected !== false) {
          if (typeof setChapterRailCollapsed === "function" && window.matchMedia("(min-width: 1181px)").matches) {
            setChapterRailCollapsed(true, { persist: false, focusCurrent: false });
          }
        }
      })
      .catch((error) => console.warn("Chapter navigation failed:", error));
    return;
  }

  const knowledgeSceneButton = event.target.closest("[data-knowledge-scene]");
  if (knowledgeSceneButton) {
    const uid = knowledgeSceneButton.dataset.unit || currentUnitId;
    const sceneType = knowledgeSceneButton.dataset.knowledgeScene;
    if (setKnowledgeSceneType(uid, sceneType)) {
      renderAll();
    }
    return;
  }

  const quizPathAction = event.target.closest("[data-quiz-path-action]");
  if (quizPathAction) {
    if (quizPathAction.dataset.quizPathAction === "coach" && typeof focusAgenticCoachPanel === "function") {
      focusAgenticCoachPanel();
    }
    return;
  }

  const unitButton = event.target.closest("[data-unit]");
  if (unitButton) {
    const uid = unitButton.dataset.unit;
    const skipped = typeof agenticIsSkipped === "function" && agenticIsSkipped(uid);
    if (typeof agenticGuardNavigation === "function") {
      if (agenticGuardNavigation(uid, { allowPrevious: true })) selectUnit(uid);
    } else if (!skipped) {
      selectUnit(uid);
    }
    return;
  }

  const jumpButton = event.target.closest("[data-jump-unit]");
  if (jumpButton) {
    const uid = jumpButton.dataset.jumpUnit;
    if (typeof agenticGuardNavigation === "function" && !agenticGuardNavigation(uid, { allowPrevious: true })) return;
    analyticsTrack("jump_unit", { data: { unitId: uid, source: "library" } });
    selectUnit(uid);
    switchView("learn");
    return;
  }

  const agenticActionBtn = event.target.closest("[data-agentic-action]");
  if (agenticActionBtn) {
    const type = agenticActionBtn.dataset.agenticAction;
    if (typeof agenticApplyDecision === "function") {
      agenticActionBtn.disabled = true;
      agenticApplyDecision(type, agenticActionBtn.dataset.agenticActionKey || "").catch((error) => {
        console.warn("Agentic decision failed:", error);
        if (error?.code !== "navigation_failed") {
          addLog(`学习路径切换失败：${error.message || "请稍后重试"}`);
        }
      });
    }
    return;
  }

  const reviewBulk = event.target.closest("[data-agentic-review-bulk]");
  if (reviewBulk) {
    if (typeof agenticUpdateReviewChoicesBulk === "function") {
      agenticUpdateReviewChoicesBulk(
        reviewBulk.dataset.agenticReviewBulk,
        reviewBulk.dataset.agenticReviewMode
      );
    }
    return;
  }

  const knowledgeBulk = event.target.closest("[data-agentic-knowledge-bulk]");
  if (knowledgeBulk) {
    if (typeof agenticUpdateKnowledgeChoicesBulk === "function") {
      agenticUpdateKnowledgeChoicesBulk(knowledgeBulk.dataset.agenticKnowledgeBulk === "learn");
    }
    return;
  }

  const reviewChoice = event.target.closest("[data-agentic-review-choice]");
  if (reviewChoice) {
    if (typeof agenticUpdateReviewChoiceMode === "function") {
      agenticUpdateReviewChoiceMode(reviewChoice.dataset.agenticReviewChoice, reviewChoice.dataset.agenticReviewMode);
    }
    return;
  }

  const filterButton = event.target.closest("[data-filter]");
  if (filterButton) {
    libraryFilter = filterButton.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((node) => node.classList.toggle("active", node === filterButton));
    trackLearningEvent("filter_library", { filter: libraryFilter }, false);
    analyticsTrack("library_filter", { data: { filter: libraryFilter } });
    renderLibrary();
    return;
  }

  const submitQuizButton = event.target.closest("[data-submit-quiz]");
  if (submitQuizButton) {
    submitQuiz(submitQuizButton.dataset.submitQuiz);
    return;
  }

  const retryAiGradeButton = event.target.closest("[data-retry-ai-grade]");
  if (retryAiGradeButton) {
    retryAiGradeButton.disabled = true;
    retryAiGradeButton.textContent = "正在重新批改";
    const retryUnitId = retryAiGradeButton.dataset.unit || currentUnitId;
    const retryQuestionId = retryAiGradeButton.dataset.questionId || "";
    retryFailedShortAnswer(
      retryUnitId,
      retryQuestionId
    ).then((succeeded) => {
      if (succeeded) return;
      retryAiGradeButton.disabled = false;
      retryAiGradeButton.textContent = "重新批改";
    }).catch((error) => {
        console.warn("Short-answer retry failed:", error);
        addLog(`简答题重新批改失败：${error.message || "服务暂时不可用"}。`);
        analyticsTrack("short_answer_regrade_failed", {
          source: "quiz",
          data: {
            unitId: retryUnitId,
            questionId: retryQuestionId,
            reason: error.code || "request_failed"
          }
        });
        retryAiGradeButton.disabled = false;
        retryAiGradeButton.textContent = "重新批改";
      });
    return;
  }

  const gradingRecoveryButton = event.target.closest("[data-agentic-grading-action]");
  if (gradingRecoveryButton) {
    const action = gradingRecoveryButton.dataset.agenticGradingAction || "retry";
    document.querySelectorAll("[data-agentic-grading-action]").forEach((button) => {
      button.disabled = true;
    });
    if (typeof agenticResolvePendingGrading === "function") {
      agenticResolvePendingGrading(action).catch((error) => {
        console.warn("Grading recovery failed:", error);
        if (typeof agenticMarkGradingRecoveryAvailable === "function") {
          agenticMarkGradingRecoveryAvailable(getUnit(), error);
        }
      });
    }
    return;
  }

  const revealAnswerButton = event.target.closest("[data-reveal-answer]");
  if (revealAnswerButton) {
    if (typeof revealQuestionAnswer === "function") revealQuestionAnswer(revealAnswerButton);
    return;
  }

  const quizNavBtn = event.target.closest(".quiz-nav-btn");
  if (quizNavBtn && quizNavBtn.dataset.unit) {
    if (typeof agenticGuardNavigation === "function" && !agenticGuardNavigation(quizNavBtn.dataset.unit, { allowPrevious: true })) return;
    selectUnit(quizNavBtn.dataset.unit);
    return;
  }

  const knowledgeSceneFullscreenButton = event.target.closest("[data-knowledge-scene-fullscreen]");
  if (knowledgeSceneFullscreenButton) {
    const panel = knowledgeSceneFullscreenButton.closest("[data-knowledge-scene-panel]");
    const stage = knowledgeSceneFullscreenButton.closest("[data-knowledge-scene-stage]")
      || panel?.querySelector("[data-knowledge-scene-stage]");
    if (!stage) return;
    const unit = getUnit();
    const entering = document.fullscreenElement !== stage;
    trackLearningEvent("resource_fullscreen", {
      unitId: unit?.id || currentUnitId,
      entering,
      target: "knowledge_scene",
      sceneType: unit?.type === "knowledge" ? selectedKnowledgeSceneType(unit) : ""
    }, false);
    analyticsTrack("resource_fullscreen", {
      data: {
        unitId: unit?.id || currentUnitId,
        entering,
        target: "knowledge_scene"
      }
    });
    toggleResourceFullscreen(stage);
    return;
  }

  const resourceFullscreenButton = event.target.closest("[data-resource-fullscreen]");
  if (resourceFullscreenButton) {
    const shell = resourceFullscreenButton.closest("[data-resource-shell]");
    const target = typeof resourceFullscreenTargetForButton === "function"
      ? resourceFullscreenTargetForButton(resourceFullscreenButton)
      : shell;
    if (!target) return;
    trackLearningEvent("resource_fullscreen", { unitId: getUnit().id, entering: document.fullscreenElement !== target }, false);
    analyticsTrack("resource_fullscreen", {
      data: { unitId: getUnit().id, entering: document.fullscreenElement !== target }
    });
    toggleResourceFullscreen(target);
    return;
  }

  if (event.target.closest("#fullscreen-player")) {
    analyticsTrack("learning_fullscreen_toggle", { data: { entering: !document.fullscreenElement } });
    toggleFullscreenLearning();
    return;
  }

  const playNarrationButton = event.target.closest("[data-play-narration]");
  if (playNarrationButton) {
    trackLearningEvent("play_narration", { unitId: getUnit().id }, false);
    analyticsTrack("narration_play_click", { source: "narration", data: { unitId: getUnit().id } });
    playNarrationQueue(playNarrationButton.closest("[data-coach-strip]") || document);
    return;
  }

  if (event.target.closest("[data-pause-narration]")) {
    trackLearningEvent("pause_narration", { unitId: getUnit().id }, false);
    analyticsTrack("narration_pause_click", { source: "narration", data: { unitId: getUnit().id } });
    pauseNarrationQueue();
    return;
  }

  if (event.target.closest("[data-stop-narration]")) {
    trackLearningEvent("stop_narration", { unitId: getUnit().id }, false);
    analyticsTrack("narration_stop_click", { source: "narration", data: { unitId: getUnit().id } });
    stopNarrationQueue();
    return;
  }

  if (event.target.closest("[data-toggle-narration]")) {
    toggleNarrationCollapse();
  }
});

const shortAnswerAnalyticsTimers = new Map();

document.addEventListener("input", (event) => {
  const seek = event.target.closest("[data-narration-seek]");
  if (seek) {
    analyticsTrack("narration_seek_input", {
      source: "narration",
      value: { new: Number(seek.value), max: Number(seek.max || 1000) }
    });
    seekNarration(Number(seek.value) / Number(seek.max || 1000), seek.closest("[data-coach-strip]") || document);
    return;
  }

  const shortAnswer = event.target.closest("[data-short-answer]");
  if (shortAnswer) {
    rememberQuizDraft(shortAnswer.dataset.unitId, shortAnswer.dataset.questionId, shortAnswer.value);
    const key = `${shortAnswer.dataset.unitId}:${shortAnswer.dataset.questionId}`;
    clearTimeout(shortAnswerAnalyticsTimers.get(key));
    shortAnswerAnalyticsTimers.set(key, setTimeout(() => {
      shortAnswerAnalyticsTimers.delete(key);
      analyticsTrack("short_answer_input", {
        source: "quiz",
        data: {
          unitId: shortAnswer.dataset.unitId,
          questionId: shortAnswer.dataset.questionId,
          length: shortAnswer.value.length
        }
      });
    }, 3000));
  }
});

document.addEventListener("change", (event) => {
  const knowledgeChoice = event.target.closest("[data-agentic-knowledge-choice]");
  if (knowledgeChoice) {
    if (typeof agenticUpdatePendingKnowledgeChoice === "function") {
      agenticUpdatePendingKnowledgeChoice(knowledgeChoice.dataset.agenticKnowledgeChoice, knowledgeChoice.checked);
    }
    return;
  }

  const choice = event.target.closest("[data-choice-answer]");
  if (!choice) return;
  const unitId = choice.dataset.unitId;
  const questionId = choice.dataset.questionId;
  const values = selectedChoiceValues(unitId, questionId);
  const unit = getUnit(unitId);
  const questions = unit?.scene?.content?.questions || [];
  const questionIndex = questions.findIndex((question) => question.id === questionId);
  const question = questionIndex >= 0 ? questions[questionIndex] : {};
  analyticsTrack("answer_select", {
    source: "quiz",
    data: {
      unitId,
      questionId,
      questionIndex: questionIndex >= 0 ? questionIndex : null,
      questionText: question.question || question.prompt || question.title || question.text || "",
      phase: unit?.assessmentPhase || "",
      moduleId: question.moduleId || "",
      moduleTitle: question.moduleTitle || "",
      knowledgePointIds: question.knowledgePointIds || question.coachHint?.knowledgePointIds || [],
      inputType: choice.type,
      values
    }
  });
  rememberQuizDraft(unitId, questionId, choice.type === "radio" ? values[0] || "" : values);
});

document.addEventListener("fullscreenchange", () => {
  analyticsTrack("fullscreen_change", { data: { active: Boolean(document.fullscreenElement) } });
  updateFullscreenButton();
  updateResourceFullscreenButtons();
  syncNarrationUi();
  if (typeof scheduleLearningCanvasLayoutSync === "function") {
    scheduleLearningCanvasLayoutSync("fullscreen-change");
  }
});

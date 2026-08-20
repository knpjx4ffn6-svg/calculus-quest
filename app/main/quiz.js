// Quiz answer handling, review, scoring, and quiz navigation.
function selectedChoiceValues(unitId, questionId) {
  return Array.from(document.querySelectorAll(`input[name="${unitId}-${questionId}"]:checked`)).map((input) => input.value);
}

function optionText(question, value) {
  const option = (question.options || []).find((item) => item.value === value);
  return option ? `${option.value}. ${displayOptionLabel(option)}` : value;
}

function displayQuestionText(question = {}) {
  const raw = String(question.question || question.prompt || question.title || question.text || "");
  return raw.replace(/^\s*【[^】]{1,80}】\s*/, "").trim() || raw;
}

function formatAnswerValues(question, values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  if (!list.length) return "未作答";
  return list.map((value) => optionText(question, value)).join("；");
}

function formatAnswerValuesHtml(question, values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  if (!list.length) return '<div class="answer-lines muted">未作答</div>';
  return `
    <div class="answer-lines">
      ${list.map((value) => `<div class="answer-line">${renderInlineMath(optionText(question, value))}</div>`).join("")}
    </div>
  `;
}

function renderReviewBlock(label, bodyHtml, className = "") {
  return `
    <div class="review-answer-block ${className}">
      <b>${escapeHtml(label)}</b>
      ${bodyHtml}
    </div>
  `;
}

function renderAnalysisBlock(text) {
  return renderReviewBlock("解析", `<div class="answer-lines analysis-line">${renderInlineMath(text || "这道题暂无解析。")}</div>`);
}

function questionConceptTags(question) {
  const explicit = question.coachHint?.concepts || question.concepts || question.tags || [];
  const tags = new Set(Array.isArray(explicit) ? explicit : [explicit].filter(Boolean));
  const source = `${question.question || ""} ${question.analysis || ""} ${question.commentPrompt || ""}`;
  [
    "自变量", "因变量", "函数", "函数图像", "坐标", "映射", "唯一性", "斜率", "变化率",
    "平均变化率", "局部线性", "切线", "导数", "速度", "方向", "向量", "矩阵", "梯度"
  ].forEach((tag) => {
    if (source.includes(tag)) tags.add(tag);
  });
  return Array.from(tags).slice(0, 4);
}

function coachReviewTarget(unit) {
  if (!unit) return "刚才对应的讲解或互动实验";
  const units = getChapter(unit.chapterId)?.allUnits || getChapter(unit.chapterId)?.units || [];
  const prior = units
    .filter((item) => item.sceneOrder < unit.sceneOrder && (item.type === "interactive" || item.type === "slide"))
    .sort((a, b) => b.sceneOrder - a.sceneOrder)[0];
  return prior?.label || "本章前面的互动实验";
}

function buildQuestionCoachHint(question, result, unit) {
  const hint = question.coachHint || {};
  const concepts = questionConceptTags(question);
  const conceptText = concepts.length ? concepts.join("、") : "题干中的关键条件";
  const selectedText = formatAnswerValues(question, result.response);
  const reviewTarget = hint.reviewScene || hint.review_scene || coachReviewTarget(unit);
  const promptText = displayQuestionText(question).replace(/\s+/g, " ").slice(0, 80);
  const typeMove = question.type === "multiple"
    ? "这是一道多选题，先把每个选项单独判定为“符合题干”或“不符合题干”，再组合选择；不要只凭一个熟悉词就全选或漏选。"
    : "这是一道单选题，先抓住题干里的限制条件，再检查你选的那句话是否和这个条件同向、同义。";
  const calculationMove = /计算|求|公式|坐标|斜率|变化率|速度/.test(`${question.question || ""} ${question.commentPrompt || ""}`)
    ? "如果题目涉及计算，先把已知量写成“输入变化量”和“输出变化量”，再决定用哪个关系式。"
    : "如果题目偏概念，先用自己的话复述概念定义，再判断选项有没有偷换对象或方向。";
  const guidance = hint.guidance || hint.prompt || `${typeMove}${calculationMove}`;
  return {
    conceptText,
    selectedText,
    promptText,
    reviewTarget,
    misconception: hint.misconception || hint.misconception_tag || "先定位你选项里的关键词和题干条件是否真的一致。",
    guidance
  };
}

function aiReviewStatus(result, question = {}) {
  const aiScore = result.aiScore ?? result.ai_score;
  const aiErrorType = result.aiErrorType || result.ai_error_type || "";
  const feedback = result.aiFeedback || result.ai_feedback || "";
  const hasAiScore = aiScore !== undefined && aiScore !== null;
  const maxScore = quizMaxScoreFor(question, result || {});
  const aiFailed = quizAiReviewFailed(result);
  const pendingReview = quizReviewIsPending(result);
  const fallbackScored = aiFailed && !pendingReview;
  const displayScore = hasAiScore ? quizScoreFromAiScore(aiScore, maxScore) : fallbackScored ? 0 : null;
  const reviewCompleted = !pendingReview && (hasAiScore || fallbackScored);
  const badgeText = reviewCompleted ? (Number(displayScore) === 0 ? "需复盘" : "已批改") : "待批改";
  const badgeClass = reviewCompleted && Number(displayScore) > 0 ? "done" : "todo";
  let line = "智能批改正在等待返回；结果回来后会保留在这里。";
  if (fallbackScored) {
    const denominator = maxScore ? ` / ${quizFormatScore(maxScore)}` : "";
    line = `智能批改暂时失败，已先按 ${quizFormatScore(displayScore || 0)}${denominator} 分计入；你可以继续学习。`;
  } else if (hasAiScore && !aiFailed) {
    const confidence = result.aiConfidence != null ? ` · 判断把握 ${Math.round(Number(result.aiConfidence) * 100)}%` : "";
    const denominator = maxScore ? ` / ${quizFormatScore(maxScore)}` : "";
    line = `建议得分：${quizFormatScore(displayScore)}${denominator} 分${confidence}`;
  } else if (aiFailed) {
    line = aiErrorType === "mock_provider"
      ? "本地 mock 环境未启用真实大模型，已保留给人工复核。"
      : aiErrorType === "api_timeout"
        ? "评分超时，已保留给人工复核。"
      : "评测暂时未完成，已保留给人工复核。";
  }
  return { hasAiScore, aiFailed, badgeText, badgeClass, line, feedback };
}

function shortAnswerReferenceText(question, result = {}) {
  return result.referenceAnswer
    || result.answerText
    || result.analysis
    || question.referenceAnswer
    || question.answerText
    || question.analysis
    || "请围绕题目要求说明关键步骤、几何意义或实际含义。";
}

function renderQuestionReview({ question, result, index, unit }) {
  if (question.type === "short_answer") {
    const ai = aiReviewStatus(result, question);
    const referenceText = shortAnswerReferenceText(question, result);
    const rubricText = result.commentPrompt || result.rubric || question.commentPrompt || question.rubric || "";
    const weakConceptLabels = typeof KnowledgePointLabels !== "undefined"
      ? KnowledgePointLabels.labelsFor(result.aiWeakConcepts, typeof curriculum !== "undefined" ? curriculum : [], unit?.chapterId)
      : (Array.isArray(result.aiWeakConcepts) ? result.aiWeakConcepts : []);
    return `
      <div class="question-review pending" data-question-review>
        <div class="review-heading">
          <span class="status-pill ${ai.badgeClass}">${ai.badgeText}</span>
          <strong>第 ${index + 1} 题参考要点</strong>
          <span class="question-score-pill">${escapeHtml(quizQuestionScoreLabel(question, result))}</span>
        </div>
        <p><b>你的回答：</b>${escapeHtml(result.response || "")}</p>
        <div class="ai-review-box" data-ai-review>
          <strong>智能批改建议</strong>
          <p>${escapeHtml(ai.line)}</p>
          ${ai.feedback ? `<p><b>反馈：</b>${escapeHtml(ai.feedback)}</p>` : ""}
          ${weakConceptLabels.length ? `<p><b>薄弱概念：</b>${escapeHtml(weakConceptLabels.join("、"))}</p>` : ""}
          ${result.aiReasoning ? `<p><b>评分依据：</b>${escapeHtml(result.aiReasoning)}</p>` : ""}
        </div>
        ${ai.aiFailed ? `<button class="button soft" type="button" data-retry-ai-grade data-unit="${escapeHtml(unit?.id || result.unitId || "")}" data-question-id="${escapeHtml(question.id || result.questionId || "")}">重新批改</button>` : ""}
        <button class="button soft coach-reveal-btn" type="button" data-reveal-answer>显示参考答案和解析</button>
        <div class="question-answer-hidden" data-answer-hidden style="display:none">
          <p><b>参考答案：</b>${renderInlineMath(referenceText)}</p>
          ${rubricText ? `<p><b>解析/评分参考：</b>${renderInlineMath(rubricText)}</p>` : ""}
        </div>
        ${renderQuizCoverage(question, unit)}
      </div>
    `;
  }

  const correct = result.isCorrect === true;
  const coach = buildQuestionCoachHint(question, result, unit);
  const resourceAccess = typeof quizQuestionResourceAccess === "function"
    ? quizQuestionResourceAccess(question, unit)
    : { hasMarkers: false, hasAccessible: true };
  const actionAdvice = unit?.assessmentPhase === "pre"
    ? `先记下这个薄弱点；完成前测后的学习路径选择后，再从「${escapeHtml(coach.reviewTarget)}」开始学习。`
    : resourceAccess.hasTimingBlocked && !resourceAccess.hasAllowed
      ? "本次形成性测验不提供后续课件入口；请继续当前学习路径。"
    : resourceAccess.hasMarkers && !resourceAccess.hasAccessible
      ? `对应课件尚未解锁。请先完成当前学习建议，解锁后再学习「${escapeHtml(coach.reviewTarget)}」。`
      : `${escapeHtml(coach.guidance)} 可以先回看「${escapeHtml(coach.reviewTarget)}」，再用一句话解释为什么自己的选择符合或不符合题干。`;
  const correctAnswer = result.answer ?? question.answer ?? [];
  const analysis = result.analysis || question.analysis || "";
  return `
    <div class="question-review ${correct ? "correct" : "incorrect"}" data-question-review>
      <div class="review-heading">
        <span class="status-pill ${correct ? "done" : "todo"}">${correct ? "正确" : "需复盘"}</span>
        <strong>第 ${index + 1} 题答案解析</strong>
        <span class="question-score-pill">${escapeHtml(quizQuestionScoreLabel(question, result))}</span>
      </div>
      ${renderReviewBlock("你的选择", formatAnswerValuesHtml(question, result.response))}
      ${correct
        ? `${renderReviewBlock("正确答案", formatAnswerValuesHtml(question, correctAnswer), "correct-answer")}
          ${renderAnalysisBlock(analysis)}`
        : `<div class="coach-hint-box" data-coach-hint>
            <div class="coach-hint-content">
              <strong>学习建议</strong>
              <p><b>题目焦点：</b>${renderQuestionTextWithLinks(question, unit)}</p>
              <p><b>你的选择：</b>${renderInlineMath(coach.selectedText)}</p>
              <p><b>先复盘：</b>这题主要卡在 <em>${escapeHtml(coach.conceptText)}</em>。${escapeHtml(coach.misconception)}</p>
              <p><b>行动建议：</b>${actionAdvice}</p>
            </div>
          </div>
          <button class="button soft coach-reveal-btn" type="button" data-reveal-answer>显示正确答案和解析</button>
          <div class="question-answer-hidden" data-answer-hidden style="display:none">
            ${renderReviewBlock("正确答案", formatAnswerValuesHtml(question, correctAnswer), "correct-answer")}
            ${renderAnalysisBlock(analysis)}
          </div>`
      }
      ${renderQuizCoverage(question, unit)}
    </div>
  `;
}

async function retryFailedShortAnswer(unitId = "", questionId = "") {
  const unit = getUnit(unitId);
  if (!unit?.id || !questionId) return false;
  const trackRegrade = (eventType, data = {}) => {
    if (typeof analyticsTrack !== "function") return;
    analyticsTrack(eventType, {
      source: "quiz",
      data: { unitId: unit.id, questionId, ...data }
    });
  };
  trackRegrade("short_answer_regrade_requested");
  const payload = await apiRequest("api/learning/grade", {
    unitId: unit.id,
    questions: [{ questionId }]
  }, { timeoutMs: 12000 });
  if (Array.isArray(payload?.results) && typeof agenticApplyGradingResults === "function") {
    agenticApplyGradingResults(payload.results, unit);
  }
  const result = (payload?.results || []).find((item) => item.questionId === questionId) || null;
  if (!result) {
    trackRegrade("short_answer_regrade_failed", { reason: "empty_response" });
    if (unit.id === currentUnitId) renderQuiz(unit);
    addLog(`「${unit.label}」中的简答题没有收到有效的重新批改结果。`);
    return false;
  }
  const failed = result && typeof QuizReviewState !== "undefined"
    ? QuizReviewState.FAILURE_TYPES.has(String(result.errorType || "").toLowerCase())
    : Boolean(result?.errorType && result.errorType !== "none");
  if (failed) {
    trackRegrade("short_answer_regrade_failed", {
      reason: result.errorType || "grading_failed"
    });
    if (unit.id === currentUnitId) renderQuiz(unit);
    addLog(`「${unit.label}」中的简答题重新批改仍未完成。`);
    return false;
  }

  const path = typeof ensureAgenticPath === "function" ? ensureAgenticPath() : null;
  if (
    path?.pendingPlan?.unitId === unit.id
    && path.pendingPlan.phase !== "grading_pending"
    && typeof agenticBuildRecommendationAfterGrading === "function"
  ) {
    await agenticBuildRecommendationAfterGrading(
      unit,
      typeof agenticQuizRecordsForUnit === "function" ? agenticQuizRecordsForUnit(unit.id) : [],
      null
    );
  }
  if (unit.id === currentUnitId) renderQuiz(unit);
  trackRegrade("short_answer_regrade_succeeded", {
    score: result.score,
    confidence: result.confidence,
    provider: result.provider || ""
  });
  addLog(`「${unit.label}」中的简答题已重新批改。`);
  return true;
}

function revealQuestionAnswer(button) {
  const card = button?.closest("[data-question]");
  if (!card) return false;
  const answerHidden = card.querySelector("[data-answer-hidden]");
  if (!answerHidden) return false;
  const coachHint = card.querySelector("[data-coach-hint]");
  answerHidden.style.display = "";
  if (coachHint) coachHint.style.display = "none";
  button.style.display = "none";
  analyticsTrack("quiz_answer_revealed", {
    source: "quiz",
    data: {
      unitId: getUnit()?.id || "",
      questionId: card.dataset.question || "",
      phase: getUnit()?.assessmentPhase || ""
    }
  });
  return true;
}

function showQuizReview(unit, records) {
  records.forEach((record) => {
    const card = document.querySelector(`[data-question="${record.question.id}"]`);
    if (!card) return;
    card.querySelector("[data-question-review]")?.remove();
    card.querySelector("[data-coach-hint]")?.remove();
    card.querySelector(".coach-reveal-btn")?.remove();
    card.insertAdjacentHTML("beforeend", renderQuestionReview({ ...record, unit }));
    const revealBtn = card.querySelector("[data-reveal-answer]");
    if (revealBtn) revealBtn.addEventListener("click", function() { revealQuestionAnswer(revealBtn); });
  });
  analyticsTrack("quiz_review_shown", {
    source: "quiz",
    data: {
      unitId: unit.id,
      phase: unit.assessmentPhase || "",
      questionCount: records.length
    }
  });
}
function setupQuizVisibilityTracking(unit) {
  const cards = Array.from(document.querySelectorAll(`[data-question]`));
  if (!cards.length || typeof IntersectionObserver === "undefined") return;
  const seen = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const questionId = entry.target.dataset.question;
      if (!questionId || seen.has(questionId)) return;
      seen.add(questionId);
      analyticsTrack("question_visible", {
        source: "quiz",
        data: {
          unitId: unit.id,
          chapterId: unit.chapterId,
          phase: unit.assessmentPhase || "",
          questionId
        }
      });
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.55 });
  cards.forEach((card) => observer.observe(card));
}

function jumpToFeedback(unitId) {
  const banner = document.querySelector(`#quiz-top-banner-${unitId}`);
  if (banner) {
    banner.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const feedback = document.querySelector(`#feedback-${unitId}`);
  if (feedback) {
    feedback.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function quizResourceReviewContext(unitId = currentUnitId) {
  const context = state.returnToQuiz;
  if (!context?.unitId || !context?.targetUnitId || context.targetUnitId !== unitId) return null;
  const quizUnit = getUnit(context.unitId);
  return quizUnit ? { ...context, quizUnit } : null;
}

function findNavTargets(unitId) {
  const previous = typeof agenticPreviousUnlockedUnitBefore === "function"
    ? agenticPreviousUnlockedUnitBefore(unitId)
    : null;
  const next = typeof agenticNextUnlockedUnitAfter === "function"
    ? agenticNextUnlockedUnitAfter(unitId)
    : null;
  return {
    prevId: previous?.id || null,
    nextId: next?.id || null
  };
}

function renderQuizPathNavigation(unit) {
  const { prevId, nextId } = findNavTargets(unit.id);
  const pending = typeof agenticIsCurrentPending === "function" && agenticIsCurrentPending(unit.id);
  const pathReady = typeof agenticQuizPathReady !== "function" || agenticQuizPathReady(unit);
  const nextUnit = nextId ? getUnit(nextId) : null;
  const nextLabel = nextUnit?.chapterId && nextUnit.chapterId !== unit.chapterId ? "进入下一章" : "下一节";
  const nextButton = pending
    ? '<button class="button primary quiz-nav-btn" type="button" data-quiz-path-action="coach">选择下一步</button>'
    : nextId
      ? `<button class="button primary quiz-nav-btn" type="button" data-unit="${escapeHtml(nextId)}">${nextLabel}</button>`
      : !pathReady
        ? '<button class="button primary quiz-nav-btn" type="button" disabled>正在生成学习建议</button>'
        : '<button class="button primary quiz-nav-btn" type="button" disabled>当前路径已完成</button>';
  return `
    <div class="quiz-nav-buttons">
      <button class="button soft quiz-nav-btn" type="button" data-unit="${escapeHtml(prevId || "")}" ${prevId ? "" : "disabled"}>上一节</button>
      ${nextButton}
    </div>
  `;
}

async function submitQuiz(unitId) {
  if ((state.submittedQuizzes || []).includes(unitId)) return;
  if (submitInProgress === unitId) return;
  submitInProgress = unitId;
  let feedback = null;
  let submitButton = null;
  try {
  const unit = getUnit(unitId);
  if (!unit?.scene?.content?.questions) return;
  if (
    typeof agenticUnitCompletionAllowed === "function"
    && !agenticUnitCompletionAllowed(unit.id)
  ) {
    feedback = document.querySelector(`#feedback-${unit.id}`);
    if (feedback) feedback.textContent = "该测验当前仅供预览；接受学习建议后才能提交并记录本节。";
    return;
  }
  const questions = unit.scene.content.questions;
  feedback = document.querySelector(`#feedback-${unit.id}`);
  const missing = [];
  const submissions = [];

  questions.forEach((question, index) => {
    if (question.type === "short_answer") {
      const textarea = document.querySelector(`textarea[name="${unit.id}-${question.id}"]`);
      const response = (textarea?.value || readQuizDraft(unit.id, question.id, "")).trim();

      if (!response) {
        missing.push(index + 1);
        return;
      }

      rememberQuizDraft(unit.id, question.id, response);
      submissions.push({
        index,
        question,
        response
      });
      return;
    }

    const selected = selectedChoiceValues(unit.id, question.id);
    if (!selected.length) {
      missing.push(index + 1);
      return;
    }

    const response = question.type === "multiple" ? selected : selected[0];
    rememberQuizDraft(unit.id, question.id, question.type === "multiple" ? selected : selected[0]);
    submissions.push({
      index,
      question,
      response
    });
  });

  if (missing.length) {
    analyticsTrack("quiz_submit_blocked", {
      source: "quiz",
      data: {
        unitId: unit.id,
        chapterId: unit.chapterId,
        phase: unit.assessmentPhase || "",
        missingQuestions: missing
      }
    });
    if (feedback) feedback.textContent = `还有第 ${missing.join("、")} 题未作答，补齐后再提交。`;
    return;
  }

  submitButton = feedback?.closest(".quiz-submit-panel")?.querySelector("[data-submit-quiz]") || null;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "正在提交";
  }
  if (feedback) feedback.textContent = "正在由服务器核对答案...";
  const submitted = await apiRequest("/api/learning/quiz/submit", {
    unitId: unit.id,
    chapterId: unit.chapterId,
    phase: unit.assessmentPhase || "",
    answers: submissions.map(({ question, response }) => ({
      questionId: question.id,
      response
    }))
  });
  const authoritative = new Map(
    (submitted.results || []).map((result) => [result.questionId, result])
  );
  const records = submissions.map(({ index, question, response }) => {
    const result = authoritative.get(question.id);
    if (!result) throw new Error(`题目 ${question.id} 缺少服务端评分结果。`);
    const review = {
      answer: result.answer,
      analysis: result.analysis || "",
      commentPrompt: result.commentPrompt || ""
    };
    Object.assign(question, review);
    return {
      index,
      question,
      result: {
        id: result.id,
        mode: result.questionType || question.type,
        response: result.response ?? response,
        isCorrect: result.isCorrect,
        status: result.status,
        score: result.score,
        maxScore: result.maxScore,
        timestamp: result.timestamp,
        ...review
      }
    };
  });

  // Clear old results for this quiz to avoid duplicate counting
  state.quizResults = (state.quizResults || []).filter(r => r.unitId !== unit.id);
  const storedRecords = records.map(({ question, result, index }) =>
    recordQuizResult(unit, question, result, { sync: false, track: false, index })
  );
  rememberQuizAttempt(unit, storedRecords);
  trackLearningEvent("quiz_submission", {
    unitId: unit.id,
    chapterId: unit.chapterId,
    unitLabel: unit.label,
    phase: unit.assessmentPhase || "",
    questionCount: records.length,
    pendingReview: records.filter(({ result }) => quizReviewIsPending(result)).length,
    correct: records.filter(({ result }) => result.isCorrect === true).length,
    incorrect: records.filter(({ result }) => result.isCorrect === false).length
  });
  analyticsTrack("quiz_submit_success", {
    source: "quiz",
    data: {
      unitId: unit.id,
      chapterId: unit.chapterId,
      unitLabel: unit.label,
      phase: unit.assessmentPhase || "",
      questionCount: records.length,
      pendingReview: records.filter(({ result }) => quizReviewIsPending(result)).length,
      correct: records.filter(({ result }) => result.isCorrect === true).length,
      incorrect: records.filter(({ result }) => result.isCorrect === false).length
    }
  });
  state.submittedQuizzes = state.submittedQuizzes || [];
  if (!state.submittedQuizzes.includes(unit.id)) state.submittedQuizzes.push(unit.id);
  if (!state.completed.includes(unit.id)) {
    state.completed.push(unit.id);
    addLog(`提交并完成「${unit.label}」。`);
  }
  saveState();
  // Lock all answer controls to prevent modification after submission
  document.querySelectorAll(`[data-question]`).forEach(card => {
    card.querySelectorAll("input, textarea").forEach(el => el.disabled = true);
  });
  showQuizReview(unit, records);
  if (feedback) {
    feedback.closest(".quiz-submit-panel")?.classList.add("submitted");
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = "已提交"; }
  }
  const isPre = unit.assessmentPhase === "pre";
  // Banner + scroll hint at top of quiz card
  const quizCard = feedback ? feedback.closest(".quiz-card") : null;
  if (quizCard) {
    const existingBanner = quizCard.querySelector(".quiz-encouragement-banner");
    if (existingBanner) existingBanner.remove();
    const existingHint = quizCard.querySelector(".quiz-scroll-hint");
    if (existingHint) existingHint.remove();
    const summary = summarizeQuizAttempt(records, questions);
    const outcomeHtml = quizOutcomeHtml(summary);
    const isPost = unit.assessmentPhase === "post";
    if (isPre) {
      quizCard.insertAdjacentHTML("afterbegin", `<div class="quiz-encouragement-banner" id="quiz-top-banner-${unitId}">前测已提交：${outcomeHtml}。</div><p class="quiz-scroll-hint">先看学习建议，答错的题再看解析。</p>`);
    } else if (isPost) {
      quizCard.insertAdjacentHTML("afterbegin", `<div class="quiz-encouragement-banner post" id="quiz-top-banner-${unitId}">后测已提交：${outcomeHtml}。</div><p class="quiz-scroll-hint">先看学习建议，答错的题再看解析。</p>`);
    } else {
      quizCard.insertAdjacentHTML("afterbegin", `<div class="quiz-encouragement-banner formative" id="quiz-top-banner-${unitId}">形成性测验已提交：${outcomeHtml}。</div><p class="quiz-scroll-hint">先看学习建议，答错的题再看解析。</p>`);
    }
  }

  // Navigation buttons in the submit panel
  if (feedback) {
    const currentSummary = summarizeQuizAttempt(state.quizResults.filter((r) => r.unitId === unit.id), questions);
    const totalLine = quizOutcomeHtml(currentSummary);
    feedback.innerHTML = `
    <div class="quiz-section-total">${totalLine}</div>
    ${renderQuizPathNavigation(unit)}
  `;
  }

  addLog(`提交「${unit.label}」整页测验：${records.length} 题已记录。`);
  renderProgress();
  renderRecommendationPanel();
  renderLibrary();
  window.setTimeout(function() { jumpToFeedback(unitId); }, 300);
  if ((unit.assessmentPhase === "pre" || unit.assessmentPhase === "post" || unit.assessmentPhase === "formative") && typeof agenticAfterQuizSubmit === "function") {
    Promise.resolve(agenticAfterQuizSubmit(unit, records)).catch((error) => {
      console.warn("Agentic quiz follow-up failed:", error);
      if (typeof agenticMarkGradingRecoveryAvailable === "function") {
        agenticMarkGradingRecoveryAvailable(unit, error);
      }
    });
  } else if (typeof agenticOnUnitCompleted === "function") {
    agenticOnUnitCompleted(unit);
  }
  } catch (error) {
    console.warn("Quiz submission failed:", error);
    if (feedback) feedback.textContent = error.message || "测验提交失败，请稍后重试。";
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "提交本次测验";
    }
  } finally {
    submitInProgress = null;
  }
}

function recordQuizResult(unit, question, result, options = {}) {
  state.quizResults = state.quizResults || [];
  const chapter = getChapter(unit.chapterId);
  const record = {
    id: `${unit.id}-${question.id}-${Date.now()}`,
    unitId: unit.id,
    questionId: question.id,
    questionIndex: Number.isFinite(options.index) ? options.index : null,
    questionText: displayQuestionText(question),
    chapterId: unit.chapterId,
    chapterLabel: chapter.label,
    unitLabel: unit.label,
    questionType: question.type,
    moduleId: question.moduleId || "",
    moduleTitle: question.moduleTitle || "",
    knowledgePointIds: question.knowledgePointIds || question.coachHint?.knowledgePointIds || [],
    concepts: questionConceptTags(question),
    points: question.points || 0,
    phase: unit.assessmentPhase || "",
    timestamp: beijingNow(),
    ...result
  };

  state.quizResults.unshift(record);
  state.quizResults = state.quizResults.slice(0, 200);
  if (options.sync !== false) saveState();
  if (options.track !== false) trackLearningEvent("quiz_result", record, options.sync !== false);
  return record;
}

els.completeLesson.addEventListener("click", completeAndAdvanceCurrentUnit);

async function goToPrevUnit() {
  const previous = typeof agenticPreviousUnlockedUnitBefore === "function"
    ? agenticPreviousUnlockedUnitBefore(currentUnitId)
    : null;
  if (!previous?.id) {
    addLog("这里是当前学习路线的第一节。");
    return;
  }
  if (typeof agenticGuardNavigation === "function" && !agenticGuardNavigation(previous.id, { allowPrevious: true })) return;
  if (typeof agenticOpenUnit === "function") await agenticOpenUnit(previous.id);
}

async function goToNextUnit() {
  if (typeof agenticCanLeaveCurrent === "function" && !agenticCanLeaveCurrent()) {
    addLog("请先在学习建议卡片中选择下一步，再继续下一关。");
    if (typeof focusAgenticCoachPanel === "function") focusAgenticCoachPanel();
    else if (typeof renderAgenticCoachPanel === "function") renderAgenticCoachPanel();
    return;
  }
  const next = typeof agenticNextUnlockedUnitAfter === "function"
    ? agenticNextUnlockedUnitAfter(currentUnitId)
    : null;
  if (!next?.id) {
    const unit = getUnit();
    if (unit?.type === "quiz" && typeof agenticQuizPathReady === "function" && !agenticQuizPathReady(unit)) {
      addLog("学习建议正在生成，请稍候片刻。");
      if (typeof focusAgenticCoachPanel === "function") focusAgenticCoachPanel();
      return;
    }
    addLog("当前没有已解锁的下一节，请先完成本节或确认学习建议。");
    return;
  }
  if (typeof agenticGuardNavigation === "function" && !agenticGuardNavigation(next.id, { allowPrevious: true })) return;
  if (typeof agenticOpenUnit === "function") await agenticOpenUnit(next.id);
}

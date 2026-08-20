const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app/main/agentic-path.js"), "utf8");
const bootstrapSource = fs.readFileSync(path.join(root, "app/main/bootstrap.js"), "utf8");
const navigationSource = fs.readFileSync(path.join(root, "app/main/navigation.js"), "utf8");
assert.match(source, /const activeExtensionResume = agenticActiveExtensionResumeForPhase\(path, unit\.chapterId, phase\)/);
assert.match(source, /const leavingExtensionChapter =\s*pending\.phase === "post"/);
assert.doesNotMatch(source, /post_extension_resume_ready/);
assert.doesNotMatch(source, /post_extension_chapter_unlocked/);

function unit(id, chapterId, sceneOrder, type = "knowledge", assessmentPhase = "") {
  return {
    id,
    chapterId,
    sceneOrder,
    type,
    assessmentPhase,
    label: id
  };
}

const c1 = {
  id: "C1",
  label: "第一章",
  order: 1,
  track: "main",
  units: [
    unit("C1-pre", "C1", 1, "quiz", "pre"),
    unit("C1-k1", "C1", 2),
    unit("C1-formative", "C1", 3, "quiz", "formative"),
    unit("C1-k2", "C1", 4),
    unit("C1-post", "C1", 5, "quiz", "post")
  ]
};
const c2 = {
  id: "C2",
  label: "第二章",
  order: 2,
  track: "main",
  units: [
    unit("C2-pre", "C2", 1, "quiz", "pre"),
    unit("C2-k1", "C2", 2),
    unit("C2-post", "C2", 3, "quiz", "post")
  ]
};
const x1 = {
  id: "X1",
  label: "扩展章",
  order: 3,
  track: "extension",
  extension: true,
  recommendedAfter: "C1",
  units: [
    unit("X1-pre", "X1", 1, "quiz", "pre"),
    unit("X1-k1", "X1", 2),
    unit("X1-post", "X1", 3, "quiz", "post")
  ]
};
const curriculum = [c1, c2, x1];
const analyticsEvents = [];

function learningState(overrides = {}) {
  return {
    completed: [],
    submittedQuizzes: [],
    quizResults: [],
    quizAttempts: {},
    selectedKnowledgeScenes: {},
    logs: [],
    agenticPath: null,
    ...overrides
  };
}

const context = vm.createContext({
  console,
  curriculum,
  chapters: curriculum,
  state: learningState(),
  currentChapterId: "C1",
  currentUnitId: "C1-pre",
  AGENTIC_CORE_SCENE_ORDERS: [1, 2, 3, 4, 6, 7, 8, 9, 10, 15],
  AGENTIC_RELEARN_SCENE_ORDERS: [5, 11, 12],
  AGENTIC_EXTENSION_SCENE_ORDERS: [13, 14],
  AGENTIC_ENABLE_EXTENSION: false,
  isMultiSceneLearningRoute: () => true,
  getChapter(id) {
    const chapterId = id || context.currentChapterId;
    return curriculum.find((chapter) => chapter.id === chapterId) || null;
  },
  findMainUnit(id) {
    return curriculum.flatMap((chapter) => chapter.units).find((item) => item.id === id) || null;
  },
  getUnit(id) {
    const unitId = id || context.currentUnitId;
    return context.findMainUnit(unitId);
  },
  quizResourceReviewContext(unitId) {
    const review = context.state.returnToQuiz;
    if (!review?.unitId || review.targetUnitId !== unitId) return null;
    return { ...review, quizUnit: context.getUnit(review.unitId) };
  },
  chapterStats: () => ({ scenes: 3 }),
  addLog: () => {},
  analyticsTrack: (eventType, payload) => analyticsEvents.push({ eventType, payload }),
  trackLearningEvent: () => {},
  quizReviewIsPending: (result = {}) => result.status === "pending_review" || result.isCorrect === null,
  saveState: () => {},
  renderAll: () => {},
  renderAgenticCoachPanel: () => {},
  beijingNow: () => "2026-07-22T12:00:00.000+08:00",
  escapeHtml: (value) => String(value || "")
});
context.ensureChapterLoaded = async () => {};
context.selectChapter = async (chapterId) => {
  context.currentChapterId = chapterId;
  return true;
};
context.selectUnit = (unitId) => {
  const target = context.findMainUnit(unitId);
  if (!target) return false;
  context.currentChapterId = target.chapterId;
  context.currentUnitId = target.id;
  return true;
};

vm.runInContext(source, context, { filename: "app/main/agentic-path.js" });
context.renderAgenticCoachPanel = () => {};
context.agenticRenderLearningUpdate = () => {};

function reset({ state, chapterId, unitId }) {
  analyticsEvents.length = 0;
  context.state = learningState(state);
  context.currentChapterId = chapterId;
  context.currentUnitId = unitId;
}

reset({
  chapterId: "C2",
  unitId: "C2-k1",
  state: {
    completed: ["C2-k1"],
    agenticPath: {
      unlocked: ["C2-k1"],
      visibleUnits: ["C2-k1"],
      activeExtensionChapter: {
        chapterId: "X1",
        fromChapterId: "C1",
        fromUnitId: "C1-post",
        resumeUnitId: "C2-pre"
      },
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.currentChapterId, "C2", "real later-chapter evidence must preserve the learner position");
assert.equal(
  context.state.agenticPath.chapterAdvanceReady.C1,
  true,
  "later-chapter evidence must backfill prerequisite chapter access"
);
assert.equal(
  context.state.agenticPath.activeExtensionChapter,
  null,
  "later-chapter evidence must retire a stale extension lock from an older snapshot"
);

reset({
  chapterId: "C2",
  unitId: "C2-pre",
  state: {
    agenticPath: {
      unlocked: ["C1-pre", "C2-pre"],
      visibleUnits: ["C1-pre", "C2-pre"],
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.currentChapterId, "C2", "free browsing must preserve a valid future-chapter position");
assert.equal(
  context.state.agenticPath.unlocked.includes("C2-pre"),
  true,
  "path reconciliation must not erase a historical unlock record"
);
assert.equal(
  context.agenticUnitCompletionAllowed("C2-pre"),
  false,
  "a historical future-chapter unlock without advance evidence must remain preview-only"
);

reset({
  chapterId: "C1",
  unitId: "C1-pre",
  state: {
    agenticPath: {
      unlocked: ["C1-pre"],
      visibleUnits: ["C1-pre"],
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.deepEqual(
  Array.from(context.agenticVisibleChaptersForNav(), (entry) => entry.chapter.id),
  ["C1", "X1", "C2"],
  "all main and extension chapters must stay visible in the chapter rail"
);
assert.equal(context.agenticDisplayUnitsForChapter(x1).length, x1.units.length, "locked extension lessons must remain browseable");
assert.equal(context.agenticIsUnitUnlocked("C2-k1"), false, "free browsing must not silently unlock the inspected lesson");
assert.equal(context.agenticGuardNavigation("C2-k1", { allowPrevious: true }), true, "locked lessons must be openable for browsing");
context.currentChapterId = "C2";
context.currentUnitId = "C2-k1";
const lockedPreviewCta = context.agenticCompletionCta(context.getUnit("C2-k1"));
assert.equal(lockedPreviewCta.disabled, true, "an unrecommended preview must not be completable");
assert.match(lockedPreviewCta.label, /未解锁/);

reset({
  chapterId: "C1",
  unitId: "C1-formative",
  state: {
    completed: ["C1-pre", "C1-formative"],
    submittedQuizzes: ["C1-pre", "C1-formative"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-formative", "C1-k2"],
      visibleUnits: ["C1-pre", "C1-formative", "C1-k2"],
      pendingPlan: {
        unitId: "C1-formative",
        anchorUnitId: "C1-formative",
        chapterId: "C1",
        phase: "formative",
        actions: [{ type: "continue", label: "继续主线", units: [] }]
      },
      pendingAt: "C1-formative",
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
assert.equal(context.agenticGuardNavigation("C1-k2", { allowPrevious: true }), true, "pending paths must still allow preview navigation");
assert.equal(context.agenticUnitCompletionAllowed("C1-k2"), false, "an unresolved recommendation must block completing a later lesson");

reset({
  chapterId: "C1",
  unitId: "C1-k2",
  state: {
    completed: ["C1-pre"],
    submittedQuizzes: ["C1-pre"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-k2"],
      visibleUnits: ["C1-pre", "C1-k2"],
      skipped: { "C1-k2": true },
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
assert.equal(context.agenticUnitCompletionAllowed("C1-k2"), false, "a skipped lesson must stay preview-only even if an old snapshot marked it unlocked");

reset({
  chapterId: "C1",
  unitId: "C1-k1",
  state: {
    completed: ["C1-k1"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-k1"],
      visibleUnits: ["C1-pre", "C1-k1"],
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.state.agenticPath.unlocked.includes("C1-formative"), true, "historical completion must restore the next formative unit");
assert.equal(context.state.agenticPath.visibleUnits.includes("C1-formative"), true, "the recovered unit must remain visible in the chapter path");
assert.equal(context.state.completed.includes("C1-formative"), false, "recovery must not mark the next unit completed");
assert.deepEqual(
  JSON.parse(JSON.stringify(context.agenticCompletionCta(context.getUnit("C1-k1")))),
  { label: "复习并跳到下一节", disabled: false },
  "a completed non-final unit must no longer be rendered as course-complete"
);

reset({
  chapterId: "X1",
  unitId: "X1-k1",
  state: {
    completed: ["X1-k1"],
    agenticPath: {
      unlocked: ["X1-pre", "X1-k1"],
      visibleUnits: ["X1-pre", "X1-k1"],
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.state.agenticPath.unlocked.includes("X1-post"), true, "extension units must use the same sequential recovery rule");
assert.equal(context.state.completed.includes("X1-post"), false, "extension recovery must not create completion evidence");

reset({
  chapterId: "C1",
  unitId: "C1-k1",
  state: {
    completed: ["C1-k1"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-k1"],
      visibleUnits: ["C1-pre", "C1-k1"],
      skipped: { "C1-formative": true },
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.state.agenticPath.unlocked.includes("C1-formative"), false, "an explicitly skipped unit must not be restored");
assert.equal(context.state.agenticPath.unlocked.includes("C1-k2"), true, "recovery must continue to the first unskipped unit after a skip");

reset({
  chapterId: "C1",
  unitId: "C1-k1",
  state: {
    completed: ["C1-k1"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-k1"],
      visibleUnits: ["C1-pre", "C1-k1"],
      pendingPlan: {
        unitId: "C1-post",
        anchorUnitId: "C1-post",
        chapterId: "C1",
        phase: "post",
        actions: [{ type: "scene", units: [{ id: "C1-formative" }] }]
      },
      pendingAt: "C1-post",
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.state.agenticPath.unlocked.includes("C1-formative"), false, "a pending student choice must take priority over automatic recovery");

reset({
  chapterId: "C1",
  unitId: "C1-post",
  state: {
    completed: ["C1-post"],
    submittedQuizzes: ["C1-post"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-post"],
      visibleUnits: ["C1-pre", "C1-post"],
      chapterAdvanceReady: { C1: true, "C1-post": true },
      chapterAdvanceReasons: {}
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.state.agenticPath.unlocked.includes("C2-pre"), false, "same-chapter recovery must not unlock the next chapter");

reset({
  chapterId: "C1",
  unitId: "C1-k1",
  state: {
    completed: ["C1-pre", "C1-k1", "C1-formative"],
    submittedQuizzes: ["C1-pre", "C1-formative"],
    returnToQuiz: {
      unitId: "C1-formative",
      targetUnitId: "C1-k1",
      questionId: "q-review"
    },
    agenticPath: {
      unlocked: ["C1-pre", "C1-k1", "C1-formative"],
      visibleUnits: ["C1-pre", "C1-k1", "C1-formative"],
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
const quizReviewCta = context.agenticCompletionCta(context.getUnit("C1-k1"));
assert.deepEqual(
  JSON.parse(JSON.stringify(quizReviewCta)),
  { label: "返回测验", disabled: false },
  "courseware opened from a quiz review must return to the quiz instead of generating another path"
);

reset({
  chapterId: "X1",
  unitId: "X1-pre",
  state: {
    completed: ["C1-post"],
    submittedQuizzes: ["C1-post"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-post", "X1-pre"],
      visibleUnits: ["C1-pre", "C1-post", "X1-pre"],
      chapterAdvanceReady: { C1: true, "C1-post": true },
      chapterAdvanceReasons: {},
      activeExtensionChapter: {
        chapterId: "X1",
        fromChapterId: "C1",
        fromUnitId: "C1-post",
        resumeUnitId: "C2-pre"
      }
    }
  }
});
context.ensureAgenticPath();
assert.equal(context.agenticExtensionChapterVisible("X1", context.state.agenticPath), true);
assert.equal(
  context.agenticChapterUnlockedBySequence("C2"),
  false,
  "choosing an extension must keep the next main chapter locked until the extension finishes"
);
assert.equal(context.agenticActiveExtensionResumeForPhase(context.state.agenticPath, "X1", "pre"), "");
assert.equal(context.agenticActiveExtensionResumeForPhase(context.state.agenticPath, "X1", "formative"), "");
assert.equal(context.agenticActiveExtensionResumeForPhase(context.state.agenticPath, "X1", "post"), "C2-pre");
context.currentChapterId = "C1";
context.currentUnitId = "C1-post";
assert.equal(context.agenticNextUnlockedUnitAfter("C1-post")?.id, "X1-pre");
const continueExtensionCta = context.agenticCompletionCta(context.getUnit("C1-post"));
assert.equal(continueExtensionCta.label, "继续扩展学习");
assert.equal(continueExtensionCta.disabled, false);
context.currentChapterId = "X1";
context.currentUnitId = "X1-pre";

const extensionPath = context.state.agenticPath;
context.agenticFinalizeActiveExtensionChapter(extensionPath, "X1", "extension_completed", { keepResume: true });
context.agenticUnlockUnit("C2-pre", "extension_resume_ready");
context.state.completed.push("X1-post");
context.currentUnitId = "X1-post";
assert.equal(extensionPath.chapterAdvanceReady.C1, true);
assert.equal(extensionPath.activeExtensionChapter.completed, true);
assert.equal(context.agenticChapterUnlockedBySequence("C2"), true);
assert.equal(context.agenticNextUnlockedUnitAfter("X1-post")?.id, "C2-pre");
assert.equal(
  context.agenticDetourResumeUnitId(
    { unitId: "C2-post", anchorUnitId: "C2-post", phase: "post", resumeUnitId: "" },
    "C2-post"
  ),
  "C2-post",
  "a final-chapter detour must return to the final main post-test"
);

reset({
  chapterId: "C1",
  unitId: "C1-pre",
  state: {
    agenticPath: {
      unlocked: ["C1-pre"],
      visibleUnits: ["C1-pre"],
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
assert.equal(context.agenticPreviousUnlockedUnitBefore("C1-pre"), null, "the first course unit must not expose a previous target");

reset({
  chapterId: "C1",
  unitId: "C1-k1",
  state: {
    completed: ["C1-k1"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-k1", "C1-formative", "C1-post"],
      visibleUnits: ["C1-pre", "C1-k1", "C1-formative", "C1-post"],
      chapterAdvanceReady: {},
      chapterAdvanceReasons: {}
    }
  }
});
const reviewCta = context.agenticCompletionCta(context.getUnit("C1-k1"));
assert.equal(reviewCta.label, "复习并跳到下一节");
assert.equal(reviewCta.disabled, false);

reset({
  chapterId: "C2",
  unitId: "C2-post",
  state: {
    completed: ["C1-post", "C2-post"],
    submittedQuizzes: ["C1-post", "C2-post"],
    agenticPath: {
      unlocked: ["C1-pre", "C1-post", "C2-pre", "C2-post"],
      visibleUnits: ["C1-pre", "C1-post", "C2-pre", "C2-post"],
      chapterAdvanceReady: {
        C1: true,
        "C1-post": true,
        C2: true,
        "C2-post": true
      },
      chapterAdvanceReasons: {}
    }
  }
});
const finalCta = context.agenticCompletionCta(context.getUnit("C2-post"));
assert.equal(finalCta.label, "课程已完成");
assert.equal(finalCta.disabled, true);

function postChoicePlan() {
  return {
    unitId: "C1-post",
    anchorUnitId: "C1-post",
    chapterId: "C1",
    phase: "post",
    resumeUnitId: "C2-pre",
    actions: [
      {
        type: "review_knowledge",
        label: "选择回看知识点",
        primary: true,
        units: [{ id: "C1-k1", label: "第一章知识点", reviewMode: "review" }]
      },
      {
        type: "extension_chapter",
        actionKey: "extension_chapter:X1",
        label: "推荐扩展：扩展章",
        units: [{ id: "X1-pre", chapterId: "X1", label: "扩展章" }],
        extensionChapterId: "X1",
        extensionChapterIds: ["X1"]
      },
      { type: "continue", label: "进入下一章", units: [] }
    ],
    createdAt: "2026-07-22T12:00:00.000+08:00"
  };
}

function resetPostChoiceFlow() {
  const pendingPlan = postChoicePlan();
  reset({
    chapterId: "C1",
    unitId: "C1-post",
    state: {
      completed: ["C1-k1", "C1-post"],
      submittedQuizzes: ["C1-post"],
      agenticPath: {
        unlocked: ["C1-pre", "C1-k1", "C1-post"],
        visibleUnits: ["C1-pre", "C1-k1", "C1-post"],
        pendingPlan,
        pendingAt: "C1-post",
        chapterAdvanceReady: {},
        chapterAdvanceReasons: {}
      }
    }
  });
  context.ensureAgenticPath();
  assert.equal(
    context.agenticGuardNavigation("C2-pre", { allowPrevious: true }),
    true,
    "a pending Agent recommendation must not block opening other lessons for preview"
  );
}

async function testDeferredReviewAndExtensionFlows() {
  resetPostChoiceFlow();
  await context.agenticApplyDecision("extension_chapter", "extension_chapter:X1");
  let pathState = context.state.agenticPath;
  assert.equal(context.currentUnitId, "X1-pre");
  assert.ok(pathState.deferredReviewPlan, "choosing extension first must preserve the review plan");
  assert.equal(context.agenticChapterUnlockedBySequence("C2"), false);

  pathState.pendingPlan = {
    unitId: "X1-pre",
    anchorUnitId: "X1-pre",
    chapterId: "X1",
    phase: "pre",
    resumeUnitId: "X1-k1",
    actions: [{ type: "continue", label: "继续扩展学习", units: [] }],
    createdAt: "2026-07-22T12:01:00.000+08:00"
  };
  pathState.pendingAt = "X1-pre";
  await context.agenticApplyDecision("continue");
  assert.equal(context.currentUnitId, "X1-k1", "extension pre-test continue must stay inside the extension chapter");
  assert.equal(pathState.activeExtensionChapter?.chapterId, "X1");

  context.agenticUnlockUnit("X1-post", "test_extension_post");
  context.currentChapterId = "X1";
  context.currentUnitId = "X1-post";
  pathState.pendingPlan = {
    unitId: "X1-post",
    anchorUnitId: "X1-post",
    chapterId: "X1",
    phase: "post",
    resumeUnitId: "C2-pre",
    actions: [{ type: "continue", label: "完成扩展", units: [] }],
    createdAt: "2026-07-22T12:02:00.000+08:00"
  };
  pathState.pendingAt = "X1-post";
  await context.agenticApplyDecision("continue");
  pathState = context.state.agenticPath;
  assert.equal(pathState.activeExtensionChapter, null);
  assert.equal(pathState.pendingPlan?.actions?.[0]?.type, "review_knowledge");
  assert.equal(context.agenticChapterUnlockedBySequence("C2"), false);

  await context.agenticApplyDecision("review_knowledge");
  assert.equal(context.currentUnitId, "C1-k1");
  const reviewReturn = context.agenticOnUnitCompleted(context.getUnit("C1-k1"));
  assert.equal(reviewReturn?.id, "C2-pre");
  assert.equal(context.state.agenticPath.chapterAdvanceReady.C1, true);
  assert.equal(context.agenticChapterUnlockedBySequence("C2"), true);

  resetPostChoiceFlow();
  await context.agenticApplyDecision("review_knowledge");
  pathState = context.state.agenticPath;
  assert.equal(context.currentUnitId, "C1-k1");
  assert.ok(pathState.deferredExtensionPlan, "choosing review first must preserve the extension plan");
  assert.equal(context.agenticOnUnitCompleted(context.getUnit("C1-k1")), null);
  assert.equal(pathState.pendingPlan?.actions?.some((action) => action.type === "extension_chapter"), true);

  await context.agenticApplyDecision("extension_chapter", "extension_chapter:X1");
  assert.equal(context.currentUnitId, "X1-pre");
  assert.equal(context.agenticChapterUnlockedBySequence("C2"), false);
  pathState.pendingPlan = {
    unitId: "X1-post",
    anchorUnitId: "X1-post",
    chapterId: "X1",
    phase: "post",
    resumeUnitId: "C2-pre",
    actions: [{ type: "continue", label: "完成扩展", units: [] }],
    createdAt: "2026-07-22T12:03:00.000+08:00"
  };
  pathState.pendingAt = "X1-post";
  context.currentChapterId = "X1";
  context.currentUnitId = "X1-post";
  await context.agenticApplyDecision("continue");
  assert.equal(context.currentUnitId, "C2-pre");
  assert.equal(context.state.agenticPath.activeExtensionChapter, null);
  assert.equal(context.state.agenticPath.chapterAdvanceReady.C1, true);
}

async function testDirectExtensionPostReturnsToMainRoute() {
  reset({
    chapterId: "X1",
    unitId: "X1-post",
    state: {
      completed: ["C1-post", "X1-post"],
      submittedQuizzes: ["C1-post", "X1-post"],
      agenticPath: {
        unlocked: ["C1-pre", "C1-post", "X1-pre", "X1-k1", "X1-post"],
        visibleUnits: ["C1-pre", "C1-post", "X1-pre", "X1-k1", "X1-post"],
        unlockedExtensionChapters: ["X1"],
        pendingPlan: {
          unitId: "X1-post",
          anchorUnitId: "X1-post",
          chapterId: "X1",
          phase: "post",
          resumeUnitId: "",
          actions: [{ type: "continue", label: "进入下一章", units: [] }],
          createdAt: "2026-07-22T12:04:00.000+08:00"
        },
        pendingAt: "X1-post",
        chapterAdvanceReady: { C1: true, "C1-post": true },
        chapterAdvanceReasons: {}
      }
    }
  });
  context.ensureAgenticPath();
  await context.agenticApplyDecision("continue");
  assert.equal(
    context.currentUnitId,
    "C2-pre",
    "直接进入扩展章的学生完成后测后，也必须回到 recommendedAfter 对应的下一主线章"
  );
  assert.equal(context.state.agenticPath.chapterAdvanceReady.C1, true);
  assert.equal(context.agenticChapterUnlockedBySequence("C2"), true);
}

function testQuizReviewReadySignalWaitsForAllScoring() {
  reset({
    chapterId: "C1",
    unitId: "C1-pre",
    state: {
      agenticPath: {
        unlocked: ["C1-pre"],
        visibleUnits: ["C1-pre"],
        chapterAdvanceReady: {},
        chapterAdvanceReasons: {}
      }
    }
  });
  const quizUnit = context.getUnit("C1-pre");
  const pendingRecords = [
    { question: { id: "q1", type: "single" }, result: { isCorrect: false, status: "incorrect" } },
    { question: { id: "q2", type: "short_answer" }, result: { isCorrect: null, status: "pending_review" } }
  ];
  assert.equal(context.agenticNotifyQuizReviewReady(quizUnit, pendingRecords), false);
  assert.equal(analyticsEvents.some((event) => event.eventType === "quiz_review_ready"), false);

  const scoredRecords = [
    pendingRecords[0],
    { question: { id: "q2", type: "short_answer" }, result: { isCorrect: false, status: "ai_reviewed" } }
  ];
  assert.equal(context.agenticNotifyQuizReviewReady(quizUnit, scoredRecords), true);
  const readyEvent = analyticsEvents.find((event) => event.eventType === "quiz_review_ready");
  assert.equal(readyEvent.payload.data.pendingReview, 0);
  assert.equal(readyEvent.payload.data.incorrect, 2);
  assert.equal(context.agenticNotifyQuizReviewReady(quizUnit, scoredRecords), false, "相同评分结果不能重复弹复盘");
}

async function testFormativeQuizAlwaysProvidesAnExit() {
  reset({
    chapterId: "C1",
    unitId: "C1-formative",
    state: {
      completed: ["C1-pre", "C1-k1", "C1-formative"],
      submittedQuizzes: ["C1-pre", "C1-formative"],
      agenticPath: {
        unlocked: ["C1-pre", "C1-k1", "C1-formative"],
        visibleUnits: ["C1-pre", "C1-k1", "C1-formative"],
        chapterAdvanceReady: {},
        chapterAdvanceReasons: {}
      }
    }
  });
  await context.agenticBuildRecommendationAfterGrading(context.getUnit("C1-formative"), [], null);
  assert.equal(context.agenticQuizPathReady(context.getUnit("C1-formative")), true);
  assert.equal(context.agenticNextUnlockedUnitAfter("C1-formative")?.id, "C1-k2");
}

async function testAgenticOpenUnitReportsNavigationFailures() {
  reset({
    chapterId: "C1",
    unitId: "C1-k1",
    state: { agenticPath: { unlocked: ["C1-k1"], visibleUnits: ["C1-k1"] } }
  });
  const originalEnsureChapterLoaded = context.ensureChapterLoaded;
  const originalSelectChapter = context.selectChapter;
  const originalSelectUnit = context.selectUnit;
  const originalRenderAll = context.renderAll;
  let renderCount = 0;
  context.renderAll = () => {
    renderCount += 1;
  };

  assert.equal(await context.agenticOpenUnit("missing-unit"), false);
  assert.equal(context.currentChapterId, "C1");
  assert.equal(context.currentUnitId, "C1-k1");
  assert.equal(
    analyticsEvents.some((event) => event.eventType === "navigation_failed" && event.payload.data.reason === "unit_not_found"),
    true,
    "missing navigation targets must produce a diagnosable failure event"
  );

  context.ensureChapterLoaded = async () => {
    throw new Error("manifest unavailable");
  };
  assert.equal(await context.agenticOpenUnit("C2-scene-1"), false);
  assert.equal(context.currentChapterId, "C1");
  assert.equal(context.currentUnitId, "C1-k1");
  assert.ok(renderCount > 0, "a failed chapter load must restore the previous view");

  context.ensureChapterLoaded = async () => false;
  assert.equal(await context.agenticOpenUnit("C2-scene-1"), false);
  assert.equal(context.currentChapterId, "C1");
  assert.equal(context.currentUnitId, "C1-k1");
  assert.equal(
    analyticsEvents.some((event) => event.eventType === "navigation_failed" && event.payload.data.reason === "chapter_load_rejected"),
    true,
    "an explicit false chapter-load result must stop navigation"
  );

  context.ensureChapterLoaded = async () => {};
  context.selectChapter = async (chapterId) => {
    context.currentChapterId = chapterId;
    return false;
  };
  context.selectUnit = originalSelectUnit;
  assert.equal(await context.agenticOpenUnit("C2-k1"), false);
  assert.equal(context.currentChapterId, "C1");
  assert.equal(context.currentUnitId, "C1-k1");
  assert.equal(
    analyticsEvents.some((event) => event.eventType === "navigation_failed" && event.payload.data.reason === "chapter_selection_rejected"),
    true,
    "a rejected chapter selection must be observable"
  );

  context.selectChapter = originalSelectChapter;
  context.selectUnit = () => false;
  assert.equal(await context.agenticOpenUnit("C2-k1"), false);
  assert.equal(context.currentChapterId, "C1");
  assert.equal(context.currentUnitId, "C1-k1");

  context.selectChapter = originalSelectChapter;
  context.selectUnit = originalSelectUnit;
  context.ensureChapterLoaded = originalEnsureChapterLoaded;
  context.renderAll = originalRenderAll;
}

async function testDecisionRestoresPendingPlanWhenNavigationFails() {
  resetPostChoiceFlow();
  const originalSelectUnit = context.selectUnit;
  context.selectUnit = () => false;
  await assert.rejects(
    () => context.agenticApplyDecision("continue"),
    (error) => error?.code === "navigation_failed"
  );
  assert.equal(context.currentChapterId, "C1");
  assert.equal(context.currentUnitId, "C1-post");
  assert.equal(context.state.agenticPath.pendingPlan?.unitId, "C1-post");
  assert.equal(context.state.agenticPath.decisionInFlight, "");
  context.selectUnit = originalSelectUnit;
}

async function testAgenticPlanUsesRequestTimeout() {
  const originalIsSignedIn = context.isSignedIn;
  const originalApiRequest = context.apiRequest;
  const originalInteractionEvidenceForUnit = context.interactionEvidenceForUnit;
  const originalInteractionEvidenceForChapter = context.interactionEvidenceForChapter;
  const originalQuizQuestionsForPlan = context.agenticQuizQuestionsForPlan;
  let observedTimeout = 0;
  context.isSignedIn = () => true;
  context.interactionEvidenceForUnit = () => null;
  context.interactionEvidenceForChapter = () => [];
  context.agenticQuizQuestionsForPlan = () => [];
  context.apiRequest = async (_path, _body, options) => {
    observedTimeout = options?.timeoutMs || 0;
    throw new Error("request_timeout");
  };
  const result = await context.agenticRequestPlan(context.getUnit("C1-formative"), []);
  assert.equal(result, null);
  assert.equal(observedTimeout, 12000);
  context.isSignedIn = originalIsSignedIn;
  context.apiRequest = originalApiRequest;
  context.interactionEvidenceForUnit = originalInteractionEvidenceForUnit;
  context.interactionEvidenceForChapter = originalInteractionEvidenceForChapter;
  context.agenticQuizQuestionsForPlan = originalQuizQuestionsForPlan;
}

async function testSelectChapterFailureRestoresView() {
  let renderCount = 0;
  const navigationContext = vm.createContext({
    console,
    currentView: "learn",
    currentChapterId: "C1",
    currentUnitId: "C1-k1",
    validViews: new Set(["home", "learn"]),
    state: {
      logs: [],
      returnToQuiz: { unitId: "C1-pre", targetUnitId: "C1-k1", questionId: "q1" }
    },
    curriculum: [
      { id: "C1", label: "第一章", loaded: true, units: [unit("C1-k1", "C1", 1)] },
      { id: "C2", label: "第二章", loaded: false, units: [unit("C2-k1", "C2", 1)] }
    ],
    getChapter(id) {
      return navigationContext.curriculum.find((chapter) => chapter.id === id) || null;
    },
    getUnit(id) {
      return navigationContext.curriculum.flatMap((chapter) => chapter.units).find((item) => item.id === id) || null;
    },
    analyticsTrack: () => {},
    trackLearningEvent: () => {},
    saveState: () => {},
    renderAll: () => { renderCount += 1; },
    preloadChapterResources: () => {},
    agenticGuardNavigation: () => true,
    analyticsEnterUnit: () => {},
    renderAuth: () => {},
    renderMetrics: () => {},
    renderChapters: () => {},
    renderLessons: () => { renderCount += 1; },
    renderPlayer: () => {},
    renderLibrary: () => {},
    renderProgress: () => {},
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: {
      scrollTo: () => {},
      dispatchEvent: () => {}
    },
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    ensureChapterLoaded: async () => false
  });
  vm.runInContext(navigationSource, navigationContext, { filename: "app/main/navigation.js" });
  assert.equal(await navigationContext.selectChapter("C2"), false);
  assert.equal(navigationContext.currentChapterId, "C1");
  assert.equal(navigationContext.currentUnitId, "C1-k1");
  assert.deepEqual(navigationContext.state.returnToQuiz, {
    unitId: "C1-pre",
    targetUnitId: "C1-k1",
    questionId: "q1"
  });
  assert.ok(renderCount >= 2, "chapter load failure must render both loading and restored views");
}

async function testPreviewRefreshDoesNotUnlockFutureChapter() {
  const initStart = bootstrapSource.indexOf("async function init()");
  const initEnd = bootstrapSource.lastIndexOf("\ninit();");
  assert.ok(initStart >= 0 && initEnd > initStart, "bootstrap init must remain testable");
  const unlocks = [];
  const futureChapter = {
    id: "C2",
    units: [unit("C2-pre", "C2", 1, "quiz", "pre"), unit("C2-k1", "C2", 2)]
  };
  const bootstrapContext = vm.createContext({
    console,
    state: { completed: [], authToken: "" },
    chapters: [{ id: "C1" }, futureChapter],
    currentChapterId: "C2",
    currentUnitId: "C2-pre",
    els: { lessonPlayer: { innerHTML: "" } },
    document: {
      getElementById: () => ({ classList: { add: () => {} } })
    },
    setTimeout,
    clearTimeout,
    renderAuth: () => {},
    isSignedIn: () => false,
    hydrateLearningState: async () => {},
    loadCourseIndex: async () => {},
    buildCurriculum: () => {},
    renderAll: () => {},
    setupLearningCanvasLayoutSync: () => {},
    setupChapterRailToggle: () => {},
    setupLessonRailToggle: () => {},
    ensureChapterLoaded: async () => {},
    ensureAgenticPath: () => ({}),
    agenticUnlockUnit: (unitId, reason) => unlocks.push({ unitId, reason }),
    agenticGuardNavigation: () => true,
    agenticRecoverInterruptedGrading: async () => {},
    analyticsEnterUnit: () => {},
    getUnit: () => futureChapter.units[0],
    getChapter: () => futureChapter,
    preloadChapterResources: () => {},
    scheduleChapterPrefetch: () => {},
    setupInteractionTracking: () => {},
    escapeHtml: (value) => String(value || "")
  });
  vm.runInContext(bootstrapSource.slice(initStart, initEnd), bootstrapContext, {
    filename: "app/main/bootstrap.js"
  });
  await bootstrapContext.init();
  assert.equal(
    unlocks.some((entry) => entry.unitId === "C2-pre"),
    false,
    "refreshing a freely previewed future chapter must not unlock its first quiz"
  );
}

function testSideNavigationClearsQuizReturnContext() {
  const units = [
    unit("C1-formative", "C1", 1, "quiz", "formative"),
    unit("C1-k1", "C1", 2),
    unit("C1-k2", "C1", 3)
  ];
  const navigationContext = vm.createContext({
    console,
    currentView: "learn",
    currentChapterId: "C1",
    currentUnitId: "C1-k1",
    state: {
      logs: [],
      selectedKnowledgeScenes: {},
      returnToQuiz: {
        unitId: "C1-formative",
        targetUnitId: "C1-k1",
        questionId: "q-review"
      }
    },
    validViews: new Set(["home", "learn"]),
    getUnit: (unitId) => units.find((entry) => entry.id === (unitId || navigationContext.currentUnitId)) || null,
    getChapter: () => ({ id: "C1", units }),
    agenticGuardNavigation: () => true,
    agenticConsumeCompletedExtensionResume: () => {},
    analyticsEnterUnit: () => {},
    trackLearningEvent: () => {},
    renderAuth: () => {},
    renderMetrics: () => {},
    renderChapters: () => {},
    renderLessons: () => {},
    renderPlayer: () => {},
    renderLibrary: () => {},
    renderProgress: () => {},
    renderAll: () => {},
    document: {
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: {
      scrollTo: () => {},
      dispatchEvent: () => {},
      setTimeout
    },
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    }
  });
  vm.runInContext(navigationSource, navigationContext, {
    filename: "app/main/navigation.js"
  });
  assert.equal(navigationContext.selectUnit("C1-k2"), true);
  assert.equal(
    navigationContext.state.returnToQuiz,
    null,
    "leaving the reviewed courseware target sideways must retire the stale return-to-quiz context"
  );
}

Promise.resolve()
  .then(testDeferredReviewAndExtensionFlows)
  .then(testDirectExtensionPostReturnsToMainRoute)
  .then(testQuizReviewReadySignalWaitsForAllScoring)
  .then(testFormativeQuizAlwaysProvidesAnExit)
  .then(testAgenticOpenUnitReportsNavigationFailures)
  .then(testDecisionRestoresPendingPlanWhenNavigationFails)
  .then(testAgenticPlanUsesRequestTimeout)
  .then(async () => {
    const failures = [];
    for (const test of [
      testSideNavigationClearsQuizReturnContext,
      testPreviewRefreshDoesNotUnlockFutureChapter,
      testSelectChapterFailureRestoresView
    ]) {
      try {
        await test();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "student navigation regression tests failed");
    }
  })
  .then(() => console.log("agentic navigation tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const desktopScreenshot = path.join(root, "tmp", "admin-layout-large-data.png");
const mobileScreenshot = path.join(root, "tmp", "admin-layout-large-data-mobile.png");
const browserCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server health timeout\n${logs.join("")}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function browserExecutable() {
  const executable = browserCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("No Chrome or Edge executable found.");
  return executable;
}

function startMockLlm(port) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = body.messages?.map((message) => message.content || "").join("\n") || "";
      const maxScore = Number(prompt.match(/满分：(\d+(?:\.\d+)?) 分/)?.[1] || 20);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              score: maxScore,
              isCorrect: true,
              confidence: 0.98,
              errorType: "none",
              weakConcepts: [],
              feedback: "浏览器回归重评通过。",
              reasoning: "测试回答按本地评分桩判为正确。"
            })
          }
        }]
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function seedDatabase(dbPath) {
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const db = require("../db");
  const courseAssessment = require("../lib/course-assessment");
  const route = JSON.parse(
    fs.readFileSync(path.join(root, "data", "multi-scene-learning-route.json"), "utf8")
  );
  const assessmentIndex = courseAssessment.buildAssessmentIndex(route);
  const shortEntry = Array.from(assessmentIndex.values()).find(
    (entry) => entry.question?.type === "short_answer"
  );
  assert.ok(shortEntry);
  await db.getDb();

  for (let userIndex = 0; userIndex < 6; userIndex += 1) {
    const userId = `layout-user-${userIndex}`;
    db.upsertUser(
      userId,
      `排版测试用户${userIndex + 1}`,
      "2026-08-13T08:00:00.000+08:00",
      "2026-08-13T12:00:00.000+08:00"
    );
    for (let resultIndex = 0; resultIndex < 5; resultIndex += 1) {
      const createdAt = `2026-08-13T${String(8 + userIndex).padStart(2, "0")}:${String(resultIndex).padStart(2, "0")}:00.000+08:00`;
      const resultId = `layout-short-${userIndex}-${resultIndex}`;
      db.insertQuizResult({
        id: resultId,
        user_id: userId,
        chapter_id: shortEntry.chapterId,
        chapter_label: shortEntry.chapterTitle || "",
        unit_id: shortEntry.unitId,
        unit_label: shortEntry.unitTitle || "",
        question_id: shortEntry.question.id,
        question_type: "short_answer",
        phase: shortEntry.phase,
        points: Number(shortEntry.question.points || 20),
        response: `这是一段用于检查管理员长答案排版的回答 ${userIndex + 1}-${resultIndex + 1}。`.repeat(8),
        is_correct: 0,
        status: "ai_reviewed",
        score: 0,
        max_score: Number(shortEntry.question.points || 20),
        created_at: createdAt
      });
      if (resultId === "layout-short-5-3") {
        // Keep one historical row without AI grading metadata.
      } else if (resultId === "layout-short-5-4") {
        db.getDbSync().run(
          `UPDATE quiz_results
           SET ai_score = 0, ai_confidence = 0.4, ai_error_type = 'none',
               ai_feedback = '评分结果置信度不足，等待重新评分。'
           WHERE id = ?`,
          [resultId]
        );
      } else {
        db.getDbSync().run(
          `UPDATE quiz_results
           SET ai_score = 0, ai_error_type = 'api_error',
               ai_feedback = ?
           WHERE id = ?`,
          [
            `旧评分接口返回错误，保留原始评分等待重评。${"这是较长的诊断反馈。".repeat(12)}`,
            resultId
          ]
        );
      }
    }

    for (let unitIndex = 0; unitIndex < 14; unitIndex += 1) {
      const unitId = `GH-01-K${String((unitIndex % 4) + 1).padStart(2, "0")}`;
      const seconds = unitIndex === 13 ? 7200 : 30 + unitIndex * 15;
      const createdAt = `2026-08-13T${String(8 + userIndex).padStart(2, "0")}:${String(10 + unitIndex).padStart(2, "0")}:00.000+08:00`;
      db.insertEvent({
        id: `layout-time-${userIndex}-${unitIndex}`,
        user_id: userId,
        type: "interaction",
        payload: {
          eventType: "time_on_unit",
          chapterId: "V14-C1",
          unitId,
          data: {
            seconds,
            sceneType: unitIndex % 2 ? "simulation" : "slide",
            unitLabel: `长名称模块 ${unitIndex + 1}`
          }
        },
        created_at: createdAt
      });
      db.insertEvent({
        id: `layout-courseware-${userIndex}-${unitIndex}`,
        user_id: userId,
        type: "interaction",
        payload: {
          eventType: unitIndex % 3 === 0
            ? "courseware_formative_check_submitted"
            : "interactive_click",
          chapterId: "V14-C1",
          unitId,
          data: {
            label: `互动证据 ${unitIndex + 1}`,
            isCorrect: unitIndex % 2 === 0
          }
        },
        created_at: createdAt
      });
    }
    db.insertFeedback({
      id: `layout-feedback-${userIndex}`,
      user_id: userId,
      feedback_type: "courseware",
      content: `这是用于检查用户详情反馈长表排版的反馈正文。${"反馈内容需要在容器内换行并保持可滚动。".repeat(12)}`,
      target_scope: "courseware",
      chapter_id: "V14-C1",
      module_id: "GH-01",
      unit_id: "GH-01-K01",
      knowledge_point: "输入、输出和函数规则",
      scene_type: "simulation",
      resource_file: "interactive/test.html",
      resource_title: "排版测试互动课件",
      current_view: "learning",
      created_at: `2026-08-13T${String(8 + userIndex).padStart(2, "0")}:40:00.000+08:00`
    });
  }
  db.saveNow();
  db.releaseWriteLock();
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
}

function collectIssues(page) {
  const issues = [];
  page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon\.ico/i.test(message.text())) {
      issues.push(`console: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    if (!/ERR_ABORTED/i.test(request.failure()?.errorText || "")) {
      issues.push(`requestfailed: ${request.url()}`);
    }
  });
  return issues;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-admin-layout-"));
  const dbPath = path.join(tmpDir, "admin-layout.db");
  const port = await freePort();
  const llmPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "admin-layout-token";
  const logs = [];
  let child;
  let browser;
  let mockLlm;

  try {
    await seedDatabase(dbPath);
    mockLlm = await startMockLlm(llmPort);
    child = spawn(process.execPath, ["server.js", String(port)], {
      cwd: root,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        HOST: "127.0.0.1",
        ADMIN_TOKEN: adminToken,
        LLM_PROVIDER: "mock",
        GRADING_LLM_PROVIDER: "openai-compatible",
        GRADING_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
        GRADING_API_KEY: "browser-test-key",
        GRADING_MODEL: "auto",
        NODE_ENV: "test"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
    child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
    await waitForHealth(baseUrl, child, logs);

    browser = await chromium.launch({
      executablePath: browserExecutable(),
      headless: true
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const issues = collectIssues(page);
    await page.goto(`${baseUrl}/admin.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#admin-token-input").fill(adminToken);
    await page.locator("#login-btn").click();
    await page.locator("#app:not(.hidden)").waitFor({ timeout: 30000 });
    await page.locator('[data-tab="shortanswers"]').click();
    await page.locator("#table-regrade-candidates tbody tr").nth(20).waitFor({ timeout: 30000 });
    assert.equal(
      await page.locator("#table-regrade-candidates .badge").filter({ hasText: "缺失评分" }).count(),
      1
    );
    assert.equal(
      await page.locator("#table-regrade-candidates .badge").filter({ hasText: "低置信度" }).count(),
      1
    );
    await page.locator("#select-all-regrade").check();
    assert.equal(
      await page.locator("[data-regrade-id]:checked").count(),
      30,
      "the header checkbox must select every loaded regrade candidate"
    );
    assert.match(
      await page.locator("#regrade-selection-summary").innerText(),
      /已选 30 \/ 30 条/,
      "the regrade summary must report the full selection"
    );
    await page.locator("#select-all-regrade").uncheck();

    const desktopLayout = await page.evaluate(() => {
      const wrap = document.querySelector("#table-regrade-candidates")?.closest(".table-wrap");
      const header = document.querySelector("#table-regrade-candidates thead th");
      return {
        rows: document.querySelectorAll("#table-regrade-candidates tbody tr").length,
        scrollHeight: wrap?.scrollHeight || 0,
        clientHeight: wrap?.clientHeight || 0,
        scrollWidth: wrap?.scrollWidth || 0,
        clientWidth: wrap?.clientWidth || 0,
        overflowX: wrap ? getComputedStyle(wrap).overflowX : "",
        overflowY: wrap ? getComputedStyle(wrap).overflowY : "",
        headerPosition: header ? getComputedStyle(header).position : ""
      };
    });
    assert.equal(desktopLayout.rows, 30);
    assert.ok(desktopLayout.scrollHeight > desktopLayout.clientHeight);
    assert.match(desktopLayout.overflowY, /auto|scroll/);
    assert.equal(desktopLayout.headerPosition, "sticky");
    fs.mkdirSync(path.dirname(desktopScreenshot), { recursive: true });
    await page.screenshot({ path: desktopScreenshot, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const mobileLayout = await page.evaluate(() => {
      const wrap = document.querySelector("#table-regrade-candidates")?.closest(".table-wrap");
      const viewportWidth = document.documentElement.clientWidth;
      const outsideScrollContainers = Array.from(document.querySelectorAll("body *"))
        .filter((element) => {
          const style = getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || !element.getClientRects().length) return false;
          if (element.closest(".table-wrap, .tabs")) return false;
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > viewportWidth + 1;
        })
        .slice(0, 10)
        .map((element) => ({
          tag: element.tagName,
          id: element.id || "",
          className: String(element.className || "")
        }));
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth,
        outsideScrollContainers,
        scrollWidth: wrap?.scrollWidth || 0,
        clientWidth: wrap?.clientWidth || 0,
        overflowX: wrap ? getComputedStyle(wrap).overflowX : ""
      };
    });
    assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1);
    assert.deepEqual(mobileLayout.outsideScrollContainers, []);
    assert.ok(mobileLayout.scrollWidth > mobileLayout.clientWidth);
    assert.match(mobileLayout.overflowX, /auto|scroll/);
    const shortAnswerLayout = await page.evaluate(() => {
      const wrap = document.querySelector("#table-shortanswers")?.closest(".table-wrap");
      return {
        scrollWidth: wrap?.scrollWidth || 0,
        clientWidth: wrap?.clientWidth || 0,
        overflowX: wrap ? getComputedStyle(wrap).overflowX : ""
      };
    });
    assert.ok(shortAnswerLayout.scrollWidth > shortAnswerLayout.clientWidth);
    assert.match(shortAnswerLayout.overflowX, /auto|scroll/);
    await page.screenshot({ path: mobileScreenshot, fullPage: true });

    await page.locator('[data-tab="interactions"]').click();
    await page.locator("#table-unit-engagement tbody tr").nth(10).waitFor({ timeout: 30000 });
    const interactionLayout = await page.evaluate(() => {
      const engagementWrap = document.querySelector("#table-unit-engagement")?.closest(".table-wrap");
      const pathText = document.querySelector("#path-rule-desc")?.textContent || "";
      return {
        rows: document.querySelectorAll("#table-unit-engagement tbody tr").length,
        scrollHeight: engagementWrap?.scrollHeight || 0,
        clientHeight: engagementWrap?.clientHeight || 0,
        pathText
      };
    });
    assert.ok(interactionLayout.rows > 10);
    assert.ok(interactionLayout.scrollHeight > interactionLayout.clientHeight);
    assert.match(interactionLayout.pathText, /单段最多按 30 分钟计入/);

    await page.locator('[data-tab="users"]').click();
    await page.locator('.view-user-btn[data-user-id="layout-user-0"]').click();
    await page.locator("#table-user-quiz-details tbody tr").nth(4).waitFor({ timeout: 30000 });
    const userAccuracyMetric = page.locator("#user-research-metrics .metric-card").filter({
      has: page.locator(".label").filter({ hasText: /^总体正确率$/ })
    });
    assert.equal((await userAccuracyMetric.locator(".value").innerText()).trim(), "0%");
    const userDetailLayout = await page.evaluate(() => {
      const tableIds = [
        "table-users",
        "table-user-phase-summary",
        "table-user-chapter-phase",
        "table-user-quiz-details",
        "table-user-effective-path",
        "table-user-recent-events",
        "table-user-feedback"
      ];
      return tableIds.map((id) => {
        const table = document.getElementById(id);
        const wrap = table?.closest(".table-wrap");
        const header = table?.querySelector("thead th");
        return {
          id,
          found: Boolean(table && wrap),
          overflowX: wrap ? getComputedStyle(wrap).overflowX : "",
          overflowY: wrap ? getComputedStyle(wrap).overflowY : "",
          maxHeight: wrap ? getComputedStyle(wrap).maxHeight : "",
          headerPosition: header ? getComputedStyle(header).position : ""
        };
      });
    });
    userDetailLayout.forEach((item) => {
      assert.equal(item.found, true, `${item.id} must have a table-wrap`);
      assert.match(item.overflowX, /auto|scroll/, `${item.id} needs horizontal scrolling`);
      assert.match(item.overflowY, /auto|scroll/, `${item.id} needs vertical scrolling`);
      assert.notEqual(item.maxHeight, "none", `${item.id} needs a bounded height`);
      assert.equal(item.headerPosition, "sticky", `${item.id} needs a sticky header`);
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-tab="shortanswers"]').click();
    await page.locator('[data-regrade-id="layout-short-0-0"]').check();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#run-regrade-btn").click();
    await page.locator("#regrade-result").filter({
      hasText: /重评完成：成功 1 条/
    }).waitFor({ timeout: 30000 });
    assert.equal(
      await page.locator("[data-regrade-id]").count(),
      29,
      "an applied regrade must disappear from the candidate table"
    );
    const overviewAccuracyMetric = page.locator("#overview-metrics .metric-card").filter({
      has: page.locator(".label").filter({ hasText: /^总体正确率$/ })
    });
    assert.equal(
      (await overviewAccuracyMetric.locator(".value").innerText()).trim(),
      "3.3%",
      "the overview must refresh after a successful regrade"
    );
    assert.equal(
      (await userAccuracyMetric.locator(".value").innerText()).trim(),
      "20%",
      "an already-open affected user detail must refresh after regrade"
    );
    assert.deepEqual(issues, []);

    console.log(
      `admin large-data layout tests passed (${desktopScreenshot}, ${mobileScreenshot})`
    );
  } finally {
    await browser?.close().catch(() => {});
    await stopChild(child);
    if (mockLlm) await new Promise((resolve) => mockLlm.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

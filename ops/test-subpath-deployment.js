const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

function indexBootstrapSource() {
  const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
  const marker = "// Auto-detect sub-path deployment for API calls";
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, "index bootstrap marker must exist");
  const scriptStart = html.lastIndexOf("<script", markerIndex);
  const codeStart = html.indexOf(">", scriptStart) + 1;
  const scriptEnd = html.indexOf("</script>", markerIndex);
  assert.ok(scriptStart >= 0 && codeStart > scriptStart && scriptEnd > codeStart, "index bootstrap script must be readable");
  assert.ok(scriptEnd < html.indexOf('href="styles.css'), "index bootstrap must run before relative assets");
  return html.slice(codeStart, scriptEnd);
}

function runIndexBootstrap(pathname, search = "", hash = "") {
  const bases = [];
  const fetchUrls = [];
  const location = {
    pathname,
    search,
    hash,
    replacedWith: "",
    replace(url) {
      this.replacedWith = url;
    }
  };
  const document = {
    head: {
      appendChild(node) {
        bases.push(node);
      }
    },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), href: "" };
    }
  };
  const window = {
    fetch(url) {
      fetchUrls.push(url);
      return Promise.resolve({ ok: true });
    }
  };

  vm.runInNewContext(indexBootstrapSource(), { document, location, window });
  return { bases, fetchUrls, location, window };
}

function testIndexBootstrap() {
  const root = runIndexBootstrap("/");
  assert.equal(root.location.replacedWith, "");
  assert.equal(root.window.__BASE_PATH__, undefined);

  for (const pathname of ["/calculus_quest", "/calculus_quest/", "/calculus_quest/index.html"]) {
    const result = runIndexBootstrap(pathname, "?from=test", "#learn-view");
    assert.equal(result.bases.length, 1, `${pathname} must install one base element`);
    assert.equal(result.bases[0].tagName, "BASE");
    assert.equal(result.bases[0].href, "/calculus_quest/");
    assert.equal(result.window.__BASE_PATH__, "/calculus_quest");
    assert.equal(
      new URL("app/main/navigation.js", `https://example.test${result.bases[0].href}`).pathname,
      "/calculus_quest/app/main/navigation.js"
    );

    result.window.fetch("/api/health");
    result.window.fetch("/calculus_quest/api/health");
    assert.deepEqual(
      result.fetchUrls,
      ["/calculus_quest/api/health", "/calculus_quest/api/health"],
      `${pathname} must apply the deployment prefix exactly once`
    );
  }

  const noSlash = runIndexBootstrap("/calculus_quest", "?from=test", "#learn-view");
  assert.equal(noSlash.location.replacedWith, "/calculus_quest/?from=test#learn-view");
  assert.equal(runIndexBootstrap("/calculus_quest/").location.replacedWith, "");
  assert.equal(runIndexBootstrap("/calculus_quest/index.html").location.replacedWith, "");
}

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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${logs.join("")}`);
    }
    try {
      const response = await fetch(baseUrl + "/calculus_quest/api/health");
      if (response.ok) return response.json();
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

async function main() {
  testIndexBootstrap();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-subpath-"));
  const dbPath = path.join(tmpDir, "subpath.db");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "subpath-admin-token";
  const logs = [];
  let child;

  try {
    child = spawn(process.execPath, ["server.js", String(port)], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        DB_PATH: dbPath,
        HOST: "127.0.0.1",
        BASE_PATH: "/calculus_quest/",
        LLM_PROVIDER: "mock",
        NODE_ENV: "development",
        ADMIN_TOKEN: adminToken
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
    child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

    const health = await waitForHealth(baseUrl, child, logs);
    assert.equal(health.ok, true);
    assert.equal(health.basePath, "/calculus_quest");

    const strippedHealthResponse = await fetch(baseUrl + "/api/health");
    assert.equal(strippedHealthResponse.status, 200, "Nginx-stripped API path must remain supported");
    const strippedHealth = await strippedHealthResponse.json();
    assert.equal(strippedHealth.basePath, "/calculus_quest");

    const redirect = await fetch(baseUrl + "/calculus_quest?from=test", { redirect: "manual" });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/calculus_quest/?from=test");

    for (const pathname of [
      "/calculus_quest/",
      "/calculus_quest/index.html",
      "/calculus_quest/admin",
      "/calculus_quest/admin.html",
      "/calculus_quest/flow-test.html",
      "/calculus_quest/flow-test",
      "/calculus_quest/styles.css",
      "/calculus_quest/admin/admin.js",
      "/calculus_quest/app/flow-test/flow-test.js",
      "/calculus_quest/app/flow-test/flow-test.css",
      "/calculus_quest/lib/chart.umd.min.js",
      "/calculus_quest/lib/interaction-policy.js",
      "/calculus_quest/lib/active-time-policy.js",
      "/calculus_quest/data/multi-scene-learning-route.json",
      "/calculus_quest/api/course/multi-scene-learning-route",
      "/calculus_quest/api/course/openmaic-v14-route"
    ]) {
      const response = await fetch(baseUrl + pathname);
      assert.equal(response.status, 200, pathname);
    }

    const flowScriptResponse = await fetch(
      baseUrl + "/calculus_quest/app/flow-test/flow-test.js?v=20260727-courseware-interaction-v4"
    );
    assert.equal(flowScriptResponse.status, 200);
    assert.match(flowScriptResponse.headers.get("cache-control") || "", /no-store/);
    assert.doesNotMatch(flowScriptResponse.headers.get("cache-control") || "", /immutable/);

    const coursewarePath = encodeURI(
      "/calculus_quest/resources/open-maic/GH-01-函数、坐标与图像读法入门/"
      + "interactive/03_输入、输出和函数规则：拖动实验.html"
    );
    const coursewareResponse = await fetch(
      baseUrl + coursewarePath + "?v=20260727-courseware-interaction-v4&cqContextBridge=20260813-v8"
    );
    assert.equal(coursewareResponse.status, 200);
    assert.match(coursewareResponse.headers.get("cache-control") || "", /no-store/);

    for (const pathname of [
      "/",
      "/index.html",
      "/admin",
      "/admin.html",
      "/flow-test",
      "/flow-test.html",
      "/styles.css",
      "/admin/admin.js",
      "/app/flow-test/flow-test.js",
      "/app/flow-test/flow-test.css",
      "/lib/chart.umd.min.js",
      "/data/multi-scene-learning-route.json",
      "/api/course/multi-scene-learning-route",
      "/api/course/openmaic-v14-route"
    ]) {
      const response = await fetch(baseUrl + pathname);
      assert.equal(response.status, 200, `stripped proxy path ${pathname}`);
    }

    for (const pathname of [
      "/calculus_quest/data/multi-scene-learning-route.json",
      "/data/multi-scene-learning-route.json"
    ]) {
      const response = await fetch(baseUrl + pathname);
      const text = await response.text();
      assert.equal(response.status, 200, pathname);
      assert.ok(!text.includes('"answer":'), `${pathname} must hide quiz answers`);
      assert.ok(!text.includes('"analysis":'), `${pathname} must hide quiz analysis`);
    }

    const flowRouteAnonymous = await fetch(
      baseUrl + "/calculus_quest/api/course/flow-test-route"
    );
    assert.equal(flowRouteAnonymous.status, 403);
    const flowRouteAdmin = await fetch(
      baseUrl + "/calculus_quest/api/course/flow-test-route",
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(flowRouteAdmin.status, 200);
    assert.match(await flowRouteAdmin.text(), /"answer":/);

    const wrongPrefix = await fetch(baseUrl + "/calculus_quest_extra/api/health");
    assert.notEqual(wrongPrefix.status, 200);
    const duplicatedPrefix = await fetch(baseUrl + "/calculus_quest/calculus_quest/api/health");
    assert.notEqual(duplicatedPrefix.status, 200);

    console.log("subpath deployment tests passed");
  } finally {
    await stopChild(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

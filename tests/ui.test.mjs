import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromePath =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const fixture = `
(() => {
  const listeners = [];
  const initial = {
    settings: {
      schemaVersion: 1, mode: "auto", proxy: {scheme: "http", host: "127.0.0.1", port: 10809},
      fallbackDirect: true, bypassLocal: true, bypassRussian: true,
      siteRules: ["example.com", "long-example-domain-for-search.example", ...Array.from({length: 31}, (_, i) => "site-" + i + ".example")]
    },
    control: new URL(location.href).searchParams.get("control") || "controlled_by_this_extension", error: "", notice: ""
  };
  const data = {
    state: structuredClone(initial), messages: [], url: new URL(location.href).searchParams.get("activeUrl") || "https://platform.openai.com/docs", optionsOpened: 0,
    failNext: new URL(location.href).searchParams.get("initialFailure") || "", delayNext: 0,
    omitNextState: new URL(location.href).searchParams.has("initialFailure"),
    emitStorage() { for (const listener of listeners) listener({settings: {newValue: this.state.settings}}, "local"); }
  };
  globalThis.testFixture = data;
  globalThis.chrome = {
    runtime: {
      id: "isolated-ui-test",
      async openOptionsPage() { data.optionsOpened += 1; },
      async sendMessage(message) {
        data.messages.push(structuredClone(message));
        if (data.delayNext) { const ms = data.delayNext; data.delayNext = 0; await new Promise(resolve => setTimeout(resolve, ms)); }
        if (data.failNext) {
          const error = data.failNext; data.failNext = "";
          if (data.omitNextState) { data.omitNextState = false; return {ok: false, error}; }
          return {ok: false, error, state: structuredClone(data.state)};
        }
        if (message.type === "REAPPLY" && data.state.control === "controllable_by_this_extension") data.state.control = "controlled_by_this_extension";
        if (message.type === "UPDATE_SETTINGS") Object.assign(data.state.settings, message.patch);
        if (message.type === "ADD_SITE") {
          const host = new URL(message.host.includes("://") ? message.host : "https://" + message.host).hostname.replace(/^www\\./, "");
          data.state.settings.siteRules = [...new Set([...data.state.settings.siteRules, host])].sort();
        }
        if (message.type === "REMOVE_SITE") data.state.settings.siteRules = data.state.settings.siteRules.filter(site => site !== message.host);
        if (message.type === "CLEAR_SITES") data.state.settings.siteRules = [];
        return {ok: true, state: structuredClone(data.state)};
      }
    },
    tabs: { async query() { return [{url: data.url}]; } },
    storage: { onChanged: { addListener(listener) { listeners.push(listener); } } }
  };
})();
`;

class Cdp {
  socket;
  next = 0;
  pending = new Map();
  errors = [];

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === "Runtime.exceptionThrown")
        this.errors.push(message.params.exceptionDetails.text);
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await once(socket, "open");
    return new Cdp(socket);
  }

  async send(method, params = {}) {
    const id = ++this.next;
    const result = new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }

  async until(expression) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(`UI condition timed out: ${expression}`);
  }

  async load(url, width, height = 800) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send("Page.navigate", { url });
    await this.until(
      'Boolean(globalThis.testFixture && document.getElementById("app")?.getAttribute("aria-busy") === "false")',
    );
  }

  async settled() {
    await this.until('document.getElementById("app").getAttribute("aria-busy") === "false"');
  }

  async click(selector) {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await this.settled();
  }

  async input(selector, value) {
    await this.evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event("input", {bubbles:true})); })()`,
    );
  }

  close() {
    this.socket.close();
  }
}

async function serve() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/fixture.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(fixture);
        return;
      }
      if (
        !/^\/(popup\.html|options\.html|styles\.css|dist\/[a-z]+\.js|icons\/icon-\d+\.png)$/.test(
          pathname,
        )
      ) {
        response.writeHead(404).end();
        return;
      }
      const content = await readFile(join(root, pathname));
      const kind = pathname.endsWith(".html")
        ? "text/html"
        : pathname.endsWith(".js")
          ? "text/javascript"
          : pathname.endsWith(".css")
            ? "text/css"
            : "image/png";
      response.writeHead(200, { "Content-Type": kind });
      response.end(
        kind === "text/html"
          ? content.toString().replace("<head>", '<head><script src="/fixture.js"></script>')
          : content,
      );
    } catch {
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function launch() {
  const directory = await mkdtemp(join(tmpdir(), "chrome-proxy-ui-"));
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--no-proxy-server",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 10_000;
  let match;
  while (Date.now() < deadline && child.exitCode === null) {
    match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!match) {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
    throw new Error("Isolated headless Chrome did not start");
  }
  const pages = await (await fetch(`http://127.0.0.1:${match[1]}/json/list`)).json();
  const page = pages.find((candidate) => candidate.type === "page");
  assert.ok(page?.webSocketDebuggerUrl);
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  return {
    cdp,
    async close() {
      cdp.close();
      child.kill("SIGTERM");
      if (child.exitCode === null)
        await Promise.race([
          once(child, "exit"),
          new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
        ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("real UI: compact popup and settings interactions in an isolated Chrome profile", {
  timeout: 45_000,
}, async (t) => {
  const { server, origin } = await serve();
  let browser;
  try {
    browser = await launch();
    const { cdp } = browser;
    await t.test(
      "popup fits 360px without a scrolling rule list and exposes clear modes",
      async () => {
        await cdp.load(`${origin}/popup.html`, 360, 600);
        const layout = await cdp.evaluate(
          '({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.body.scrollHeight, host: document.getElementById("hostname").textContent, route: document.getElementById("route").textContent})',
        );
        assert.equal(layout.width, 360);
        assert.ok(layout.scrollWidth <= 360);
        assert.ok(layout.height < 500, `popup height ${layout.height}`);
        assert.equal(layout.host, "platform.openai.com");
        assert.equal(layout.route, "Через Happ");
        assert.equal(
          await cdp.evaluate('document.getElementById("exceptions").textContent'),
          "Сайты напрямую · 33",
        );
        await cdp.click('input[value="direct"]');
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Напрямую",
        );
        assert.equal(await cdp.evaluate('document.getElementById("site-action").disabled'), true);
        await cdp.click('input[value="system"]');
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Как в macOS",
        );
        assert.match(
          await cdp.evaluate('document.getElementById("mode-description").textContent'),
          /Happ может оставаться/,
        );
        await cdp.click('input[value="auto"]');
        await cdp.click("#site-action");
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Напрямую",
        );
        assert.equal(
          await cdp.evaluate('document.getElementById("reason").textContent'),
          "Ваше исключение",
        );
        await cdp.click("#site-action");
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Через Happ",
        );
        await cdp.click("#settings");
        assert.equal(await cdp.evaluate("testFixture.optionsOpened"), 1);
      },
    );

    await t.test(
      "long domains remain visible within popup bounds; failed mode changes are rolled back",
      async () => {
        const longHost = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.example`;
        await cdp.load(
          `${origin}/popup.html?activeUrl=${encodeURIComponent(`https://${longHost}/`)}`,
          360,
          600,
        );
        assert.equal(
          await cdp.evaluate('document.getElementById("hostname").textContent'),
          longHost,
        );
        assert.ok(await cdp.evaluate("document.documentElement.scrollWidth <= innerWidth"));
        assert.ok(await cdp.evaluate("document.body.scrollHeight < 500"));
        await cdp.evaluate('testFixture.failNext = "Тест: Chrome не применил режим"');
        await cdp.click('input[value="direct"]');
        assert.equal(
          await cdp.evaluate('document.querySelector("input[value=auto]").checked'),
          true,
        );
        assert.match(
          await cdp.evaluate('document.getElementById("error").textContent'),
          /Chrome не применил/,
        );
      },
    );

    await t.test(
      "first-load errors offer recovery and fresh backend state replaces stale controls",
      async () => {
        await cdp.load(`${origin}/popup.html?initialFailure=Test%20initial%20failure`, 360, 600);
        assert.equal(await cdp.evaluate('document.getElementById("retry").hidden'), false);
        assert.equal(await cdp.evaluate('document.getElementById("mode-picker").disabled'), true);
        assert.doesNotMatch(
          await cdp.evaluate('document.getElementById("mode-description").textContent'),
          /Загружаю/,
        );
        await cdp.click("#retry");
        assert.equal(await cdp.evaluate('document.getElementById("mode-picker").disabled'), false);
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Через Happ",
        );
        await cdp.evaluate(
          'testFixture.state.settings.mode = "direct"; testFixture.failNext = "Test stale state"',
        );
        await cdp.click('input[value="system"]');
        assert.equal(
          await cdp.evaluate('document.querySelector("input[value=direct]").checked'),
          true,
        );
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Напрямую",
        );
        await cdp.load(`${origin}/options.html?initialFailure=Test%20initial%20failure`, 1100, 900);
        assert.equal(await cdp.evaluate('document.getElementById("proxy-fields").disabled'), true);
        assert.doesNotMatch(
          await cdp.evaluate('document.getElementById("saved").textContent'),
          /Загружаю|Проверяю/,
        );
        await cdp.click("#retry");
        assert.equal(await cdp.evaluate('document.getElementById("proxy-fields").disabled'), false);
        assert.equal(await cdp.evaluate('document.getElementById("error").hidden'), true);
      },
    );

    await t.test(
      "unapplied and blocked Chrome settings do not claim a confirmed route",
      async () => {
        await cdp.load(`${origin}/popup.html?control=controllable_by_this_extension`, 360, 600);
        assert.equal(
          await cdp.evaluate('document.getElementById("control").textContent'),
          "Правила ещё не применены",
        );
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Правило не применено",
        );
        assert.equal(await cdp.evaluate('document.getElementById("retry").hidden'), false);
        await cdp.click("#retry");
        assert.equal(
          await cdp.evaluate('document.getElementById("control").textContent'),
          "Правила применены",
        );
        assert.equal(await cdp.evaluate('document.getElementById("retry").hidden'), true);
        await cdp.load(`${origin}/popup.html?control=controlled_by_other_extensions`, 360, 600);
        assert.match(
          await cdp.evaluate('document.getElementById("control").textContent'),
          /другое расширение/,
        );
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Правило не применено",
        );
      },
    );

    await t.test(
      "owned stale settings do not claim success and a custom endpoint is not named Happ",
      async () => {
        await cdp.load(`${origin}/popup.html`, 360, 600);
        await cdp.evaluate('testFixture.state.error = "Test: Chrome settings drifted"');
        await cdp.click('input[value="direct"]');
        assert.equal(
          await cdp.evaluate('document.getElementById("control").textContent'),
          "Применение не подтверждено",
        );
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Правило не применено",
        );
        assert.equal(await cdp.evaluate('document.getElementById("retry").hidden'), false);
        assert.match(
          await cdp.evaluate('document.getElementById("error").textContent'),
          /settings drifted/,
        );
        await cdp.evaluate(
          'testFixture.state.error = ""; testFixture.state.settings.proxy = {scheme:"http", host:"192.0.2.9", port:3128}',
        );
        await cdp.click('input[value="auto"]');
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Через прокси",
        );
        assert.doesNotMatch(
          await cdp.evaluate('document.getElementById("mode-description").textContent'),
          /Happ/,
        );
        await cdp.evaluate(
          'testFixture.state.settings.proxy = {scheme:"socks5", host:"127.0.0.1", port:10808}',
        );
        await cdp.click('input[value="direct"]');
        await cdp.click('input[value="auto"]');
        assert.equal(
          await cdp.evaluate('document.getElementById("route").textContent'),
          "Через Happ",
        );
        await cdp.load(`${origin}/options.html`, 1100, 900);
        await cdp.evaluate(
          'testFixture.state.error = "Test: Chrome settings drifted"; testFixture.emitStorage()',
        );
        await cdp.settled();
        assert.equal(
          await cdp.evaluate('document.getElementById("control").textContent'),
          "Применение не подтверждено",
        );
        assert.match(await cdp.evaluate('document.getElementById("saved").textContent'), /ошибке/);
      },
    );

    await t.test("settings search, add, remove and explicit clear confirmation", async () => {
      await cdp.load(`${origin}/options.html`, 1120, 900);
      assert.ok(await cdp.evaluate("document.documentElement.scrollWidth <= innerWidth"));
      assert.equal(await cdp.evaluate('document.querySelectorAll("#site-list li").length'), 33);
      await cdp.input("#search", "long-example");
      assert.equal(await cdp.evaluate('document.querySelectorAll("#site-list li").length'), 1);
      assert.equal(await cdp.evaluate('document.getElementById("count").textContent'), "1 из 33");
      await cdp.input("#search", "not-present-anywhere");
      assert.equal(await cdp.evaluate('document.getElementById("empty").hidden'), false);
      await cdp.input("#search", "");
      await cdp.input("#new-site", "https://new.example/path");
      await cdp.click("#add-site");
      assert.equal(
        await cdp.evaluate('testFixture.state.settings.siteRules.includes("new.example")'),
        true,
      );
      assert.equal(await cdp.evaluate('document.getElementById("new-site").value'), "");
      await cdp.input("#search", "new.example");
      await cdp.click("#site-list button");
      assert.equal(
        await cdp.evaluate('testFixture.state.settings.siteRules.includes("new.example")'),
        false,
      );
      await cdp.click("#clear");
      assert.equal(await cdp.evaluate('document.getElementById("clear-confirm").hidden'), false);
      assert.equal(
        await cdp.evaluate(
          'testFixture.messages.filter(message => message.type === "CLEAR_SITES").length',
        ),
        0,
      );
      await cdp.click("#cancel-clear");
      assert.equal(await cdp.evaluate('document.getElementById("clear-confirm").hidden'), true);
      await cdp.click("#clear");
      await cdp.click("#confirm-clear");
      assert.equal(await cdp.evaluate("testFixture.state.settings.siteRules.length"), 0);
      assert.equal(await cdp.evaluate('document.getElementById("clear-confirm").hidden'), true);
    });

    await t.test(
      "draft proxy endpoint survives refresh and unrelated changes; failed settings remain unsaved",
      async () => {
        await cdp.load(`${origin}/options.html`, 1120, 900);
        await cdp.input("#proxy-host", "192.0.2.9");
        await cdp.input("#proxy-port", "10808");
        await cdp.evaluate(
          'testFixture.state.settings.siteRules.push("external.example"); testFixture.emitStorage()',
        );
        await cdp.settled();
        assert.equal(
          await cdp.evaluate('document.getElementById("proxy-host").value'),
          "192.0.2.9",
        );
        await cdp.click("#retry");
        assert.equal(await cdp.evaluate('document.getElementById("proxy-port").value'), "10808");
        await cdp.click("#save-proxy");
        assert.equal(await cdp.evaluate("testFixture.state.settings.proxy.host"), "192.0.2.9");
        assert.equal(await cdp.evaluate("testFixture.state.settings.proxy.port"), 10808);
        await cdp.evaluate('testFixture.failNext = "Тест: Chrome отклонил изменение"');
        await cdp.click("#fallback");
        assert.equal(await cdp.evaluate('document.getElementById("fallback").checked'), true);
        assert.match(
          await cdp.evaluate('document.getElementById("error").textContent'),
          /отклонил/,
        );
        assert.match(
          await cdp.evaluate('document.getElementById("saved").textContent'),
          /не подтверждено/,
        );
        await cdp.evaluate(
          'testFixture.state.control = "controlled_by_other_extensions"; testFixture.emitStorage()',
        );
        await cdp.settled();
        assert.match(
          await cdp.evaluate('document.getElementById("control").textContent'),
          /другое расширение/,
        );
      },
    );

    await t.test(
      "narrow settings view has no horizontal scroll or clipped action buttons",
      async () => {
        await cdp.load(`${origin}/options.html`, 360, 800);
        assert.ok(await cdp.evaluate("document.documentElement.scrollWidth <= innerWidth"));
        assert.ok(
          await cdp.evaluate(
            '[...document.querySelectorAll("button,input,select")].filter(element => element.getClientRects().length).every(element => {const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;})',
          ),
        );
      },
    );
    if (process.env.UI_SCREENSHOT_DIR) {
      const directory = resolve(process.env.UI_SCREENSHOT_DIR);
      await mkdir(directory, { recursive: true });
      for (const colorScheme of ["light", "dark"]) {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: colorScheme }],
        });
        for (const [page, width] of [
          ["popup", 360],
          ["options", 1100],
        ]) {
          await cdp.load(`${origin}/${page}.html`, width, 900);
          const size = await cdp.evaluate(
            "({width: document.documentElement.scrollWidth, height: document.body.scrollHeight})",
          );
          const screenshot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
          });
          await writeFile(
            join(directory, `${page}-${colorScheme}.png`),
            Buffer.from(screenshot.data, "base64"),
          );
        }
      }
    }
    assert.deepEqual(cdp.errors, [], "UI must not throw runtime errors");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

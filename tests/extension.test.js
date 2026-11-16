import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createController } from "../dist/controller.js";
import { classifyHost, getHostname, getPacScript, normalizeHost } from "../dist/routing.js";
import { defaultSettings, loadSettings, parseMessage, parseSettings } from "../dist/settings.js";

const copy = (value) => structuredClone(value);
const autoSettings = (patch = {}) => ({ ...defaultSettings(), mode: "auto", ...patch });

function setup(seed = { settings: autoSettings() }) {
  const stored = copy(seed);
  const calls = { set: [], clear: [], removed: [], badge: [] };
  const control = {
    level: "controllable_by_this_extension",
    effective: { mode: "system" },
    failSet: false,
    failClear: false,
    failStorage: false,
    loseControl: false,
  };
  const api = {
    storage: {
      local: {
        async get(keys) {
          await Promise.resolve();
          return copy(
            Object.fromEntries(
              keys.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]),
            ),
          );
        },
        async set(patch) {
          if (control.failStorage) {
            control.failStorage = false;
            throw new Error("storage failure");
          }
          Object.assign(stored, copy(patch));
        },
        async remove(keys) {
          calls.removed.push(...keys);
          for (const key of keys) delete stored[key];
        },
      },
    },
    proxy: {
      settings: {
        async get() {
          return copy({ levelOfControl: control.level, value: control.effective });
        },
        async set({ scope, value }) {
          assert.equal(scope, "regular");
          calls.set.push(copy(value));
          if (control.failSet) {
            control.failSet = false;
            throw new Error("proxy write failure");
          }
          control.effective = copy(value);
          control.level = control.loseControl
            ? "controlled_by_other_extensions"
            : "controlled_by_this_extension";
          control.loseControl = false;
        },
        async clear({ scope }) {
          assert.equal(scope, "regular");
          calls.clear.push(scope);
          if (control.failClear) {
            control.failClear = false;
            throw new Error("proxy clear failure");
          }
          control.effective = { mode: "system" };
          control.level = "controllable_by_this_extension";
        },
      },
    },
    action: {
      async setBadgeText({ text }) {
        calls.badge.push(text);
      },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
    },
  };
  const controller = createController(api);
  return { stored, calls, control, controller, api, send: controller.handle };
}

function pac(settings = autoSettings()) {
  const context = vm.createContext({});
  vm.runInContext(getPacScript(settings), context);
  return (host) => context.FindProxyForURL(`https://${host}/`, host);
}

test("PAC is self-contained and preserves local / Russian / exception boundaries", () => {
  const resolve = pac(autoSettings({ siteRules: ["example.com"] }));
  const direct = [
    "example.com",
    "app.example.com",
    "DEEP.EXAMPLE.RU.",
    "example.su",
    "xn--e1afmkfd.xn--p1ai",
    "192.168.0.1",
    "10.255.255.255",
    "127.20.0.1",
    "172.16.0.0",
    "172.31.255.255",
    "169.254.0.1",
    "router.local",
    "app.localhost",
    "router.home.arpa",
    "intranet",
    "::1",
    "::",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "febf::1",
    "::ffff:7f00:1",
    "::ffff:c0a8:1",
  ];
  const proxied = [
    "example.com.evil.test",
    "evil-example.com",
    "example.ru.evil.test",
    "localhost.evil.test",
    "172.15.255.255",
    "172.32.0.0",
    "169.255.0.1",
    "192.169.0.1",
    "8.8.8.8",
    "fc0::1",
    "fbff::1",
    "fe00::1",
    "fec0::1",
    "2606:4700:4700::1111",
    "::ffff:808:808",
    "10.public.test",
    "127.public.example",
  ];
  for (const host of direct) assert.equal(resolve(host), "DIRECT", host);
  for (const host of proxied) assert.equal(resolve(host), "PROXY 127.0.0.1:10809; DIRECT", host);
});

test("individual routing settings generate PAC with HTTP/SOCKS5 and optional fallback", () => {
  const resolve = pac(
    autoSettings({
      bypassLocal: false,
      bypassRussian: false,
      fallbackDirect: false,
      proxy: { scheme: "socks5", host: "::1", port: 10808 },
      siteRules: ["example.ru"],
    }),
  );
  for (const host of ["192.168.0.1", "localhost", "yandex.ru", "example.com"]) {
    assert.equal(resolve(host), "SOCKS5 [::1]:10808");
  }
  assert.equal(resolve("example.ru"), "DIRECT");
});

test("shared matcher and PAC agree for Unicode, literal IPs and domain rules", () => {
  const settings = autoSettings({ siteRules: ["vk.com"] });
  const resolve = pac(settings);
  for (const url of [
    "https://пример.рф/",
    "https://app.vk.com/",
    "http://localhost:3000",
    "https://[fd12::1]/",
    "https://8.8.8.8/",
    "https://example.ru.evil.test/",
  ]) {
    const host = getHostname(url);
    assert.equal(classifyHost(host, settings.siteRules).direct, resolve(host) === "DIRECT");
  }
});

test("domain input normalizes URLs and rejects malformed labels, schemes and IP exceptions", () => {
  assert.equal(normalizeHost("https://WWW.Example.COM/path"), "example.com");
  assert.equal(normalizeHost("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  for (const input of [
    "-evil.com",
    "evil-.com",
    ".evil.com",
    "a..com",
    "https://",
    "chrome://extensions",
    "localhost",
    "192.168.0.1",
    {},
    null,
  ]) {
    assert.equal(normalizeHost(input), "", String(input));
  }
});

test("new install remains system-controlled; migration preserves all 33 rules", async () => {
  const fresh = setup({});
  assert.equal((await fresh.controller.initialize()).state.settings.mode, "system");
  assert.equal(fresh.calls.set.length, 0);
  const sites = Array.from({ length: 33 }, (_, index) => `site${index}.test`);
  const existing = setup({ enabled: true, siteRules: sites, lastError: "obsolete" });
  const result = await existing.controller.initialize();
  assert.equal(result.ok, true);
  assert.equal(result.state.settings.mode, "auto");
  assert.deepEqual(result.state.settings.siteRules, [...sites].sort());
  assert.deepEqual(existing.calls.removed, ["enabled", "siteRules", "lastError"]);
  assert.equal(Object.hasOwn(existing.stored, "enabled"), false);
  assert.equal(existing.control.effective.pacScript.mandatory, true);
});

test("migration failure preserves original data; invalid current settings never silently reset", async () => {
  const context = setup({ enabled: false, siteRules: ["kept.test"] });
  context.control.failStorage = true;
  assert.equal((await context.controller.initialize()).ok, false);
  assert.deepEqual(context.stored.siteRules, ["kept.test"]);
  assert.equal(context.calls.removed.length, 0);
  assert.equal(context.stored.enabled, false);
  const corrupt = setup({
    settings: { schemaVersion: 2 },
    enabled: true,
    siteRules: ["keep.test"],
  });
  assert.equal((await corrupt.send({ type: "GET_STATE" })).ok, false);
  assert.deepEqual(corrupt.stored.settings, { schemaVersion: 2 });
  assert.equal(corrupt.calls.set.length, 0);
});

test("disabled migration and later exception edits never enable auto mode", async () => {
  const context = setup({ enabled: false, siteRules: ["kept.test"] });
  await context.controller.initialize();
  const result = await context.send({ type: "ADD_SITE", host: "added.test" });
  assert.equal(result.state.settings.mode, "system");
  assert.equal(context.calls.set.length, 0);
  assert.deepEqual(context.stored.settings.siteRules, ["added.test", "kept.test"]);
});

test("patch validation rejects unknown keys, nonbooleans and injected proxy directives", () => {
  for (const patch of [
    { enabled: true },
    { bypassLocal: 1 },
    { mode: "paused" },
    { proxy: { scheme: "https", host: "127.0.0.1", port: 1 } },
    { proxy: { scheme: "http", host: "evil; DIRECT", port: 10809 } },
    { proxy: { scheme: "http", host: "example.com:1234", port: 10809 } },
    { proxy: { scheme: "http", host: "user@example.com", port: 10809 } },
    { proxy: { scheme: "http", host: "127.0.0.1", port: "10809" } },
    { proxy: { scheme: "http", host: "127.0.0.1", port: 65536 } },
    { siteRules: [] },
  ])
    assert.throws(() => parseMessage({ type: "UPDATE_SETTINGS", patch }));
  assert.throws(() => parseMessage({ type: "GET_STATE", siteRules: [] }));
  assert.throws(() => parseMessage({ type: "UNKNOWN" }));
  assert.throws(() => parseSettings({ ...defaultSettings(), fallbackDirect: undefined }));
  assert.equal(
    parseMessage({ type: "UPDATE_SETTINGS", patch: { bypassLocal: false } }).patch.bypassLocal,
    false,
  );
});

test("three modes apply only to regular profile; system releases extension control", async () => {
  const context = setup();
  await context.controller.initialize();
  const direct = await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "direct" } });
  assert.equal(direct.ok, true);
  assert.deepEqual(context.control.effective, { mode: "direct" });
  assert.equal(context.calls.badge.at(-1), "DIR");
  const system = await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "system" } });
  assert.equal(system.state.settings.mode, "system");
  assert.equal(system.state.control, "controllable_by_this_extension");
  assert.equal(context.calls.badge.at(-1), "");
  await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "auto" } });
  assert.equal(context.calls.badge.at(-1), "AUTO");
});

test("concurrent incremental changes preserve rules and unrelated settings", async () => {
  const context = setup({ settings: autoSettings({ siteRules: ["kept.test"] }) });
  const results = await Promise.all([
    context.send({ type: "ADD_SITE", host: "one.test" }),
    context.send({ type: "ADD_SITE", host: "two.test" }),
    context.send({ type: "UPDATE_SETTINGS", patch: { bypassRussian: false } }),
    context.send({ type: "UPDATE_SETTINGS", patch: { mode: "system" } }),
    context.send({ type: "GET_STATE" }),
  ]);
  assert.deepEqual(results.at(-1).state.settings.siteRules, ["kept.test", "one.test", "two.test"]);
  assert.equal(results.at(-1).state.settings.bypassRussian, false);
  assert.equal(results.at(-1).state.settings.mode, "system");
});

test("storage failure restores prior Chrome configuration and retry works", async () => {
  const context = setup();
  await context.controller.initialize();
  const previous = copy(context.control.effective);
  context.control.failStorage = true;
  const failed = await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "direct" } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /storage failure/);
  assert.equal(failed.state.settings.mode, "auto");
  assert.deepEqual(context.control.effective, previous);
  assert.equal(context.stored.settings.mode, "auto");
  const retried = await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "direct" } });
  assert.equal(retried.ok, true);
  assert.equal(retried.state.error, "");
});

test("failed clear preserves saved mode and active proxy without fake success", async () => {
  const context = setup();
  await context.controller.initialize();
  const previous = copy(context.control.effective);
  context.control.failClear = true;
  const failed = await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "system" } });
  assert.equal(failed.ok, false);
  assert.equal(failed.state.settings.mode, "auto");
  assert.deepEqual(context.control.effective, previous);
  assert.equal(context.calls.badge.at(-1), "!");
});

test("failed exception application never persists an unapplied rule", async () => {
  const context = setup();
  await context.controller.initialize();
  context.control.failSet = true;
  const result = await context.send({ type: "ADD_SITE", host: "unapplied.test" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.state.settings.siteRules, []);
  assert.deepEqual(context.stored.settings.siteRules, []);
});

test("other controller / policy is surfaced without changing routing", async () => {
  for (const level of ["controlled_by_other_extensions", "not_controllable"]) {
    const context = setup();
    context.control.level = level;
    assert.equal((await context.send({ type: "GET_STATE" })).state.control, level);
    assert.equal(
      (await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "direct" } })).ok,
      false,
    );
    assert.equal(context.calls.set.length, 0);
    assert.equal(context.calls.clear.length, 0);
    assert.equal(context.stored.settings.mode, "auto");
  }
});

test("control lost during apply is not committed; previous config is restored", async () => {
  const context = setup();
  await context.controller.initialize();
  const previous = copy(context.control.effective);
  context.control.loseControl = true;
  const result = await context.send({ type: "UPDATE_SETTINGS", patch: { mode: "direct" } });
  assert.equal(result.ok, false);
  assert.equal(context.stored.settings.mode, "auto");
  assert.deepEqual(context.control.effective, previous);
});

test("removal targets actual covering rule; clearing preserves automatic rules", async () => {
  const context = setup({ settings: autoSettings({ siteRules: ["example.com", "kept.test"] }) });
  assert.equal(
    classifyHost("app.example.com", context.stored.settings.siteRules).rule,
    "example.com",
  );
  await context.send({ type: "REMOVE_SITE", host: "example.com" });
  assert.deepEqual(context.stored.settings.siteRules, ["kept.test"]);
  await context.send({ type: "CLEAR_SITES" });
  assert.equal(pac(context.stored.settings)("yandex.ru"), "DIRECT");
  assert.deepEqual(context.stored.settings.siteRules, []);
});

test("nonfatal error is notice; fatal is error; pause ignores obsolete error", async () => {
  const context = setup();
  await context.controller.initialize();
  await context.controller.proxyError({ error: "ERR_PROXY_CONNECTION_FAILED", fatal: false });
  const warning = await context.send({ type: "GET_STATE" });
  assert.equal(warning.state.error, "");
  assert.match(warning.state.notice, /фактический маршрут/);
  await context.controller.proxyError({ error: "ERR_PAC_SCRIPT_FAILED", fatal: true });
  assert.match((await context.send({ type: "GET_STATE" })).state.error, /ERR_PAC_SCRIPT_FAILED/);
  await Promise.all([
    context.send({ type: "UPDATE_SETTINGS", patch: { mode: "system" } }),
    context.controller.proxyError({ error: "obsolete", fatal: true }),
  ]);
  assert.equal((await context.send({ type: "GET_STATE" })).state.error, "");
});

test("canonical settings survive worker restart and proxy endpoint round-trips", async () => {
  const context = setup();
  await context.send({
    type: "UPDATE_SETTINGS",
    patch: {
      proxy: { scheme: "socks5", host: "127.0.0.1", port: 10808 },
      fallbackDirect: false,
    },
  });
  const restarted = setup(context.stored);
  await restarted.controller.initialize();
  assert.equal(pac(restarted.stored.settings)("example.com"), "SOCKS5 127.0.0.1:10808");
  assert.deepEqual(await loadSettings(restarted.api.storage.local), context.stored.settings);
});

test("GET_STATE detects an owned but stale effective configuration; reapply repairs it", async () => {
  const context = setup();
  await context.controller.initialize();
  context.control.effective = { mode: "direct" };
  const drifted = await context.send({ type: "GET_STATE" });
  assert.match(drifted.state.error, /отличается/);
  assert.equal(drifted.state.settings.mode, "auto");
  const repaired = await context.send({ type: "REAPPLY" });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.state.error, "");
  assert.equal(context.control.effective.mode, "pac_script");
});

test("actual module worker routes Chrome events and rejects messages from another extension", async () => {
  const context = setup({ enabled: true, siteRules: ["kept.test"] });
  const events = {};
  const event = (name) => ({
    addListener(listener) {
      events[name] = listener;
    },
  });
  globalThis.chrome = {
    ...context.api,
    runtime: {
      id: "test-extension",
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message"),
    },
    proxy: { ...context.api.proxy, onProxyError: event("proxyError") },
  };
  try {
    await import("../dist/background.js");
    events.installed();
    const send = (message) =>
      new Promise((resolve) => {
        assert.equal(events.message(message, { id: "test-extension" }, resolve), true);
      });
    const migrated = await send({ type: "GET_STATE" });
    assert.equal(migrated.state.settings.mode, "auto");
    assert.deepEqual(migrated.state.settings.siteRules, ["kept.test"]);
    let rejected;
    assert.equal(
      events.message({ type: "CLEAR_SITES" }, { id: "other-extension" }, (value) => {
        rejected = value;
      }),
      false,
    );
    assert.equal(rejected.ok, false);
    assert.deepEqual(context.stored.settings.siteRules, ["kept.test"]);
    await send({ type: "UPDATE_SETTINGS", patch: { mode: "system" } });
    events.startup();
    const restarted = await send({ type: "GET_STATE" });
    assert.equal(restarted.state.settings.mode, "system");
    events.proxyError({ error: "obsolete", fatal: true });
    assert.equal((await send({ type: "GET_STATE" })).state.error, "");
  } finally {
    delete globalThis.chrome;
  }
});

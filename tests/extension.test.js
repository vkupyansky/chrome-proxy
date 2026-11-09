"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");
const backgroundSource = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8");
const popupSource = fs.readFileSync(path.join(extensionRoot, "popup.js"), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));

function createBackground(seed = {}) {
  const stored = { enabled: true, siteRules: [], lastError: "", ...copy(seed) };
  const events = {};
  const calls = { set: [], clear: [], badge: [] };
  const control = {
    level: "controlled_by_this_extension",
    failNextProxySet: false,
    failNextProxyClear: false,
    failNextStorageSet: false,
    effectiveProxy: undefined
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const snapshot = Array.isArray(keys)
            ? Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]))
            : { ...keys, ...stored };
          await Promise.resolve();
          return copy(snapshot);
        },
        async set(patch) {
          if (control.failNextStorageSet) {
            control.failNextStorageSet = false;
            throw new Error("Simulated storage write failure");
          }
          Object.assign(stored, copy(patch));
        }
      }
    },
    action: {
      async setBadgeText({ text }) { calls.badge.push(text); },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {}
    },
    proxy: {
      settings: {
        async set(options) {
          calls.set.push(copy(options));
          if (control.failNextProxySet) {
            control.failNextProxySet = false;
            throw new Error("Simulated proxy write failure");
          }
          control.effectiveProxy = copy(options.value);
        },
        async get() { return { levelOfControl: control.level, value: control.effectiveProxy }; },
        async clear(options) {
          calls.clear.push(copy(options));
          if (control.failNextProxyClear) {
            control.failNextProxyClear = false;
            throw new Error("Simulated proxy clear failure");
          }
          control.effectiveProxy = undefined;
        }
      },
      onProxyError: { addListener(listener) { events.proxyError = listener; } }
    },
    runtime: {
      onInstalled: { addListener(listener) { events.installed = listener; } },
      onStartup: { addListener(listener) { events.startup = listener; } },
      onMessage: { addListener(listener) { events.message = listener; } }
    }
  };
  const context = vm.createContext({ chrome, URL });
  vm.runInContext(backgroundSource, context, { filename: "background.js" });
  const send = message => new Promise(resolve => {
    assert.equal(events.message(copy(message), {}, response => resolve(copy(response))), true);
  });
  return { stored, events, calls, control, context, send };
}

function createElement() {
  return {
    textContent: "", value: "", title: "", disabled: false, hidden: false,
    attributes: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
    append(...children) { this.children.push(...children); }
  };
}

function createPopup(background, url = "https://app.example.com/", hasRuntime = true) {
  const elements = new Map();
  const messages = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    createElement,
    addEventListener() {}
  };
  const chrome = {
    tabs: { async query() { return [{ url }]; } },
    runtime: {
      async sendMessage(message) {
        messages.push(copy(message));
        return background.send(message);
      }
    }
  };
  const context = vm.createContext({ document, ...(hasRuntime ? { chrome } : {}), URL });
  vm.runInContext(popupSource, context, { filename: "popup.js" });
  return { elements, messages, context, run: expression => vm.runInContext(expression, context) };
}

function resolvePac(background, siteRules) {
  const script = vm.runInContext(`getPacScript(${JSON.stringify(siteRules)})`, background.context);
  // Chromium excludes IP literals from isPlainHostName; no DNS is performed here.
  const context = vm.createContext({
    isPlainHostName: host => !host.includes(".") && net.isIP(host) === 0,
    dnsDomainIs: (host, domain) => host.endsWith(domain),
    shExpMatch: (value, pattern) => new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)
  });
  vm.runInContext(script, context);
  return host => context.FindProxyForURL(`https://${host}/`, host);
}

test("PAC routes browser sites to SOCKS5 and preserves domain boundaries and local bypass", () => {
  const resolve = resolvePac(createBackground(), ["example.com"]);
  const cases = [
    ["example.com", "DIRECT"], ["www.example.com", "DIRECT"],
    ["deep.app.example.com", "DIRECT"], ["WWW.EXAMPLE.COM", "DIRECT"],
    ["example.com.evil.test", "SOCKS5 127.0.0.1:21982"],
    ["evil-example.com", "SOCKS5 127.0.0.1:21982"],
    ["192.168.5.7", "DIRECT"], ["172.16.0.1", "DIRECT"],
    ["172.29.0.1", "DIRECT"], ["172.32.0.1", "SOCKS5 127.0.0.1:21982"],
    ["localhost", "DIRECT"], ["intranet", "DIRECT"],
    ["8.8.8.8", "SOCKS5 127.0.0.1:21982"],
    ["2001:4860:4860::8888", "SOCKS5 127.0.0.1:21982"]
  ];
  for (const [host, expected] of cases) assert.equal(resolve(host), expected, host);
});

test("startup and update preserve disabled state and existing exclusions", async () => {
  const background = createBackground({ enabled: false, siteRules: ["example.com", "work.test"] });
  await background.events.installed();
  await background.events.startup();
  assert.equal(background.stored.enabled, false);
  assert.deepEqual(background.stored.siteRules, ["example.com", "work.test"]);
  assert.equal(background.calls.set.length, 0);
  assert.equal(background.calls.badge.at(-1), "");
});

test("first installation stays paused and preserves previously enabled profiles", async () => {
  const fresh = createBackground();
  delete fresh.stored.enabled;
  delete fresh.stored.siteRules;
  await fresh.events.installed();
  assert.equal(fresh.stored.enabled, false);
  assert.deepEqual(fresh.stored.siteRules, []);
  assert.equal(fresh.calls.set.length, 0);
  assert.equal(fresh.calls.badge.at(-1), "");
  const existing = createBackground({ enabled: true, siteRules: ["kept.test"] });
  await existing.events.installed();
  assert.equal(existing.stored.enabled, true);
  assert.deepEqual(existing.stored.siteRules, ["kept.test"]);
  assert.equal(existing.calls.badge.at(-1), "EX");
});

test("public domain names resembling private IPv4 addresses still use the proxy", () => {
  const resolve = resolvePac(createBackground(), []);
  const expected = resolve("ordinary.example");
  for (const host of ["10.example.com", "127.public.example", "172.20.example.com", "192.168.example.com"]) {
    assert.equal(resolve(host), expected, host);
  }
});

test("failed proxy disable is saved and a later retry clears the error", async () => {
  const background = createBackground();
  await background.events.startup();
  const popup = createPopup(background);
  await popup.run("loadState()");
  const previousProxy = copy(background.control.effectiveProxy);
  background.control.failNextProxyClear = true;
  await popup.run("toggleRules()");
  assert.equal(background.stored.enabled, true);
  assert.equal(popup.elements.get("toggle").attributes["aria-checked"], "true");
  assert.match(background.stored.lastError, /proxy clear failure/);
  assert.equal(background.calls.badge.at(-1), "!");
  assert.deepEqual(background.control.effectiveProxy, previousProxy);
  await popup.run("toggleRules()");
  assert.equal(background.stored.enabled, false);
  assert.equal(popup.elements.get("toggle").attributes["aria-checked"], "false");
  assert.equal(background.stored.lastError, "");
  assert.equal(background.calls.badge.at(-1), "");
  assert.equal(background.control.effectiveProxy, undefined);
});

test("editing exclusions while paused cannot enable proxy traffic", async () => {
  const background = createBackground({ enabled: false, siteRules: ["kept.test"] });
  const popup = createPopup(background);
  await popup.run("loadState()");
  await popup.run('addSite("another.test")');
  assert.equal(background.stored.enabled, false);
  assert.deepEqual(background.stored.siteRules, ["another.test", "kept.test"]);
  assert.equal(background.calls.set.length, 0);
  assert.equal(popup.elements.get("toggle").attributes["aria-checked"], "false");
});

test("ALL, EX and pause apply only the regular profile and preserve exclusions", async () => {
  const background = createBackground();
  await background.events.startup();
  assert.equal(background.calls.badge.at(-1), "ALL");
  assert.equal(background.calls.set.at(-1).scope, "regular");
  assert.equal(background.calls.set.at(-1).value.pacScript.mandatory, true);
  await background.send({ type: "ADD_SITE", host: "https://WWW.Example.com/path" });
  assert.equal(background.calls.badge.at(-1), "EX");
  await background.send({ type: "SET_ENABLED", enabled: false });
  assert.equal(background.calls.badge.at(-1), "");
  assert.deepEqual(background.calls.clear, [{ scope: "regular" }]);
  const response = await background.send({ type: "SET_ENABLED", enabled: true });
  assert.deepEqual(response.siteRules, ["example.com"]);
  assert.equal(background.calls.badge.at(-1), "EX");
  const restarted = createBackground(background.stored);
  await restarted.events.startup();
  assert.equal(restarted.calls.badge.at(-1), "EX");
});

test("failed PAC application reports an error without removing the active proxy", async () => {
  const background = createBackground({ siteRules: ["work.test"] });
  await background.events.startup();
  const previousProxy = copy(background.control.effectiveProxy);
  background.control.failNextProxySet = true;
  const response = await background.send({ type: "SET_ENABLED", enabled: true });
  assert.equal(response.ok, false);
  assert.equal(response.enabled, true);
  assert.match(response.error, /proxy write failure/);
  assert.equal(background.calls.badge.at(-1), "!");
  assert.equal(background.calls.clear.length, 0);
  assert.deepEqual(background.control.effectiveProxy, previousProxy);
  assert.equal((await background.send({ type: "SET_ENABLED", enabled: true })).ok, true);
});

test("another controller is reported without clearing this extension's proxy settings", async () => {
  const background = createBackground();
  background.control.level = "controlled_by_other_extensions";
  const response = await background.send({ type: "SET_ENABLED", enabled: true });
  assert.equal(response.ok, false);
  assert.match(response.error, /управление прокси/);
  assert.equal(background.calls.clear.length, 0);
});

test("concurrent popup requests do not lose exclusions or race the final pause", async () => {
  const background = createBackground({ siteRules: ["existing.test"] });
  const responses = await Promise.all([
    background.send({ type: "ADD_SITE", host: "one.test" }),
    background.send({ type: "ADD_SITE", host: "two.test" }),
    background.send({ type: "SET_ENABLED", enabled: false }),
    background.send({ type: "GET_STATE", currentHost: "one.test" })
  ]);
  assert.deepEqual(responses[3].siteRules, ["existing.test", "one.test", "two.test"]);
  assert.equal(responses[3].enabled, false);
  assert.equal(background.calls.badge.at(-1), "");
  assert.equal(background.control.effectiveProxy, undefined);
});

test("a rejected queued write reaches the caller and later requests still succeed", async () => {
  const background = createBackground({ siteRules: ["existing.test"] });
  background.control.failNextStorageSet = true;
  const failed = await background.send({ type: "ADD_SITE", host: "failed.test" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /storage write failure/);
  assert.equal(Object.hasOwn(failed, "enabled"), false);
  assert.equal(Object.hasOwn(failed, "siteRules"), false);
  const successful = await background.send({ type: "ADD_SITE", host: "later.test" });
  assert.equal(successful.ok, true);
  assert.deepEqual(successful.siteRules, ["existing.test", "later.test"]);
});

test("a proxy error queued after pause cannot restore an obsolete error badge", async () => {
  const background = createBackground();
  await Promise.all([
    background.send({ type: "SET_ENABLED", enabled: false }),
    background.events.proxyError({ error: "ERR_PROXY_CONNECTION_FAILED", fatal: true })
  ]);
  assert.equal(background.stored.lastError, "");
  assert.equal(background.calls.badge.at(-1), "");
});

test("invalid popup input preserves the enabled state and the next click pauses", async () => {
  const background = createBackground();
  const popup = createPopup(background);
  await popup.run("loadState()");
  await popup.run('addSite("")');
  assert.equal(popup.elements.get("status").textContent, "Прокси для всех");
  assert.equal(popup.elements.get("toggle").attributes["aria-checked"], "true");
  assert.match(popup.elements.get("error").textContent, /Введите домен/);
  await popup.run("toggleRules()");
  assert.equal(background.stored.enabled, false);
});

test("popup opened without Chrome APIs cannot imitate a working proxy", async () => {
  const popup = createPopup(undefined, "https://example.com/", false);
  await popup.run("loadState()");
  assert.equal(popup.elements.get("status").textContent, "Расширение недоступно");
  assert.equal(popup.elements.get("toggle").disabled, true);
  assert.equal(popup.elements.get("toggle").attributes["aria-checked"], "false");
  assert.match(popup.elements.get("error").textContent, /значок расширения/u);
});

test("an initial worker failure cannot confirm default popup state", async () => {
  const background = createBackground({ enabled: true, siteRules: ["kept.test"] });
  const popup = createPopup(background);
  popup.run('chrome.runtime.sendMessage = async () => { throw new Error("Simulated worker unavailable"); }');
  await popup.run("loadState()");
  assert.equal(popup.elements.get("status").textContent, "Состояние недоступно");
  assert.equal(popup.elements.get("countBadge").textContent, "?");
  assert.equal(popup.elements.get("currentMode").textContent, "?");
  assert.equal(popup.elements.get("toggle").disabled, true);
  assert.match(popup.elements.get("error").textContent, /worker unavailable/u);
  assert.equal(background.stored.enabled, true);
  assert.deepEqual(background.stored.siteRules, ["kept.test"]);
});

test("popup operation errors preserve its displayed rules and enabled state", async () => {
  const background = createBackground({ siteRules: ["existing.test"] });
  const popup = createPopup(background);
  await popup.run("loadState()");
  background.control.failNextStorageSet = true;
  await popup.run('addSite("new.test")');
  assert.equal(popup.elements.get("toggle").attributes["aria-checked"], "true");
  assert.equal(popup.elements.get("countBadge").textContent, "1");
  assert.match(popup.elements.get("error").textContent, /storage write failure/);
});

test("the subdomain removal button names and removes the rule actually covering it", async () => {
  const background = createBackground({ siteRules: ["example.com", "unrelated.test"] });
  const popup = createPopup(background);
  await popup.run("loadState()");
  assert.equal(popup.elements.get("detail").textContent, "Исключение: example.com");
  assert.match(popup.elements.get("siteAction").title, /example\.com и его поддомены/);
  assert.match(popup.elements.get("siteAction").attributes["aria-label"], /example\.com/);
  await popup.run("handleSiteAction()");
  assert.deepEqual(popup.messages.at(-1), { type: "REMOVE_SITE", host: "example.com" });
  assert.deepEqual(background.stored.siteRules, ["unrelated.test"]);
  assert.equal(popup.elements.get("currentMode").textContent, "Прокси");
});

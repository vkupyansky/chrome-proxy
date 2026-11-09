const PROXY_CONFIG = {
  scheme: "socks5",
  host: "127.0.0.1",
  port: 21982
};

const BADGE = {
  all: { text: "ALL", color: "#16a34a" },
  bypass: { text: "EX", color: "#2563eb" },
  paused: { text: "", color: "#6b7280" },
  error: { text: "!", color: "#dc2626" }
};

const STORAGE_DEFAULTS = {
  enabled: false,
  siteRules: [],
  lastError: ""
};

let stateQueue = Promise.resolve();

function queueStateChange(operation) {
  const result = stateQueue.then(operation);
  // A failed request must reach its caller without blocking later requests.
  stateQueue = result.catch(() => {});
  return result;
}

function proxyDirective() {
  if (PROXY_CONFIG.scheme === "socks4") {
    return `SOCKS ${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`;
  }

  if (PROXY_CONFIG.scheme === "socks5") {
    return `SOCKS5 ${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`;
  }

  if (PROXY_CONFIG.scheme === "https") {
    return `HTTPS ${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`;
  }

  return `PROXY ${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`;
}

function normalizeHost(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) {
    return "";
  }

  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return normalizeHostname(url.hostname);
  } catch {
    const host = raw
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^[^@]+@/, "")
      .split("/")[0]
      .split(":")[0];

    return normalizeHostname(host);
  }
}

function normalizeHostname(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "")
    .replace(/^www\./, "");

  if (
    !host ||
    host === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    !/^[a-z0-9.-]+$/.test(host) ||
    !host.includes(".")
  ) {
    return "";
  }

  return host;
}

function normalizeSites(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/\r?\n|,/);

  return [...new Set(source.map(normalizeHost).filter(Boolean))].sort();
}

function getPacScript(siteRules) {
  const rules = JSON.stringify(normalizeSites(siteRules));
  const proxy = JSON.stringify(proxyDirective());

  return `
function FindProxyForURL(url, host) {
  host = String(host || "").toLowerCase();
  // маска 10.* также совпадает с публичным доменом 10.example.com
  var parts = host.split(".");
  var ipv4 = /^[0-9]{1,3}([.][0-9]{1,3}){3}$/.test(host);
  for (var p = 0; ipv4 && p < parts.length; p += 1) {
    if (Number(parts[p]) > 255) ipv4 = false;
  }
  var localIpv4 = ipv4 && (
    Number(parts[0]) === 127 ||
    Number(parts[0]) === 10 ||
    (Number(parts[0]) === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) ||
    (Number(parts[0]) === 192 && Number(parts[1]) === 168)
  );

  if (
    isPlainHostName(host) ||
    host === "localhost" ||
    localIpv4
  ) {
    return "DIRECT";
  }

  var rules = ${rules};
  for (var i = 0; i < rules.length; i += 1) {
    var site = rules[i];
    if (host === site || dnsDomainIs(host, "." + site)) {
      return "DIRECT";
    }
  }

  return ${proxy};
}`;
}

function formatError(error, fallback = "Неизвестная ошибка прокси") {
  return error?.message || String(error || "") || fallback;
}

async function getStoredState() {
  const data = await chrome.storage.local.get(STORAGE_DEFAULTS);

  return {
    enabled: data.enabled === true,
    siteRules: normalizeSites(data.siteRules),
    lastError: String(data.lastError || "")
  };
}

async function saveState(patch) {
  return chrome.storage.local.set(patch);
}

function isHostCovered(host, siteRules) {
  const normalized = normalizeHost(host);

  return Boolean(
    normalized &&
    siteRules.some(site => normalized === site || normalized.endsWith(`.${site}`))
  );
}

function publicStateFromStored(stored, patch = {}) {
  const merged = {
    ...stored,
    ...patch,
    siteRules: normalizeSites(Object.hasOwn(patch, "siteRules") ? patch.siteRules : stored.siteRules)
  };
  const currentHost = normalizeHost(patch.currentHost);
  const currentSiteListed = isHostCovered(currentHost, merged.siteRules);
  const mode = !merged.enabled
    ? "paused"
    : merged.siteRules.length
      ? "bypass"
      : "all";

  return {
    ok: !merged.lastError,
    enabled: Boolean(merged.enabled),
    mode,
    endpoint: `${PROXY_CONFIG.scheme}://${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`,
    siteRules: merged.siteRules,
    siteCount: merged.siteRules.length,
    currentHost,
    currentSiteEnabled: Boolean(merged.enabled && currentHost && !currentSiteListed),
    currentSiteListed,
    error: merged.lastError || ""
  };
}

async function setBadge(mode) {
  const badge = BADGE[mode] || BADGE.paused;

  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
}

async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: "regular" });
}

async function applyState(enabled) {
  const previous = await getStoredState();
  const stored = typeof enabled === "boolean" ? { ...previous, enabled } : previous;

  try {
    if (!stored.enabled) {
      await clearProxy();
      await saveState({ enabled: false, lastError: "" });
      await setBadge("paused");
      return publicStateFromStored(stored, { lastError: "" });
    }

    await chrome.proxy.settings.set({
      scope: "regular",
      value: {
        mode: "pac_script",
        pacScript: {
          data: getPacScript(stored.siteRules),
          mandatory: true
        }
      }
    });

    const current = await chrome.proxy.settings.get({ incognito: false });
    if (current.levelOfControl !== "controlled_by_this_extension") {
      throw new Error("Chrome не передал расширению управление прокси");
    }

    await saveState({ enabled: true, lastError: "" });
    await setBadge(stored.siteRules.length ? "bypass" : "all");
    return publicStateFromStored(stored, { lastError: "" });
  } catch (error) {
    const message = formatError(error, "Chrome не применил PAC-настройки прокси");
    await saveState({ lastError: message });
    await setBadge("error");
    return publicStateFromStored(previous, { lastError: message });
  }
}

async function setEnabled(enabled) {
  return applyState(Boolean(enabled));
}

async function addSite(host) {
  const site = normalizeHost(host);

  if (!site) {
    const stored = await getStoredState();
    return publicStateFromStored(stored, {
      lastError: "Этот адрес нельзя добавить. Откройте обычный сайт с http или https."
    });
  }

  const stored = await getStoredState();
  const siteRules = normalizeSites([...stored.siteRules, site]);

  await saveState({ siteRules, lastError: "" });
  return applyState();
}

async function removeSite(host) {
  const site = normalizeHost(host);
  const stored = await getStoredState();
  const siteRules = stored.siteRules.filter(item => item !== site);

  await saveState({ siteRules, lastError: "" });
  return applyState();
}

async function clearSites() {
  await saveState({ siteRules: [], lastError: "" });
  return applyState();
}

async function handleMessage(message) {
  return queueStateChange(async () => {
    if (message?.type === "GET_STATE") {
      const stored = await getStoredState();
      return publicStateFromStored(stored, {
        currentHost: normalizeHost(message.currentHost)
      });
    }

    if (message?.type === "SET_ENABLED") {
      return setEnabled(message.enabled);
    }

    if (message?.type === "ADD_SITE") {
      return addSite(message.host);
    }

    if (message?.type === "REMOVE_SITE") {
      return removeSite(message.host);
    }

    if (message?.type === "CLEAR_SITES") {
      return clearSites();
    }

    return { ok: false, error: "Unknown message type" };
  });
}

chrome.runtime.onInstalled.addListener(() => queueStateChange(async () => {
  const data = await chrome.storage.local.get(["enabled", "siteRules"]);
  const patch = {};

  if (typeof data.enabled !== "boolean") {
    patch.enabled = false;
  }

  if (!Array.isArray(data.siteRules)) {
    patch.siteRules = [];
  }

  if (Object.keys(patch).length) {
    await saveState(patch);
  }

  await applyState();
}));

chrome.runtime.onStartup.addListener(() => queueStateChange(applyState));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(error => {
      sendResponse({
        ok: false,
        error: formatError(error)
      });
    });

  return true;
});

chrome.proxy.onProxyError.addListener(details => queueStateChange(async () => {
  const message = details?.error || "Chrome сообщил об ошибке прокси.";
  const stored = await getStoredState();

  if (stored.enabled) {
    await saveState({ lastError: message });
    await setBadge("error");
  }
}));

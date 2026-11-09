const elements = {
  toggle: document.getElementById("toggle"),
  toggleText: document.getElementById("toggleText"),
  toggleHint: document.getElementById("toggleHint"),
  status: document.getElementById("status"),
  detail: document.getElementById("detail"),
  dot: document.getElementById("dot"),
  countBadge: document.getElementById("countBadge"),
  currentHost: document.getElementById("currentHost"),
  currentMode: document.getElementById("currentMode"),
  siteAction: document.getElementById("siteAction"),
  manualForm: document.getElementById("manualForm"),
  manualHost: document.getElementById("manualHost"),
  addManual: document.getElementById("addManual"),
  clearSites: document.getElementById("clearSites"),
  emptyList: document.getElementById("emptyList"),
  siteList: document.getElementById("siteList"),
  error: document.getElementById("error")
};

const hasChromeRuntime = Boolean(globalThis.chrome?.runtime?.sendMessage);

let currentHost = "";
let currentState = {
  enabled: false,
  mode: "paused",
  endpoint: "",
  siteRules: [],
  siteCount: 0,
  currentSiteEnabled: false,
  currentSiteListed: false,
  currentSiteRule: "",
  error: ""
};
let busy = false;
let stateKnown = false;

function normalizeHost(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) {
    return "";
  }

  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return normalizeHostname(url.hostname);
  } catch {
    return normalizeHostname(
      raw
        .replace(/^[a-z]+:\/\//, "")
        .replace(/^[^@]+@/, "")
        .split("/")[0]
        .split(":")[0]
    );
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

function getCoveringRule(host, rules) {
  const normalized = normalizeHost(host);

  return normalized
    ? rules.find(site => normalized === site || normalized.endsWith(`.${site}`)) || ""
    : "";
}

async function getCurrentHost() {
  if (globalThis.chrome?.tabs?.query) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return normalizeHost(tab?.url || "");
  }

  return "";
}

function hydrateState(state = {}) {
  const siteRules = Array.isArray(state.siteRules) ? state.siteRules : currentState.siteRules;
  const enabled = Object.hasOwn(state, "enabled")
    ? Boolean(state.enabled)
    : currentState.enabled;
  const mode = enabled ? (siteRules.length ? "bypass" : "all") : "paused";
  const currentSiteRule = getCoveringRule(currentHost, siteRules);
  const currentSiteListed = Boolean(currentSiteRule);

  return {
    ...currentState,
    ...state,
    enabled,
    mode,
    siteRules,
    siteCount: siteRules.length,
    currentSiteListed,
    currentSiteRule,
    currentSiteEnabled: Boolean(enabled && currentHost && !currentSiteListed)
  };
}

async function send(type, payload = {}) {
  if (!hasChromeRuntime) {
    throw new Error("Откройте Chrome Proxy через значок расширения в Chrome");
  }

  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (typeof response?.enabled === "boolean") stateKnown = true;
  return response;
}

function getViewModel() {
  if (!hasChromeRuntime) {
    return {
      dot: "error",
      status: "Расширение недоступно",
      detail: "Откройте его через значок Chrome Proxy",
      toggleText: "Прокси недоступен",
      toggleHint: "Требуется Chrome"
    };
  }

  if (!stateKnown) {
    return {
      dot: "error",
      status: "Состояние недоступно",
      detail: "Закройте и снова откройте расширение",
      toggleText: "Прокси",
      toggleHint: "Не удалось проверить"
    };
  }

  if (!currentState.enabled) {
    return {
      dot: "off",
      status: "Пауза",
      detail: "DIRECT",
      toggleText: "Прокси выключен",
      toggleHint: "Включить"
    };
  }

  if (!currentState.siteRules.length) {
    return {
      dot: "on",
      status: "Прокси для всех",
      detail: "ALL",
      toggleText: "Прокси включён",
      toggleHint: "Пауза"
    };
  }

  if (currentState.currentSiteEnabled) {
    return {
      dot: "on",
      status: "Прокси",
      detail: `${currentState.siteRules.length} исключений`,
      toggleText: "Прокси включён",
      toggleHint: "Пауза"
    };
  }

  return {
    dot: "neutral",
    status: "DIRECT",
    detail: `Исключение: ${currentState.currentSiteRule}`,
    toggleText: "Прокси включён",
    toggleHint: "Пауза"
  };
}

function getModeLabel() {
  if (!stateKnown) {
    return "?";
  }

  if (!currentHost) {
    return "-";
  }

  if (!currentState.enabled) {
    return "OFF";
  }

  return currentState.currentSiteEnabled ? "Прокси" : "DIRECT";
}

function getActionLabel() {
  if (!currentHost) {
    return "-";
  }

  if (currentState.currentSiteListed) {
    return "Убрать";
  }

  return "Исключить";
}

function getActionTitle() {
  if (!currentHost) {
    return "Откройте обычный сайт";
  }

  if (currentState.currentSiteListed) {
    return `Убрать ${currentState.currentSiteRule} и его поддомены из исключений`;
  }

  return "Пустить сайт напрямую";
}

function getModeClass() {
  if (!currentState.enabled) {
    return "off";
  }

  return currentState.currentSiteEnabled ? "vpn" : "direct";
}

function setBusy(nextBusy) {
  busy = nextBusy;
  const disabled = busy || !hasChromeRuntime || !stateKnown;
  elements.toggle.disabled = disabled;
  elements.siteAction.disabled = disabled || !currentHost;
  elements.addManual.disabled = disabled;
  elements.manualHost.disabled = disabled;
  elements.clearSites.disabled = disabled || !currentState.siteRules.length;
}

function renderSiteList() {
  elements.siteList.textContent = "";
  elements.emptyList.textContent = currentState.enabled ? "Нет исключений" : "Прокси на паузе";
  elements.emptyList.hidden = Boolean(currentState.siteRules.length);

  for (const site of currentState.siteRules) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    const button = document.createElement("button");

    label.textContent = site;
    button.type = "button";
    button.textContent = "×";
    button.title = `Убрать ${site}`;
    button.setAttribute("aria-label", `Убрать ${site} из исключений`);
    button.addEventListener("click", () => removeSite(site));

    item.append(label, button);
    elements.siteList.append(item);
  }
}

function render(state) {
  currentState = hydrateState(state);

  const view = getViewModel();
  const countText = !stateKnown
    ? "?"
    : currentState.enabled
    ? currentState.siteRules.length
      ? String(currentState.siteRules.length)
      : "ALL"
    : "OFF";

  elements.status.textContent = view.status;
  elements.detail.textContent = view.detail;
  elements.toggleText.textContent = view.toggleText;
  elements.toggleHint.textContent = busy ? "..." : view.toggleHint;
  elements.countBadge.textContent = countText;
  elements.currentHost.textContent = currentHost || "Недоступно";
  elements.currentHost.title = currentHost || "";
  elements.currentMode.textContent = getModeLabel();
  elements.currentMode.classList.remove("vpn", "direct", "off");
  elements.currentMode.classList.add(getModeClass());
  elements.siteAction.textContent = getActionLabel();
  elements.siteAction.title = getActionTitle();
  elements.siteAction.setAttribute("aria-label", getActionTitle());
  elements.siteAction.classList.toggle("remove", currentState.currentSiteListed);

  elements.toggle.classList.toggle("on", currentState.enabled);
  elements.toggle.setAttribute("aria-checked", String(currentState.enabled));

  elements.dot.classList.remove("on", "warn", "error", "neutral");
  if (view.dot !== "off") {
    elements.dot.classList.add(view.dot);
  }

  if (currentState.error) {
    elements.error.textContent = currentState.error;
    elements.error.classList.add("show");
  } else {
    elements.error.textContent = "";
    elements.error.classList.remove("show");
  }

  renderSiteList();
  setBusy(busy);
}

async function loadState() {
  setBusy(true);

  try {
    currentHost = await getCurrentHost();
    render(await send("GET_STATE", { currentHost }));
  } catch (error) {
    render({ error: error?.message || "Не удалось получить состояние." });
  } finally {
    setBusy(false);
    render(currentState);
  }
}

async function toggleRules() {
  setBusy(true);

  try {
    render(await send("SET_ENABLED", { enabled: !currentState.enabled }));
  } catch (error) {
    render({ error: error?.message || "Не удалось переключить прокси." });
  } finally {
    setBusy(false);
    render(currentState);
  }
}

async function addSite(host) {
  const site = normalizeHost(host);

  if (!site) {
    render({ error: "Введите домен: example.com" });
    return;
  }

  setBusy(true);

  try {
    render(await send("ADD_SITE", { host: site }));
    elements.manualHost.value = "";
  } catch (error) {
    render({ error: error?.message || "Не удалось добавить сайт." });
  } finally {
    setBusy(false);
    render(currentState);
  }
}

async function removeSite(host) {
  setBusy(true);

  try {
    render(await send("REMOVE_SITE", { host }));
  } catch (error) {
    render({ error: error?.message || "Не удалось убрать сайт." });
  } finally {
    setBusy(false);
    render(currentState);
  }
}

async function clearSites() {
  setBusy(true);

  try {
    render(await send("CLEAR_SITES"));
  } catch (error) {
    render({ error: error?.message || "Не удалось очистить список." });
  } finally {
    setBusy(false);
    render(currentState);
  }
}

function handleSiteAction() {
  if (!currentHost) {
    return;
  }

  if (currentState.currentSiteListed) {
    return removeSite(currentState.currentSiteRule);
  }

  return addSite(currentHost);
}

elements.toggle.addEventListener("click", toggleRules);
elements.siteAction.addEventListener("click", handleSiteAction);
elements.manualForm.addEventListener("submit", event => {
  event.preventDefault();
  addSite(elements.manualHost.value);
});
elements.clearSites.addEventListener("click", clearSites);
document.addEventListener("DOMContentLoaded", loadState);

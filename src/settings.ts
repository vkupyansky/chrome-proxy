import { getHostname, normalizeHost, normalizeSites } from "./routing.js";
import type { Message, Settings, SettingsPatch } from "./types.js";

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    mode: "system",
    proxy: { scheme: "http", host: "127.0.0.1", port: 10809 },
    fallbackDirect: true,
    bypassLocal: true,
    bypassRussian: true,
    siteRules: [],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Неизвестный параметр настроек");
  }
}

function validatePatch(value: unknown): SettingsPatch {
  if (!record(value)) throw new Error("Неверные настройки");
  assertKeys(value, ["mode", "proxy", "fallbackDirect", "bypassLocal", "bypassRussian"]);
  const patch: SettingsPatch = {};
  if (Object.hasOwn(value, "mode")) {
    if (value.mode !== "auto" && value.mode !== "direct" && value.mode !== "system") {
      throw new Error("Выберите режим подключения");
    }
    patch.mode = value.mode;
  }
  for (const key of ["fallbackDirect", "bypassLocal", "bypassRussian"] as const) {
    if (Object.hasOwn(value, key)) {
      if (typeof value[key] !== "boolean") throw new Error("Неверное значение переключателя");
      patch[key] = value[key];
    }
  }
  if (Object.hasOwn(value, "proxy")) {
    if (!record(value.proxy)) throw new Error("Неверный адрес прокси");
    const proxy = value.proxy;
    assertKeys(proxy, ["scheme", "host", "port"]);
    if (proxy.scheme !== "http" && proxy.scheme !== "socks5")
      throw new Error("Выберите HTTP или SOCKS5");
    if (typeof proxy.host !== "string" || proxy.host.length > 253 || !proxy.host.trim()) {
      throw new Error("Введите адрес прокси без протокола и порта");
    }
    const raw = proxy.host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    const host = getHostname(raw);
    if (!host || host !== raw || /[\s/@?#;]/.test(raw)) {
      throw new Error("Введите адрес прокси без протокола и порта");
    }
    if (
      !Number.isInteger(proxy.port) ||
      typeof proxy.port !== "number" ||
      proxy.port < 1 ||
      proxy.port > 65535
    ) {
      throw new Error("Порт должен быть от 1 до 65535");
    }
    patch.proxy = { scheme: proxy.scheme, host, port: proxy.port };
  }
  return patch;
}

export function parseSettings(value: unknown): Settings {
  if (!record(value)) throw new Error("Сохранённые настройки повреждены");
  assertKeys(value, [
    "schemaVersion",
    "mode",
    "proxy",
    "fallbackDirect",
    "bypassLocal",
    "bypassRussian",
    "siteRules",
  ]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.siteRules)) {
    throw new Error("Не удалось прочитать сохранённые настройки");
  }
  const { schemaVersion: _version, siteRules, ...rawPatch } = value;
  if (Object.keys(rawPatch).length !== 5) throw new Error("Сохранённые настройки неполные");
  if (siteRules.some((site: unknown) => typeof site !== "string" || !normalizeHost(site))) {
    throw new Error("В сохранённых исключениях есть неверный домен");
  }
  return { ...defaultSettings(), ...validatePatch(rawPatch), siteRules: normalizeSites(siteRules) };
}

export function parseMessage(value: unknown): Message {
  if (!record(value) || typeof value.type !== "string")
    throw new Error("Неверная команда расширения");
  switch (value.type) {
    case "GET_STATE":
    case "CLEAR_SITES":
    case "REAPPLY":
      assertKeys(value, ["type"]);
      return { type: value.type };
    case "UPDATE_SETTINGS":
      assertKeys(value, ["type", "patch"]);
      return { type: value.type, patch: validatePatch(value.patch) };
    case "ADD_SITE":
    case "REMOVE_SITE": {
      assertKeys(value, ["type", "host"]);
      if (typeof value.host !== "string" || value.host.length > 2048)
        throw new Error("Введите домен, например example.com");
      const host = normalizeHost(value.host);
      if (!host) throw new Error("Введите домен, например example.com");
      return { type: value.type, host };
    }
    default:
      throw new Error("Неизвестная команда расширения");
  }
}

export async function loadSettings(storage: chrome.storage.LocalStorageArea): Promise<Settings> {
  const data = await storage.get(["settings", "enabled", "siteRules"]);
  if (Object.hasOwn(data, "settings")) {
    const settings = parseSettings(data.settings);
    if (Object.hasOwn(data, "enabled") || Object.hasOwn(data, "siteRules")) {
      await storage.remove(["enabled", "siteRules", "lastError"]);
    }
    return settings;
  }
  if (data.enabled !== undefined && typeof data.enabled !== "boolean")
    throw new Error("Не удалось перенести прежний режим");
  if (
    data.siteRules !== undefined &&
    (!Array.isArray(data.siteRules) || data.siteRules.some((site: unknown) => !normalizeHost(site)))
  ) {
    throw new Error("Не удалось перенести прежние исключения; исходный список сохранён");
  }
  const settings: Settings = {
    ...defaultSettings(),
    mode: data.enabled === true ? "auto" : "system",
    siteRules: normalizeSites(data.siteRules),
  };
  await storage.set({ settings });
  await storage.remove(["enabled", "siteRules", "lastError"]);
  return settings;
}

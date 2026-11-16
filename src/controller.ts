import { getPacScript } from "./routing.js";
import { loadSettings, parseMessage } from "./settings.js";
import type { PublicState, Response, Settings } from "./types.js";

type ProxySnapshot = { levelOfControl: string; value: chrome.proxy.ProxyConfig | undefined };
type Api = Pick<typeof chrome, "storage" | "proxy" | "action">;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось применить настройки Chrome";
}

export function createController(api: Api) {
  let queue: Promise<unknown> = Promise.resolve();
  let lastError = "";
  let notice = "";
  let knownSettings: Settings | undefined;

  async function snapshot(): Promise<ProxySnapshot> {
    const result = await api.proxy.settings.get({ incognito: false });
    if (typeof result.levelOfControl !== "string")
      throw new Error("Chrome не сообщил, кто управляет прокси");
    let value: chrome.proxy.ProxyConfig | undefined;
    if (result.levelOfControl === "controlled_by_this_extension") {
      const raw: unknown = result.value;
      if (typeof raw !== "object" || raw === null || !("mode" in raw)) {
        throw new Error("Chrome не сообщил применённый режим прокси");
      }
      if (raw.mode === "direct") {
        value = { mode: "direct" };
      } else if (
        raw.mode === "pac_script" &&
        "pacScript" in raw &&
        typeof raw.pacScript === "object" &&
        raw.pacScript !== null &&
        "data" in raw.pacScript &&
        typeof raw.pacScript.data === "string"
      ) {
        value = { mode: "pac_script", pacScript: { data: raw.pacScript.data } };
        if ("mandatory" in raw.pacScript && typeof raw.pacScript.mandatory === "boolean") {
          value.pacScript = { ...value.pacScript, mandatory: raw.pacScript.mandatory };
        }
      } else {
        throw new Error("Chrome вернул неподдерживаемый режим этого расширения");
      }
    }
    return { levelOfControl: result.levelOfControl, value };
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  async function readSettings(): Promise<Settings> {
    const settings = await loadSettings(api.storage.local);
    knownSettings = settings;
    return settings;
  }

  async function state(settings: Settings): Promise<PublicState> {
    const current = await snapshot();
    const mismatch =
      current.levelOfControl === "controlled_by_this_extension" && !matches(settings, current);
    return {
      settings,
      control: current.levelOfControl,
      error:
        lastError ||
        (mismatch ? "Применённый режим отличается от сохранённого. Проверьте настройки." : ""),
      notice,
    };
  }

  function matches(settings: Settings, current: ProxySnapshot): boolean {
    if (settings.mode === "system")
      return current.levelOfControl !== "controlled_by_this_extension";
    if (settings.mode === "direct") return current.value?.mode === "direct";
    return (
      current.value?.mode === "pac_script" &&
      current.value.pacScript?.data === getPacScript(settings) &&
      current.value.pacScript.mandatory === true
    );
  }

  async function badge(settings: Settings): Promise<void> {
    const text = lastError
      ? "!"
      : settings.mode === "auto"
        ? "AUTO"
        : settings.mode === "direct"
          ? "DIR"
          : "";
    const color = lastError ? "#b42318" : settings.mode === "auto" ? "#147d64" : "#475467";
    try {
      await api.action.setBadgeText({ text });
      await api.action.setBadgeBackgroundColor({ color });
      await api.action.setBadgeTextColor({ color: "#ffffff" });
    } catch {
      notice = "Chrome не обновил значок расширения";
    }
  }

  async function restore(snapshot: ProxySnapshot): Promise<void> {
    if (snapshot.levelOfControl === "controlled_by_this_extension") {
      if (!snapshot.value) throw new Error("Не удалось прочитать прежние настройки Chrome");
      await api.proxy.settings.set({ scope: "regular", value: snapshot.value });
    } else {
      await api.proxy.settings.clear({ scope: "regular" });
    }
  }

  async function apply(settings: Settings, persist: boolean): Promise<void> {
    const before = await snapshot();
    if (
      settings.mode !== "system" &&
      before.levelOfControl !== "controllable_by_this_extension" &&
      before.levelOfControl !== "controlled_by_this_extension"
    ) {
      throw new Error(
        "Прокси управляет другое расширение или политика Chrome. Освободите управление и повторите.",
      );
    }
    let changed = false;
    try {
      changed = true;
      if (settings.mode === "system") {
        await api.proxy.settings.clear({ scope: "regular" });
      } else {
        await api.proxy.settings.set({
          scope: "regular",
          value:
            settings.mode === "direct"
              ? { mode: "direct" }
              : {
                  mode: "pac_script",
                  pacScript: { data: getPacScript(settings), mandatory: true },
                },
        });
      }
      const after = await snapshot();
      if (
        settings.mode === "system"
          ? after.levelOfControl === "controlled_by_this_extension"
          : after.levelOfControl !== "controlled_by_this_extension"
      ) {
        throw new Error("Chrome не подтвердил применение режима. Проверьте настройки.");
      }
      if (!matches(settings, after)) {
        throw new Error(
          "Применённые настройки Chrome отличаются от выбранных. Проверьте настройки.",
        );
      }
      if (persist) await api.storage.local.set({ settings });
      knownSettings = settings;
      lastError = "";
      notice = "";
    } catch (error) {
      if (changed) {
        try {
          await restore(before);
        } catch {
          throw new Error(
            `${errorText(error)}. Chrome также не подтвердил возврат прежнего режима; нажмите «Проверить настройки».`,
          );
        }
      }
      throw error;
    }
    await badge(settings);
  }

  async function failure(error: unknown): Promise<Response> {
    lastError = errorText(error);
    if (!knownSettings) return { ok: false, error: lastError };
    try {
      const current = await state(knownSettings);
      await badge(current.settings);
      return { ok: false, error: lastError, state: current };
    } catch {
      return { ok: false, error: lastError };
    }
  }

  async function handleUnqueued(raw: unknown): Promise<Response> {
    try {
      const message = parseMessage(raw);
      const settings = await readSettings();
      if (message.type === "GET_STATE") return { ok: true, state: await state(settings) };
      const next = structuredClone(settings);
      switch (message.type) {
        case "UPDATE_SETTINGS":
          Object.assign(next, message.patch);
          break;
        case "ADD_SITE":
          next.siteRules = [...new Set([...next.siteRules, message.host])].sort();
          break;
        case "REMOVE_SITE":
          next.siteRules = next.siteRules.filter((site) => site !== message.host);
          break;
        case "CLEAR_SITES":
          next.siteRules = [];
          break;
        case "REAPPLY":
          break;
      }
      await apply(next, message.type !== "REAPPLY");
      return { ok: true, state: await state(next) };
    } catch (error) {
      return failure(error);
    }
  }

  return {
    handle(raw: unknown): Promise<Response> {
      return enqueue(() => handleUnqueued(raw));
    },
    initialize(): Promise<Response> {
      return enqueue(async () => {
        try {
          const settings = await readSettings();
          await apply(settings, false);
          return { ok: true, state: await state(settings) };
        } catch (error) {
          return failure(error);
        }
      });
    },
    proxyError(details: { error: string; fatal: boolean }): Promise<void> {
      return enqueue(async () => {
        try {
          const settings = await readSettings();
          if (settings.mode !== "auto") return;
          if (details.fatal) {
            lastError = `Chrome сообщил об ошибке прокси: ${details.error}`;
          } else {
            notice = settings.fallbackDirect
              ? `Прокси сообщил об ошибке (${details.error}). Переход напрямую разрешён; фактический маршрут определяет Chrome.`
              : `Прокси сообщил об ошибке: ${details.error}. Переход напрямую выключен.`;
          }
          await badge(settings);
        } catch (error) {
          await failure(error);
        }
      });
    },
  };
}

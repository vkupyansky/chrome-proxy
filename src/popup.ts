import {
  controlDescription,
  element,
  errorMessage,
  feedback,
  modeValue,
  proxyName,
  request,
  StateError,
  syncModes,
} from "./client.js";
import { classifyHost, getHostname } from "./routing.js";
import type { Message, PublicState } from "./types.js";

const picker = element("mode-picker", HTMLFieldSetElement);
const action = element("site-action", HTMLButtonElement);
const exceptions = element("exceptions", HTMLButtonElement);
let state: PublicState | undefined;
let hostname = "";
let busy = false;

function lock(): void {
  element("app", HTMLElement).setAttribute("aria-busy", String(busy));
  picker.disabled = busy || !state;
  element("retry", HTMLButtonElement).disabled = busy;
  exceptions.disabled = !state;
  action.disabled = true;
  if (state) {
    const route = classifyHost(
      hostname,
      state.settings.siteRules,
      state.settings.bypassLocal,
      state.settings.bypassRussian,
    );
    action.disabled =
      busy ||
      !hostname ||
      state.settings.mode !== "auto" ||
      (route.direct && route.kind !== "site");
  }
}

function render(): void {
  lock();
  if (!state) return;
  syncModes(state.settings.mode);
  const { settings } = state;
  const serverName = proxyName(settings);
  element("mode-description", HTMLParagraphElement).textContent =
    settings.mode === "auto"
      ? settings.fallbackDirect
        ? `Через ${serverName} по правилам. Без ${serverName} — обычное соединение.`
        : `Через ${serverName} по правилам. Без него сайты могут не открываться.`
      : settings.mode === "direct"
        ? "Обычный интернет для всех сайтов в этом профиле."
        : "Прокси берётся из настроек macOS. Happ может оставаться включённым.";
  element("hostname", HTMLParagraphElement).textContent = hostname || "Откройте обычный сайт";
  const route = classifyHost(
    hostname,
    settings.siteRules,
    settings.bypassLocal,
    settings.bypassRussian,
  );
  const routeLabel = element("route", HTMLSpanElement);
  const reason = element("reason", HTMLSpanElement);
  const effective = settings.mode === "auto";
  routeLabel.textContent = !hostname
    ? "Нет адреса сайта"
    : settings.mode === "system"
      ? "Как в macOS"
      : settings.mode === "direct" || route.direct
        ? "Напрямую"
        : `Через ${serverName}`;
  reason.textContent =
    !hostname || !effective
      ? ""
      : route.kind === "local"
        ? "Локальная сеть"
        : route.kind === "russian"
          ? "Российский домен"
          : route.kind === "site"
            ? "Ваше исключение"
            : "По правилам расширения";
  if (
    state.error ||
    (settings.mode !== "system" && state.control !== "controlled_by_this_extension")
  ) {
    routeLabel.textContent = "Правило не применено";
    reason.textContent = "Нажмите «Повторить»";
  }
  action.textContent = effective
    ? route.kind === "site"
      ? "Убрать из исключений"
      : route.direct
        ? "Уже напрямую по автоправилу"
        : "Открывать напрямую"
    : "Исключения работают в режиме «Авто»";
  exceptions.textContent = `Сайты напрямую · ${settings.siteRules.length}`;
  element("control", HTMLSpanElement).textContent = controlDescription(state);
  feedback("error", state.error);
  element("retry", HTMLButtonElement).hidden =
    !state.error &&
    (state.settings.mode === "system" || state.control === "controlled_by_this_extension");
  feedback("notice", state.notice);
}

async function perform(message: Message): Promise<void> {
  if (busy) return;
  busy = true;
  lock();
  try {
    state = await request(message);
    render();
  } catch (error) {
    if (error instanceof StateError && error.state) state = error.state;
    if (state) render();
    else {
      element("mode-description", HTMLParagraphElement).textContent =
        "Не удалось получить настройки.";
      element("hostname", HTMLParagraphElement).textContent = hostname || "Откройте обычный сайт";
      element("route", HTMLSpanElement).textContent = "Не удалось проверить";
    }
    feedback("error", errorMessage(error));
    element("retry", HTMLButtonElement).hidden = false;
  } finally {
    busy = false;
    lock();
  }
}

picker.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement)
    void perform({ type: "UPDATE_SETTINGS", patch: { mode: modeValue(event.target.value) } });
});
action.addEventListener("click", () => {
  if (!state) return;
  const route = classifyHost(
    hostname,
    state.settings.siteRules,
    state.settings.bypassLocal,
    state.settings.bypassRussian,
  );
  void perform({
    type: route.kind === "site" ? "REMOVE_SITE" : "ADD_SITE",
    host: route.kind === "site" ? route.rule : hostname,
  });
});
element("settings", HTMLButtonElement).addEventListener("click", () => {
  void chrome.runtime
    .openOptionsPage()
    .catch((error: unknown) => feedback("error", errorMessage(error)));
});
exceptions.addEventListener("click", () => {
  void chrome.runtime
    .openOptionsPage()
    .catch((error: unknown) => feedback("error", errorMessage(error)));
});
element("retry", HTMLButtonElement).addEventListener("click", () => {
  void perform({ type: "REAPPLY" });
});

async function initialize(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    hostname = getHostname(tabs[0]?.url);
  } catch {
    hostname = "";
  }
  await perform({ type: "GET_STATE" });
}
void initialize();

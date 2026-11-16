import { controlDescription, element, errorMessage, feedback, modeValue, request, StateError, syncModes, } from "./client.js";
let state;
let busy = false;
let proxyDirty = false;
const modePicker = element("mode-picker", HTMLFieldSetElement);
const rules = element("rules", HTMLFieldSetElement);
const proxyFields = element("proxy-fields", HTMLFieldSetElement);
const host = element("proxy-host", HTMLInputElement);
const port = element("proxy-port", HTMLInputElement);
const scheme = element("scheme", HTMLSelectElement);
const newSite = element("new-site", HTMLInputElement);
const search = element("search", HTMLInputElement);
const list = element("site-list", HTMLUListElement);
function lock() {
    const disabled = busy || !state;
    element("app", HTMLElement).setAttribute("aria-busy", String(busy));
    modePicker.disabled = disabled;
    rules.disabled = disabled;
    proxyFields.disabled = disabled;
    newSite.disabled = disabled;
    search.disabled = disabled;
    element("add-site", HTMLButtonElement).disabled = disabled;
    element("retry", HTMLButtonElement).disabled = busy;
    element("clear", HTMLButtonElement).disabled = disabled || !state?.settings.siteRules.length;
    element("confirm-clear", HTMLButtonElement).disabled = disabled;
    for (const button of list.querySelectorAll("button"))
        button.disabled = disabled;
}
function renderList() {
    if (!state)
        return;
    const query = search.value.trim().toLowerCase();
    const sites = state.settings.siteRules.filter((site) => site.includes(query));
    const fragment = document.createDocumentFragment();
    for (const site of sites) {
        const item = document.createElement("li");
        const text = document.createElement("span");
        text.className = "domain-label";
        text.textContent = site;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "×";
        button.title = `Удалить ${site}`;
        button.setAttribute("aria-label", `Удалить исключение ${site}`);
        button.disabled = busy;
        button.addEventListener("click", () => {
            void perform({ type: "REMOVE_SITE", host: site });
        });
        item.append(text, button);
        fragment.append(item);
    }
    list.replaceChildren(fragment);
    const empty = element("empty", HTMLParagraphElement);
    empty.hidden = sites.length > 0;
    empty.textContent = query
        ? "По этому запросу ничего нет."
        : "Исключений пока нет. Автоматические правила работают отдельно.";
    element("count", HTMLSpanElement).textContent = query
        ? `${sites.length} из ${state.settings.siteRules.length}`
        : String(state.settings.siteRules.length);
}
function render() {
    if (!state)
        return;
    const { settings } = state;
    syncModes(settings.mode);
    element("bypass-local", HTMLInputElement).checked = settings.bypassLocal;
    element("bypass-russian", HTMLInputElement).checked = settings.bypassRussian;
    element("fallback", HTMLInputElement).checked = settings.fallbackDirect;
    if (!proxyDirty) {
        host.value = settings.proxy.host;
        port.value = String(settings.proxy.port);
        scheme.value = settings.proxy.scheme;
    }
    element("auto-hint", HTMLParagraphElement).textContent =
        settings.mode === "auto"
            ? "Изменения сохраняются сразу."
            : "Сохранены и начнут действовать при выборе режима «Авто».";
    element("control", HTMLSpanElement).textContent = controlDescription(state);
    feedback("error", state.error);
    feedback("notice", state.notice);
    element("clear-description", HTMLParagraphElement).textContent =
        `Удалить все ${settings.siteRules.length} исключения? Автоматические правила останутся.`;
    renderList();
    lock();
}
async function perform(message) {
    if (busy)
        return false;
    busy = true;
    lock();
    element("saved", HTMLParagraphElement).textContent =
        message.type === "GET_STATE" || message.type === "REAPPLY" ? "Проверяю…" : "Сохраняю…";
    try {
        state = await request(message);
        render();
        element("saved", HTMLParagraphElement).textContent = state.error
            ? "Проверьте сообщение об ошибке."
            : message.type === "GET_STATE" || message.type === "REAPPLY"
                ? "Настройки актуальны."
                : "Сохранено.";
        return true;
    }
    catch (error) {
        if (error instanceof StateError && error.state)
            state = error.state;
        if (state)
            render();
        feedback("error", errorMessage(error));
        element("saved", HTMLParagraphElement).textContent =
            "Изменение не подтверждено. Повторите действие.";
        return false;
    }
    finally {
        busy = false;
        lock();
    }
}
modePicker.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement)
        void perform({ type: "UPDATE_SETTINGS", patch: { mode: modeValue(event.target.value) } });
});
for (const [id, key] of [
    ["bypass-local", "bypassLocal"],
    ["bypass-russian", "bypassRussian"],
    ["fallback", "fallbackDirect"],
]) {
    element(id, HTMLInputElement).addEventListener("change", (event) => {
        if (event.target instanceof HTMLInputElement)
            void perform({ type: "UPDATE_SETTINGS", patch: { [key]: event.target.checked } });
    });
}
element("proxy-form", HTMLFormElement).addEventListener("input", () => {
    proxyDirty = true;
});
element("proxy-form", HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = scheme.value;
    if (selected !== "http" && selected !== "socks5") {
        feedback("error", "Выберите HTTP или SOCKS5.");
        return;
    }
    const proxyScheme = selected;
    void perform({
        type: "UPDATE_SETTINGS",
        patch: { proxy: { scheme: proxyScheme, host: host.value.trim(), port: Number(port.value) } },
    }).then((saved) => {
        if (saved) {
            proxyDirty = false;
            render();
        }
    });
});
element("site-form", HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault();
    void perform({ type: "ADD_SITE", host: newSite.value }).then((saved) => {
        if (saved)
            newSite.value = "";
    });
});
search.addEventListener("input", renderList);
element("clear", HTMLButtonElement).addEventListener("click", () => {
    element("clear-confirm", HTMLDivElement).hidden = false;
    element("cancel-clear", HTMLButtonElement).focus();
});
element("cancel-clear", HTMLButtonElement).addEventListener("click", () => {
    element("clear-confirm", HTMLDivElement).hidden = true;
    element("clear", HTMLButtonElement).focus();
});
element("confirm-clear", HTMLButtonElement).addEventListener("click", () => {
    void perform({ type: "CLEAR_SITES" }).then((saved) => {
        if (saved)
            element("clear-confirm", HTMLDivElement).hidden = true;
    });
});
element("retry", HTMLButtonElement).addEventListener("click", () => {
    void perform({ type: "REAPPLY" });
});
if (globalThis.chrome?.storage)
    chrome.storage.onChanged.addListener((_changes, area) => {
        if (area === "local" && !busy)
            void perform({ type: "GET_STATE" });
    });
void perform({ type: "GET_STATE" });

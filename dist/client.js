export function element(id, type) {
    const result = document.getElementById(id);
    if (!(result instanceof type))
        throw new Error(`Не найден элемент интерфейса: ${id}`);
    return result;
}
export function errorMessage(error) {
    return error instanceof Error
        ? error.message
        : "Не удалось применить настройки. Повторите действие.";
}
export class StateError extends Error {
    state;
    constructor(message, state) {
        super(message);
        this.name = "StateError";
        this.state = state;
    }
}
export async function request(message) {
    if (!globalThis.chrome?.runtime?.id)
        throw new Error("Откройте интерфейс через значок Chrome Proxy.");
    const response = await chrome.runtime.sendMessage(message);
    if (!response)
        throw new Error("Расширение не ответило. Откройте его заново.");
    if (!response.ok)
        throw new StateError(response.error, response.state);
    return response.state;
}
export function modeValue(value) {
    if (value === "auto" || value === "direct" || value === "system")
        return value;
    throw new Error("Неизвестный режим подключения");
}
export function controlDescription(state) {
    if (state.control === "not_controllable")
        return "Прокси задан политикой Chrome";
    if (state.control === "controlled_by_other_extensions")
        return "Прокси управляет другое расширение";
    if (state.error)
        return "Применение не подтверждено";
    if (state.settings.mode === "system")
        return "Управляет macOS";
    if (state.control === "controlled_by_this_extension")
        return "Правила применены";
    if (state.control === "controllable_by_this_extension")
        return "Правила ещё не применены";
    return "Управление не подтверждено";
}
export function proxyName(settings) {
    const proxy = settings.proxy;
    return proxy.host === "127.0.0.1" &&
        ((proxy.scheme === "http" && proxy.port === 10809) ||
            (proxy.scheme === "socks5" && proxy.port === 10808))
        ? "Happ"
        : "прокси";
}
export function feedback(id, message) {
    const target = element(id, HTMLParagraphElement);
    target.textContent = message;
    target.hidden = !message;
}
export function syncModes(mode) {
    for (const radio of document.querySelectorAll('input[name="mode"]'))
        radio.checked = radio.value === mode;
}

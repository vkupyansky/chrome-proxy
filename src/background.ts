import { createController } from "./controller.js";

const controller = createController(chrome);

chrome.runtime.onInstalled.addListener(() => {
  void controller.initialize();
});
chrome.runtime.onStartup.addListener(() => {
  void controller.initialize();
});
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Команда доступна только этому расширению" });
    return false;
  }
  void controller.handle(message).then(sendResponse);
  return true;
});
chrome.proxy.onProxyError.addListener((details) => {
  void controller.proxyError(details);
});

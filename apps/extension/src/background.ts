if (typeof chrome !== "undefined" && chrome?.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome?.storage?.local?.set({ backendUrl: "http://127.0.0.1:4317" });
  });
}

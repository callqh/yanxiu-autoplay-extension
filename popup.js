"use strict";

const DEFAULTS = {
  enabled: true,
  autoPlay: true,
  autoRate: true,
  rating: 5,
  autoNext: true,
};

const ids = Object.keys(DEFAULTS);
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const statusElement = document.getElementById("status");
const versionElement = document.getElementById("version");
const extensionVersion = chrome.runtime.getManifest().version;
versionElement.textContent = `扩展 v${extensionVersion}`;

function renderEnabledState(enabled) {
  document.body.classList.toggle("is-disabled", !enabled);
  for (const id of ids) {
    if (id !== "enabled") elements[id].disabled = !enabled;
  }
}

function saveSetting(id) {
  const element = elements[id];
  const value = element.type === "checkbox" ? element.checked : Number(element.value);
  chrome.storage.sync.set({ [id]: value });

  if (id === "enabled") {
    renderEnabledState(value);
    statusElement.textContent = value ? "自动连播已开启" : "自动连播已暂停";
  }
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  for (const id of ids) {
    const element = elements[id];
    if (element.type === "checkbox") element.checked = Boolean(stored[id]);
    else element.value = String(stored[id]);
    element.addEventListener("change", () => saveSetting(id));
  }
  renderEnabledState(Boolean(stored.enabled));
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id || !/^https?:\/\/ipx\.yanxiu\.com\//.test(tab.url || "")) {
    statusElement.textContent = "请在研修网课程页面使用";
    return;
  }

  function readStatus() {
    chrome.tabs.sendMessage(tab.id, { type: "YANXIU_GET_STATUS" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        statusElement.textContent = "刷新课程页面后即可启用";
        return;
      }
      statusElement.textContent = response.status?.action || "已连接课程页面";
      versionElement.textContent = response.version === extensionVersion
        ? `扩展与页面 v${extensionVersion}`
        : `扩展 v${extensionVersion} · 页面 ${response.version || "旧版本"}，请刷新课程页`;
    });
  }
  readStatus();
  window.setInterval(readStatus, 1000);
});

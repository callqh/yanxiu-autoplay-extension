const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const previewUrl = "https://preview.yanxiu.com/?url=fixture";
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json")));
assert(manifest.content_scripts.some((entry) => entry.all_frames && entry.js.includes("document.js")));

function checkPreview() {
  let tick;
  let receive;
  let loadedPages = 2;
  let scrolls = 0;
  const messages = [];
  const root = {
    scrollTop: 0,
    clientHeight: 400,
    get scrollHeight() { return loadedPages * 400; },
    scrollTo() {
      scrolls += 1;
      this.scrollTop = this.scrollHeight - this.clientHeight;
      if (loadedPages < 6) loadedPages += 1;
    },
  };
  const parent = { postMessage: (data) => messages.push(data) };
  const context = {
    window: {
      parent,
      location: { href: previewUrl },
      addEventListener: (_type, callback) => { receive = callback; },
      setInterval: (callback) => { tick = callback; },
      getComputedStyle: () => ({ overflowY: "visible" }),
    },
    document: {
      scrollingElement: root,
      querySelector: () => ({ textContent: `${loadedPages}/6` }),
      querySelectorAll: (selector) => selector === ".page-box[data-index]"
        ? Array.from({ length: loadedPages }, (_, i) => ({
          getAttribute: () => String(i + 1),
          querySelectorAll: () => [{ complete: true, naturalWidth: 100 }],
        })) : [],
    },
    URL,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "document.js"), "utf8"), context);
  tick();
  assert.equal(scrolls, 0, "preview must wait for the course page to enable scrolling");
  receive({ source: parent, origin: "https://ipx.yanxiu.com", data: { type: "YANXIU_PREVIEW_CONTROL", paused: false } });
  for (let i = 0; i < 10; i += 1) tick();
  assert.equal(loadedPages, 6, "bottom scrolling must keep loading lazy pages");
  assert(messages.some((message) => message.complete === true));
  receive({ source: parent, origin: "https://ipx.yanxiu.com", data: { type: "YANXIU_PREVIEW_CONTROL", paused: true } });
  const count = messages.length;
  tick();
  assert.equal(messages.length, count, "paused preview must stop processing");
}

async function checkCoursePage() {
  let receive;
  let clicks = 0;
  class Element { getClientRects() { return [1]; } }
  const frame = new Element();
  frame.src = previewUrl;
  frame.contentWindow = { postMessage() {} };
  const next = new Element();
  next.textContent = "下一份课件";
  next.click = () => { clicks += 1; };
  const items = [true, false].map((active) => ({
    classList: { contains: () => active },
    querySelector: () => next,
  }));
  const context = {
    HTMLElement: Element,
    document: {
      documentElement: {},
      querySelectorAll: (selector) => {
        if (selector === ".player-wrapper .iframe-wrapper iframe") return [frame];
        if (selector === ".resource-list .res-item") return items;
        return [];
      },
    },
    window: {
      addEventListener: (_type, callback) => { receive = callback; },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
    },
    chrome: {
      storage: {
        sync: { get: (_defaults, callback) => callback({}) },
        onChanged: { addListener() {} },
      },
      runtime: { onMessage: { addListener() {} } },
    },
    MutationObserver: class { observe() {} },
    URL,
    URLSearchParams,
    AbortController,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context);
  const event = { source: frame.contentWindow, origin: "https://preview.yanxiu.com", data: {
    type: "YANXIU_PREVIEW_PROGRESS", url: previewUrl, complete: true,
  } };
  receive({ ...event, source: {} });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(clicks, 0, "messages from another frame must not advance the course");
  receive(event);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(clicks, 1, "the completed preview should click the next resource name");
}

checkPreview();
checkCoursePage().then(() => {
  process.stdout.write("懒加载课件滚动到底、暂停控制和下一目录项切换：通过\n");
}).catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

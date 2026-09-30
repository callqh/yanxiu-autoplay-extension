const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

class Element {
  getClientRects() {
    return [1];
  }
}

async function main() {
  let selectedRating = 0;
  let submitCount = 0;
  let visible = true;
  let scanInterval;
  let hoveredRating = 0;

  const stars = Array.from({ length: 5 }, (_, index) => {
    const star = new Element();
    const icon = new Element();
    icon.getBoundingClientRect = () => ({ left: index * 40, top: 0, width: 30, height: 30 });
    icon.dispatchEvent = (event) => {
      if (event.type === "mousemove") {
        hoveredRating = event.clientX > index * 40 + 15 ? index + 1 : index + 0.5;
      }
      return true;
    };
    star.querySelector = () => icon;
    star.click = () => {
      // Production half-star widget starts at 0 until mousemove sets currentValue.
      selectedRating = hoveredRating;
      submit.disabled = selectedRating === 0;
    };
    return star;
  });

  const submit = new Element();
  submit.textContent = "提交";
  submit.disabled = true;
  submit.classList = { contains: () => false };
  submit.getAttribute = () => null;
  submit.click = () => { submitCount += 1; };

  const wrapper = new Element();
  wrapper.querySelectorAll = (selector) => {
    if (selector === ".info-rate .rate-item") return stars;
    if (selector === "button") return [submit];
    return [];
  };

  const context = {
    HTMLElement: Element,
    document: {
      documentElement: {},
      querySelectorAll: (selector) => selector === ".scoring-wrapper" ? [wrapper] : [],
    },
    window: {
      addEventListener: () => {},
      location: { pathname: "/grain/course/123/detail" },
      getComputedStyle: (element) => ({ display: element === wrapper && !visible ? "none" : "block", visibility: "visible", opacity: "1" }),
      setTimeout,
      clearTimeout,
      setInterval: (callback) => { scanInterval = callback; return 1; },
    },
    chrome: {
      storage: {
        sync: { get: (_defaults, callback) => callback({}) },
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: () => {} } },
    },
    MutationObserver: class { observe() {} },
    URL,
    URLSearchParams,
    AbortController,
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  };

  vm.runInNewContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 750));

  assert.equal(selectedRating, 5, "the real .rate-item stars should be selected");
  assert.equal(submitCount, 1, "the enabled submit button should be clicked once");
  visible = false;
  scanInterval();
  await new Promise((resolve) => setTimeout(resolve, 120));
  visible = true;
  hoveredRating = 0;
  selectedRating = 0;
  submit.disabled = true;
  scanInterval();
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(selectedRating, 5, "a reused popup should select stars again");
  assert.equal(submitCount, 2, "a reused popup should submit again");
  process.stdout.write("半星控件先悬停再选星、复用弹窗重新提交：通过\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

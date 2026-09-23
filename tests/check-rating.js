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

  const stars = Array.from({ length: 5 }, (_, index) => {
    const star = new Element();
    star.click = () => {
      selectedRating = index + 1;
      submit.disabled = false;
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
      location: { pathname: "/grain/course/123/detail" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
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
  };

  vm.runInNewContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 750));

  assert.equal(selectedRating, 5, "the real .rate-item stars should be selected");
  assert.equal(submitCount, 1, "the enabled submit button should be clicked once");
  process.stdout.write("实际 rate-item 星级选择与提交：通过\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

(() => {
  "use strict";
  if (window.parent === window) return;

  let paused = true;
  let parentOrigin = "";
  let stableBottom = 0;
  let lastHeight = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "YANXIU_PREVIEW_CONTROL") return;
    try {
      if (new URL(event.origin).hostname !== "ipx.yanxiu.com") return;
    } catch (_error) {
      return;
    }
    parentOrigin = event.origin;
    paused = event.data.paused !== false;
  });

  function scan() {
    if (paused || !parentOrigin) return;
    const pager = document.querySelector(".dp-page-num .num")?.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    const total = Number(pager?.[2]) || 0;
    const boxes = [...document.querySelectorAll(".page-box[data-index]")];
    if (!total || !boxes.length) return;

    let root = document.scrollingElement;
    for (const candidate of document.querySelectorAll("#main, .content")) {
      if (/auto|scroll/.test(window.getComputedStyle(candidate).overflowY) && candidate.clientHeight > 0 && candidate.scrollHeight > candidate.clientHeight) {
        root = candidate;
        break;
      }
    }
    if (!root || root.clientHeight <= 0) return;

    const lastPage = boxes.find((box) => Number(box.getAttribute("data-index")) === total);
    const images = lastPage ? [...lastPage.querySelectorAll(".img-box img")] : [];
    const loaded = images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
    const bottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
    stableBottom = bottom && loaded && root.scrollHeight === lastHeight ? stableBottom + 1 : 0;
    lastHeight = root.scrollHeight;

    window.parent.postMessage({
      type: "YANXIU_PREVIEW_PROGRESS",
      url: window.location.href,
      page: Number(pager[1]),
      total,
      complete: stableBottom >= 2,
    }, parentOrigin);

    if (stableBottom < 2) {
      // Repeated bottom scrolls let the site's lazy loader append the next pages.
      root.scrollTo({ top: root.scrollHeight, behavior: "instant" });
    }
  }

  window.setInterval(scan, 600);
})();

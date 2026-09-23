(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled: true,
    autoPlay: true,
    autoRate: true,
    rating: 5,
    autoNext: true,
  });

  const SCORE_SELECTOR = ".scoring-wrapper";
  const ENDED_SELECTOR = ".ended-mask";
  const SCAN_INTERVAL_MS = 1000;
  const SCORE_SUBMIT_DELAY_MS = 500;
  const PLAY_RETRY_MS = 5000;
  const NEXT_RETRY_MS = 4000;
  const COURSE_PAGE_SIZE = 50;
  const MAX_COURSE_PAGES = 100;
  const COURSE_API_TIMEOUT_MS = 10000;
  const COURSE_DETAIL_PATH = /^\/grain\/course\/([^/]+)\/detail$/;

  let settings = { ...DEFAULTS };
  let scanTimer = null;
  let lastStatus = {
    action: "等待课程页面",
    at: Date.now(),
  };

  const scoreStates = new WeakMap();
  const endedStates = new WeakMap();
  const playStates = new WeakMap();
  const crossCourseAttempts = new WeakSet();

  function setStatus(action) {
    lastStatus = { action, at: Date.now() };
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      element.getClientRects().length > 0
    );
  }

  function visibleElement(selector, root = document) {
    return [...root.querySelectorAll(selector)].find(isVisible) || null;
  }

  function normalizedText(element) {
    return (element?.textContent || "").replace(/\s+/g, "").trim();
  }

  function safeClick(element) {
    if (!element || !isVisible(element)) return false;
    element.click();
    return true;
  }

  function cookieValue(name) {
    const item = document.cookie
      .split("; ")
      .find((cookie) => cookie.startsWith(`${name}=`));
    if (!item) return "";
    try {
      return decodeURIComponent(item.slice(name.length + 1));
    } catch (_error) {
      return item.slice(name.length + 1);
    }
  }

  function currentCourseParams() {
    const match = window.location.pathname.match(COURSE_DETAIL_PATH);
    if (!match) return null;

    const query = new URLSearchParams(window.location.search);
    const projectId = query.get("projectId");
    const toolId = query.get("toolId");
    const role = query.get("role") || "100";
    if (!projectId || !toolId || role !== "100") return null;

    return { courseId: match[1], projectId, toolId, role };
  }

  async function fetchApi(path, query) {
    const token = cookieValue("X-DT-accessToken");
    if (!token) throw new Error("登录信息不可用，请刷新课程页面");

    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      COURSE_API_TIMEOUT_MS,
    );

    try {
      const response = await fetch(
        `https://ipx-api.yanxiu.com${path}?${query}`,
        {
          method: "GET",
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Authorization: "Basic c2FucmVuLXdhbmQtcGM6UjNOaHR2MUkyVVpsR1RmcTBv",
            "X-DT-clientId": "ums-teacher-pc",
            "X-DT-accessToken": token,
            "X-DT-Passport": cookieValue("passport"),
            srxUserInfo: cookieValue("srxUserInfo"),
          },
        },
      );
      if (!response.ok) throw new Error(`课程请求失败：HTTP ${response.status}`);

      const result = await response.json();
      if (result?.status?.code !== 200) {
        throw new Error(result?.status?.desc || "课程数据不可用");
      }

      return result.data;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("课程列表请求超时");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function fetchProjectFilters(projectId) {
    const query = new URLSearchParams({ trainProjectId: projectId });
    const profile = await fetchApi(
      "/train-project-center/trainProject/user/detail",
      query,
    );
    if (!profile) throw new Error("无法读取当前项目的学段和学科");
    return {
      segmentId: profile.stageId || "",
      subjectId: profile.subjectId || "",
    };
  }

  async function fetchCoursePage(params, pageIndex) {
    const query = new URLSearchParams({
      projectId: params.projectId,
      pageIndex: String(pageIndex),
      pageSize: String(COURSE_PAGE_SIZE),
      roleKey: params.role,
      moduleSort: "1",
      learnStatus: "0",
    });
    if (params.toolId) query.set("toolId", params.toolId);
    if (params.segmentId) query.set("segmentId", params.segmentId);
    if (params.subjectId) query.set("subjectId", params.subjectId);

    const page = await fetchApi("/task-center/course/V1/queryCourseList", query);
    if (!page || !Array.isArray(page.rows)) {
      throw new Error("课程列表数据不可用");
    }
    return page;
  }

  function canWatchCourse(course) {
    return (
      (course.boolCanVisit === true || course.boolCanVisit === 1) &&
      Number(course.completeRate || 0) < 100
    );
  }

  async function findNextCourse(params) {
    let foundCurrent = false;
    let firstPageTotal = null;
    let loadedCount = 0;
    let lastPageSignature = "";

    for (let pageIndex = 1; pageIndex <= MAX_COURSE_PAGES; pageIndex += 1) {
      const page = await fetchCoursePage(params, pageIndex);
      const rows = page.rows;

      if (firstPageTotal === null) firstPageTotal = Number(page.total) || 0;
      const pageSignature = rows.map((course) => String(course.id)).join(",");
      if (pageSignature && pageSignature === lastPageSignature) break;
      lastPageSignature = pageSignature;
      loadedCount += rows.length;

      for (const course of rows) {
        if (!foundCurrent) {
          foundCurrent = String(course.id) === params.courseId;
          continue;
        }
        if (String(course.id) !== params.courseId && canWatchCourse(course)) {
          return { foundCurrent: true, course };
        }
      }

      if (
        !rows.length ||
        (firstPageTotal > 0 && loadedCount >= firstPageTotal) ||
        (firstPageTotal === 0 && rows.length < COURSE_PAGE_SIZE)
      ) {
        break;
      }
    }

    return { foundCurrent, course: null };
  }

  function nextCourseUrl(course, params, scoped) {
    const courseId = course.id;
    const toolId = course.toolId || course.taskToolId || (scoped && params.toolId);
    const courseSourceId = course.courseSourceId;
    if (!courseId || !toolId || !courseSourceId) return null;

    const url = new URL(
      `/grain/course/${encodeURIComponent(courseId)}/detail`,
      window.location.origin,
    );
    url.search = new URLSearchParams({
      projectId: params.projectId,
      toolId: String(toolId),
      courseSourceId: String(courseSourceId),
      role: params.role,
    }).toString();
    return url;
  }

  async function continueToNextCourse() {
    const params = currentCourseParams();
    if (!params) {
      setStatus("无法识别当前课程，请手动选择下一门");
      return;
    }

    try {
      setStatus("正在查找下一门课程");
      const filters = await fetchProjectFilters(params.projectId);
      const listParams = { ...params, ...filters };
      const scoped = await findNextCourse(listParams);
      let target = scoped.course;
      let targetUrl = target && nextCourseUrl(target, listParams, true);

      if (!targetUrl) {
        const allCourses = await findNextCourse({ ...listParams, toolId: null });
        target = allCourses.course;
        targetUrl = target && nextCourseUrl(target, listParams, false);
      }

      if (!targetUrl) {
        setStatus("未找到可自动打开的下一门课程，正在返回选课页");
        window.location.assign(
          `/train2/workspace/${encodeURIComponent(params.projectId)}/member`,
        );
        return;
      }

      if (!settings.enabled || !settings.autoNext) return;
      setStatus(`正在打开下一门课程：${target.courseName || target.name || target.id}`);
      window.location.assign(targetUrl.href);
    } catch (error) {
      setStatus(`切换课程失败：${error.message || "请手动选择下一门"}`);
    }
  }

  function findRatingChoices(wrapper) {
    const rateItems = [...wrapper.querySelectorAll(".info-rate .rate-item")].filter(
      isVisible,
    );
    if (rateItems.length >= 5) return rateItems;

    const exactStars = [...wrapper.querySelectorAll(".ivu-rate-star")].filter(
      isVisible,
    );
    if (exactStars.length >= 5) return exactStars;

    const radios = [...wrapper.querySelectorAll('[role="radio"]')].filter(
      isVisible,
    );
    if (radios.length >= 5) return radios;

    const listItems = [...wrapper.querySelectorAll(".info-rate li")].filter(
      isVisible,
    );
    return listItems.length >= 5 ? listItems : [];
  }

  function handleScoreDialog() {
    if (!settings.autoRate) return false;

    const wrapper = visibleElement(SCORE_SELECTOR);
    if (!wrapper) return false;

    let state = scoreStates.get(wrapper);
    if (!state) {
      state = { ratedAt: 0, ratingAttempts: 0, submitted: false };
      scoreStates.set(wrapper, state);
    }

    if (!state.ratedAt) {
      const choices = findRatingChoices(wrapper);
      const rating = Math.min(5, Math.max(1, Number(settings.rating) || 5));
      const target = choices[rating - 1];

      if (target && safeClick(target)) {
        state.ratedAt = Date.now();
        state.ratingAttempts += 1;
        setStatus(`已选择 ${rating} 星评分`);
        window.setTimeout(scheduleScan, SCORE_SUBMIT_DELAY_MS);
      }
      return true;
    }

    if (!state.submitted && Date.now() - state.ratedAt >= SCORE_SUBMIT_DELAY_MS) {
      const submitButton = [...wrapper.querySelectorAll("button")].find(
        (button) => normalizedText(button) === "提交" && isVisible(button),
      );
      const disabled =
        !submitButton ||
        submitButton.disabled ||
        submitButton.getAttribute("aria-disabled") === "true" ||
        submitButton.classList.contains("ivu-btn-disabled");

      if (!disabled && safeClick(submitButton)) {
        state.submitted = true;
        setStatus("已提交评分，继续播放");
      } else if (
        disabled &&
        Date.now() - state.ratedAt >= 1500 &&
        state.ratingAttempts < 3
      ) {
        state.ratedAt = 0;
        setStatus("评分控件尚未响应，正在重试");
      } else if (disabled && state.ratingAttempts >= 3) {
        setStatus("自动评分未生效，请手动选择星级并提交");
      }
    }

    return true;
  }

  function handleEndedScreen() {
    const masks = [...document.querySelectorAll(ENDED_SELECTOR)];
    let hasVisibleEndedScreen = false;

    for (const mask of masks) {
      let state = endedStates.get(mask);
      if (!state) {
        state = { attempts: 0, lastClickAt: 0 };
        endedStates.set(mask, state);
      }

      if (!isVisible(mask)) {
        state.attempts = 0;
        state.lastClickAt = 0;
        continue;
      }

      hasVisibleEndedScreen = true;
      if (!settings.autoNext) continue;

      const next = visibleElement(".btns .next, .next", mask);
      if (!next) {
        if (!crossCourseAttempts.has(mask)) {
          crossCourseAttempts.add(mask);
          void continueToNextCourse();
        }
        continue;
      }

      const now = Date.now();
      if (state.attempts >= 3 || now - state.lastClickAt < NEXT_RETRY_MS) {
        continue;
      }

      if (safeClick(next)) {
        state.attempts += 1;
        state.lastClickAt = now;
        setStatus(`正在切换：${normalizedText(next)}`);
      }
    }

    return hasVisibleEndedScreen;
  }

  function hasBlockingDialog() {
    const selectors = [
      SCORE_SELECTOR,
      ".questionnaire-wrapper",
      ".alarm-clock-wrapper",
      ".answer-card-wrapper",
      ".ivu-modal-wrap",
      ".slider-wrapper",
    ];
    return selectors.some((selector) => visibleElement(selector));
  }

  function handleMediaPlayback() {
    if (!settings.autoPlay || hasBlockingDialog()) return;

    const mediaElements = [
      ...document.querySelectorAll(".player-wrapper video, .player-wrapper audio"),
    ].filter(isVisible);

    for (const media of mediaElements) {
      if (!media.paused || media.ended || media.readyState < 2) continue;

      const state = playStates.get(media) || { lastAttemptAt: 0 };
      const now = Date.now();
      if (now - state.lastAttemptAt < PLAY_RETRY_MS) continue;

      state.lastAttemptAt = now;
      playStates.set(media, state);

      void playMedia(media);
    }
  }

  async function playMedia(media) {
    try {
      await media.play();
      setStatus("课程正在自动播放");
    } catch (error) {
      if (error?.name !== "NotAllowedError" || media.tagName !== "VIDEO" || media.muted) {
        setStatus("浏览器阻止了自动播放，请手动播放一次");
        return;
      }

      // Chrome allows muted video autoplay even when audible autoplay is blocked.
      media.muted = true;
      try {
        await media.play();
        setStatus("已静音自动播放；如需声音，请手动开启");
      } catch (_retryError) {
        media.muted = false;
        setStatus("浏览器阻止了自动播放，请手动播放一次");
      }
    }
  }

  function scan() {
    scanTimer = null;
    if (!settings.enabled) return;

    const scoringVisible = handleScoreDialog();
    const endedVisible = handleEndedScreen();

    if (!scoringVisible && !endedVisible) {
      handleMediaPlayback();
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(scan, 80);
  }

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = change.newValue ?? DEFAULTS[key];
    }
    setStatus(settings.enabled ? "自动连播已开启" : "自动连播已暂停");
    scheduleScan();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "YANXIU_GET_STATUS") {
      sendResponse({
        ok: true,
        pageSupported: true,
        settings,
        status: lastStatus,
      });
    }
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "disabled", "aria-disabled"],
  });

  window.setInterval(scheduleScan, SCAN_INTERVAL_MS);
})();

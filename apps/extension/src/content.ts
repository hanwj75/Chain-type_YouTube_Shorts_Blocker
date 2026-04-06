import type { CachedBlockState } from "./config.js";
import {
  buildShortsHideCss,
  decideShortsBlocking,
  shouldBlockShorts,
  shouldReapplyBlockingForNavigation,
} from "./index.js";
import type { ExtensionMessageResponse, ExtensionTabMessage } from "./messages.js";

const STYLE_ELEMENT_ID = "shorts-blocker-style";
const HIDE_SHORTS_ATTRIBUTE = "hide-shorts";

let currentState: CachedBlockState | null = null;
let lastKnownUrl = location.href;
let applyScheduled = false;

void initializeContentScript();

async function initializeContentScript(): Promise<void> {
  await refreshState();
  installUrlObservers();
  installMutationObserver();
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const typedMessage = message as ExtensionTabMessage;

    if (typedMessage.type === "BLOCK_STATE_UPDATED") {
      currentState = typedMessage.payload;
      applyBlocking();
    }
  });
}

async function refreshState(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "GET_BLOCK_STATE",
    })) as ExtensionMessageResponse;

    if (response.ok) {
      currentState = (response.data as CachedBlockState | null) ?? null;
      applyBlocking();
    }
  } catch {
    applyBlocking();
  }
}

function applyBlocking(): void {
  const decision = decideShortsBlocking({
    state: currentState?.state ?? null,
    pathname: location.pathname,
    search: location.search,
    href: location.href,
  });
  const blocked = shouldBlockShorts(currentState?.state ?? null);
  const shouldRedirectSharedShorts =
    blocked &&
    location.pathname === "/watch" &&
    isWatchPageShowingShortsContext();

  syncHideShortsAttribute(blocked);

  if (!blocked) {
    removeBlockStyle();
    return;
  }

  ensureBlockStyle();

  if ((decision.shouldRedirect || shouldRedirectSharedShorts) && decision.redirectTarget) {
    if (location.pathname !== decision.redirectTarget) {
      location.replace(decision.redirectTarget);
      return;
    }
  }

  if (decision.shouldHideUi) {
    hideShortsUi();
  }
}

function ensureBlockStyle(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = buildShortsHideCss();
  document.documentElement.appendChild(style);
}

function removeBlockStyle(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}

function hideShortsUi(): void {
  const sidebarLinks = document.querySelectorAll('a[href^="/shorts/"]');

  sidebarLinks.forEach((link) => {
    const container =
      link.closest("ytd-guide-entry-renderer") ??
      link.closest("ytd-mini-guide-entry-renderer") ??
      link.closest("ytd-rich-shelf-renderer") ??
      link.closest("ytd-reel-shelf-renderer");

    if (container instanceof HTMLElement) {
      container.style.display = "none";
    }
  });

  const possibleSidebarItems = document.querySelectorAll(
    "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer",
  );

  possibleSidebarItems.forEach((item) => {
    if (!(item instanceof HTMLElement)) {
      return;
    }

    const text = item.textContent?.trim().toLowerCase() ?? "";

    if (text.includes("shorts")) {
      item.style.display = "none";
    }
  });
}

function installUrlObservers(): void {
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    originalPushState(...args);
    onUrlChanged();
  };

  history.replaceState = (...args) => {
    originalReplaceState(...args);
    onUrlChanged();
  };

  window.addEventListener("popstate", onUrlChanged);
}

function installMutationObserver(): void {
  const observer = new MutationObserver(() => {
    scheduleApply();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function onUrlChanged(): void {
  if (
    shouldReapplyBlockingForNavigation({
      previousUrl: lastKnownUrl,
      nextUrl: location.href,
    })
  ) {
    lastKnownUrl = location.href;
    scheduleApply();
  }
}

function scheduleApply(): void {
  if (applyScheduled) {
    return;
  }

  applyScheduled = true;
  queueMicrotask(() => {
    applyScheduled = false;
    applyBlocking();
  });
}
function syncHideShortsAttribute(blocked: boolean): void {
  document.documentElement.setAttribute(
    HIDE_SHORTS_ATTRIBUTE,
    blocked ? "true" : "false",
  );
}

function isWatchPageShowingShortsContext(): boolean {
  const videoId = new URLSearchParams(location.search).get("v");
  const pageHtml = document.documentElement.innerHTML;

  if (videoId) {
    if (
      pageHtml.includes(`"reelWatchEndpoint":{"videoId":"${videoId}"`) ||
      pageHtml.includes(`"/shorts/${videoId}"`) ||
      pageHtml.includes(`"url":"/shorts/${videoId}"`)
    ) {
      return true;
    }
  }

  return Boolean(
    document.querySelector('link[rel="canonical"][href*="/shorts/"]') ||
      document.querySelector('meta[property="og:url"][content*="/shorts/"]') ||
      document.querySelector('meta[property="al:web:url"][content*="/shorts/"]') ||
      document.querySelector("ytd-reel-player-overlay-renderer") ||
      document.querySelector("ytd-shorts") ||
      document.querySelector("ytd-reel-video-renderer"),
  );
}

(() => {
const STYLE_ELEMENT_ID = "shorts-blocker-style";
const HIDE_SHORTS_ATTRIBUTE = "hide-shorts";
const SHORTS_REDIRECT_PATH = "/feed/subscriptions";
const SHORTS_HIDE_SELECTORS = [
  'a[href^="/shorts/"]',
  'a[title="Shorts"]',
  'a[aria-label="Shorts"]',
  'ytd-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
  "ytd-reel-shelf-renderer",
  "ytd-rich-shelf-renderer:has(ytd-reel-shelf-renderer)",
  "ytd-rich-section-renderer:has(ytd-reel-shelf-renderer)",
  'ytd-guide-entry-renderer:has(a[href^="/shorts/"])',
  'ytd-mini-guide-entry-renderer:has(a[href^="/shorts/"])',
  "ytm-shorts-lockup-view-model",
] as const;

type CachedBlockState = {
  state: "LOCKED" | "UNLOCKED";
  syncedAt: number | null;
  source: "worker" | "cache" | "admin";
};

type ExtensionMessageResponse =
  | { ok: true; data: unknown | null }
  | { ok: false; message: string };

type ExtensionTabMessage = {
  type: "BLOCK_STATE_UPDATED";
  payload: CachedBlockState;
};

type ShortsBlockDecision = {
  shouldHideUi: boolean;
  shouldRedirect: boolean;
  redirectTarget: string | null;
};

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
  if (shouldReapplyBlockingForNavigation({ previousUrl: lastKnownUrl, nextUrl: location.href })) {
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

function isShortsPath(pathname: string, search = "", href = ""): boolean {
  if (pathname.startsWith("/shorts/")) {
    return true;
  }

  if (pathname === "/watch") {
    const params = new URLSearchParams(search);
    const shortsContextParamKeys = ["shorts", "shortsui"];

    if (shortsContextParamKeys.some((key) => params.has(key))) {
      return true;
    }

    if (href.toLowerCase().includes("shorts")) {
      return true;
    }
  }

  return false;
}

function buildShortsHideCss(): string {
  return `${SHORTS_HIDE_SELECTORS.join(",")} { display: none !important; }`;
}

function shouldBlockShorts(state: CachedBlockState["state"] | null): boolean {
  return state === "LOCKED";
}

function decideShortsBlocking({
  state,
  pathname,
  search = "",
  href = "",
}: {
  state: CachedBlockState["state"] | null;
  pathname: string;
  search?: string;
  href?: string;
}): ShortsBlockDecision {
  const blocked = shouldBlockShorts(state);

  if (!blocked) {
    return {
      shouldHideUi: false,
      shouldRedirect: false,
      redirectTarget: null,
    };
  }

  if (isShortsPath(pathname, search, href)) {
    return {
      shouldHideUi: true,
      shouldRedirect: true,
      redirectTarget: SHORTS_REDIRECT_PATH,
    };
  }

  return {
    shouldHideUi: true,
    shouldRedirect: false,
    redirectTarget: null,
  };
}

function shouldReapplyBlockingForNavigation({
  previousUrl,
  nextUrl,
}: {
  previousUrl: string;
  nextUrl: string;
}): boolean {
  return previousUrl !== nextUrl;
}
})();

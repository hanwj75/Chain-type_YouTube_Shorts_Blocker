const STYLE_ELEMENT_ID = "shorts-blocker-style";
const SHORTS_REDIRECT_PATH = "/feed/subscriptions";
const SHORTS_HIDE_SELECTORS = [
  'a[href^="/shorts/"]',
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
  source: "worker" | "cache";
};

type ExtensionMessageResponse =
  | { ok: true; data: unknown | null }
  | { ok: false; message: string };

type ExtensionTabMessage = {
  type: "BLOCK_STATE_UPDATED";
  payload: CachedBlockState;
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
  });

  if (!shouldBlockShorts(currentState?.state ?? null)) {
    removeBlockStyle();
    return;
  }

  ensureBlockStyle();

  if (decision.shouldRedirect && decision.redirectTarget) {
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

function isShortsPath(pathname: string): boolean {
  return pathname.startsWith("/shorts/");
}

function buildShortsHideCss(): string {
  return `${SHORTS_HIDE_SELECTORS.join(",")} { display: none !important; }`;
}

function shouldBlockShorts(state: "LOCKED" | "UNLOCKED" | null): boolean {
  return state === "LOCKED";
}

function decideShortsBlocking({
  state,
  pathname,
}: {
  state: "LOCKED" | "UNLOCKED" | null;
  pathname: string;
}): {
  shouldHideUi: boolean;
  shouldRedirect: boolean;
  redirectTarget: string | null;
} {
  if (!shouldBlockShorts(state)) {
    return {
      shouldHideUi: false,
      shouldRedirect: false,
      redirectTarget: null,
    };
  }

  if (isShortsPath(pathname)) {
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

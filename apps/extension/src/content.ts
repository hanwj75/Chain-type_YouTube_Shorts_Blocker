import type { CachedBlockState } from "./config.js";
import { buildShortsHideCss, getRedirectTarget, isShortsPath, shouldBlockShorts } from "./index.js";
import type { ExtensionMessageResponse, ExtensionTabMessage } from "./messages.js";

const STYLE_ELEMENT_ID = "shorts-blocker-style";

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
  if (!shouldBlockShorts(currentState?.state ?? null)) {
    removeBlockStyle();
    return;
  }

  ensureBlockStyle();

  if (isShortsPath(location.pathname)) {
    const redirectTarget = getRedirectTarget();

    if (location.pathname !== redirectTarget) {
      location.replace(redirectTarget);
      return;
    }
  }

  hideShortsUi();
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
  if (lastKnownUrl !== location.href) {
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

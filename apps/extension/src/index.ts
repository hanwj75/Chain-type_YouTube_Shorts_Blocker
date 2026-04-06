export const SHORTS_REDIRECT_PATH = "/feed/subscriptions";

export const SHORTS_HIDE_SELECTORS = [
  'a[href^="/shorts/"]',
  'a[title="Shorts"]',
  'a[aria-label="Shorts"]',
  'ytd-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
  'ytd-reel-shelf-renderer',
  'ytd-rich-shelf-renderer:has(ytd-reel-shelf-renderer)',
  'ytd-rich-section-renderer:has(ytd-reel-shelf-renderer)',
  'ytd-guide-entry-renderer:has(a[href^="/shorts/"])',
  'ytd-mini-guide-entry-renderer:has(a[href^="/shorts/"])',
  'ytm-shorts-lockup-view-model',
] as const;

export const isShortsPath = (
  pathname: string,
  search = "",
  href = "",
): boolean => {
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
};

export const buildShortsHideCss = (): string => {
  return `${SHORTS_HIDE_SELECTORS.join(",")} { display: none !important; }`;
};

export const shouldBlockShorts = (state: "LOCKED" | "UNLOCKED" | null): boolean => {
  return state === "LOCKED";
};

export const getRedirectTarget = (): string => {
  return SHORTS_REDIRECT_PATH;
};

export type ShortsBlockDecision = {
  shouldHideUi: boolean;
  shouldRedirect: boolean;
  redirectTarget: string | null;
};

export const decideShortsBlocking = ({
  state,
  pathname,
  search = "",
  href = "",
}: {
  state: "LOCKED" | "UNLOCKED" | null;
  pathname: string;
  search?: string;
  href?: string;
}): ShortsBlockDecision => {
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
      redirectTarget: getRedirectTarget(),
    };
  }

  return {
    shouldHideUi: true,
    shouldRedirect: false,
    redirectTarget: null,
  };
};

export const shouldReapplyBlockingForNavigation = ({
  previousUrl,
  nextUrl,
}: {
  previousUrl: string;
  nextUrl: string;
}): boolean => {
  return previousUrl !== nextUrl;
};

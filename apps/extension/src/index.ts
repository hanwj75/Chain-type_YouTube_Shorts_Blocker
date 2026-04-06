export const SHORTS_REDIRECT_PATH = "/feed/subscriptions";

export const SHORTS_HIDE_SELECTORS = [
  'a[href^="/shorts/"]',
  'ytd-reel-shelf-renderer',
  'ytd-rich-shelf-renderer:has(ytd-reel-shelf-renderer)',
  'ytd-rich-section-renderer:has(ytd-reel-shelf-renderer)',
  'ytd-guide-entry-renderer:has(a[href^="/shorts/"])',
  'ytd-mini-guide-entry-renderer:has(a[href^="/shorts/"])',
  'ytm-shorts-lockup-view-model',
] as const;

export const isShortsPath = (pathname: string): boolean => {
  return pathname.startsWith("/shorts/");
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
}: {
  state: "LOCKED" | "UNLOCKED" | null;
  pathname: string;
}): ShortsBlockDecision => {
  const blocked = shouldBlockShorts(state);

  if (!blocked) {
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

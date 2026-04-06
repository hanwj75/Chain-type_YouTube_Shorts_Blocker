import {
  buildShortsHideCss,
  decideShortsBlocking,
  getRedirectTarget,
  isShortsPath,
  SHORTS_REDIRECT_PATH,
  shouldReapplyBlockingForNavigation,
  shouldBlockShorts,
} from "./index.js";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const run = (): void => {
  assert(isShortsPath("/shorts/abc"), "shorts path should be detected");
  assert(!isShortsPath("/watch?v=abc"), "watch path should not be treated as shorts");
  assert(shouldBlockShorts("LOCKED"), "locked state must block shorts");
  assert(!shouldBlockShorts("UNLOCKED"), "unlocked state must not block shorts");
  assert(
    buildShortsHideCss().includes('a[href^="/shorts/"]'),
    "hide css must include shorts links",
  );
  assert(
    getRedirectTarget() === SHORTS_REDIRECT_PATH,
    "redirect target mismatch",
  );

  const lockedShortsDecision = decideShortsBlocking({
    state: "LOCKED",
    pathname: "/shorts/abc",
  });

  assert(
    lockedShortsDecision.shouldRedirect &&
      lockedShortsDecision.redirectTarget === SHORTS_REDIRECT_PATH,
    "locked state must block direct /shorts/ access",
  );

  const unlockedShortsDecision = decideShortsBlocking({
    state: "UNLOCKED",
    pathname: "/shorts/abc",
  });

  assert(
    !unlockedShortsDecision.shouldRedirect &&
      !unlockedShortsDecision.shouldHideUi,
    "unlocked state must allow /shorts/ access",
  );

  assert(
    shouldReapplyBlockingForNavigation({
      previousUrl: "https://www.youtube.com/watch?v=abc",
      nextUrl: "https://www.youtube.com/shorts/abc",
    }),
    "SPA navigation must trigger reapply",
  );

  const spaNavigationDecision = decideShortsBlocking({
    state: "LOCKED",
    pathname: "/shorts/abc",
  });

  assert(
    spaNavigationDecision.shouldRedirect,
    "LOCKED state must reapply blocking after SPA navigation",
  );

  console.log("extension tests passed");
};

run();

import {
  simulateAdminRequest,
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
  assert(!isShortsPath("/watch", "?v=abc"), "plain watch url should not be treated as shorts");
  assert(
    isShortsPath("/watch", "?v=qThKsJhrFM0&shorts=1"),
    "watch url with explicit shorts context should be treated as shorts",
  );
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

  const lockedSharedShortsDecision = decideShortsBlocking({
    state: "LOCKED",
    pathname: "/watch",
    search: "?v=qThKsJhrFM0&shorts=1",
    href: "https://www.youtube.com/watch?v=qThKsJhrFM0&shorts=1",
  });

  assert(
    lockedSharedShortsDecision.shouldRedirect,
    "locked state must block shorts-context watch urls",
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

  const adminLockSimulation = simulateAdminRequest({
    currentState: "UNLOCKED",
    requesterId: "B",
    targetUserId: "A",
    requestType: "LOCK_REQUEST",
    votes: {
      A: "NONE",
      B: "APPROVE",
      C: "APPROVE",
    },
  });

  assert(
    adminLockSimulation.ok && adminLockSimulation.nextState === "LOCKED",
    "admin simulation must lock the target after two approve votes",
  );

  const adminTieSimulation = simulateAdminRequest({
    currentState: "LOCKED",
    requesterId: "B",
    targetUserId: "A",
    requestType: "UNLOCK_REQUEST",
    votes: {
      A: "NONE",
      B: "APPROVE",
      C: "REJECT",
    },
  });

  assert(
    adminTieSimulation.ok && adminTieSimulation.nextState === "LOCKED",
    "admin simulation tie must keep the current LOCKED state",
  );

  console.log("extension tests passed");
};

run();

import {
  buildShortsHideCss,
  getRedirectTarget,
  isShortsPath,
  SHORTS_REDIRECT_PATH,
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

  console.log("extension tests passed");
};

run();

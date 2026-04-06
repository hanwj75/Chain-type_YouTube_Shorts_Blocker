import { extensionPlaceholder } from "./index.js";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const run = (): void => {
  assert(extensionPlaceholder.name === "extension", "extension name mismatch");
  assert(
    extensionPlaceholder.status === "placeholder",
    "extension status mismatch",
  );

  console.log("extension tests passed");
};

run();

import type { CachedBlockState, ExtensionConfig } from "./config.js";

export type ExtensionMessage =
  | { type: "GET_BLOCK_STATE" }
  | { type: "SYNC_BLOCK_STATE" }
  | { type: "GET_EXTENSION_CONFIG" }
  | { type: "SET_EXTENSION_CONFIG"; payload: ExtensionConfig }
  | { type: "START_DISCORD_OAUTH" }
  | { type: "POLL_DISCORD_OAUTH" }
  | { type: "GET_SESSION" }
  | { type: "LOGOUT" };

export type ExtensionMessageResponse =
  | { ok: true; data: unknown | null }
  | { ok: false; message: string };

export type ExtensionTabMessage = {
  type: "BLOCK_STATE_UPDATED";
  payload: CachedBlockState;
};

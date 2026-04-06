import type { RequestType } from "@youtube-shorts-chain-blocker/domain";
import type { AdminMemberId, AdminVoteSelection } from "./index.js";
import type { AdminModeState, CachedBlockState, ExtensionConfig } from "./config.js";

export type ExtensionMessage =
  | { type: "GET_BLOCK_STATE" }
  | { type: "SYNC_BLOCK_STATE" }
  | { type: "GET_EXTENSION_CONFIG" }
  | { type: "SET_EXTENSION_CONFIG"; payload: ExtensionConfig }
  | { type: "START_DISCORD_OAUTH" }
  | { type: "POLL_DISCORD_OAUTH" }
  | { type: "GET_SESSION" }
  | { type: "LOGOUT" }
  | { type: "GET_ADMIN_MODE_STATE" }
  | { type: "SET_ADMIN_MODE"; payload: { enabled: boolean } }
  | {
      type: "RUN_ADMIN_SIMULATION";
      payload: {
        requesterId: AdminMemberId;
        targetUserId: AdminMemberId;
        requestType: RequestType;
        votes: Record<AdminMemberId, AdminVoteSelection>;
      };
    };

export type ExtensionMessageResponse =
  | { ok: true; data: unknown | null }
  | { ok: false; message: string };

export type ExtensionTabMessage = {
  type: "BLOCK_STATE_UPDATED";
  payload: CachedBlockState;
};

export type AdminSimulationResponse = {
  adminMode: AdminModeState;
  cachedState: CachedBlockState;
};

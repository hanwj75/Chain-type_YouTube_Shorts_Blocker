export const EXTENSION_SYNC_ALARM = "shorts-blocker-sync";
export const STORAGE_KEYS = {
  config: "shortsBlockerConfig",
  cachedState: "shortsBlockerCachedState",
  cachedAt: "shortsBlockerCachedStateAt",
  adminMode: "shortsBlockerAdminMode",
} as const;

export type ExtensionConfig = {
  apiBaseUrl: string;
  groupId: string;
  extensionUserId: string | null;
  discordUserId: string | null;
  sessionToken: string | null;
  authRequestId: string | null;
};

export type CachedBlockState = {
  state: "LOCKED" | "UNLOCKED";
  syncedAt: number | null;
  source: "worker" | "cache" | "admin";
};

export type AdminModeState = {
  enabled: boolean;
  currentState: "LOCKED" | "UNLOCKED";
  lastSummary: string | null;
};

export const isConfigured = (config: Partial<ExtensionConfig>): config is ExtensionConfig => {
  return Boolean(
    config.apiBaseUrl?.trim() &&
      config.groupId?.trim() &&
      typeof config.extensionUserId !== "undefined" &&
      typeof config.discordUserId !== "undefined" &&
      typeof config.sessionToken !== "undefined" &&
      typeof config.authRequestId !== "undefined",
  );
};

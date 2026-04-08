import type {
  GetDiscordOAuthPendingResponse,
  GetSessionResponse,
  GetUserGroupResponse,
  GetUserStateResponse,
  StartDiscordOAuthResponse,
} from "@youtube-shorts-chain-blocker/api-contract";
import type { UserState } from "@youtube-shorts-chain-blocker/domain";
import {
  DEFAULT_WORKER_API_BASE_URL,
  EXTENSION_SYNC_ALARM,
  STORAGE_KEYS,
  type CachedBlockState,
  type ExtensionConfig,
} from "./config.js";
import type {
  ExtensionMessage,
  ExtensionMessageResponse,
  ExtensionTabMessage,
} from "./messages.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(EXTENSION_SYNC_ALARM, { periodInMinutes: 1 });
  void ensureDefaultConfig();
  void syncAndBroadcastState();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(EXTENSION_SYNC_ALARM, { periodInMinutes: 1 });
  void ensureDefaultConfig();
  void syncAndBroadcastState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXTENSION_SYNC_ALARM) {
    void syncAndBroadcastState();
  }
});

chrome.tabs.onActivated.addListener(() => {
  void syncAndBroadcastState();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void handleMessage(message as ExtensionMessage).then(sendResponse);
  return true;
});

const handleMessage = async (
  message: ExtensionMessage,
): Promise<ExtensionMessageResponse> => {
  if (message.type === "GET_BLOCK_STATE") {
    return { ok: true, data: await getLastKnownState() };
  }

  if (message.type === "SYNC_BLOCK_STATE") {
    return { ok: true, data: await syncAndBroadcastState() };
  }

  if (message.type === "GET_EXTENSION_CONFIG") {
    return { ok: true, data: await getExtensionConfig() };
  }

  if (message.type === "SET_EXTENSION_CONFIG") {
    const currentConfig = await getExtensionConfig();
    await chrome.storage.local.set({
      [STORAGE_KEYS.config]: {
        ...message.payload,
        apiBaseUrl: currentConfig?.apiBaseUrl ?? DEFAULT_WORKER_API_BASE_URL,
      } satisfies ExtensionConfig,
    });

    return { ok: true, data: await syncAndBroadcastState() };
  }

  if (message.type === "START_DISCORD_OAUTH") {
    const auth = await startDiscordOAuth();

    if (!auth) {
      return { ok: false, message: "Failed to start Discord OAuth." };
    }

    await chrome.tabs.create({ url: auth.authUrl });
    return { ok: true, data: auth };
  }

  if (message.type === "POLL_DISCORD_OAUTH") {
    const mapping = await pollDiscordOAuth();

    if (!mapping) {
      return { ok: false, message: "OAuth is still pending or failed." };
    }

    return { ok: true, data: mapping };
  }

  if (message.type === "GET_SESSION") {
    return { ok: true, data: await getSessionInfo() };
  }

  if (message.type === "LOGOUT") {
    const revoked = await logoutSession();

    return revoked
      ? { ok: true, data: null }
      : { ok: false, message: "Logout failed." };
  }

  return { ok: false, message: "Unsupported message." };
};

const syncAndBroadcastState = async (): Promise<CachedBlockState | null> => {
  const state = await syncBlockState();

  if (state) {
    await broadcastState(state);
  }

  return state;
};

const syncBlockState = async (): Promise<CachedBlockState | null> => {
  const config = await ensureDefaultConfig();

  if (!config?.apiBaseUrl || !config.sessionToken) {
    return getLastKnownState();
  }

  const session = await getSessionInfo();

  if (!session?.discordUserId) {
    return getLastKnownState();
  }

  const groupId = session.groupId ?? (await ensureGroupIdForDiscordUser(session.discordUserId));

  if (!groupId) {
    return getLastKnownState();
  }

  try {
    const response = await fetch(
      `${config.apiBaseUrl.replace(/\/$/, "")}/users/${encodeURIComponent(session.discordUserId)}/state`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.sessionToken}`,
          "x-client-type": "extension",
          "x-group-id": groupId,
        },
      },
    );

    if (!response.ok) {
      return getLastKnownState();
    }

    const data = (await response.json()) as GetUserStateResponse;

    if (!data.success) {
      return getLastKnownState();
    }

    const nextState: CachedBlockState = {
      state: data.data.state,
      syncedAt: Date.now(),
      source: "worker",
    };

    await chrome.storage.local.set({
      [STORAGE_KEYS.cachedState]: nextState.state,
      [STORAGE_KEYS.cachedAt]: nextState.syncedAt,
    });

    return nextState;
  } catch {
    const fallbackState = await getLastKnownState();

    return fallbackState
      ? {
          ...fallbackState,
          source: "cache",
        }
      : null;
  }
};

const startDiscordOAuth = async (): Promise<{
  extensionUserId: string;
  authRequestId: string;
  authUrl: string;
} | null> => {
  const config = await getExtensionConfig();

  if (!config?.apiBaseUrl) {
    return null;
  }

  const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/auth/discord/start`, {
    method: "POST",
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as StartDiscordOAuthResponse;

  if (!data.success) {
    return null;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.config]: {
      ...config,
      extensionUserId: data.data.extensionUserId,
      authRequestId: data.data.authRequestId,
      discordUserId: null,
      sessionToken: null,
    } satisfies ExtensionConfig,
  });

  return data.data;
};

const ensureGroupIdForDiscordUser = async (
  discordUserId: string,
): Promise<string | null> => {
  const config = await getExtensionConfig();

  if (!config?.apiBaseUrl) {
    return null;
  }

  const response = await fetch(
    `${config.apiBaseUrl.replace(/\/$/, "")}/users/${encodeURIComponent(discordUserId)}/group`,
    {
      method: "GET",
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as GetUserGroupResponse;

  if (!data.success) {
    return null;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.config]: {
      ...(config ?? {
        apiBaseUrl: DEFAULT_WORKER_API_BASE_URL,
        groupId: "",
        extensionUserId: null,
        discordUserId: null,
        sessionToken: null,
        authRequestId: null,
      }),
      groupId: data.data.group.id,
    } satisfies ExtensionConfig,
  });

  return data.data.group.id;
};

const pollDiscordOAuth = async (): Promise<{
  extensionUserId: string;
  discordUserId: string;
  sessionToken: string;
  expiresAt: number;
} | null> => {
  const config = await getExtensionConfig();

  if (!config?.apiBaseUrl || !config.authRequestId) {
    return null;
  }

  const response = await fetch(
    `${config.apiBaseUrl.replace(/\/$/, "")}/auth/discord/pending/${encodeURIComponent(config.authRequestId)}`,
    {
      method: "GET",
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as GetDiscordOAuthPendingResponse;

  if (!data.success || data.data.status !== "COMPLETED" || !data.data.mapping) {
    return null;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.config]: {
      ...config,
      extensionUserId: data.data.mapping.extensionUserId,
      discordUserId: data.data.mapping.discordUserId,
      sessionToken: data.data.mapping.sessionToken,
      authRequestId: null,
    } satisfies ExtensionConfig,
  });

  await ensureGroupIdForDiscordUser(data.data.mapping.discordUserId);

  return data.data.mapping;
};

const getSessionInfo = async (): Promise<{
  extensionUserId: string;
  discordUserId: string;
  expiresAt: number;
  groupId?: string | null;
} | null> => {
  const config = await getExtensionConfig();

  if (!config?.apiBaseUrl || !config.sessionToken) {
    return null;
  }

  const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/auth/session`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${config.sessionToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as GetSessionResponse;

  if (!data.success) {
    return null;
  }

  const groupId = await ensureGroupIdForDiscordUser(data.data.discordUserId);

  return {
    ...data.data,
    groupId,
  };
};

const logoutSession = async (): Promise<boolean> => {
  const config = await getExtensionConfig();

  if (!config?.apiBaseUrl || !config.sessionToken) {
    return false;
  }

  const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/auth/logout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.sessionToken}`,
    },
  });

  if (!response.ok) {
    return false;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.config]: {
      ...config,
      discordUserId: null,
      sessionToken: null,
      authRequestId: null,
    } satisfies ExtensionConfig,
  });

  return true;
};

const getExtensionConfig = async (): Promise<ExtensionConfig | null> => {
  const values = await chrome.storage.local.get(STORAGE_KEYS.config);
  return (values[STORAGE_KEYS.config] as ExtensionConfig | undefined) ?? null;
};

const ensureDefaultConfig = async (): Promise<ExtensionConfig> => {
  const existing = await getExtensionConfig();
  const nextConfig: ExtensionConfig = {
    apiBaseUrl: existing?.apiBaseUrl?.trim() || DEFAULT_WORKER_API_BASE_URL,
    groupId: existing?.groupId?.trim() ?? "",
    extensionUserId: existing?.extensionUserId ?? null,
    discordUserId: existing?.discordUserId ?? null,
    sessionToken: existing?.sessionToken ?? null,
    authRequestId: existing?.authRequestId ?? null,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.config]: nextConfig,
  });

  return nextConfig;
};

const getLastKnownState = async (): Promise<CachedBlockState | null> => {
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.cachedState,
    STORAGE_KEYS.cachedAt,
  ]);
  const state = values[STORAGE_KEYS.cachedState] as UserState | undefined;
  const syncedAt = values[STORAGE_KEYS.cachedAt] as number | undefined;

  if (!state) {
    return null;
  }

  return {
    state,
    syncedAt: syncedAt ?? null,
    source: "cache",
  };
};

const broadcastState = async (state: CachedBlockState): Promise<void> => {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] });

  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map(async (tab) => {
        try {
          const message: ExtensionTabMessage = {
            type: "BLOCK_STATE_UPDATED",
            payload: state,
          };

          await chrome.tabs.sendMessage(tab.id as number, message);
        } catch {
          return undefined;
        }
      }),
  );
};

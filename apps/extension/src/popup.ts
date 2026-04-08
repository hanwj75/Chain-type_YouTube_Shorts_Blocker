import {
  DEFAULT_WORKER_API_BASE_URL,
  type CachedBlockState,
  type ExtensionConfig,
} from "./config.js";
import { isConfigured } from "./config.js";
import type { ExtensionMessageResponse } from "./messages.js";

const settingsForm = document.getElementById("settings-form") as HTMLFormElement;
const syncButton = document.getElementById("sync-button") as HTMLButtonElement;
const loginButton = document.getElementById("login-button") as HTMLButtonElement;
const pollButton = document.getElementById("poll-button") as HTMLButtonElement;
const logoutButton = document.getElementById("logout-button") as HTMLButtonElement;
const statusText = document.getElementById("status-text") as HTMLParagraphElement;
const identityText = document.getElementById("identity-text") as HTMLParagraphElement;

const groupIdInput = document.getElementById("group-id") as HTMLInputElement;
const workerUrlText = document.getElementById("worker-url-text") as HTMLParagraphElement;

void initializePopup();

async function initializePopup(): Promise<void> {
  await loadConfig();
  await refreshStatus();
  await refreshIdentity();

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const existing = await getStoredConfig();
    const config: ExtensionConfig = {
      apiBaseUrl: existing?.apiBaseUrl?.trim() || DEFAULT_WORKER_API_BASE_URL,
      groupId: groupIdInput.value.trim(),
      extensionUserId: existing?.extensionUserId ?? null,
      discordUserId: existing?.discordUserId ?? null,
      sessionToken: existing?.sessionToken ?? null,
      authRequestId: existing?.authRequestId ?? null,
    };

    if (!isConfigured(config)) {
      statusText.textContent = "Fill required fields before saving.";
      return;
    }

    const response = (await chrome.runtime.sendMessage({
      type: "SET_EXTENSION_CONFIG",
      payload: config,
    })) as ExtensionMessageResponse;

    if (!response.ok) {
      statusText.textContent = response.message;
      return;
    }

    updateStatusText(response.data as CachedBlockState | null);
    await refreshIdentity();
  });

  syncButton.addEventListener("click", async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "SYNC_BLOCK_STATE",
    })) as ExtensionMessageResponse;

    if (!response.ok) {
      statusText.textContent = response.message;
      return;
    }

    updateStatusText(response.data as CachedBlockState | null);
  });

  loginButton.addEventListener("click", async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "START_DISCORD_OAUTH",
    })) as ExtensionMessageResponse;

    statusText.textContent = response.ok
      ? "Discord login started. Complete the browser flow, then press Check Login."
      : response.message;
  });

  pollButton.addEventListener("click", async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "POLL_DISCORD_OAUTH",
    })) as ExtensionMessageResponse;

    if (!response.ok) {
      statusText.textContent = response.message;
      return;
    }

    statusText.textContent = "Discord account linked.";
    await refreshIdentity();
    await refreshStatus();
  });

  logoutButton.addEventListener("click", async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "LOGOUT",
    })) as ExtensionMessageResponse;

    statusText.textContent = response.ok ? "Logged out." : response.message;
    await refreshIdentity();
  });
}

async function loadConfig(): Promise<void> {
  const config = await getStoredConfig();

  if (!config) {
    workerUrlText.textContent = DEFAULT_WORKER_API_BASE_URL;
    return;
  }

  workerUrlText.textContent = config.apiBaseUrl || DEFAULT_WORKER_API_BASE_URL;
  groupIdInput.value = config.groupId;
}

async function getStoredConfig(): Promise<ExtensionConfig | null> {
  const response = (await chrome.runtime.sendMessage({
    type: "GET_EXTENSION_CONFIG",
  })) as ExtensionMessageResponse;

  return response.ok ? (response.data as ExtensionConfig | null) : null;
}

async function refreshStatus(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "GET_BLOCK_STATE",
  })) as ExtensionMessageResponse;

  if (!response.ok) {
    statusText.textContent = response.message;
    return;
  }

  updateStatusText(response.data as CachedBlockState | null);
}

async function refreshIdentity(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "GET_SESSION",
  })) as ExtensionMessageResponse;

  if (!response.ok || !response.data) {
    identityText.textContent = "Not signed in.";
    return;
  }

  const session = response.data as unknown as {
    extensionUserId: string;
    discordUserId: string;
    expiresAt: number;
    groupId?: string | null;
  };

  if (session.groupId) {
    groupIdInput.value = session.groupId;
  }

  identityText.textContent = `Discord ${session.discordUserId}, extension ${session.extensionUserId}, expires ${new Date(session.expiresAt).toLocaleString()}`;
}

function updateStatusText(state: CachedBlockState | null): void {
  if (!state) {
    statusText.textContent = "No synced state yet.";
    return;
  }

  const syncedAtText = state.syncedAt
    ? new Date(state.syncedAt).toLocaleTimeString()
    : "unknown";

  statusText.textContent = `State: ${state.state} (${state.source}, ${syncedAtText})`;
}

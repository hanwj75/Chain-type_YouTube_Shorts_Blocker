import type { RequestType } from "@youtube-shorts-chain-blocker/domain";
import type { AdminModeState, CachedBlockState, ExtensionConfig } from "./config.js";
import { isConfigured } from "./config.js";
import {
  ADMIN_MEMBER_IDS,
  type AdminMemberId,
  type AdminVoteSelection,
} from "./index.js";
import type {
  AdminSimulationResponse,
  ExtensionMessageResponse,
} from "./messages.js";

const settingsForm = document.getElementById("settings-form") as HTMLFormElement;
const syncButton = document.getElementById("sync-button") as HTMLButtonElement;
const loginButton = document.getElementById("login-button") as HTMLButtonElement;
const pollButton = document.getElementById("poll-button") as HTMLButtonElement;
const logoutButton = document.getElementById("logout-button") as HTMLButtonElement;
const adminModeButton = document.getElementById("admin-mode-button") as HTMLButtonElement;
const adminRunButton = document.getElementById("admin-run-button") as HTMLButtonElement;
const adminResetButton = document.getElementById("admin-reset-button") as HTMLButtonElement;

const statusText = document.getElementById("status-text") as HTMLParagraphElement;
const identityText = document.getElementById("identity-text") as HTMLParagraphElement;
const adminStatusText = document.getElementById("admin-status-text") as HTMLParagraphElement;
const adminSummaryText = document.getElementById("admin-summary-text") as HTMLParagraphElement;
const adminPanel = document.getElementById("admin-panel") as HTMLDivElement;

const apiBaseUrlInput = document.getElementById("api-base-url") as HTMLInputElement;
const groupIdInput = document.getElementById("group-id") as HTMLInputElement;
const adminRequesterSelect = document.getElementById("admin-requester-id") as HTMLSelectElement;
const adminTargetSelect = document.getElementById("admin-target-id") as HTMLSelectElement;
const adminRequestTypeSelect = document.getElementById("admin-request-type") as HTMLSelectElement;
const adminVoteButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".popup__vote-button"),
);

const voteCycle: AdminVoteSelection[] = ["NONE", "APPROVE", "REJECT"];
let currentVoteSelections: Record<AdminMemberId, AdminVoteSelection> = {
  A: "NONE",
  B: "NONE",
  C: "NONE",
};

void initializePopup();

async function initializePopup(): Promise<void> {
  await loadConfig();
  await refreshStatus();
  await refreshIdentity();
  await refreshAdminMode();
  renderVoteButtons();

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const existing = await getStoredConfig();
    const config: ExtensionConfig = {
      apiBaseUrl: apiBaseUrlInput.value.trim(),
      groupId: groupIdInput.value.trim(),
      extensionUserId: existing?.extensionUserId ?? null,
      discordUserId: existing?.discordUserId ?? null,
      sessionToken: existing?.sessionToken ?? null,
      authRequestId: existing?.authRequestId ?? null,
    };

    if (!isConfigured(config)) {
      statusText.textContent = "Worker 주소와 그룹 ID를 먼저 입력해 주세요.";
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
    await refreshAdminMode();
  });

  loginButton.addEventListener("click", async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "START_DISCORD_OAUTH",
    })) as ExtensionMessageResponse;

    statusText.textContent = response.ok
      ? "Discord 로그인 창을 열었습니다. 로그인 후 '로그인 확인'을 눌러 주세요."
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

    statusText.textContent = "Discord 계정 연결이 완료되었습니다.";
    await refreshIdentity();
    await refreshStatus();
  });

  logoutButton.addEventListener("click", async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "LOGOUT",
    })) as ExtensionMessageResponse;

    statusText.textContent = response.ok ? "로그아웃되었습니다." : response.message;
    await refreshIdentity();
  });

  adminModeButton.addEventListener("click", async () => {
    const adminMode = await getAdminMode();
    const response = (await chrome.runtime.sendMessage({
      type: "SET_ADMIN_MODE",
      payload: {
        enabled: !adminMode.enabled,
      },
    })) as ExtensionMessageResponse;

    if (!response.ok) {
      statusText.textContent = response.message;
      return;
    }

    await refreshAdminMode();
    await refreshStatus();
  });

  adminTargetSelect.addEventListener("change", () => {
    currentVoteSelections[adminTargetSelect.value as AdminMemberId] = "NONE";
    renderVoteButtons();
  });

  adminResetButton.addEventListener("click", () => {
    currentVoteSelections = {
      A: "NONE",
      B: "NONE",
      C: "NONE",
    };
    renderVoteButtons();
    adminSummaryText.textContent = "토글을 초기화했습니다.";
  });

  adminVoteButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const memberId = button.dataset.memberId as AdminMemberId;

      if (memberId === adminTargetSelect.value) {
        return;
      }

      const currentIndex = voteCycle.indexOf(currentVoteSelections[memberId]);
      const nextIndex = (currentIndex + 1) % voteCycle.length;
      currentVoteSelections[memberId] = voteCycle[nextIndex];
      renderVoteButtons();
    });
  });

  adminRunButton.addEventListener("click", async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "RUN_ADMIN_SIMULATION",
      payload: {
        requesterId: adminRequesterSelect.value as AdminMemberId,
        targetUserId: adminTargetSelect.value as AdminMemberId,
        requestType: adminRequestTypeSelect.value as RequestType,
        votes: currentVoteSelections,
      },
    })) as ExtensionMessageResponse;

    if (!response.ok) {
      adminSummaryText.textContent = response.message;
      return;
    }

    const data = response.data as AdminSimulationResponse;
    adminSummaryText.textContent = data.adminMode.lastSummary ?? "시뮬레이션이 완료되었습니다.";
    updateStatusText(data.cachedState);
    await refreshAdminMode();
  });
}

async function loadConfig(): Promise<void> {
  const config = await getStoredConfig();

  if (!config) {
    return;
  }

  apiBaseUrlInput.value = config.apiBaseUrl;
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
    identityText.textContent = "로그인되지 않았습니다.";
    return;
  }

  const session = response.data as {
    extensionUserId: string;
    discordUserId: string;
    expiresAt: number;
  };

  identityText.textContent =
    `Discord ${session.discordUserId} / 확장 사용자 ${session.extensionUserId} / 만료 ${new Date(session.expiresAt).toLocaleString("ko-KR")}`;
}

async function getAdminMode(): Promise<AdminModeState> {
  const response = (await chrome.runtime.sendMessage({
    type: "GET_ADMIN_MODE_STATE",
  })) as ExtensionMessageResponse;

  if (!response.ok) {
    return {
      enabled: false,
      currentState: "UNLOCKED",
      lastSummary: null,
    };
  }

  return (response.data as AdminModeState | null) ?? {
    enabled: false,
    currentState: "UNLOCKED",
    lastSummary: null,
  };
}

async function refreshAdminMode(): Promise<void> {
  const adminMode = await getAdminMode();

  adminPanel.hidden = !adminMode.enabled;
  adminModeButton.textContent = adminMode.enabled
    ? "관리자 모드 끄기"
    : "관리자 모드 켜기";
  adminStatusText.textContent = `현재 테스트 상태: ${adminMode.currentState}`;
  adminSummaryText.textContent =
    adminMode.lastSummary ?? "아직 실행 결과가 없습니다.";
}

function updateStatusText(state: CachedBlockState | null): void {
  if (!state) {
    statusText.textContent = "아직 동기화된 상태가 없습니다.";
    return;
  }

  const sourceText =
    state.source === "worker"
      ? "Worker"
      : state.source === "cache"
        ? "캐시"
        : "관리자 모드";
  const syncedAtText = state.syncedAt
    ? new Date(state.syncedAt).toLocaleTimeString("ko-KR")
    : "알 수 없음";

  statusText.textContent = `현재 상태: ${state.state} / 출처: ${sourceText} / 시각: ${syncedAtText}`;
}

function renderVoteButtons(): void {
  const targetUserId = adminTargetSelect.value as AdminMemberId;

  adminVoteButtons.forEach((button) => {
    const memberId = button.dataset.memberId as AdminMemberId;
    const selection = currentVoteSelections[memberId];
    const isTarget = memberId === targetUserId;

    button.classList.remove("is-approve", "is-reject", "is-target");
    button.disabled = false;

    if (isTarget) {
      button.textContent = `${memberId}: 대상자`;
      button.classList.add("is-target");
      button.disabled = true;
      return;
    }

    if (selection === "APPROVE") {
      button.textContent = `${memberId}: 승인`;
      button.classList.add("is-approve");
      return;
    }

    if (selection === "REJECT") {
      button.textContent = `${memberId}: 거절`;
      button.classList.add("is-reject");
      return;
    }

    button.textContent = `${memberId}: 보류`;
  });
}

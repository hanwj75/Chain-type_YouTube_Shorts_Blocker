(() => {
    const DEFAULT_WORKER_API_BASE_URL = "https://chain-short-man.wjws9608.workers.dev";
    const statusText = getRequiredElement("status-text");
    const identityText = getRequiredElement("identity-text");
    const workerUrlText = getRequiredElement("worker-url-text");
    const groupIdText = getRequiredElement("group-id-text");
    let authPollTimer = null;
    void initializePopup();
    async function initializePopup() {
        const config = await loadConfig();
        await refreshStatus();
        const sessionGroupId = await refreshIdentity();
        workerUrlText.textContent = config?.apiBaseUrl || DEFAULT_WORKER_API_BASE_URL;
        groupIdText.textContent = sessionGroupId || config?.groupId?.trim() || "미설정";
        if (!config?.sessionToken && config?.authRequestId) {
            statusText.textContent = "디스코드 로그인 진행 중입니다. 완료되면 자동으로 반영됩니다.";
            startAuthPolling();
            return;
        }
        if (!config?.sessionToken) {
            void ensureDiscordOAuthStarted();
        }
    }
    async function ensureDiscordOAuthStarted() {
        const config = await getStoredConfig();
        if (!config || config.sessionToken || config.authRequestId) {
            return;
        }
        const response = (await chrome.runtime.sendMessage({
            type: "START_DISCORD_OAUTH",
        }));
        if (!response.ok) {
            statusText.textContent = "디스코드 로그인 시작에 실패했습니다.";
            return;
        }
        statusText.textContent = "디스코드 로그인 창을 열었습니다. 완료되면 자동으로 반영됩니다.";
        startAuthPolling();
    }
    function startAuthPolling() {
        if (authPollTimer !== null) {
            return;
        }
        authPollTimer = window.setInterval(() => {
            void pollDiscordOAuth();
        }, 2000);
    }
    function stopAuthPolling() {
        if (authPollTimer === null) {
            return;
        }
        window.clearInterval(authPollTimer);
        authPollTimer = null;
    }
    async function pollDiscordOAuth() {
        const response = (await chrome.runtime.sendMessage({
            type: "POLL_DISCORD_OAUTH",
        }));
        if (!response.ok) {
            return;
        }
        stopAuthPolling();
        statusText.textContent = "디스코드 계정 연결이 완료되었습니다.";
        await refreshIdentity();
        await refreshStatus();
    }
    async function loadConfig() {
        const config = await getStoredConfig();
        if (!config) {
            workerUrlText.textContent = DEFAULT_WORKER_API_BASE_URL;
            groupIdText.textContent = "미설정";
            return null;
        }
        workerUrlText.textContent = config.apiBaseUrl || DEFAULT_WORKER_API_BASE_URL;
        groupIdText.textContent = config.groupId?.trim() || "미설정";
        return config;
    }
    async function getStoredConfig() {
        const response = (await chrome.runtime.sendMessage({
            type: "GET_EXTENSION_CONFIG",
        }));
        return response.ok ? response.data : null;
    }
    async function refreshStatus() {
        const response = (await chrome.runtime.sendMessage({
            type: "GET_BLOCK_STATE",
        }));
        if (!response.ok) {
            statusText.textContent = response.message;
            return;
        }
        updateStatusText(response.data);
    }
    async function refreshIdentity() {
        const response = (await chrome.runtime.sendMessage({
            type: "GET_SESSION",
        }));
        if (!response.ok || !response.data) {
            identityText.textContent = "로그인되지 않음.";
            return null;
        }
        const session = response.data;
        identityText.textContent = `디스코드 ${session.discordUserId}, 확장 ${session.extensionUserId}, 만료 ${new Date(session.expiresAt).toLocaleString()}`;
        return session.groupId?.trim() || null;
    }
    function updateStatusText(state) {
        if (!state) {
            statusText.textContent = "아직 동기화된 상태가 없습니다.";
            return;
        }
        const syncedAtText = state.syncedAt
            ? new Date(state.syncedAt).toLocaleTimeString()
            : "알 수 없음";
        const stateLabel = state.state === "LOCKED" ? "차단됨" : "허용됨";
        const sourceLabel = state.source === "worker" ? "서버" : state.source === "cache" ? "캐시" : "관리자";
        statusText.textContent = `현재 상태: ${stateLabel} (${sourceLabel}, ${syncedAtText})`;
    }
    function getRequiredElement(id) {
        const element = document.getElementById(id);
        if (!element) {
            throw new Error(`Missing popup element: ${id}`);
        }
        return element;
    }
})();

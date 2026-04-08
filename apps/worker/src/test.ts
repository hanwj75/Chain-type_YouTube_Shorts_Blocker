import worker, {
  AuthDurableObject,
  GroupDurableObject,
  GroupRegistryDurableObject,
} from "./index.js";
import { decideShortsBlocking } from "../../extension/src/index.js";
import type {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
  ExecutionContext,
  WorkerEnv,
} from "./cloudflare.js";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

class MemoryDurableObjectStorage implements DurableObjectStorage {
  private readonly store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class MemoryGroupDurableObjectNamespace implements DurableObjectNamespace {
  private readonly instances = new Map<string, GroupDurableObject>();

  constructor(private readonly env: WorkerEnv) {}

  idFromName(name: string): DurableObjectId {
    return { name };
  }

  get(id: DurableObjectId) {
    if (!this.instances.has(id.name)) {
      const state: DurableObjectState = {
        storage: new MemoryDurableObjectStorage(),
      };

      this.instances.set(id.name, new GroupDurableObject(state, this.env));
    }

    const instance = this.instances.get(id.name);

    if (!instance) {
      throw new Error("Durable Object instance was not created.");
    }

    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);

        return instance.fetch(request);
      },
    };
  }
}

class MemoryAuthDurableObjectNamespace implements DurableObjectNamespace {
  private readonly instances = new Map<string, AuthDurableObject>();

  constructor(private readonly env: WorkerEnv) {}

  idFromName(name: string): DurableObjectId {
    return { name };
  }

  get(id: DurableObjectId) {
    if (!this.instances.has(id.name)) {
      const state: DurableObjectState = {
        storage: new MemoryDurableObjectStorage(),
      };

      this.instances.set(id.name, new AuthDurableObject(state, this.env));
    }

    const instance = this.instances.get(id.name);

    if (!instance) {
      throw new Error("Auth Durable Object instance was not created.");
    }

    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);

        return instance.fetch(request);
      },
    };
  }
}

class MemoryGroupRegistryDurableObjectNamespace implements DurableObjectNamespace {
  private readonly instances = new Map<string, GroupRegistryDurableObject>();

  idFromName(name: string): DurableObjectId {
    return { name };
  }

  get(id: DurableObjectId) {
    if (!this.instances.has(id.name)) {
      const state: DurableObjectState = {
        storage: new MemoryDurableObjectStorage(),
      };

      this.instances.set(id.name, new GroupRegistryDurableObject(state));
    }

    const instance = this.instances.get(id.name);

    if (!instance) {
      throw new Error("Group Registry Durable Object instance was not created.");
    }

    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);

        return instance.fetch(request);
      },
    };
  }
}

const ctx: ExecutionContext = {
  waitUntil() {},
};

const run = async (): Promise<void> => {
  const env = createTestEnv();
  await createGroup(env, "group-1", ["A", "B", "C"]);
  await runGroupDeleteTest(env);
  await runDiscordGroupCreationFlowTest();
  await runDiscordCommandRegistrationTest();
  const extensionSession = await createExtensionSession(env, "A");
  await runPublicOAuthFlowTest();

  const health = await callWorker(env, "GET", "/health");
  const healthBody = await health.json();

  assert(health.status === 200, "health status must be 200");
  assert(healthBody.success === true, "health must return success");
  assert(healthBody.data.status === "ok", "health payload mismatch");

  const unauthorizedState = await callWorker(env, "GET", "/users/A/state", {
    headers: {
      "x-group-id": "group-1",
    },
  });
  const unauthorizedStateBody = await unauthorizedState.json();

  assert(unauthorizedState.status === 401, "auth must be required");
  assert(
    unauthorizedStateBody.errorCode === "INVALID_AUTH",
    "invalid auth code mismatch",
  );

  const initialState = await callWorker(env, "GET", "/users/A/state", {
    headers: authorizedHeaders("extension", "group-1", extensionSession),
  });
  const initialStateBody = await initialState.json();

  assert(initialState.status === 200, "initial state request must succeed");
  assert(
    initialStateBody.data.state === "UNLOCKED",
    "new user state must default to UNLOCKED",
  );

  const createdRequest = await callWorker(env, "POST", "/requests", {
    headers: authorizedHeaders("extension", undefined, extensionSession),
    body: JSON.stringify({
      groupId: "group-1",
      requesterId: "A",
      targetUserId: "A",
      type: "LOCK_REQUEST",
    }),
  });
  const createdRequestBody = await createdRequest.json();

  assert(createdRequest.status === 200, "request creation must succeed");
  assert(
    createdRequestBody.data.request.status === "OPEN",
    "created request must be OPEN",
  );

  const requestId = createdRequestBody.data.request.id as string;

  const requestLookup = await callWorker(env, "GET", `/requests/${requestId}`, {
    headers: authorizedHeaders("discord", "group-1"),
  });
  const requestLookupBody = await requestLookup.json();

  assert(requestLookup.status === 200, "request lookup must succeed");
  assert(
    requestLookupBody.data.request.id === requestId,
    "request lookup id mismatch",
  );

  const targetVoteAttempt = await callWorker(
    env,
    "POST",
    `/requests/${requestId}/votes`,
    {
      headers: authorizedHeaders("discord", "group-1"),
      body: JSON.stringify({
        voterId: "A",
        choice: "APPROVE",
      }),
    },
  );
  const targetVoteAttemptBody = await targetVoteAttempt.json();

  assert(targetVoteAttempt.status === 400, "target vote must be rejected");
  assert(
    targetVoteAttemptBody.errorCode === "TARGET_CANNOT_VOTE",
    "target vote error code mismatch",
  );

  const firstVote = await callWorker(env, "POST", `/requests/${requestId}/votes`, {
    headers: authorizedHeaders("discord", "group-1"),
    body: JSON.stringify({
      voterId: "B",
      choice: "APPROVE",
    }),
  });
  const firstVoteBody = await firstVote.json();

  assert(firstVote.status === 200, "first vote must succeed");
  assert(firstVoteBody.data.request.status === "OPEN", "request must stay OPEN");

  const secondVote = await callWorker(env, "POST", `/requests/${requestId}/votes`, {
    headers: authorizedHeaders("discord", "group-1"),
    body: JSON.stringify({
      voterId: "C",
      choice: "APPROVE",
    }),
  });
  const secondVoteBody = await secondVote.json();

  assert(secondVote.status === 200, "second vote must succeed");
  assert(
    secondVoteBody.data.request.status === "RESOLVED",
    "request must resolve after two votes",
  );
  assert(
    secondVoteBody.data.resultingState === "LOCKED",
    "approved lock request must lock user",
  );

  const resolvedVoteAttempt = await callWorker(
    env,
    "POST",
    `/requests/${requestId}/votes`,
    {
      headers: authorizedHeaders("discord", "group-1"),
      body: JSON.stringify({
        voterId: "B",
        choice: "APPROVE",
      }),
    },
  );
  const resolvedVoteAttemptBody = await resolvedVoteAttempt.json();

  assert(
    resolvedVoteAttempt.status === 400,
    "resolved request must reject additional votes",
  );
  assert(
    resolvedVoteAttemptBody.errorCode === "REQUEST_ALREADY_RESOLVED",
    "resolved request vote error code mismatch",
  );

  const lockedState = await callWorker(env, "GET", "/users/A/state", {
    headers: authorizedHeaders("extension", "group-1", extensionSession),
  });
  const lockedStateBody = await lockedState.json();

  assert(lockedState.status === 200, "locked state lookup must succeed");
  assert(lockedStateBody.data.state === "LOCKED", "final user state mismatch");

  await runDiscordInteractionFlowTest();
  await runLocalIntegrationFlowTest();

  console.log("worker tests passed");
};

const createTestEnv = (): WorkerEnv => {
  const env = {
    ALLOWED_ORIGINS: "*",
    ADMIN_API_TOKEN: "admin-token",
    DISCORD_API_TOKEN: "discord-token",
    DISCORD_API_BASE_URL: "https://discord.test/api/v10",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_OAUTH_REDIRECT_URI: "https://worker.test/auth/discord/callback",
  } as WorkerEnv;

  env.GROUP_DO = new MemoryGroupDurableObjectNamespace(env);
  env.AUTH_DO = new MemoryAuthDurableObjectNamespace(env);
  env.GROUP_REGISTRY_DO = new MemoryGroupRegistryDurableObjectNamespace();

  return env;
};

const runDiscordInteractionFlowTest = async (): Promise<void> => {
  const env = createTestEnv();
  await createGroup(env, "group-1", ["A", "B", "C"]);
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "Ed25519",
    },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  env.DISCORD_PUBLIC_KEY = bytesToHex(publicKeyBytes);

  const originalFetch = globalThis.fetch;
  const outboundRequests: Array<{ url: string; body: string }> = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    outboundRequests.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : "",
    });

    return new Response(null, { status: 200 });
  };

  try {
    const slashResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "interaction-1",
      application_id: "app-1",
      type: 2,
      token: "interaction-token-1",
      member: {
        user: { id: "A" },
      },
      data: {
        id: "cmd-1",
        name: "unlock",
        options: [{ name: "user", type: 6, value: "A" }],
      },
    });
    const slashBody = await slashResponse.json();

    assert(
      slashResponse.status === 200 && slashBody.data.flags === 64,
      "same-direction command must be blocked",
    );

    const createLockResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "interaction-2",
      application_id: "app-1",
      type: 2,
      token: "interaction-token-2",
      member: {
        user: { id: "A" },
      },
      data: {
        id: "cmd-2",
        name: "lock",
        options: [{ name: "user", type: 6, value: "B" }],
      },
    });
    const createLockBody = await createLockResponse.json();
    const approveButton = createLockBody.data.components[0].components[0];
    const rejectButton = createLockBody.data.components[0].components[1];

    assert(createLockResponse.status === 200, "discord lock command must succeed");
    assert(
      approveButton.custom_id && rejectButton.custom_id,
      "vote buttons must be present",
    );

    const targetVoteResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "interaction-3",
      application_id: "app-1",
      type: 3,
      token: "interaction-token-3",
      member: {
        user: { id: "B" },
      },
      data: {
        custom_id: approveButton.custom_id,
        component_type: 2,
      },
    });
    const targetVoteBody = await targetVoteResponse.json();

    assert(
      targetVoteResponse.status === 200 &&
        targetVoteBody.data.content.includes("투표할 수 없습니다"),
      "target user vote must be rejected",
    );

    const firstVoteResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "interaction-4",
      application_id: "app-1",
      type: 3,
      token: "interaction-token-4",
      member: {
        user: { id: "A" },
      },
      data: {
        custom_id: approveButton.custom_id,
        component_type: 2,
      },
    });
    const firstVoteBody = await firstVoteResponse.json();

    assert(firstVoteResponse.status === 200 && firstVoteBody.type === 6, "first vote must defer update");

    const duplicateVoteResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "interaction-5",
      application_id: "app-1",
      type: 3,
      token: "interaction-token-5",
      member: {
        user: { id: "A" },
      },
      data: {
        custom_id: rejectButton.custom_id,
        component_type: 2,
      },
    });
    const duplicateVoteBody = await duplicateVoteResponse.json();

    assert(
      duplicateVoteResponse.status === 200 &&
        duplicateVoteBody.data.content.includes("이미 이 요청에 투표했습니다"),
      "duplicate vote must be rejected",
    );

    const secondVoteResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "interaction-6",
      application_id: "app-1",
      type: 3,
      token: "interaction-token-6",
      member: {
        user: { id: "C" },
      },
      data: {
        custom_id: approveButton.custom_id,
        component_type: 2,
      },
    });
    const secondVoteBody = await secondVoteResponse.json();

    assert(secondVoteResponse.status === 200 && secondVoteBody.type === 6, "second vote must defer update");

    await Promise.resolve();
    await Promise.resolve();

    const finalPatch = outboundRequests[outboundRequests.length - 1];
    const finalPatchBody = JSON.parse(finalPatch.body) as {
      content: string;
      components: Array<{ components: Array<{ disabled?: boolean }> }>;
    };

    assert(finalPatch.url.includes("/messages/@original"), "final message patch must call Discord API");
    assert(
      finalPatchBody.content.includes("종료되었습니다"),
      "final message must be resolved",
    );
    assert(
      finalPatchBody.components[0].components.every((component) => component.disabled === true),
      "resolved message buttons must be disabled",
    );

    const resolvedVoteResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "interaction-7",
      application_id: "app-1",
      type: 3,
      token: "interaction-token-7",
      member: {
        user: { id: "A" },
      },
      data: {
        custom_id: approveButton.custom_id,
        component_type: 2,
      },
    });
    const resolvedVoteBody = await resolvedVoteResponse.json();

    assert(
      resolvedVoteResponse.status === 200 &&
        resolvedVoteBody.data.content.includes("이미 종료된 요청입니다"),
      "resolved request vote must be rejected",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const runPublicOAuthFlowTest = async (): Promise<void> => {
  const env = createTestEnv();
  const originalFetch = globalThis.fetch;
  const discordUserId = "oauth-user";

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/oauth2/token")) {
      return Response.json({ access_token: "oauth-access-token" });
    }

    if (url.includes("/users/@me")) {
      return Response.json({ id: discordUserId });
    }

    return new Response(null, { status: 404 });
  };

  try {
    const start = await callWorker(env, "POST", "/auth/discord/start");
    const startBody = await start.json();
    const authRequestId = startBody.data.authRequestId as string;

    assert(start.status === 200, "oauth start must succeed");
    assert(startBody.data.authUrl.includes("state="), "oauth start must include state");

    const pending = await callWorker(env, "GET", `/auth/discord/pending/${authRequestId}`);
    const pendingBody = await pending.json();

    assert(
      pending.status === 200 && pendingBody.data.status === "PENDING",
      "oauth pending must be pending before callback",
    );

    const callbackUrl = new URL(startBody.data.authUrl);
    const state = callbackUrl.searchParams.get("state");

    if (!state) {
      throw new Error("OAuth state was missing.");
    }

    const callback = await callWorker(
      env,
      "GET",
      `/auth/discord/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    );

    assert(callback.status === 200, "oauth callback must succeed");

    const completed = await callWorker(env, "GET", `/auth/discord/pending/${authRequestId}`);
    const completedBody = await completed.json();

    assert(
      completed.status === 200 &&
        completedBody.data.status === "COMPLETED" &&
        completedBody.data.mapping.discordUserId === discordUserId,
      "oauth pending must complete with mapping",
    );

    const sessionToken = completedBody.data.mapping.sessionToken as string;
    const session = await callWorker(env, "GET", "/auth/session", {
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    });
    const sessionBody = await session.json();

    assert(
      session.status === 200 && sessionBody.data.discordUserId === discordUserId,
      "session verification must return mapped discord user",
    );

    const logout = await callWorker(env, "POST", "/auth/logout", {
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    });

    assert(logout.status === 200, "logout must succeed");

    const afterLogout = await callWorker(env, "GET", "/auth/session", {
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    });

    assert(afterLogout.status === 401, "revoked session must fail verification");
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const runLocalIntegrationFlowTest = async (): Promise<void> => {
  const env = createTestEnv();
  await createGroup(env, "group-1", ["A", "B", "C"]);
  const extensionSession = await createExtensionSession(env, "A");
  const extension = createLocalExtensionHarness(
    env,
    "group-1",
    "A",
    extensionSession,
  );
  const initialState = await extension.sync();

  assert(
    initialState?.state === "UNLOCKED",
    "extension initial sync must read UNLOCKED for new user",
  );

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "Ed25519",
    },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  env.DISCORD_PUBLIC_KEY = bytesToHex(publicKeyBytes);

  const originalFetch = globalThis.fetch;
  const outboundRequests: Array<{ url: string; body: string }> = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    outboundRequests.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : "",
    });

    return new Response(null, { status: 200 });
  };

  try {
    const createLockResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "local-flow-1",
      application_id: "app-1",
      type: 2,
      token: "local-flow-token-1",
      member: {
        user: { id: "B" },
      },
      data: {
        id: "cmd-lock-a",
        name: "lock",
        options: [{ name: "user", type: 6, value: "A" }],
      },
    });
    const createLockBody = await createLockResponse.json();

    assert(createLockResponse.status === 200, "discord lock request must be created");
    assert(
      createLockBody.data.content.includes("잠금 요청이 <@A> 대상에 대해 열려 있습니다."),
      "discord create message must describe the open lock request",
    );

    const lockApproveButton = createLockBody.data.components[0].components[0];

    const approveByC = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "local-flow-2",
      application_id: "app-1",
      type: 3,
      token: "local-flow-token-2",
      member: {
        user: { id: "C" },
      },
      data: {
        custom_id: lockApproveButton.custom_id,
        component_type: 2,
      },
    });
    const approveByCBody = await approveByC.json();

    assert(
      approveByC.status === 200 && approveByCBody.type === 6,
      "first lock vote must defer the Discord message update",
    );

    await Promise.resolve();
    await Promise.resolve();

    const firstPatch = JSON.parse(outboundRequests[0]?.body ?? "{}") as {
      content?: string;
      components?: Array<{ components: Array<{ disabled?: boolean }> }>;
    };

    assert(
      firstPatch.content?.includes("승인 1, 거절 0."),
      "first lock vote must update the Discord message with live counts",
    );

    const approveByB = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "local-flow-3",
      application_id: "app-1",
      type: 3,
      token: "local-flow-token-3",
      member: {
        user: { id: "B" },
      },
      data: {
        custom_id: lockApproveButton.custom_id,
        component_type: 2,
      },
    });
    const approveByBBody = await approveByB.json();

    assert(
      approveByB.status === 200 && approveByBBody.type === 6,
      "second lock vote must defer the Discord message update",
    );

    const staleExtensionDecision = extension.getBlockingDecision("/shorts/locked");

    assert(
      !staleExtensionDecision.shouldRedirect,
      "extension must keep the stale UNLOCKED cache until the next sync",
    );

    await Promise.resolve();
    await Promise.resolve();

    const lockedState = await getUserStateForTest(env, "group-1", "A", extensionSession);

    assert(
      lockedState === "LOCKED",
      "two approve votes must lock the target user through Worker and Durable Object state",
    );

    const resolvedLockPatch = JSON.parse(
      outboundRequests[outboundRequests.length - 1]?.body ?? "{}",
    ) as {
      content?: string;
      components?: Array<{ components: Array<{ disabled?: boolean }> }>;
    };

    assert(
      resolvedLockPatch.content?.includes("최종 상태: LOCKED."),
      "resolved lock request must publish the final LOCKED result",
    );
    assert(
      resolvedLockPatch.components?.[0]?.components.every(
        (component) => component.disabled === true,
      ),
      "resolved lock request must disable all Discord vote buttons",
    );

    const syncedLockedState = await extension.sync();

    assert(
      syncedLockedState?.state === "LOCKED",
      "extension sync must eventually observe the Worker LOCKED state",
    );

    const blockedShortsDecision = extension.getBlockingDecision("/shorts/locked");

    assert(
      blockedShortsDecision.shouldRedirect,
      "extension must block direct /shorts/ access after the LOCKED sync",
    );

    const createUnlockResponse = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "local-flow-4",
      application_id: "app-1",
      type: 2,
      token: "local-flow-token-4",
      member: {
        user: { id: "B" },
      },
      data: {
        id: "cmd-unlock-a",
        name: "unlock",
        options: [{ name: "user", type: 6, value: "A" }],
      },
    });
    const createUnlockBody = await createUnlockResponse.json();

    assert(createUnlockResponse.status === 200, "discord unlock request must be created");
    assert(
      createUnlockBody.data.content.includes("잠금 해제 요청이 <@A> 대상에 대해 열려 있습니다."),
      "discord create message must describe the open unlock request",
    );

    const unlockApproveButton = createUnlockBody.data.components[0].components[0];
    const unlockRejectButton = createUnlockBody.data.components[0].components[1];

    const [unlockApproveByB, unlockRejectByC] = await Promise.all([
      callSignedDiscordInteraction(env, keyPair.privateKey, {
        id: "local-flow-5",
        application_id: "app-1",
        type: 3,
        token: "local-flow-token-5",
        member: {
          user: { id: "B" },
        },
        data: {
          custom_id: unlockApproveButton.custom_id,
          component_type: 2,
        },
      }),
      callSignedDiscordInteraction(env, keyPair.privateKey, {
        id: "local-flow-6",
        application_id: "app-1",
        type: 3,
        token: "local-flow-token-6",
        member: {
          user: { id: "C" },
        },
        data: {
          custom_id: unlockRejectButton.custom_id,
          component_type: 2,
        },
      }),
    ]);
    const unlockApproveByBBody = await unlockApproveByB.json();
    const unlockRejectByCBody = await unlockRejectByC.json();

    assert(
      unlockApproveByB.status === 200 && unlockApproveByBBody.type === 6,
      "concurrent unlock approve vote must succeed",
    );
    assert(
      unlockRejectByC.status === 200 && unlockRejectByCBody.type === 6,
      "concurrent unlock reject vote must succeed",
    );

    await Promise.resolve();
    await Promise.resolve();

    const unlockRequestId = getRequestIdFromButtonCustomId(unlockApproveButton.custom_id);
    const unlockRequest = await getRequestForTest(env, "group-1", unlockRequestId);

    assert(
      unlockRequest.status === "RESOLVED" && unlockRequest.votes.length === 2,
      "concurrent unlock votes must resolve exactly once with two stored votes",
    );

    const approveVotes = unlockRequest.votes.filter((vote) => vote.choice === "APPROVE").length;
    const rejectVotes = unlockRequest.votes.filter((vote) => vote.choice === "REJECT").length;

    assert(
      approveVotes === 1 && rejectVotes === 1,
      "unlock request must record the expected 1 approve / 1 reject tie",
    );

    const finalStateAfterTie = await getUserStateForTest(env, "group-1", "A", extensionSession);

    assert(
      finalStateAfterTie === "LOCKED",
      "1:1 unlock vote tie must keep the current LOCKED state",
    );

    const resolvedUnlockVote = await callSignedDiscordInteraction(env, keyPair.privateKey, {
      id: "local-flow-7",
      application_id: "app-1",
      type: 3,
      token: "local-flow-token-7",
      member: {
        user: { id: "B" },
      },
      data: {
        custom_id: unlockApproveButton.custom_id,
        component_type: 2,
      },
    });
    const resolvedUnlockVoteBody = await resolvedUnlockVote.json();

    assert(
      resolvedUnlockVote.status === 200 &&
        resolvedUnlockVoteBody.data.content.includes("이미 종료된 요청입니다"),
      "resolved unlock request must reject further Discord button processing",
    );

    const resolvedUnlockPatch = JSON.parse(
      outboundRequests[outboundRequests.length - 1]?.body ?? "{}",
    ) as {
      content?: string;
      components?: Array<{ components: Array<{ disabled?: boolean }> }>;
    };

    assert(
      resolvedUnlockPatch.content?.includes("최종 상태: LOCKED."),
      "tie resolution must publish the unchanged LOCKED final state",
    );
    assert(
      resolvedUnlockPatch.components?.[0]?.components.every(
        (component) => component.disabled === true,
      ),
      "resolved tie request must disable Discord vote buttons",
    );

    const syncedTieState = await extension.sync();

    assert(
      syncedTieState?.state === "LOCKED",
      "extension sync after tie must keep the LOCKED state from Worker",
    );
    assert(
      extension.getBlockingDecision("/shorts/tie").shouldRedirect,
      "extension must keep blocking Shorts after the tie preserves LOCKED state",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const runDiscordGroupCreationFlowTest = async (): Promise<void> => {
  const env = createTestEnv();
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "Ed25519",
    },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  env.DISCORD_PUBLIC_KEY = bytesToHex(publicKeyBytes);

  const response = await callSignedDiscordInteraction(env, keyPair.privateKey, {
    id: "group-create-interaction",
    application_id: "app-1",
    type: 2,
    token: "group-create-token",
    guild_id: "group-1",
    member: {
      user: { id: "ADMIN" },
    },
    data: {
      id: "cmd-group-create",
      name: "group-create",
      options: [
        { name: "user1", type: 6, value: "A" },
        { name: "user2", type: 6, value: "B" },
        { name: "user3", type: 6, value: "C" },
      ],
    },
  });

  const body = await response.json();

  assert(response.status === 200, "discord group-create command must succeed");
  assert(
    body.data.content.includes("그룹 group-1가"),
    "discord group-create command must confirm the created group",
  );

  const groupResponse = await callWorker(env, "GET", "/groups/group-1");
  const groupBody = await groupResponse.json();

  assert(groupResponse.status === 200, "created group must be retrievable");
  assert(
    groupBody.data.group.members.length === 3,
    "created group must contain exactly 3 members",
  );
};

const runDiscordCommandRegistrationTest = async (): Promise<void> => {
  const env = createTestEnv();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string }> = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });

    return Response.json([
      { id: "cmd-1" },
      { id: "cmd-2" },
      { id: "cmd-3" },
    ]);
  };

  try {
    const response = await callWorker(env, "POST", "/admin/discord/commands/register", {
      headers: {
        authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
        "content-type": "application/json",
      },
    });
    const body = await response.json();

    assert(response.status === 200, "discord command registration must succeed");
    assert(body.data.registered === 3, "three global commands must be registered");
    assert(
      body.data.commands.includes("group-create") &&
        body.data.commands.includes("lock") &&
        body.data.commands.includes("unlock"),
      "registered command names must match the expected global commands",
    );

    const registrationRequest = requests.find((entry) =>
      entry.url.includes("/applications/client-id/commands"),
    );

    assert(registrationRequest !== undefined, "discord registration request must be issued");
    assert(registrationRequest?.method === "PUT", "discord registration must use PUT");

    const payload = JSON.parse(registrationRequest?.body ?? "[]") as Array<{
      name: string;
      options?: Array<{ name: string; type: number; required?: boolean }>;
    }>;

    assert(payload.length === 3, "discord global registration payload must contain three commands");
    assert(
      payload[0]?.name === "group-create" &&
        payload[0]?.options?.length === 3 &&
        payload[0]?.options?.every((option) => option.type === 6 && option.required === true),
      "group-create command payload must define three required user options",
    );
    assert(
      payload[1]?.name === "lock" &&
        payload[1]?.options?.[0]?.name === "user" &&
        payload[1]?.options?.[0]?.type === 6 &&
        payload[1]?.options?.[0]?.required === true,
      "lock command payload must define one required user option",
    );
    assert(
      payload[2]?.name === "unlock" &&
        payload[2]?.options?.[0]?.name === "user" &&
        payload[2]?.options?.[0]?.type === 6 &&
        payload[2]?.options?.[0]?.required === true,
      "unlock command payload must define one required user option",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const createGroup = async (
  env: WorkerEnv,
  groupId: string,
  memberIds: [string, string, string],
): Promise<void> => {
  const response = await callWorker(env, "POST", "/admin/groups", {
    headers: {
      authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      groupId,
      memberIds,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to create test group.");
  }
};

const runGroupDeleteTest = async (env: WorkerEnv): Promise<void> => {
  await createGroup(env, "group-delete", ["D", "E", "F"]);
  const extensionSession = await createExtensionSession(env, "A");
  const deleteResponse = await callWorker(env, "DELETE", "/admin/groups/group-delete", {
    headers: {
      authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
    },
  });
  const deleteBody = await deleteResponse.json();

  assert(deleteResponse.status === 200, "group delete must succeed");
  assert(deleteBody.data.deleted === true, "group delete must report deleted true");
  assert(deleteBody.data.groupId === "group-delete", "group delete must echo group id");

  const groupResponse = await callWorker(env, "GET", "/groups/group-delete");
  const groupBody = await groupResponse.json();

  assert(groupResponse.status === 404, "deleted group must not be retrievable");
  assert(groupBody.errorCode === "GROUP_NOT_FOUND", "deleted group lookup must fail");

  const stateResponse = await callWorker(env, "GET", "/users/A/state", {
    headers: authorizedHeaders("extension", "group-delete", extensionSession),
  });
  const stateBody = await stateResponse.json();

  assert(stateResponse.status === 404, "deleted group state must not be retrievable");
  assert(stateBody.errorCode === "GROUP_NOT_FOUND", "deleted group state lookup must fail");
};

const authorizedHeaders = (
  clientType: "extension" | "discord",
  groupId?: string,
  token?: string,
): Record<string, string> => {
  return {
    authorization: `Bearer ${token ?? `${clientType}-token`}`,
    "content-type": "application/json",
    "x-client-type": clientType,
    ...(groupId ? { "x-group-id": groupId } : {}),
  };
};

const createExtensionSession = async (
  env: WorkerEnv,
  discordUserId: string,
): Promise<string> => {
  const objectId = env.AUTH_DO.idFromName("auth");
  const stub = env.AUTH_DO.get(objectId);
  const startResponse = await stub.fetch("https://auth-do/internal/auth/discord/start", {
    method: "POST",
  });
  const startBody = (await startResponse.json()) as {
    success: true;
    data: {
      authUrl: string;
    };
  };
  const state = new URL(startBody.data.authUrl).searchParams.get("state");

  if (!state) {
    throw new Error("OAuth state token was not generated.");
  }

  const completeResponse = await stub.fetch("https://auth-do/internal/auth/discord/callback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      state,
      discordUserId,
    }),
  });
  const completeBody = (await completeResponse.json()) as {
    success: true;
    data: {
      sessionToken: string;
    };
  };

  return completeBody.data.sessionToken;
};

const createLocalExtensionHarness = (
  env: WorkerEnv,
  groupId: string,
  userId: string,
  sessionToken: string,
): {
  sync: () => Promise<{ state: "LOCKED" | "UNLOCKED"; syncedAt: number } | null>;
  getBlockingDecision: (pathname: string) => ReturnType<typeof decideShortsBlocking>;
} => {
  let cachedState: { state: "LOCKED" | "UNLOCKED"; syncedAt: number } | null = null;

  return {
    sync: async () => {
      const state = await getUserStateForTest(env, groupId, userId, sessionToken);

      cachedState = {
        state,
        syncedAt: Date.now(),
      };

      return cachedState;
    },
    getBlockingDecision: (pathname: string) =>
      decideShortsBlocking({
        state: cachedState?.state ?? null,
        pathname,
      }),
  };
};

const getUserStateForTest = async (
  env: WorkerEnv,
  groupId: string,
  userId: string,
  sessionToken: string,
): Promise<"LOCKED" | "UNLOCKED"> => {
  const response = await callWorker(env, "GET", `/users/${userId}/state`, {
    headers: authorizedHeaders("extension", groupId, sessionToken),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new Error("Failed to fetch user state for integration test.");
  }

  return body.data.state as "LOCKED" | "UNLOCKED";
};

const getRequestForTest = async (
  env: WorkerEnv,
  groupId: string,
  requestId: string,
): Promise<{
  status: string;
  votes: Array<{ voterId: string; choice: "APPROVE" | "REJECT" }>;
}> => {
  const response = await callWorker(env, "GET", `/requests/${requestId}`, {
    headers: authorizedHeaders("discord", groupId),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new Error("Failed to fetch request for integration test.");
  }

  return body.data.request as {
    status: string;
    votes: Array<{ voterId: string; choice: "APPROVE" | "REJECT" }>;
  };
};

const getRequestIdFromButtonCustomId = (customId: string): string => {
  const [, , requestId] = customId.split("|");

  if (!requestId) {
    throw new Error("Vote button custom id did not include a request id.");
  }

  return requestId;
};

const callWorker = (
  env: WorkerEnv,
  method: string,
  pathname: string,
  init?: {
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Response> => {
  return worker.fetch(
    new Request(`https://worker.test${pathname}`, {
      method,
      headers: init?.headers,
      body: init?.body,
    }),
    env,
    ctx,
  );
};

const callSignedDiscordInteraction = async (
  env: WorkerEnv,
  privateKey: CryptoKey,
  interaction: object,
): Promise<Response> => {
  const body = JSON.stringify(interaction);
  const timestamp = String(Date.now());
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(timestamp + body),
  );

  return callWorker(env, "POST", "/discord/interactions", {
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": bytesToHex(new Uint8Array(signature)),
      "x-signature-timestamp": timestamp,
    },
    body,
  });
};

const bytesToHex = (bytes: Uint8Array): string => {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

await run();

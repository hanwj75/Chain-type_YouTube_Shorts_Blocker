import worker, {
  AuthDurableObject,
  GroupDurableObject,
  GroupRegistryDurableObject,
} from "./index.js";
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
        targetVoteBody.data.content.includes("target user cannot vote"),
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
        duplicateVoteBody.data.content.includes("already voted"),
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
    assert(finalPatchBody.content.includes("resolved"), "final message must be resolved");
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
        resolvedVoteBody.data.content.includes("already resolved"),
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

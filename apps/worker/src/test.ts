import worker, { GroupDurableObject } from "./index.js";
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

class MemoryDurableObjectNamespace implements DurableObjectNamespace {
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

const ctx: ExecutionContext = {
  waitUntil() {},
};

const run = async (): Promise<void> => {
  const env = createTestEnv();

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
    headers: authorizedHeaders("extension", "group-1"),
  });
  const initialStateBody = await initialState.json();

  assert(initialState.status === 200, "initial state request must succeed");
  assert(
    initialStateBody.data.state === "UNLOCKED",
    "new user state must default to UNLOCKED",
  );

  const createdRequest = await callWorker(env, "POST", "/requests", {
    headers: authorizedHeaders("extension"),
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

  const lockedState = await callWorker(env, "GET", "/users/A/state", {
    headers: authorizedHeaders("extension", "group-1"),
  });
  const lockedStateBody = await lockedState.json();

  assert(lockedState.status === 200, "locked state lookup must succeed");
  assert(lockedStateBody.data.state === "LOCKED", "final user state mismatch");

  await runDiscordInteractionFlowTest();

  console.log("worker tests passed");
};

const createTestEnv = (): WorkerEnv => {
  const env = {
    GROUPS_JSON: JSON.stringify([
      {
        id: "group-1",
        members: ["A", "B", "C"],
      },
    ]),
    ALLOWED_ORIGINS: "*",
    EXTENSION_API_TOKEN: "extension-token",
    DISCORD_API_TOKEN: "discord-token",
    DISCORD_API_BASE_URL: "https://discord.test/api/v10",
  } as WorkerEnv;

  env.GROUP_DO = new MemoryDurableObjectNamespace(env);

  return env;
};

const runDiscordInteractionFlowTest = async (): Promise<void> => {
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

const authorizedHeaders = (
  clientType: "extension" | "discord",
  groupId?: string,
): Record<string, string> => {
  return {
    authorization: `Bearer ${clientType}-token`,
    "content-type": "application/json",
    "x-client-type": clientType,
    ...(groupId ? { "x-group-id": groupId } : {}),
  };
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

import type {
  ApiResponse,
  CastVoteBody,
  CreateGroupBody,
  CreateRequestBody,
  RequestSummary,
} from "@youtube-shorts-chain-blocker/api-contract";
import type { Group, RequestType, VoteChoice } from "@youtube-shorts-chain-blocker/domain";
import {
  castVoteInGroup,
  createInitialGroupDOState,
  createRequestInGroup,
  getActiveRequestForTarget,
  getGroupDurableObjectKey,
  getRequestById,
  getUserStateInGroup,
  type CastVoteInput,
  type CreateRequestInput,
  type GroupDOState,
  type GroupDurableObjectKey,
  type GroupStateFailure,
  type GroupStateResult,
  type GroupStateSuccess,
  type RequestResolutionKind,
  type ResolvedRequestOutcome,
  type StoredRequestRecord,
} from "./group-do-model.js";
import {
  authenticateRequest,
  exchangeDiscordOAuthCode,
  fetchDiscordUserIdentity,
} from "./auth.js";
import type { ExecutionContext, WorkerEnv } from "./cloudflare.js";
import { AuthDurableObject } from "./auth-do.js";
import { handleDiscordInteraction } from "./discord.js";
import { GroupDurableObject } from "./group-do.js";
import { GroupRegistryDurableObject } from "./group-registry-do.js";
import { buildCorsPreflightResponse, jsonError, withCors, jsonSuccess } from "./http.js";

type WorkerHandler = (
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  params: Record<string, string>,
) => Promise<Response>;

const routes: RouteDefinition[] = [
  {
    method: "GET",
    pathname: /^\/health$/,
    handler: handleHealth,
    authRequired: false,
  },
  {
    method: "POST",
    pathname: /^\/discord\/interactions$/,
    handler: handleDiscordInteractions,
    authRequired: false,
  },
  {
    method: "POST",
    pathname: /^\/auth\/discord\/start$/,
    handler: handleStartDiscordOAuth,
    authRequired: false,
  },
  {
    method: "GET",
    pathname: /^\/auth\/discord\/pending\/(?<authRequestId>[^/]+)$/,
    handler: handleGetDiscordOAuthPending,
    authRequired: false,
  },
  {
    method: "GET",
    pathname: /^\/auth\/discord\/callback$/,
    handler: handleDiscordOAuthCallback,
    authRequired: false,
  },
  {
    method: "GET",
    pathname: /^\/auth\/session$/,
    handler: handleGetSession,
    authRequired: false,
  },
  {
    method: "POST",
    pathname: /^\/auth\/logout$/,
    handler: handleLogout,
    authRequired: false,
  },
  {
    method: "GET",
    pathname: /^\/users\/(?<userId>[^/]+)\/state$/,
    handler: handleGetUserState,
  },
  {
    method: "GET",
    pathname: /^\/users\/(?<userId>[^/]+)\/group$/,
    handler: handleGetUserGroup,
    authRequired: false,
  },
  {
    method: "POST",
    pathname: /^\/requests$/,
    handler: handleCreateRequest,
  },
  {
    method: "POST",
    pathname: /^\/requests\/(?<requestId>[^/]+)\/votes$/,
    handler: handleCastVote,
  },
  {
    method: "GET",
    pathname: /^\/requests\/(?<requestId>[^/]+)$/,
    handler: handleGetRequest,
  },
  {
    method: "GET",
    pathname: /^\/groups\/(?<groupId>[^/]+)$/,
    handler: handleGetGroup,
    authRequired: false,
  },
  {
    method: "POST",
    pathname: /^\/admin\/groups$/,
    handler: handleCreateGroup,
    authRequired: false,
  },
];

const worker = {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return buildCorsPreflightResponse(request, env.ALLOWED_ORIGINS);
    }

    try {
      const matchedRoute = matchRoute(request);

      if (!matchedRoute) {
        return withCors(
          request,
          jsonError("METHOD_NOT_ALLOWED", "Route was not found.", {
            status: 404,
          }),
          env.ALLOWED_ORIGINS,
        );
      }

      if (matchedRoute.authRequired !== false) {
        const authenticatedClient = await authenticateRequest(request, env);

        if (!authenticatedClient) {
          return withCors(
            request,
            jsonError("INVALID_AUTH", "Request authentication failed.", {
              status: 401,
            }),
            env.ALLOWED_ORIGINS,
          );
        }
      }

      const response = await matchedRoute.handler(
        request,
        env,
        ctx,
        matchedRoute.params,
      );

      return withCors(request, response, env.ALLOWED_ORIGINS);
    } catch (error) {
      return withCors(
        request,
        jsonError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "Unexpected worker error.",
          { status: 500 },
        ),
        env.ALLOWED_ORIGINS,
      );
    }
  },
};

export default worker;
export { AuthDurableObject, GroupDurableObject, GroupRegistryDurableObject };
export {
  castVoteInGroup,
  createInitialGroupDOState,
  createRequestInGroup,
  getActiveRequestForTarget,
  getGroupDurableObjectKey,
  getRequestById,
  getUserStateInGroup,
  type CastVoteInput,
  type CreateRequestInput,
  type GroupDOState,
  type GroupDurableObjectKey,
  type GroupStateFailure,
  type GroupStateResult,
  type GroupStateSuccess,
  type RequestResolutionKind,
  type ResolvedRequestOutcome,
  type StoredRequestRecord,
};

type RouteDefinition = {
  method: string;
  pathname: RegExp;
  handler: WorkerHandler;
  authRequired?: boolean;
};

async function handleHealth(): Promise<Response> {
  return jsonSuccess({
    status: "ok",
  });
}

async function handleStartDiscordOAuth(
  _request: Request,
  env: WorkerEnv,
): Promise<Response> {
  return forwardToAuthDurableObject(env, "/internal/auth/discord/start", {
    method: "POST",
  });
}

async function handleGetDiscordOAuthPending(
  _request: Request,
  env: WorkerEnv,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  return forwardToAuthDurableObject(
    env,
    `/internal/auth/discord/pending/${params.authRequestId}`,
    {
      method: "GET",
    },
  );
}

async function handleDiscordOAuthCallback(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing OAuth code or state.", { status: 400 });
  }

  const token = await exchangeDiscordOAuthCode(code, env);

  if (!token) {
    return new Response("Discord OAuth token exchange failed.", { status: 401 });
  }

  const userIdentity = await fetchDiscordUserIdentity(token.accessToken);

  if (!userIdentity) {
    return new Response("Discord user verification failed.", { status: 401 });
  }

  const response = await forwardToAuthDurableObject(
    env,
    "/internal/auth/discord/callback",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        state,
        discordUserId: userIdentity.discordUserId,
      }),
    },
  );

  if (!response.ok) {
    return new Response("OAuth mapping registration failed.", { status: 401 });
  }

  return new Response(
    "<!doctype html><html><body><script>window.close();</script><p>Discord login completed. You can return to the extension.</p></body></html>",
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

async function handleGetSession(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return jsonError("AUTH_REQUIRED", "Missing session token.", {
      status: 401,
    });
  }

  return forwardToAuthDurableObject(env, "/internal/auth/session/verify", {
    method: "GET",
    headers: {
      authorization,
    },
  });
}

async function handleLogout(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return jsonError("AUTH_REQUIRED", "Missing session token.", {
      status: 401,
    });
  }

  return forwardToAuthDurableObject(env, "/internal/auth/session/logout", {
    method: "POST",
    headers: {
      authorization,
    },
  });
}

async function handleDiscordInteractions(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  return handleDiscordInteraction({
    request,
    env,
    ctx,
    createRequest: async (groupId, body) =>
      parseApiResponse<{ request: import("@youtube-shorts-chain-blocker/api-contract").RequestSummary }>(
        await forwardToGroupDurableObject(env, groupId, "/internal/requests", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            groupId,
            requesterId: body.requesterId,
            targetUserId: body.targetUserId,
            type: body.type,
          }),
        }),
      ),
    castVote: async (groupId, requestId, body) =>
      parseApiResponse<{ request: import("@youtube-shorts-chain-blocker/api-contract").RequestSummary; resultingState: string }>(
        await forwardToGroupDurableObject(env, groupId, `/internal/requests/${requestId}/votes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),
    getRequest: async (groupId, requestId) =>
      parseApiResponse<{ request: import("@youtube-shorts-chain-blocker/api-contract").RequestSummary }>(
        await forwardToGroupDurableObject(env, groupId, `/internal/requests/${requestId}`, {
          method: "GET",
        }),
      ),
    resolveGroupByUsers: async (userIds) => {
      for (const userId of userIds) {
        const response = await forwardToGroupRegistryDurableObject(
          env,
          `/internal/users/${userId}/group`,
          {
            method: "GET",
          },
        );

        if (!response.ok) {
          continue;
        }

        const payload = await parseApiResponse<{ group: Group }>(response);

        if (!payload.success) {
          continue;
        }

        const includesAllUsers = userIds.every((candidateUserId) =>
          payload.data.group.members.some((member) => member.userId === candidateUserId),
        );

        if (includesAllUsers) {
          return payload.data.group;
        }
      }

      return null;
    },
  });
}

async function handleGetUserState(
  request: Request,
  env: WorkerEnv,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  const groupId = getRequiredGroupId(request);

  if (!groupId) {
    return jsonError("GROUP_CONTEXT_REQUIRED", "Missing x-group-id header.", {
      status: 400,
    });
  }

  return forwardToGroupDurableObject(env, groupId, `/internal/users/${params.userId}/state`, {
    method: "GET",
  });
}

async function handleGetUserGroup(
  _request: Request,
  env: WorkerEnv,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  return forwardToGroupRegistryDurableObject(
    env,
    `/internal/users/${params.userId}/group`,
    {
      method: "GET",
    },
  );
}

async function handleCreateRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const body = await parseJsonBody<CreateRequestBody>(request);

  if (!body.ok) {
    return body.response;
  }

  const validationError = validateCreateRequestBody(body.value);

  if (validationError) {
    return validationError;
  }

  return forwardToGroupDurableObject(env, body.value.groupId, "/internal/requests", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body.value),
  });
}

async function handleCastVote(
  request: Request,
  env: WorkerEnv,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  const groupId = getRequiredGroupId(request);

  if (!groupId) {
    return jsonError("GROUP_CONTEXT_REQUIRED", "Missing x-group-id header.", {
      status: 400,
    });
  }

  const body = await parseJsonBody<CastVoteBody>(request);

  if (!body.ok) {
    return body.response;
  }

  const validationError = validateCastVoteBody(body.value);

  if (validationError) {
    return validationError;
  }

  return forwardToGroupDurableObject(
    env,
    groupId,
    `/internal/requests/${params.requestId}/votes`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body.value),
    },
  );
}

async function handleGetRequest(
  request: Request,
  env: WorkerEnv,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  const groupId = getRequiredGroupId(request);

  if (!groupId) {
    return jsonError("GROUP_CONTEXT_REQUIRED", "Missing x-group-id header.", {
      status: 400,
    });
  }

  return forwardToGroupDurableObject(env, groupId, `/internal/requests/${params.requestId}`, {
    method: "GET",
  });
}

async function handleGetGroup(
  _request: Request,
  env: WorkerEnv,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  return forwardToGroupRegistryDurableObject(
    env,
    `/internal/groups/${params.groupId}`,
    {
      method: "GET",
    },
  );
}

async function handleCreateGroup(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_API_TOKEN}`) {
    return jsonError("INVALID_AUTH", "Admin authentication failed.", {
      status: 401,
    });
  }

  const body = await parseJsonBody<CreateGroupBody>(request);

  if (!body.ok) {
    return body.response;
  }

  if (
    !isNonEmptyString(body.value.groupId) ||
    !Array.isArray(body.value.memberIds) ||
    body.value.memberIds.length !== 3 ||
    !body.value.memberIds.every(isNonEmptyString)
  ) {
    return jsonError("INVALID_REQUEST", "Invalid group payload.", {
      status: 400,
    });
  }

  return forwardToGroupRegistryDurableObject(env, "/internal/groups", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body.value),
  });
}

const matchRoute = (
  request: Request,
): { handler: WorkerHandler; authRequired?: boolean; params: Record<string, string> } | null => {
  const { pathname } = new URL(request.url);

  for (const route of routes) {
    if (route.method !== request.method) {
      continue;
    }

    const match = pathname.match(route.pathname);

    if (!match) {
      continue;
    }

    return {
      handler: route.handler,
      authRequired: route.authRequired,
      params: match.groups ?? {},
    };
  }

  return null;
};

const parseJsonBody = async <T>(
  request: Request,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> => {
  try {
    const body = (await request.json()) as T;

    return {
      ok: true,
      value: body,
    };
  } catch {
    return {
      ok: false,
      response: jsonError("INVALID_REQUEST", "Request body must be valid JSON.", {
        status: 400,
      }),
    };
  }
};

const parseApiResponse = async <T>(response: Response): Promise<ApiResponse<T>> => {
  return (await response.json()) as ApiResponse<T>;
};

const validateCreateRequestBody = (
  body: CreateRequestBody,
): Response | null => {
  if (
    !body ||
    !isNonEmptyString(body.groupId) ||
    !isNonEmptyString(body.requesterId) ||
    !isNonEmptyString(body.targetUserId) ||
    !isRequestType(body.type)
  ) {
    return jsonError("INVALID_REQUEST", "Invalid create request payload.", {
      status: 400,
    });
  }

  return null;
};

const validateCastVoteBody = (body: CastVoteBody): Response | null => {
  if (
    !body ||
    !isNonEmptyString(body.voterId) ||
    !isVoteChoice(body.choice)
  ) {
    return jsonError("INVALID_REQUEST", "Invalid vote payload.", {
      status: 400,
    });
  }

  return null;
};

const forwardToGroupDurableObject = async (
  env: WorkerEnv,
  groupId: string,
  pathname: string,
  init: RequestInit,
): Promise<Response> => {
  const objectId = env.GROUP_DO.idFromName(getGroupDurableObjectKey(groupId));
  const stub = env.GROUP_DO.get(objectId);

  return stub.fetch(`https://group-do${pathname}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      "x-group-id": groupId,
    },
  });
};

const forwardToAuthDurableObject = async (
  env: WorkerEnv,
  pathname: string,
  init: RequestInit,
): Promise<Response> => {
  const objectId = env.AUTH_DO.idFromName("auth");
  const stub = env.AUTH_DO.get(objectId);

  return stub.fetch(`https://auth-do${pathname}`, init);
};

const forwardToGroupRegistryDurableObject = async (
  env: WorkerEnv,
  pathname: string,
  init: RequestInit,
): Promise<Response> => {
  const objectId = env.GROUP_REGISTRY_DO.idFromName("groups");
  const stub = env.GROUP_REGISTRY_DO.get(objectId);

  return stub.fetch(`https://group-registry${pathname}`, init);
};

const getRequiredGroupId = (request: Request): string | null => {
  const groupId = request.headers.get("x-group-id");

  return isNonEmptyString(groupId) ? groupId : null;
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === "string" && value.trim() !== "";
};

const isRequestType = (value: unknown): value is RequestType => {
  return value === "LOCK_REQUEST" || value === "UNLOCK_REQUEST";
};

const isVoteChoice = (value: unknown): value is VoteChoice => {
  return value === "APPROVE" || value === "REJECT";
};

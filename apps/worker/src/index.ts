import type {
  CastVoteBody,
  CreateRequestBody,
} from "@youtube-shorts-chain-blocker/api-contract";
import type { RequestType, VoteChoice } from "@youtube-shorts-chain-blocker/domain";
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
import { authenticateRequest } from "./auth.js";
import type { ExecutionContext, WorkerEnv } from "./cloudflare.js";
import { handleDiscordInteraction } from "./discord.js";
import { GroupDurableObject } from "./group-do.js";
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
    method: "GET",
    pathname: /^\/users\/(?<userId>[^/]+)\/state$/,
    handler: handleGetUserState,
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
        const authenticatedClient = authenticateRequest(request, env);

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
export { GroupDurableObject };
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

const parseApiResponse = async <T>(response: Response): Promise<import("@youtube-shorts-chain-blocker/api-contract").ApiResponse<T>> => {
  return (await response.json()) as import("@youtube-shorts-chain-blocker/api-contract").ApiResponse<T>;
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

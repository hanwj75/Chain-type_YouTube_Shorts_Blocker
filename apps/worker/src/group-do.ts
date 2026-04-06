import type {
  CastVoteBody,
  CreateRequestBody,
  GetGroupResponse,
  GetRequestResponse,
  GetUserStateResponse,
  RequestSummary,
} from "@youtube-shorts-chain-blocker/api-contract";
import {
  castVoteInGroup,
  createInitialGroupDOState,
  createRequestInGroup,
  getRequestById,
  getUserStateInGroup,
  type GroupDOState,
  type StoredRequestRecord,
} from "./group-do-model.js";
import type { DurableObjectState, WorkerEnv } from "./cloudflare.js";
import { getConfiguredGroupById } from "./groups.js";
import { jsonError, jsonSuccess } from "./http.js";

const STORAGE_KEY = "group-do-state";

export class GroupDurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const groupId = request.headers.get("x-group-id");

    if (!groupId) {
      return jsonError("GROUP_CONTEXT_REQUIRED", "Missing x-group-id header.", {
        status: 400,
      });
    }

    if (request.method === "GET" && url.pathname === "/internal/group") {
      return this.handleGetGroup(groupId);
    }

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/internal/users/") &&
      url.pathname.endsWith("/state")
    ) {
      const userId = getLastPathSegment(url.pathname, 1);

      return this.handleGetUserState(groupId, userId);
    }

    if (request.method === "POST" && url.pathname === "/internal/requests") {
      const body = (await request.json()) as CreateRequestBody;

      return this.handleCreateRequest(groupId, body);
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/internal/requests/") &&
      url.pathname.endsWith("/votes")
    ) {
      const requestId = getLastPathSegment(url.pathname, 1);
      const body = (await request.json()) as CastVoteBody;

      return this.handleCastVote(groupId, requestId, body);
    }

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/internal/requests/")
    ) {
      const requestId = getLastPathSegment(url.pathname, 0);

      return this.handleGetRequest(groupId, requestId);
    }

    return jsonError("METHOD_NOT_ALLOWED", "Unsupported durable object route.", {
      status: 405,
    });
  }

  private async handleGetGroup(groupId: string): Promise<Response> {
    const state = await this.loadOrInitializeState(groupId);

    if (!state.ok) {
      return state.response;
    }

    const response: GetGroupResponse = {
      success: true,
      data: {
        group: state.value.group,
      },
    };

    return jsonSuccess(response.data);
  }

  private async handleGetUserState(
    groupId: string,
    userId: string,
  ): Promise<Response> {
    const state = await this.loadOrInitializeState(groupId);

    if (!state.ok) {
      return state.response;
    }

    const userState = getUserStateInGroup(state.value, userId);

    if (userState === null) {
      return jsonError("USER_NOT_FOUND", "User state was not found.", {
        status: 404,
      });
    }

    const response: GetUserStateResponse = {
      success: true,
      data: {
        userId,
        state: userState,
      },
    };

    return jsonSuccess(response.data);
  }

  private async handleCreateRequest(
    groupId: string,
    body: CreateRequestBody,
  ): Promise<Response> {
    const state = await this.loadOrInitializeState(groupId);

    if (!state.ok) {
      return state.response;
    }

    const result = createRequestInGroup(state.value, {
      requestId: crypto.randomUUID(),
      requesterId: body.requesterId,
      targetUserId: body.targetUserId,
      type: body.type,
    });

    if (!result.ok) {
      return jsonError(result.errorCode, result.message, {
        status: 400,
      });
    }

    await this.persistState(result.state);

    return jsonSuccess({
      request: toRequestSummary(result.data.request),
    });
  }

  private async handleCastVote(
    groupId: string,
    requestId: string,
    body: CastVoteBody,
  ): Promise<Response> {
    const state = await this.loadOrInitializeState(groupId);

    if (!state.ok) {
      return state.response;
    }

    const result = castVoteInGroup(state.value, {
      requestId,
      voterId: body.voterId,
      choice: body.choice,
    });

    if (!result.ok) {
      const status = result.errorCode === "REQUEST_NOT_FOUND" ? 404 : 400;

      return jsonError(result.errorCode, result.message, {
        status,
      });
    }

    await this.persistState(result.state);

    return jsonSuccess({
      request: toRequestSummary(result.data.request),
      resultingState: result.data.resultingState,
    });
  }

  private async handleGetRequest(
    groupId: string,
    requestId: string,
  ): Promise<Response> {
    const state = await this.loadOrInitializeState(groupId);

    if (!state.ok) {
      return state.response;
    }

    const request = getRequestById(state.value, requestId);

    if (!request) {
      return jsonError("REQUEST_NOT_FOUND", "Request was not found.", {
        status: 404,
      });
    }

    const response: GetRequestResponse = {
      success: true,
      data: {
        request: toRequestSummary(request),
      },
    };

    return jsonSuccess(response.data);
  }

  private async loadOrInitializeState(
    groupId: string,
  ): Promise<
    | { ok: true; value: GroupDOState }
    | { ok: false; response: Response }
  > {
    const storedState = await this.state.storage.get<GroupDOState>(STORAGE_KEY);

    if (storedState) {
      return { ok: true, value: storedState };
    }

    const group = getConfiguredGroupById(groupId, this.env.GROUPS_JSON);

    if (!group) {
      return {
        ok: false,
        response: jsonError("GROUP_NOT_FOUND", "Group was not found.", {
          status: 404,
        }),
      };
    }

    const initialState = createInitialGroupDOState(group);
    await this.persistState(initialState);

    return { ok: true, value: initialState };
  }

  private async persistState(state: GroupDOState): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, state);
  }
}

const toRequestSummary = (request: StoredRequestRecord): RequestSummary => {
  return {
    id: request.id,
    groupId: request.groupId,
    requesterId: request.requesterId,
    targetUserId: request.targetUserId,
    type: request.type,
    status: request.status,
    currentState: request.currentState,
    votes: request.votes,
  };
};

const getLastPathSegment = (pathname: string, trimTailSegments: number): string => {
  const segments = pathname.split("/").filter(Boolean);
  return segments[segments.length - 1 - trimTailSegments] ?? "";
};

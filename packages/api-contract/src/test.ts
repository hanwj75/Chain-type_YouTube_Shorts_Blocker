import type {
  ApiContract,
  ApiError,
  CreateRequestBody,
  CreateRequestResponse,
  ErrorCode,
  GetGroupResponse,
  GetHealthResponse,
} from "./index";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const healthResponse: GetHealthResponse = {
  success: true,
  data: {
    status: "ok",
  },
};

const createRequestBody: CreateRequestBody = {
  groupId: "group-1",
  requesterId: "A",
  targetUserId: "A",
  type: "LOCK_REQUEST",
};

const createRequestResponse: CreateRequestResponse = {
  success: true,
  data: {
    request: {
      id: "req-1",
      groupId: "group-1",
      requesterId: "A",
      targetUserId: "A",
      type: "LOCK_REQUEST",
      status: "OPEN",
      currentState: "UNLOCKED",
      votes: [],
    },
  },
};

const groupResponse: GetGroupResponse = {
  success: true,
  data: {
    group: {
      id: "group-1",
      members: [{ userId: "A" }, { userId: "B" }, { userId: "C" }],
    },
  },
};

const apiError: ApiError = {
  success: false,
  errorCode: "TARGET_CANNOT_VOTE",
  message: "Target user cannot vote on the request.",
};

const contract: ApiContract = {
  "/health": {
    GET: {
      response: healthResponse,
    },
  },
  "/users/:userId/state": {
    GET: {
      params: { userId: "A" },
      response: {
        success: true,
        data: {
          userId: "A",
          state: "UNLOCKED",
        },
      },
    },
  },
  "/users/:userId/group": {
    GET: {
      params: { userId: "A" },
      response: {
        success: true,
        data: {
          group: {
            id: "group-1",
            members: [{ userId: "A" }, { userId: "B" }, { userId: "C" }],
          },
        },
      },
    },
  },
  "/admin/groups": {
    POST: {
      body: {
        groupId: "group-1",
        memberIds: ["A", "B", "C"],
      },
      response: {
        success: true,
        data: {
          group: {
            id: "group-1",
            members: [{ userId: "A" }, { userId: "B" }, { userId: "C" }],
          },
        },
      },
    },
  },
  "/admin/groups/:groupId": {
    DELETE: {
      params: { groupId: "group-1" },
      response: {
        success: true,
        data: {
          groupId: "group-1",
          deleted: true,
        },
      },
    },
  },
  "/requests": {
    POST: {
      body: createRequestBody,
      response: createRequestResponse,
    },
  },
  "/requests/:requestId/votes": {
    POST: {
      params: { requestId: "req-1" },
      body: { voterId: "B", choice: "APPROVE" },
      response: {
        success: true,
        data: {
          request: createRequestResponse.data.request,
          resultingState: "UNLOCKED",
        },
      },
    },
  },
  "/requests/:requestId": {
    GET: {
      params: { requestId: "req-1" },
      response: createRequestResponse,
    },
  },
  "/groups/:groupId": {
    GET: {
      params: { groupId: "group-1" },
      response: groupResponse,
    },
  },
  "/auth/discord/start": {
    POST: {
      response: {
        success: true,
        data: {
          extensionUserId: "ext-1",
          authRequestId: "auth-1",
          authUrl: "https://discord.com/oauth2/authorize?state=state-1",
        },
      },
    },
  },
  "/auth/discord/pending/:authRequestId": {
    GET: {
      params: { authRequestId: "auth-1" },
      response: {
        success: true,
        data: {
          status: "COMPLETED",
          mapping: {
            extensionUserId: "ext-1",
            discordUserId: "discord-1",
            sessionToken: "session-1",
            expiresAt: 1,
          },
        },
      },
    },
  },
  "/auth/session": {
    GET: {
      response: {
        success: true,
        data: {
          extensionUserId: "ext-1",
          discordUserId: "discord-1",
          expiresAt: 1,
        },
      },
    },
  },
  "/auth/logout": {
    POST: {
      response: {
        success: true,
        data: {
          revoked: true,
        },
      },
    },
  },
};

const run = (): void => {
  const errorCode: ErrorCode = apiError.errorCode;

  assert(healthResponse.data.status === "ok", "health response mismatch");
  assert(createRequestBody.type === "LOCK_REQUEST", "request type mismatch");
  assert(
    createRequestResponse.data.request.status === "OPEN",
    "request response status mismatch",
  );
  assert(groupResponse.data.group.members.length === 3, "group size mismatch");
  assert(errorCode === "TARGET_CANNOT_VOTE", "error code mismatch");
  assert(contract["/health"].GET.response.success, "contract health mismatch");

  console.log("api-contract tests passed");
};

run();

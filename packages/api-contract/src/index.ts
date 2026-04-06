import type {
  Group,
  RequestStatus,
  RequestType,
  StateChangeRequest,
  UserState,
  Vote,
  VoteChoice,
} from "@youtube-shorts-chain-blocker/domain";

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_AUTH"
  | "AUTH_PENDING"
  | "SESSION_NOT_FOUND"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR"
  | "METHOD_NOT_ALLOWED"
  | "GROUP_CONTEXT_REQUIRED"
  | "INVALID_GROUP_MEMBERS"
  | "USER_ALREADY_IN_GROUP"
  | "ALREADY_LOCKED"
  | "ALREADY_UNLOCKED"
  | "ACTIVE_REQUEST_EXISTS"
  | "TARGET_CANNOT_VOTE"
  | "REQUEST_NOT_FOUND"
  | "GROUP_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "REQUEST_ALREADY_RESOLVED"
  | "DUPLICATE_VOTE"
  | "VOTER_NOT_IN_GROUP"
  | "REQUESTER_NOT_IN_GROUP"
  | "TARGET_NOT_IN_GROUP"
  | "REQUEST_GROUP_MISMATCH"
  | "INVALID_REQUEST_TYPE_FOR_STATE";

export type ApiSuccess<T> = {
  success: true;
  data: T;
};

export type ApiError = {
  success: false;
  errorCode: ErrorCode;
  message: string;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type RequestSummary = {
  id: string;
  groupId: string;
  requesterId: string;
  targetUserId: string;
  type: RequestType;
  status: RequestStatus;
  currentState: UserState;
  votes: Vote[];
};

export type UserStateView = {
  userId: string;
  state: UserState;
};

export type UserIdentityMapping = {
  extensionUserId: string;
  discordUserId: string;
  sessionToken: string;
  expiresAt: number;
};

export type OAuthStartData = {
  extensionUserId: string;
  authRequestId: string;
  authUrl: string;
};

export type OAuthPendingData = {
  status: "PENDING" | "COMPLETED";
  mapping: UserIdentityMapping | null;
};

export type SessionData = {
  extensionUserId: string;
  discordUserId: string;
  expiresAt: number;
};

export type HealthData = {
  status: "ok";
};

export type GetHealthResponse = ApiSuccess<HealthData>;

export type GetUserStateParams = {
  userId: string;
};

export type GetUserStateResponse = ApiResponse<UserStateView>;

export type CreateRequestBody = {
  groupId: string;
  requesterId: string;
  targetUserId: string;
  type: RequestType;
};

export type CreateRequestResponse = ApiResponse<{
  request: RequestSummary;
}>;

export type CastVoteParams = {
  requestId: string;
};

export type CastVoteBody = {
  voterId: string;
  choice: VoteChoice;
};

export type CastVoteResponse = ApiResponse<{
  request: RequestSummary;
  resultingState: UserState;
}>;

export type GetRequestParams = {
  requestId: string;
};

export type GetRequestResponse = ApiResponse<{
  request: RequestSummary;
}>;

export type GetGroupParams = {
  groupId: string;
};

export type GetGroupResponse = ApiResponse<{
  group: Group;
}>;

export type GetUserGroupResponse = ApiResponse<{
  group: Group;
}>;

export type CreateGroupBody = {
  groupId: string;
  memberIds: [string, string, string];
};

export type CreateGroupResponse = ApiResponse<{
  group: Group;
}>;

export type StartDiscordOAuthResponse = ApiResponse<OAuthStartData>;

export type GetDiscordOAuthPendingParams = {
  authRequestId: string;
};

export type GetDiscordOAuthPendingResponse = ApiResponse<OAuthPendingData>;

export type GetSessionResponse = ApiResponse<SessionData>;

export type LogoutResponse = ApiResponse<{
  revoked: true;
}>;

export type ApiContract = {
  "/health": {
    GET: {
      response: GetHealthResponse;
    };
  };
  "/users/:userId/state": {
    GET: {
      params: GetUserStateParams;
      response: GetUserStateResponse;
    };
  };
  "/requests": {
    POST: {
      body: CreateRequestBody;
      response: CreateRequestResponse;
    };
  };
  "/requests/:requestId/votes": {
    POST: {
      params: CastVoteParams;
      body: CastVoteBody;
      response: CastVoteResponse;
    };
  };
  "/requests/:requestId": {
    GET: {
      params: GetRequestParams;
      response: GetRequestResponse;
    };
  };
  "/groups/:groupId": {
    GET: {
      params: GetGroupParams;
      response: GetGroupResponse;
    };
  };
  "/users/:userId/group": {
    GET: {
      params: GetUserStateParams;
      response: GetUserGroupResponse;
    };
  };
  "/admin/groups": {
    POST: {
      body: CreateGroupBody;
      response: CreateGroupResponse;
    };
  };
  "/auth/discord/start": {
    POST: {
      response: StartDiscordOAuthResponse;
    };
  };
  "/auth/discord/pending/:authRequestId": {
    GET: {
      params: GetDiscordOAuthPendingParams;
      response: GetDiscordOAuthPendingResponse;
    };
  };
  "/auth/session": {
    GET: {
      response: GetSessionResponse;
    };
  };
  "/auth/logout": {
    POST: {
      response: LogoutResponse;
    };
  };
};

export type DomainStateChangeRequest = StateChangeRequest;

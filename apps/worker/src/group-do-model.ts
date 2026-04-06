import type { ErrorCode } from "@youtube-shorts-chain-blocker/api-contract";
import {
  canCreateRequest,
  canVoteOnRequest,
  countVotes,
  defaultUserState,
  resolveVoteOutcome,
  type Group,
  type RequestType,
  type StateChangeRequest,
  type UserState,
  type Vote,
  type VoteChoice,
} from "@youtube-shorts-chain-blocker/domain";

export type GroupDurableObjectKey = string;

export type RequestResolutionKind =
  | "APPROVED"
  | "REJECTED"
  | "TIE_KEEP_CURRENT_STATE";

export type ResolvedRequestOutcome = {
  requestId: string;
  targetUserId: string;
  requestType: RequestType;
  previousState: UserState;
  finalState: UserState;
  stateChanged: boolean;
  resolutionKind: RequestResolutionKind;
  approveCount: number;
  rejectCount: number;
};

export type StoredRequestRecord = StateChangeRequest & {
  resolvedOutcome: ResolvedRequestOutcome | null;
};

export type GroupDOState = {
  group: Group;
  userStates: Record<string, UserState>;
  activeRequestIdsByTargetUserId: Partial<Record<string, string>>;
  requestsById: Record<string, StoredRequestRecord>;
  resolvedOutcomesByRequestId: Record<string, ResolvedRequestOutcome>;
};

export type GroupStateSuccess<T> = {
  ok: true;
  state: GroupDOState;
  data: T;
};

export type GroupStateFailure = {
  ok: false;
  errorCode: ErrorCode;
  message: string;
};

export type GroupStateResult<T> = GroupStateSuccess<T> | GroupStateFailure;

export type CreateRequestInput = {
  requestId: string;
  requesterId: string;
  targetUserId: string;
  type: RequestType;
};

export type CastVoteInput = {
  requestId: string;
  voterId: string;
  choice: VoteChoice;
};

export const getGroupDurableObjectKey = (
  groupId: string,
): GroupDurableObjectKey => {
  return groupId;
};

export const createInitialGroupDOState = (group: Group): GroupDOState => {
  const userStates = Object.fromEntries(
    group.members.map((member) => [member.userId, defaultUserState]),
  ) as Record<string, UserState>;

  return {
    group,
    userStates,
    activeRequestIdsByTargetUserId: {},
    requestsById: {},
    resolvedOutcomesByRequestId: {},
  };
};

export const getUserStateInGroup = (
  state: GroupDOState,
  userId: string,
): UserState | null => {
  return state.userStates[userId] ?? null;
};

export const getActiveRequestForTarget = (
  state: GroupDOState,
  targetUserId: string,
): StoredRequestRecord | null => {
  const requestId = state.activeRequestIdsByTargetUserId[targetUserId];

  return requestId ? state.requestsById[requestId] ?? null : null;
};

export const getRequestById = (
  state: GroupDOState,
  requestId: string,
): StoredRequestRecord | null => {
  return state.requestsById[requestId] ?? null;
};

export const createRequestInGroup = (
  state: GroupDOState,
  input: CreateRequestInput,
): GroupStateResult<{ request: StoredRequestRecord }> => {
  const currentState = getUserStateInGroup(state, input.targetUserId);

  if (currentState === null) {
    return fail("USER_NOT_FOUND", "Target user state does not exist in group.");
  }

  const validation = canCreateRequest({
    group: state.group,
    requesterId: input.requesterId,
    targetUserId: input.targetUserId,
    requestType: input.type,
    currentState,
    activeRequests: Object.values(state.requestsById).filter(
      (request) => request.status === "OPEN",
    ),
  });

  if (!validation.ok) {
    return fail(
      mapCreateRequestErrorCode(input.type, currentState, validation.reason),
      validation.reason,
    );
  }

  const request: StoredRequestRecord = {
    id: input.requestId,
    groupId: state.group.id,
    requesterId: input.requesterId,
    targetUserId: input.targetUserId,
    type: input.type,
    status: "OPEN",
    currentState,
    votes: [],
    resolvedOutcome: null,
  };

  const nextState: GroupDOState = {
    ...state,
    activeRequestIdsByTargetUserId: {
      ...state.activeRequestIdsByTargetUserId,
      [input.targetUserId]: request.id,
    },
    requestsById: {
      ...state.requestsById,
      [request.id]: request,
    },
  };

  return {
    ok: true,
    state: nextState,
    data: { request },
  };
};

export const castVoteInGroup = (
  state: GroupDOState,
  input: CastVoteInput,
): GroupStateResult<{
  request: StoredRequestRecord;
  resultingState: UserState;
}> => {
  const existingRequest = state.requestsById[input.requestId];

  if (!existingRequest) {
    return fail("REQUEST_NOT_FOUND", "Request does not exist.");
  }

  const validation = canVoteOnRequest({
    group: state.group,
    request: existingRequest,
    voterId: input.voterId,
  });

  if (!validation.ok) {
    return fail(mapVoteErrorCode(validation.reason), validation.reason);
  }

  const votes: Vote[] = [
    ...existingRequest.votes,
    {
      voterId: input.voterId,
      choice: input.choice,
    },
  ];

  const resolution = resolveVoteOutcome({
    currentState: existingRequest.currentState,
    requestType: existingRequest.type,
    votes,
  });

  const resolvedOutcome =
    resolution.status === "RESOLVED"
      ? buildResolvedOutcome({
          request: existingRequest,
          votes,
          finalState: resolution.nextState,
        })
      : null;

  const updatedRequest: StoredRequestRecord = {
    ...existingRequest,
    votes,
    status: resolution.status,
    resolvedOutcome,
  };

  const nextUserStates =
    resolution.status === "RESOLVED"
      ? {
          ...state.userStates,
          [existingRequest.targetUserId]: resolution.nextState,
        }
      : state.userStates;

  const nextActiveRequestIdsByTargetUserId =
    resolution.status === "RESOLVED"
      ? omitTargetActiveRequest(
          state.activeRequestIdsByTargetUserId,
          existingRequest.targetUserId,
        )
      : state.activeRequestIdsByTargetUserId;

  const nextResolvedOutcomesByRequestId =
    resolvedOutcome === null
      ? state.resolvedOutcomesByRequestId
      : {
          ...state.resolvedOutcomesByRequestId,
          [existingRequest.id]: resolvedOutcome,
        };

  const nextState: GroupDOState = {
    ...state,
    userStates: nextUserStates,
    activeRequestIdsByTargetUserId: nextActiveRequestIdsByTargetUserId,
    requestsById: {
      ...state.requestsById,
      [updatedRequest.id]: updatedRequest,
    },
    resolvedOutcomesByRequestId: nextResolvedOutcomesByRequestId,
  };

  return {
    ok: true,
    state: nextState,
    data: {
      request: updatedRequest,
      resultingState: nextState.userStates[existingRequest.targetUserId],
    },
  };
};

const buildResolvedOutcome = ({
  request,
  votes,
  finalState,
}: {
  request: StoredRequestRecord;
  votes: Vote[];
  finalState: UserState;
}): ResolvedRequestOutcome => {
  const { approveCount, rejectCount } = countVotes(votes);

  return {
    requestId: request.id,
    targetUserId: request.targetUserId,
    requestType: request.type,
    previousState: request.currentState,
    finalState,
    stateChanged: request.currentState !== finalState,
    resolutionKind:
      approveCount === 1 && rejectCount === 1
        ? "TIE_KEEP_CURRENT_STATE"
        : finalState === request.currentState
          ? "REJECTED"
          : "APPROVED",
    approveCount,
    rejectCount,
  };
};

const mapCreateRequestErrorCode = (
  requestType: RequestType,
  currentState: UserState,
  reason: string,
): ErrorCode => {
  if (reason === "An open request for the target user already exists.") {
    return "ACTIVE_REQUEST_EXISTS";
  }

  if (reason === "Requester must be a member of the group.") {
    return "REQUESTER_NOT_IN_GROUP";
  }

  if (reason === "Target user must be a member of the group.") {
    return "TARGET_NOT_IN_GROUP";
  }

  if (
    reason === "Cannot create a request that matches the current state." &&
    requestType === "LOCK_REQUEST" &&
    currentState === "LOCKED"
  ) {
    return "ALREADY_LOCKED";
  }

  if (
    reason === "Cannot create a request that matches the current state." &&
    requestType === "UNLOCK_REQUEST" &&
    currentState === "UNLOCKED"
  ) {
    return "ALREADY_UNLOCKED";
  }

  return "INVALID_REQUEST_TYPE_FOR_STATE";
};

const mapVoteErrorCode = (reason: string): ErrorCode => {
  if (reason === "Target user cannot vote on the request.") {
    return "TARGET_CANNOT_VOTE";
  }

  if (reason === "A voter can vote only once per request.") {
    return "DUPLICATE_VOTE";
  }

  if (reason === "Resolved requests cannot receive votes.") {
    return "REQUEST_ALREADY_RESOLVED";
  }

  if (reason === "Voter must be a member of the group.") {
    return "VOTER_NOT_IN_GROUP";
  }

  if (reason === "Request group must match the voting group.") {
    return "REQUEST_GROUP_MISMATCH";
  }

  return "REQUEST_ALREADY_RESOLVED";
};

const omitTargetActiveRequest = (
  activeRequestIdsByTargetUserId: Partial<Record<string, string>>,
  targetUserId: string,
): Partial<Record<string, string>> => {
  const nextEntries = Object.entries(activeRequestIdsByTargetUserId).filter(
    ([userId]) => userId !== targetUserId,
  );

  return Object.fromEntries(nextEntries);
};

const fail = (errorCode: ErrorCode, message: string): GroupStateFailure => {
  return {
    ok: false,
    errorCode,
    message,
  };
};

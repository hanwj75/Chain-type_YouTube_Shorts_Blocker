import {
  canCreateGroup,
  canCreateRequest,
  canVoteOnRequest,
  defaultUserState,
  findGroupByUserId,
  GROUP_MEMBER_COUNT,
  hasOpenRequestForTarget,
  resolveStateTransition,
  resolveVoteOutcome,
  validateGroupMembers,
  type Group,
  type GroupRecord,
  type StateChangeRequest,
} from "./index.js";
import { createInitialVotes } from "./test-helpers.js";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const group: Group = {
  id: "group-1",
  members: [{ userId: "A" }, { userId: "B" }, { userId: "C" }],
};

const openRequest: StateChangeRequest = {
  id: "req-1",
  groupId: "group-1",
  requesterId: "A",
  targetUserId: "A",
  type: "LOCK_REQUEST",
  status: "OPEN",
  currentState: "UNLOCKED",
  votes: [],
};

const resolvedRequest: StateChangeRequest = {
  ...openRequest,
  id: "req-2",
  status: "RESOLVED",
  votes: createInitialVotes(),
};

const run = (): void => {
  assert(defaultUserState === "UNLOCKED", "default state must be UNLOCKED");
  assert(GROUP_MEMBER_COUNT === 3, "group member count must stay 3");
  assert(
    validateGroupMembers(["A", "B", "C"]).ok,
    "three unique users should form a valid group",
  );
  assert(
    !validateGroupMembers(["A", "A", "C"]).ok,
    "duplicate group members must be rejected",
  );

  const existingGroups: GroupRecord[] = [
    {
      id: "group-existing",
      members: [{ userId: "A" }, { userId: "B" }, { userId: "C" }],
    },
  ];

  assert(
    !canCreateGroup({
      groups: existingGroups,
      memberIds: ["A", "D", "E"],
    }).ok,
    "user must not belong to more than one active group",
  );
  assert(
    findGroupByUserId(existingGroups, "B")?.id === "group-existing",
    "user group lookup should return the containing group",
  );

  assert(
    canCreateRequest({
      group,
      requesterId: "A",
      targetUserId: "A",
      requestType: "LOCK_REQUEST",
      currentState: "UNLOCKED",
      activeRequests: [],
    }).ok,
    "lock request from unlocked state should be allowed",
  );

  assert(
    !canCreateRequest({
      group,
      requesterId: "A",
      targetUserId: "A",
      requestType: "UNLOCK_REQUEST",
      currentState: "UNLOCKED",
      activeRequests: [],
    }).ok,
    "unlock request from unlocked state should be rejected",
  );

  assert(
    hasOpenRequestForTarget([openRequest], "A"),
    "open request lookup should detect active target request",
  );

  assert(
    !canVoteOnRequest({
      group,
      request: openRequest,
      voterId: "A",
    }).ok,
    "target user must not vote",
  );

  assert(
    canVoteOnRequest({
      group,
      request: openRequest,
      voterId: "B",
    }).ok,
    "non-target group member should vote",
  );

  assert(
    !canVoteOnRequest({
      group,
      request: resolvedRequest,
      voterId: "B",
    }).ok,
    "resolved request must reject more votes",
  );

  const tieVotes = createInitialVotes();

  assert(
    resolveStateTransition({
      currentState: "UNLOCKED",
      requestType: "LOCK_REQUEST",
      votes: tieVotes,
    }) === "UNLOCKED",
    "tie must keep current state",
  );

  const approvedOutcome = resolveVoteOutcome({
    currentState: "UNLOCKED",
    requestType: "LOCK_REQUEST",
    votes: [
      { voterId: "B", choice: "APPROVE" },
      { voterId: "C", choice: "APPROVE" },
    ],
  });

  assert(approvedOutcome.status === "RESOLVED", "two votes should resolve");
  assert(
    approvedOutcome.nextState === "LOCKED",
    "approved lock request should lock target",
  );

  console.log("domain tests passed");
};

run();

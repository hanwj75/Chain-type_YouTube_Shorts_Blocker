import {
  castVoteInGroup,
  createInitialGroupDOState,
  createRequestInGroup,
  getActiveRequestForTarget,
  getGroupDurableObjectKey,
} from "./index.js";
import type { Group } from "@youtube-shorts-chain-blocker/domain";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const group: Group = {
  id: "group-1",
  members: [{ userId: "A" }, { userId: "B" }, { userId: "C" }],
};

const run = (): void => {
  const initialState = createInitialGroupDOState(group);

  assert(
    getGroupDurableObjectKey(group.id) === "group-1",
    "group DO key mismatch",
  );
  assert(initialState.userStates.A === "UNLOCKED", "default user state mismatch");

  const created = createRequestInGroup(initialState, {
    requestId: "req-1",
    requesterId: "A",
    targetUserId: "A",
    type: "LOCK_REQUEST",
  });

  assert(created.ok, "request creation should succeed");
  if (!created.ok) {
    throw new Error(created.message);
  }

  assert(
    getActiveRequestForTarget(created.state, "A")?.id === "req-1",
    "active request must be tracked by target",
  );

  const duplicate = createRequestInGroup(created.state, {
    requestId: "req-2",
    requesterId: "B",
    targetUserId: "A",
    type: "LOCK_REQUEST",
  });

  assert(
    !duplicate.ok && duplicate.errorCode === "ACTIVE_REQUEST_EXISTS",
    "duplicate active request must be rejected",
  );

  const afterFirstVote = castVoteInGroup(created.state, {
    requestId: "req-1",
    voterId: "B",
    choice: "APPROVE",
  });

  assert(afterFirstVote.ok, "first vote should succeed");
  if (!afterFirstVote.ok) {
    throw new Error(afterFirstVote.message);
  }

  assert(
    afterFirstVote.data.request.status === "OPEN",
    "request must remain open after one vote",
  );

  const afterSecondVote = castVoteInGroup(afterFirstVote.state, {
    requestId: "req-1",
    voterId: "C",
    choice: "APPROVE",
  });

  assert(afterSecondVote.ok, "second vote should succeed");
  if (!afterSecondVote.ok) {
    throw new Error(afterSecondVote.message);
  }

  assert(
    afterSecondVote.data.request.status === "RESOLVED",
    "request must resolve after two votes",
  );
  assert(
    afterSecondVote.data.resultingState === "LOCKED",
    "approved lock request must update target state",
  );
  assert(
    !getActiveRequestForTarget(afterSecondVote.state, "A"),
    "resolved request must be removed from active target map",
  );

  console.log("worker tests passed");
};

run();

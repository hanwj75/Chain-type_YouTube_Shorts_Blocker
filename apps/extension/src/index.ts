export type UserState = "LOCKED" | "UNLOCKED";
export type RequestType = "LOCK_REQUEST" | "UNLOCK_REQUEST";
export type VoteChoice = "APPROVE" | "REJECT";
export type Group = {
  id: string;
  members: Array<{ userId: string }>;
};

export const SHORTS_REDIRECT_PATH = "/feed/subscriptions";
export const ADMIN_MEMBER_IDS = ["A", "B", "C"] as const;
export const ADMIN_GROUP: Group = {
  id: "admin-local-group",
  members: ADMIN_MEMBER_IDS.map((userId) => ({ userId })) as [
    { userId: "A" },
    { userId: "B" },
    { userId: "C" },
  ],
};

export const SHORTS_HIDE_SELECTORS = [
  'a[href^="/shorts/"]',
  'a[title="Shorts"]',
  'a[aria-label="Shorts"]',
  'ytd-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
  'ytd-reel-shelf-renderer',
  'ytd-rich-shelf-renderer:has(ytd-reel-shelf-renderer)',
  'ytd-rich-section-renderer:has(ytd-reel-shelf-renderer)',
  'ytd-guide-entry-renderer:has(a[href^="/shorts/"])',
  'ytd-mini-guide-entry-renderer:has(a[href^="/shorts/"])',
  'ytm-shorts-lockup-view-model',
] as const;

export const isShortsPath = (
  pathname: string,
  search = "",
  href = "",
): boolean => {
  if (pathname.startsWith("/shorts/")) {
    return true;
  }

  if (pathname === "/watch") {
    const params = new URLSearchParams(search);
    const shortsContextParamKeys = ["shorts", "shortsui"];

    if (shortsContextParamKeys.some((key) => params.has(key))) {
      return true;
    }

    if (href.toLowerCase().includes("shorts")) {
      return true;
    }
  }

  return false;
};

export const buildShortsHideCss = (): string => {
  return `${SHORTS_HIDE_SELECTORS.join(",")} { display: none !important; }`;
};

export const shouldBlockShorts = (state: "LOCKED" | "UNLOCKED" | null): boolean => {
  return state === "LOCKED";
};

export const getRedirectTarget = (): string => {
  return SHORTS_REDIRECT_PATH;
};

export type ShortsBlockDecision = {
  shouldHideUi: boolean;
  shouldRedirect: boolean;
  redirectTarget: string | null;
};

export const decideShortsBlocking = ({
  state,
  pathname,
  search = "",
  href = "",
}: {
  state: "LOCKED" | "UNLOCKED" | null;
  pathname: string;
  search?: string;
  href?: string;
}): ShortsBlockDecision => {
  const blocked = shouldBlockShorts(state);

  if (!blocked) {
    return {
      shouldHideUi: false,
      shouldRedirect: false,
      redirectTarget: null,
    };
  }

  if (isShortsPath(pathname, search, href)) {
    return {
      shouldHideUi: true,
      shouldRedirect: true,
      redirectTarget: getRedirectTarget(),
    };
  }

  return {
    shouldHideUi: true,
    shouldRedirect: false,
    redirectTarget: null,
  };
};

export const shouldReapplyBlockingForNavigation = ({
  previousUrl,
  nextUrl,
}: {
  previousUrl: string;
  nextUrl: string;
}): boolean => {
  return previousUrl !== nextUrl;
};

export type AdminMemberId = (typeof ADMIN_MEMBER_IDS)[number];
export type AdminVoteSelection = VoteChoice | "NONE";

export type AdminSimulationInput = {
  currentState: UserState;
  requesterId: AdminMemberId;
  targetUserId: AdminMemberId;
  requestType: RequestType;
  votes: Record<AdminMemberId, AdminVoteSelection>;
};

export type AdminSimulationResult =
  | {
      ok: true;
      nextState: UserState;
      summary: string;
      appliedVotes: Array<{ voterId: AdminMemberId; choice: VoteChoice }>;
    }
  | {
      ok: false;
      message: string;
    };

export const simulateAdminRequest = (
  input: AdminSimulationInput,
): AdminSimulationResult => {
  const creation = canCreateAdminRequest(input);

  if (!creation.ok) {
    return {
      ok: false,
      message: toKoreanRuleMessage(creation.reason),
    };
  }

  if (input.votes[input.targetUserId] !== "NONE") {
    return {
      ok: false,
      message: "대상자는 투표할 수 없습니다.",
    };
  }

  const appliedVotes = ADMIN_MEMBER_IDS.flatMap((memberId) => {
    const choice = input.votes[memberId];

    if (choice === "NONE") {
      return [];
    }

    return [{ voterId: memberId, choice }];
  }).filter((vote) => vote.voterId !== input.targetUserId);

  if (appliedVotes.length !== 2) {
    return {
      ok: false,
      message: "대상자를 제외한 2명이 모두 승인 또는 거절을 선택해야 합니다.",
    };
  }

  const outcome = resolveAdminVoteOutcome({
    currentState: input.currentState,
    requestType: input.requestType,
    votes: appliedVotes,
  });

  const approveCount = appliedVotes.filter((vote) => vote.choice === "APPROVE").length;
  const rejectCount = appliedVotes.filter((vote) => vote.choice === "REJECT").length;

  return {
    ok: true,
    nextState: outcome.nextState,
    summary: `${toKoreanRequestType(input.requestType)} 완료: 승인 ${approveCount}, 거절 ${rejectCount}, 최종 상태 ${outcome.nextState}`,
    appliedVotes,
  };
};

const toKoreanRuleMessage = (reason: string): string => {
  const messages: Record<string, string> = {
    "Requester must be a member of the group.": "요청자는 그룹 멤버여야 합니다.",
    "Target user must be a member of the group.": "대상자는 그룹 멤버여야 합니다.",
    "Cannot create a request that matches the current state.":
      "현재 상태와 같은 방향의 요청은 만들 수 없습니다.",
    "An open request for the target user already exists.":
      "같은 대상에 대한 활성 요청이 이미 존재합니다.",
  };

  return messages[reason] ?? reason;
};

export const toKoreanRequestType = (requestType: RequestType): string => {
  return requestType === "LOCK_REQUEST" ? "잠금 요청" : "잠금 해제 요청";
};

const canCreateAdminRequest = (
  input: AdminSimulationInput,
): { ok: true } | { ok: false; reason: string } => {
  const memberIds = ADMIN_GROUP.members.map((member) => member.userId);

  if (!memberIds.includes(input.requesterId)) {
    return { ok: false, reason: "Requester must be a member of the group." };
  }

  if (!memberIds.includes(input.targetUserId)) {
    return { ok: false, reason: "Target user must be a member of the group." };
  }

  const requestedState =
    input.requestType === "LOCK_REQUEST" ? "LOCKED" : "UNLOCKED";

  if (requestedState === input.currentState) {
    return {
      ok: false,
      reason: "Cannot create a request that matches the current state.",
    };
  }

  return { ok: true };
};

const resolveAdminVoteOutcome = ({
  currentState,
  requestType,
  votes,
}: {
  currentState: UserState;
  requestType: RequestType;
  votes: Array<{ voterId: AdminMemberId; choice: VoteChoice }>;
}): { nextState: UserState } => {
  const approveCount = votes.filter((vote) => vote.choice === "APPROVE").length;
  const rejectCount = votes.filter((vote) => vote.choice === "REJECT").length;

  if (approveCount === 1 && rejectCount === 1) {
    return { nextState: currentState };
  }

  if (approveCount === 2) {
    return {
      nextState: requestType === "LOCK_REQUEST" ? "LOCKED" : "UNLOCKED",
    };
  }

  return { nextState: currentState };
};

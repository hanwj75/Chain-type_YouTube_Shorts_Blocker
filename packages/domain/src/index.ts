export type UserState = 'LOCKED' | 'UNLOCKED'

export type RequestType = 'LOCK_REQUEST' | 'UNLOCK_REQUEST'

export type VoteChoice = 'APPROVE' | 'REJECT'

export type RequestStatus = 'OPEN' | 'RESOLVED'

export type GroupMember = {
  userId: string
}

export type Group = {
  id: string
  members: [GroupMember, GroupMember, GroupMember]
}

export type GroupRecord = {
  id: string
  members: GroupMember[]
}

export type Vote = {
  voterId: string
  choice: VoteChoice
}

export type StateChangeRequest = {
  id: string
  groupId: string
  requesterId: string
  targetUserId: string
  type: RequestType
  status: RequestStatus
  currentState: UserState
  votes: Vote[]
}

export type ValidationResult = { ok: true } | { ok: false; reason: string }

export type VoteResolution = {
  status: RequestStatus
  nextState: UserState
  isTie: boolean
  approveCount: number
  rejectCount: number
}

export const defaultUserState: UserState = 'UNLOCKED'

export const MAX_VOTES_PER_REQUEST = 2
export const GROUP_MEMBER_COUNT = 3

export const countVotes = (
  votes: Vote[],
): { approveCount: number; rejectCount: number } => {
  return votes.reduce(
    (counts, vote) => {
      if (vote.choice === 'APPROVE') {
        return {
          ...counts,
          approveCount: counts.approveCount + 1,
        }
      }

      return {
        ...counts,
        rejectCount: counts.rejectCount + 1,
      }
    },
    { approveCount: 0, rejectCount: 0 },
  )
}

export const getRequestedState = (requestType: RequestType): UserState => {
  return requestType === 'LOCK_REQUEST' ? 'LOCKED' : 'UNLOCKED'
}

export const validateGroupMembers = (memberIds: string[]): ValidationResult => {
  const uniqueMemberIds = [...new Set(memberIds)]

  if (memberIds.length !== GROUP_MEMBER_COUNT) {
    return {
      ok: false,
      reason: 'A group must contain exactly three members.',
    }
  }

  if (uniqueMemberIds.length !== GROUP_MEMBER_COUNT) {
    return {
      ok: false,
      reason: 'A group cannot contain duplicate members.',
    }
  }

  if (uniqueMemberIds.some((memberId) => memberId.trim() === '')) {
    return {
      ok: false,
      reason: 'Group members must have non-empty user ids.',
    }
  }

  return { ok: true }
}

export const canCreateGroup = ({
  groups,
  memberIds,
}: {
  groups: GroupRecord[]
  memberIds: string[]
}): ValidationResult => {
  const memberValidation = validateGroupMembers(memberIds)

  if (!memberValidation.ok) {
    return memberValidation
  }

  const conflictingMemberId = memberIds.find((memberId) =>
    groups.some((group) =>
      group.members.some((member) => member.userId === memberId),
    ),
  )

  if (conflictingMemberId) {
    return {
      ok: false,
      reason: 'A user can belong to only one active group.',
    }
  }

  return { ok: true }
}

export const findGroupByUserId = (
  groups: GroupRecord[],
  userId: string,
): GroupRecord | null => {
  return (
    groups.find((group) =>
      group.members.some((member) => member.userId === userId),
    ) ?? null
  )
}

export const isTieVote = (votes: Vote[]): boolean => {
  const { approveCount, rejectCount } = countVotes(votes)

  return approveCount === 1 && rejectCount === 1
}

export const keepCurrentStateOnTie = (currentState: UserState): UserState => {
  return currentState
}

export const isRequestResolved = (votes: Vote[]): boolean => {
  return votes.length === MAX_VOTES_PER_REQUEST
}

export const hasOpenRequestForTarget = (
  requests: StateChangeRequest[],
  targetUserId: string,
): boolean => {
  return requests.some(
    (request) =>
      request.targetUserId === targetUserId && request.status === 'OPEN',
  )
}

export const canCreateConcurrentRequestForTarget = (
  requests: StateChangeRequest[],
  targetUserId: string,
): ValidationResult => {
  if (hasOpenRequestForTarget(requests, targetUserId)) {
    return {
      ok: false,
      reason: 'An open request for the target user already exists.',
    }
  }

  return { ok: true }
}

export const canCreateRequest = ({
  group,
  requesterId,
  targetUserId,
  requestType,
  currentState,
  activeRequests,
}: {
  group: Group
  requesterId: string
  targetUserId: string
  requestType: RequestType
  currentState: UserState
  activeRequests: StateChangeRequest[]
}): ValidationResult => {
  const memberIds = group.members.map((member) => member.userId)

  if (!memberIds.includes(requesterId)) {
    return { ok: false, reason: 'Requester must be a member of the group.' }
  }

  if (!memberIds.includes(targetUserId)) {
    return { ok: false, reason: 'Target user must be a member of the group.' }
  }

  if (getRequestedState(requestType) === currentState) {
    return {
      ok: false,
      reason: 'Cannot create a request that matches the current state.',
    }
  }

  return canCreateConcurrentRequestForTarget(activeRequests, targetUserId)
}

export const canVoteOnRequest = ({
  group,
  request,
  voterId,
}: {
  group: Group
  request: StateChangeRequest
  voterId: string
}): ValidationResult => {
  const memberIds = group.members.map((member) => member.userId)

  if (request.groupId !== group.id) {
    return { ok: false, reason: 'Request group must match the voting group.' }
  }

  if (!memberIds.includes(voterId)) {
    return { ok: false, reason: 'Voter must be a member of the group.' }
  }

  if (request.status !== 'OPEN') {
    return { ok: false, reason: 'Resolved requests cannot receive votes.' }
  }

  if (voterId === request.targetUserId) {
    return { ok: false, reason: 'Target user cannot vote on the request.' }
  }

  if (request.votes.some((vote) => vote.voterId === voterId)) {
    return { ok: false, reason: 'A voter can vote only once per request.' }
  }

  if (request.votes.length >= MAX_VOTES_PER_REQUEST) {
    return {
      ok: false,
      reason: 'A request cannot receive more than two votes.',
    }
  }

  const eligibleVoterCount = group.members.filter(
    (member) => member.userId !== request.targetUserId,
  ).length

  if (eligibleVoterCount !== MAX_VOTES_PER_REQUEST) {
    return {
      ok: false,
      reason: 'Exactly two non-target group members must be eligible to vote.',
    }
  }

  return { ok: true }
}

export const resolveStateTransition = ({
  currentState,
  requestType,
  votes,
}: {
  currentState: UserState
  requestType: RequestType
  votes: Vote[]
}): UserState => {
  const { approveCount, rejectCount } = countVotes(votes)

  if (approveCount === 1 && rejectCount === 1) {
    return keepCurrentStateOnTie(currentState)
  }

  if (approveCount === MAX_VOTES_PER_REQUEST) {
    return getRequestedState(requestType)
  }

  if (rejectCount === MAX_VOTES_PER_REQUEST) {
    return currentState
  }

  return currentState
}

export const resolveVoteOutcome = ({
  currentState,
  requestType,
  votes,
}: {
  currentState: UserState
  requestType: RequestType
  votes: Vote[]
}): VoteResolution => {
  const { approveCount, rejectCount } = countVotes(votes)
  const resolved = isRequestResolved(votes)

  return {
    status: resolved ? 'RESOLVED' : 'OPEN',
    nextState: resolved
      ? resolveStateTransition({ currentState, requestType, votes })
      : currentState,
    isTie: resolved && isTieVote(votes),
    approveCount,
    rejectCount,
  }
}

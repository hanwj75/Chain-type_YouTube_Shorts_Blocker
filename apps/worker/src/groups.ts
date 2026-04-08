import {
  canCreateGroup,
  findGroupByUserId,
  type Group,
  type GroupRecord,
  type ValidationResult,
} from "@youtube-shorts-chain-blocker/domain";

export type GroupRegistryState = {
  groupsById: Record<string, Group>;
  groupIdByUserId: Record<string, string>;
};

export const createInitialGroupRegistryState = (): GroupRegistryState => {
  return {
    groupsById: {},
    groupIdByUserId: {},
  };
};

export const listGroups = (state: GroupRegistryState): GroupRecord[] => {
  return Object.values(state.groupsById).map((group) => ({
    id: group.id,
    members: [...group.members],
  }));
};

export const createGroupInRegistry = (
  state: GroupRegistryState,
  {
    groupId,
    memberIds,
  }: {
    groupId: string
    memberIds: [string, string, string]
  },
): { ok: true; state: GroupRegistryState; group: Group } | { ok: false; reason: string } => {
  const validation = canCreateGroup({
    groups: listGroups(state),
    memberIds,
  })

  if (!validation.ok) {
    return validation
  }

  if (state.groupsById[groupId]) {
    return {
      ok: false,
      reason: 'Group id already exists.',
    }
  }

  const group: Group = {
    id: groupId,
    members: [
      { userId: memberIds[0] },
      { userId: memberIds[1] },
      { userId: memberIds[2] },
    ],
  }

  return {
    ok: true,
    group,
    state: {
      groupsById: {
        ...state.groupsById,
        [groupId]: group,
      },
      groupIdByUserId: {
        ...state.groupIdByUserId,
        [memberIds[0]]: groupId,
        [memberIds[1]]: groupId,
        [memberIds[2]]: groupId,
      },
    },
  }
}

export const deleteGroupFromRegistry = (
  state: GroupRegistryState,
  groupId: string,
): { ok: true; state: GroupRegistryState; deletedGroup: Group } | { ok: false; reason: string } => {
  const group = state.groupsById[groupId]

  if (!group) {
    return {
      ok: false,
      reason: 'Group was not found.',
    }
  }

  const nextGroupsById = { ...state.groupsById }
  delete nextGroupsById[groupId]

  const nextGroupIdByUserId = { ...state.groupIdByUserId }
  for (const member of group.members) {
    if (nextGroupIdByUserId[member.userId] === groupId) {
      delete nextGroupIdByUserId[member.userId]
    }
  }

  return {
    ok: true,
    deletedGroup: group,
    state: {
      groupsById: nextGroupsById,
      groupIdByUserId: nextGroupIdByUserId,
    },
  }
}

export const getGroupByIdFromRegistry = (
  state: GroupRegistryState,
  groupId: string,
): Group | null => {
  return state.groupsById[groupId] ?? null
}

export const getGroupByUserIdFromRegistry = (
  state: GroupRegistryState,
  userId: string,
): Group | null => {
  const groupId = state.groupIdByUserId[userId]

  return groupId ? state.groupsById[groupId] ?? null : null
}

export const validateGroupTargeting = ({
  group,
  requesterId,
  targetUserId,
}: {
  group: Group
  requesterId: string
  targetUserId: string
}): ValidationResult => {
  const requesterGroup = findGroupByUserId(
    [{ id: group.id, members: [...group.members] }],
    requesterId,
  )
  const targetGroup = findGroupByUserId(
    [{ id: group.id, members: [...group.members] }],
    targetUserId,
  )

  if (!requesterGroup || !targetGroup || requesterGroup.id !== targetGroup.id) {
    return {
      ok: false,
      reason: 'Requester and target user must belong to the same group.',
    }
  }

  return { ok: true }
}

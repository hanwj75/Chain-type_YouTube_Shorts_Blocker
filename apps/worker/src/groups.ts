import type { Group } from "@youtube-shorts-chain-blocker/domain";

type GroupConfigRecord = {
  id: string;
  members: string[];
};

export const parseConfiguredGroups = (groupsJson?: string): Group[] => {
  if (!groupsJson) {
    return [];
  }

  const parsed = JSON.parse(groupsJson) as GroupConfigRecord[];

  return parsed
    .filter((group) => group.members.length === 3)
    .map((group) => ({
      id: group.id,
      members: [
        { userId: group.members[0] },
        { userId: group.members[1] },
        { userId: group.members[2] },
      ],
    }));
};

export const getConfiguredGroupById = (
  groupId: string,
  groupsJson?: string,
): Group | null => {
  return parseConfiguredGroups(groupsJson).find((group) => group.id === groupId) ?? null;
};

export const findGroupByMemberIds = (
  groupsJson: string | undefined,
  memberIds: string[],
): Group | null => {
  const uniqueMemberIds = [...new Set(memberIds)];

  return (
    parseConfiguredGroups(groupsJson).find((group) =>
      uniqueMemberIds.every((memberId) =>
        group.members.some((member) => member.userId === memberId),
      ),
    ) ?? null
  );
};

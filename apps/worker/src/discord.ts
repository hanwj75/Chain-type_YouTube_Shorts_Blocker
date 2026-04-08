import type {
  ApiResponse,
  CreateGroupBody,
  ErrorCode,
  RequestSummary,
} from "@youtube-shorts-chain-blocker/api-contract";
import {
  resolveVoteOutcome,
  type RequestType,
  type VoteChoice,
} from "@youtube-shorts-chain-blocker/domain";
import type { ExecutionContext, WorkerEnv } from "./cloudflare.js";
import type { Group } from "@youtube-shorts-chain-blocker/domain";

export type DiscordInteraction =
  | DiscordPingInteraction
  | DiscordApplicationCommandInteraction
  | DiscordMessageComponentInteraction;

type DiscordPingInteraction = {
  id: string;
  application_id: string;
  type: 1;
  token: string;
};

type DiscordUser = {
  id: string;
  username?: string;
};

type DiscordApplicationCommandOption = {
  name: string;
  type: number;
  value?: string;
};

type DiscordApplicationCommandOptionDefinition = {
  name: string;
  description: string;
  type: number;
  required?: boolean;
};

type DiscordApplicationCommandDefinition = {
  name: string;
  description: string;
  type?: number;
  options?: DiscordApplicationCommandOptionDefinition[];
  dm_permission?: boolean;
};

type DiscordApplicationCommandData = {
  id: string;
  name: string;
  options?: DiscordApplicationCommandOption[];
};

type DiscordApplicationCommandInteraction = {
  id: string;
  application_id: string;
  type: 2;
  token: string;
  guild_id?: string;
  member?: {
    user?: DiscordUser;
  };
  user?: DiscordUser;
  data: DiscordApplicationCommandData;
};

type DiscordMessageComponentData = {
  custom_id: string;
  component_type: number;
};

type DiscordMessageComponentInteraction = {
  id: string;
  application_id: string;
  type: 3;
  token: string;
  member?: {
    user?: DiscordUser;
  };
  user?: DiscordUser;
  data: DiscordMessageComponentData;
};

type DiscordResponse = {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    components?: DiscordActionRow[];
  };
};

type DiscordActionRow = {
  type: 1;
  components: DiscordButton[];
};

type DiscordButton = {
  type: 2;
  style: number;
  label: string;
  custom_id: string;
  disabled?: boolean;
};

type VoteButtonAction = {
  kind: "vote";
  groupId: string;
  requestId: string;
  choice: VoteChoice;
};

type DiscordMessageView = {
  content: string;
  components: DiscordActionRow[];
};

export const handleDiscordInteraction = async ({
  request,
  env,
  ctx,
  createRequest,
  createGroup,
  castVote,
  getRequest,
  resolveGroupByUsers,
}: {
  request: Request;
  env: WorkerEnv;
  ctx: ExecutionContext;
  createRequest: (groupId: string, body: {
    requesterId: string;
    targetUserId: string;
    type: RequestType;
  }) => Promise<ApiResponse<{ request: RequestSummary }>>;
  createGroup: (body: CreateGroupBody) => Promise<ApiResponse<{ group: Group }>>;
  castVote: (
    groupId: string,
    requestId: string,
    body: { voterId: string; choice: VoteChoice },
  ) => Promise<ApiResponse<{ request: RequestSummary; resultingState: string }>>;
  getRequest: (
    groupId: string,
    requestId: string,
  ) => Promise<ApiResponse<{ request: RequestSummary }>>;
  resolveGroupByUsers: (userIds: string[]) => Promise<Group | null>;
}): Promise<Response> => {
  const rawBody = await request.text();
  const verified = await verifyDiscordSignature(request, rawBody, env);

  if (!verified) {
    return jsonDiscord({
      type: 4,
      data: {
        content: "디스코드 서명이 유효하지 않습니다.",
        flags: 64,
      },
    }, 401);
  }

  const interaction = JSON.parse(rawBody) as DiscordInteraction;

  if (interaction.type === 1) {
    return jsonDiscord({ type: 1 });
  }

  if (interaction.type === 2) {
    return handleApplicationCommand(
      interaction,
      createRequest,
      createGroup,
      resolveGroupByUsers,
    );
  }

  if (interaction.type === 3) {
    return handleComponentInteraction({
      interaction,
      env,
      ctx,
      castVote,
      getRequest,
    });
  }

  return jsonDiscord({
    type: 4,
    data: {
      content: "지원하지 않는 디스코드 상호작용입니다.",
      flags: 64,
    },
  }, 400);
};

const handleApplicationCommand = async (
  interaction: DiscordApplicationCommandInteraction,
  createRequest: (groupId: string, body: {
    requesterId: string;
    targetUserId: string;
    type: RequestType;
  }) => Promise<ApiResponse<{ request: RequestSummary }>>,
  createGroup: (body: CreateGroupBody) => Promise<ApiResponse<{ group: Group }>>,
  resolveGroupByUsers: (userIds: string[]) => Promise<Group | null>,
): Promise<Response> => {
  if (isCreateGroupCommand(interaction.data.name)) {
    return handleCreateGroupCommand(interaction, createGroup);
  }

  const requesterId = getInteractionUserId(interaction);
  const targetUserId = getCommandUserId(interaction.data.options);
  const requestType = mapCommandToRequestType(interaction.data.name);

  if (!requesterId || !targetUserId || !requestType) {
    return ephemeralDiscordMessage("디스코드 명령 형식이 올바르지 않습니다.");
  }

  const group = await resolveGroupByUsers([requesterId, targetUserId]);

  if (!group) {
    return ephemeralDiscordMessage("요청자와 대상자는 같은 3인 그룹에 속해야 합니다.");
  }

  const result = await createRequest(group.id, {
    requesterId,
    targetUserId,
    type: requestType,
  });

  if (!result.success) {
    return ephemeralDiscordMessage(formatErrorMessage(result.errorCode));
  }

  const message = buildRequestMessage(result.data.request);

  return jsonDiscord({
    type: 4,
    data: {
      content: message.content,
      components: message.components,
    },
  });
};

export const registerDiscordGlobalCommands = async (
  env: WorkerEnv,
): Promise<ApiResponse<{ commands: DiscordApplicationCommandDefinition[] }>> => {
  if (!env.DISCORD_API_TOKEN || !env.DISCORD_CLIENT_ID) {
    return {
      success: false,
      errorCode: "DISCORD_COMMAND_REGISTRATION_FAILED",
      message: "디스코드 앱 자격 증명이 없습니다.",
    };
  }

  const commands = buildDiscordGlobalCommands();
  const baseUrl = env.DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";
  const response = await fetch(
    `${baseUrl}/applications/${env.DISCORD_CLIENT_ID}/commands`,
    {
      method: "PUT",
      headers: {
        authorization: `Bot ${env.DISCORD_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    },
  );

  if (!response.ok) {
    return {
      success: false,
      errorCode: "DISCORD_COMMAND_REGISTRATION_FAILED",
      message: `디스코드 명령 등록에 실패했습니다. 상태 코드: ${response.status}.`,
    };
  }

  return {
    success: true,
    data: {
      commands,
    },
  };
};

const handleCreateGroupCommand = async (
  interaction: DiscordApplicationCommandInteraction,
  createGroup: (body: CreateGroupBody) => Promise<ApiResponse<{ group: Group }>>,
): Promise<Response> => {
  const guildId = interaction.guild_id;
  const memberIds = getCommandUserIds(interaction.data.options);

  if (!guildId || !memberIds) {
    return ephemeralDiscordMessage("그룹 생성 형식이 올바르지 않습니다.");
  }

  const result = await createGroup({
    groupId: guildId,
    memberIds,
  });

  if (!result.success) {
    return ephemeralDiscordMessage(formatErrorMessage(result.errorCode));
  }

  return ephemeralDiscordMessage(
    `그룹 ${result.data.group.id}가 <@${memberIds[0]}>, <@${memberIds[1]}>, <@${memberIds[2]}> 멤버로 생성되었습니다.`,
  );
};

const handleComponentInteraction = async ({
  interaction,
  env,
  ctx,
  castVote,
  getRequest,
}: {
  interaction: DiscordMessageComponentInteraction;
  env: WorkerEnv;
  ctx: ExecutionContext;
  castVote: (
    groupId: string,
    requestId: string,
    body: { voterId: string; choice: VoteChoice },
  ) => Promise<ApiResponse<{ request: RequestSummary; resultingState: string }>>;
  getRequest: (
    groupId: string,
    requestId: string,
  ) => Promise<ApiResponse<{ request: RequestSummary }>>;
}): Promise<Response> => {
  const action = parseVoteButtonCustomId(interaction.data.custom_id);
  const voterId = getInteractionUserId(interaction);

  if (!action || !voterId) {
    return ephemeralDiscordMessage("투표 동작이 올바르지 않습니다.");
  }

  const result = await castVote(action.groupId, action.requestId, {
    voterId,
    choice: action.choice,
  });

  if (result.success) {
    ctx.waitUntil(
      updateDiscordOriginalMessage(
        interaction,
        env,
        buildRequestMessage(result.data.request, result.data.resultingState),
      ),
    );

    return jsonDiscord({ type: 6 });
  }

  if (result.errorCode === "REQUEST_ALREADY_RESOLVED") {
    const requestResult = await getRequest(action.groupId, action.requestId);

    if (requestResult.success) {
      ctx.waitUntil(
        updateDiscordOriginalMessage(
          interaction,
          env,
          buildRequestMessage(
            requestResult.data.request,
            requestResult.data.request.currentState,
          ),
        ),
      );
    }
  }

  return ephemeralDiscordMessage(formatErrorMessage(result.errorCode));
};

const buildRequestMessage = (
  request: RequestSummary,
  resultingState?: string,
): DiscordMessageView => {
  const approveCount = request.votes.filter((vote) => vote.choice === "APPROVE").length;
  const rejectCount = request.votes.filter((vote) => vote.choice === "REJECT").length;
  const resolved = request.status === "RESOLVED";
  const finalState =
    resultingState ??
    resolveVoteOutcome({
      currentState: request.currentState,
      requestType: request.type,
      votes: request.votes,
    }).nextState;
  const content = resolved
    ? `${requestTypeLabel(request.type)} 요청이 <@${request.targetUserId}> 대상에 대해 종료되었습니다. 최종 상태: ${finalState}. 승인 ${approveCount}, 거절 ${rejectCount}.`
    : `${requestTypeLabel(request.type)} 요청이 <@${request.targetUserId}> 대상에 대해 열려 있습니다. 승인 ${approveCount}, 거절 ${rejectCount}.`;

  return {
    content,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "승인",
            custom_id: serializeVoteButtonCustomId({
              kind: "vote",
              groupId: request.groupId,
              requestId: request.id,
              choice: "APPROVE",
            }),
            disabled: resolved,
          },
          {
            type: 2,
            style: 4,
            label: "거절",
            custom_id: serializeVoteButtonCustomId({
              kind: "vote",
              groupId: request.groupId,
              requestId: request.id,
              choice: "REJECT",
            }),
            disabled: resolved,
          },
        ],
      },
    ],
  };
};

const serializeVoteButtonCustomId = (action: VoteButtonAction): string => {
  return [
    action.kind,
    action.groupId,
    action.requestId,
    action.choice,
  ].join("|");
};

const parseVoteButtonCustomId = (customId: string): VoteButtonAction | null => {
  const [kind, groupId, requestId, choice] = customId.split("|");

  if (
    kind !== "vote" ||
    !groupId ||
    !requestId ||
    (choice !== "APPROVE" && choice !== "REJECT")
  ) {
    return null;
  }

  return {
    kind: "vote",
    groupId,
    requestId,
    choice,
  };
};

const getInteractionUserId = (
  interaction: DiscordApplicationCommandInteraction | DiscordMessageComponentInteraction,
): string | null => {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
};

const getCommandUserId = (
  options: DiscordApplicationCommandOption[] | undefined,
): string | null => {
  const targetOption = options?.find((option) => option.name === "user");

  return typeof targetOption?.value === "string" ? targetOption.value : null;
};

const getCommandUserIds = (
  options: DiscordApplicationCommandOption[] | undefined,
): [string, string, string] | null => {
  const userIds = (options ?? [])
    .map((option) => (typeof option.value === "string" ? option.value : null))
    .filter((value): value is string => Boolean(value));

  const uniqueUserIds = [...new Set(userIds)];

  if (uniqueUserIds.length !== 3) {
    return null;
  }

  return [uniqueUserIds[0], uniqueUserIds[1], uniqueUserIds[2]];
};

const isCreateGroupCommand = (commandName: string): boolean => {
  return commandName === "group" || commandName === "group-create" || commandName === "create-group";
};

const buildDiscordGlobalCommands = (): DiscordApplicationCommandDefinition[] => {
    return [
    {
      name: "group-create",
      description: "3인 그룹을 생성합니다.",
      options: [
        {
          name: "user1",
          description: "첫 번째 그룹 멤버입니다.",
          type: 6,
          required: true,
        },
        {
          name: "user2",
          description: "두 번째 그룹 멤버입니다.",
          type: 6,
          required: true,
        },
        {
          name: "user3",
          description: "세 번째 그룹 멤버입니다.",
          type: 6,
          required: true,
        },
      ],
    },
    {
      name: "lock",
      description: "대상 사용자에 대한 잠금 요청을 생성합니다.",
      options: [
        {
          name: "user",
          description: "대상 사용자입니다.",
          type: 6,
          required: true,
        },
      ],
    },
    {
      name: "unlock",
      description: "대상 사용자에 대한 잠금 해제 요청을 생성합니다.",
      options: [
        {
          name: "user",
          description: "대상 사용자입니다.",
          type: 6,
          required: true,
        },
      ],
    },
  ];
};

const mapCommandToRequestType = (commandName: string): RequestType | null => {
  if (commandName === "lock") {
    return "LOCK_REQUEST";
  }

  if (commandName === "unlock") {
    return "UNLOCK_REQUEST";
  }

  return null;
};

const formatErrorMessage = (errorCode: ErrorCode): string => {
  const messages: Record<ErrorCode, string> = {
    AUTH_REQUIRED: "인증이 필요합니다.",
    INVALID_AUTH: "인증에 실패했습니다.",
    AUTH_PENDING: "인증이 아직 진행 중입니다.",
    SESSION_NOT_FOUND: "세션을 찾을 수 없습니다.",
    INVALID_REQUEST: "요청 형식이 올바르지 않습니다.",
    INTERNAL_ERROR: "내부 오류가 발생했습니다.",
    METHOD_NOT_ALLOWED: "허용되지 않은 메서드입니다.",
    GROUP_CONTEXT_REQUIRED: "그룹 정보가 필요합니다.",
    INVALID_GROUP_MEMBERS: "그룹 멤버 구성이 올바르지 않습니다.",
    USER_ALREADY_IN_GROUP: "이미 다른 그룹에 속한 사용자입니다.",
    ALREADY_LOCKED: "대상 사용자는 이미 잠금 상태입니다.",
    ALREADY_UNLOCKED: "대상 사용자는 이미 해제 상태입니다.",
    ACTIVE_REQUEST_EXISTS: "대상 사용자에 대한 활성 요청이 이미 존재합니다.",
    TARGET_CANNOT_VOTE: "대상 사용자는 이 요청에 투표할 수 없습니다.",
    REQUEST_NOT_FOUND: "요청을 찾을 수 없습니다.",
    GROUP_NOT_FOUND: "그룹을 찾을 수 없습니다.",
    USER_NOT_FOUND: "사용자를 찾을 수 없습니다.",
    REQUEST_ALREADY_RESOLVED: "이미 종료된 요청입니다.",
    DUPLICATE_VOTE: "이미 이 요청에 투표했습니다.",
    VOTER_NOT_IN_GROUP: "그룹 멤버만 투표할 수 있습니다.",
    REQUESTER_NOT_IN_GROUP: "요청자가 그룹 멤버가 아닙니다.",
    TARGET_NOT_IN_GROUP: "대상 사용자가 그룹 멤버가 아닙니다.",
    REQUEST_GROUP_MISMATCH: "요청 그룹이 일치하지 않습니다.",
    INVALID_REQUEST_TYPE_FOR_STATE: "현재 상태에서는 이 방향의 요청을 사용할 수 없습니다.",
    GROUP_ALREADY_EXISTS: "이 서버에는 이미 그룹이 존재합니다.",
    DISCORD_COMMAND_REGISTRATION_FAILED: "디스코드 명령 등록에 실패했습니다.",
  };

  return messages[errorCode];
};

const requestTypeLabel = (requestType: RequestType): string => {
  return requestType === "LOCK_REQUEST" ? "잠금" : "잠금 해제";
};

const ephemeralDiscordMessage = (content: string): Response => {
  return jsonDiscord({
    type: 4,
    data: {
      content,
      flags: 64,
    },
  });
};

const jsonDiscord = (body: DiscordResponse, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
};

const verifyDiscordSignature = async (
  request: Request,
  rawBody: string,
  env: WorkerEnv,
): Promise<boolean> => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");

  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
    return false;
  }

  const publicKey = await crypto.subtle.importKey(
    "raw",
    hexToArrayBuffer(env.DISCORD_PUBLIC_KEY),
    {
      name: "Ed25519",
    },
    false,
    ["verify"],
  );

  return crypto.subtle.verify(
    "Ed25519",
    publicKey,
    hexToArrayBuffer(signature),
    new TextEncoder().encode(timestamp + rawBody),
  );
};

const hexToArrayBuffer = (hex: string): ArrayBuffer => {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string.");
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes.buffer.slice(0);
};

const updateDiscordOriginalMessage = async (
  interaction: DiscordApplicationCommandInteraction | DiscordMessageComponentInteraction,
  env: WorkerEnv,
  message: DiscordMessageView,
): Promise<void> => {
  const baseUrl = env.DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";

  await fetch(
    `${baseUrl}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: message.content,
        components: message.components,
      }),
    },
  );
};

export const discordInternals = {
  buildRequestMessage,
  parseVoteButtonCustomId,
  serializeVoteButtonCustomId,
  verifyDiscordSignature,
};

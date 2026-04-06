import type {
  ApiResponse,
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
        content: "Invalid Discord signature.",
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
      content: "Unsupported Discord interaction.",
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
  resolveGroupByUsers: (userIds: string[]) => Promise<Group | null>,
): Promise<Response> => {
  const requesterId = getInteractionUserId(interaction);
  const targetUserId = getCommandUserId(interaction.data.options);
  const requestType = mapCommandToRequestType(interaction.data.name);

  if (!requesterId || !targetUserId || !requestType) {
    return ephemeralDiscordMessage("Invalid Discord command payload.");
  }

  const group = await resolveGroupByUsers([requesterId, targetUserId]);

  if (!group) {
    return ephemeralDiscordMessage("Requester and target must be in the same 3-person group.");
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
    return ephemeralDiscordMessage("Invalid vote action.");
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
    ? `Request ${request.type} for <@${request.targetUserId}> resolved. Final state: ${finalState}. Approve ${approveCount}, reject ${rejectCount}.`
    : `Request ${request.type} for <@${request.targetUserId}> is open. Approve ${approveCount}, reject ${rejectCount}.`;

  return {
    content,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Approve",
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
            label: "Reject",
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
    AUTH_REQUIRED: "Authentication is required.",
    INVALID_AUTH: "Authentication failed.",
    AUTH_PENDING: "Authentication is still pending.",
    SESSION_NOT_FOUND: "Session was not found.",
    INVALID_REQUEST: "Invalid request payload.",
    INTERNAL_ERROR: "Internal error.",
    METHOD_NOT_ALLOWED: "Method not allowed.",
    GROUP_CONTEXT_REQUIRED: "Group context is required.",
    INVALID_GROUP_MEMBERS: "Invalid group member configuration.",
    USER_ALREADY_IN_GROUP: "A user already belongs to another group.",
    ALREADY_LOCKED: "The target user is already locked.",
    ALREADY_UNLOCKED: "The target user is already unlocked.",
    ACTIVE_REQUEST_EXISTS: "An active request already exists for the target user.",
    TARGET_CANNOT_VOTE: "The target user cannot vote on this request.",
    REQUEST_NOT_FOUND: "The request was not found.",
    GROUP_NOT_FOUND: "The group was not found.",
    USER_NOT_FOUND: "The user was not found.",
    REQUEST_ALREADY_RESOLVED: "This request is already resolved.",
    DUPLICATE_VOTE: "You have already voted on this request.",
    VOTER_NOT_IN_GROUP: "Only group members can vote.",
    REQUESTER_NOT_IN_GROUP: "Requester is not in the group.",
    TARGET_NOT_IN_GROUP: "Target user is not in the group.",
    REQUEST_GROUP_MISMATCH: "Request group mismatch.",
    INVALID_REQUEST_TYPE_FOR_STATE: "This request direction is not allowed for the current state.",
  };

  return messages[errorCode];
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

export type IdentityMapping = {
  extensionUserId: string;
  discordUserId: string;
  sessionToken: string;
  expiresAt: number;
};

export type OAuthRequestRecord = {
  authRequestId: string;
  extensionUserId: string;
  state: string;
  status: "PENDING" | "COMPLETED";
  mapping: IdentityMapping | null;
  createdAt: number;
};

export type SessionRecord = {
  token: string;
  extensionUserId: string;
  discordUserId: string;
  expiresAt: number;
};

export type AuthState = {
  mappingsByExtensionUserId: Record<string, IdentityMapping>;
  extensionUserIdByDiscordUserId: Record<string, string>;
  oauthRequestsById: Record<string, OAuthRequestRecord>;
  authRequestIdByState: Record<string, string>;
  sessionsByToken: Record<string, SessionRecord>;
};

export const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export const createInitialAuthState = (): AuthState => {
  return {
    mappingsByExtensionUserId: {},
    extensionUserIdByDiscordUserId: {},
    oauthRequestsById: {},
    authRequestIdByState: {},
    sessionsByToken: {},
  };
};

export const upsertMapping = (
  state: AuthState,
  {
    extensionUserId,
    discordUserId,
    sessionToken,
    now,
  }: {
    extensionUserId: string;
    discordUserId: string;
    sessionToken: string;
    now: number;
  },
): { state: AuthState; mapping: IdentityMapping } => {
  const existingExtensionUserId =
    state.extensionUserIdByDiscordUserId[discordUserId] ?? extensionUserId;
  const expiresAt = now + AUTH_SESSION_TTL_MS;
  const mapping: IdentityMapping = {
    extensionUserId: existingExtensionUserId,
    discordUserId,
    sessionToken,
    expiresAt,
  };
  const session: SessionRecord = {
    token: sessionToken,
    extensionUserId: existingExtensionUserId,
    discordUserId,
    expiresAt,
  };

  return {
    mapping,
    state: {
      ...state,
      mappingsByExtensionUserId: {
        ...state.mappingsByExtensionUserId,
        [existingExtensionUserId]: mapping,
      },
      extensionUserIdByDiscordUserId: {
        ...state.extensionUserIdByDiscordUserId,
        [discordUserId]: existingExtensionUserId,
      },
      sessionsByToken: {
        ...state.sessionsByToken,
        [sessionToken]: session,
      },
    },
  };
};

export const createOAuthRequest = (
  state: AuthState,
  {
    authRequestId,
    extensionUserId,
    stateToken,
    now,
  }: {
    authRequestId: string;
    extensionUserId: string;
    stateToken: string;
    now: number;
  },
): AuthState => {
  const authRequest: OAuthRequestRecord = {
    authRequestId,
    extensionUserId,
    state: stateToken,
    status: "PENDING",
    mapping: null,
    createdAt: now,
  };

  return {
    ...state,
    oauthRequestsById: {
      ...state.oauthRequestsById,
      [authRequestId]: authRequest,
    },
    authRequestIdByState: {
      ...state.authRequestIdByState,
      [stateToken]: authRequestId,
    },
  };
};

export const completeOAuthRequest = (
  state: AuthState,
  {
    stateToken,
    mapping,
  }: {
    stateToken: string;
    mapping: IdentityMapping;
  },
): { state: AuthState; authRequest: OAuthRequestRecord | null } => {
  const authRequestId = state.authRequestIdByState[stateToken];

  if (!authRequestId) {
    return { state, authRequest: null };
  }

  const existing = state.oauthRequestsById[authRequestId];

  if (!existing) {
    return { state, authRequest: null };
  }

  const completed: OAuthRequestRecord = {
    ...existing,
    status: "COMPLETED",
    mapping,
  };

  return {
    authRequest: completed,
    state: {
      ...state,
      oauthRequestsById: {
        ...state.oauthRequestsById,
        [authRequestId]: completed,
      },
    },
  };
};

export const findOAuthRequestById = (
  state: AuthState,
  authRequestId: string,
): OAuthRequestRecord | null => {
  return state.oauthRequestsById[authRequestId] ?? null;
};

export const findOAuthRequestByState = (
  state: AuthState,
  stateToken: string,
): OAuthRequestRecord | null => {
  const authRequestId = state.authRequestIdByState[stateToken];
  return authRequestId ? state.oauthRequestsById[authRequestId] ?? null : null;
};

export const verifySessionToken = (
  state: AuthState,
  token: string,
  now: number,
): SessionRecord | null => {
  const session = state.sessionsByToken[token];

  if (!session || session.expiresAt <= now) {
    return null;
  }

  return session;
};

export const revokeSessionToken = (
  state: AuthState,
  token: string,
): AuthState => {
  const nextEntries = Object.entries(state.sessionsByToken).filter(
    ([sessionToken]) => sessionToken !== token,
  );

  return {
    ...state,
    sessionsByToken: Object.fromEntries(nextEntries),
  };
};

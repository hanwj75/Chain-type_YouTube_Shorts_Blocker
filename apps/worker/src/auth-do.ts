import type {
  GetDiscordOAuthPendingResponse,
  GetSessionResponse,
  LogoutResponse,
  OAuthPendingData,
  OAuthStartData,
  StartDiscordOAuthResponse,
} from "@youtube-shorts-chain-blocker/api-contract";
import type { DurableObjectState, WorkerEnv } from "./cloudflare.js";
import {
  completeOAuthRequest,
  createInitialAuthState,
  createOAuthRequest,
  findOAuthRequestById,
  findOAuthRequestByState,
  revokeSessionToken,
  upsertMapping,
  verifySessionToken,
  type AuthState,
} from "./auth-model.js";
import { jsonError, jsonSuccess } from "./http.js";

const STORAGE_KEY = "auth-state";

export class AuthDurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/auth/discord/start") {
      return this.handleStartDiscordOAuth();
    }

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/internal/auth/discord/pending/")
    ) {
      const authRequestId = getLastPathSegment(url.pathname);
      return this.handleGetPendingOAuth(authRequestId);
    }

    if (request.method === "GET" && url.pathname === "/internal/auth/session/verify") {
      const token = request.headers.get("authorization")?.replace("Bearer ", "").trim();
      return this.handleVerifySession(token);
    }

    if (request.method === "POST" && url.pathname === "/internal/auth/session/logout") {
      const token = request.headers.get("authorization")?.replace("Bearer ", "").trim();
      return this.handleLogout(token);
    }

    if (request.method === "POST" && url.pathname === "/internal/auth/discord/callback") {
      const body = (await request.json()) as {
        state: string;
        discordUserId: string;
      };

      return this.handleCompleteOAuth(body.state, body.discordUserId);
    }

    return jsonError("METHOD_NOT_ALLOWED", "Unsupported auth durable object route.", {
      status: 405,
    });
  }

  private async handleStartDiscordOAuth(): Promise<Response> {
    const authState = await this.loadState();
    const extensionUserId = crypto.randomUUID();
    const authRequestId = crypto.randomUUID();
    const stateToken = crypto.randomUUID();
    const nextState = createOAuthRequest(authState, {
      authRequestId,
      extensionUserId,
      stateToken,
      now: Date.now(),
    });

    await this.persistState(nextState);

    const authUrl = buildDiscordOAuthUrl({
      clientId: this.env.DISCORD_CLIENT_ID,
      redirectUri: this.env.DISCORD_OAUTH_REDIRECT_URI,
      stateToken,
    });

    const response: StartDiscordOAuthResponse = {
      success: true,
      data: {
        extensionUserId,
        authRequestId,
        authUrl,
      },
    };

    return jsonSuccess(response.data);
  }

  private async handleGetPendingOAuth(authRequestId: string): Promise<Response> {
    const authState = await this.loadState();
    const authRequest = findOAuthRequestById(authState, authRequestId);

    if (!authRequest) {
      return jsonError("SESSION_NOT_FOUND", "OAuth request was not found.", {
        status: 404,
      });
    }

    const payload: OAuthPendingData = {
      status: authRequest.status,
      mapping: authRequest.mapping,
    };

    return jsonSuccess(payload);
  }

  private async handleVerifySession(token: string | undefined): Promise<Response> {
    if (!token) {
      return jsonError("AUTH_REQUIRED", "Missing session token.", {
        status: 401,
      });
    }

    const authState = await this.loadState();
    const session = verifySessionToken(authState, token, Date.now());

    if (!session) {
      return jsonError("INVALID_AUTH", "Session token is invalid or expired.", {
        status: 401,
      });
    }

    const response: GetSessionResponse = {
      success: true,
      data: {
        extensionUserId: session.extensionUserId,
        discordUserId: session.discordUserId,
        expiresAt: session.expiresAt,
      },
    };

    return jsonSuccess(response.data);
  }

  private async handleLogout(token: string | undefined): Promise<Response> {
    if (!token) {
      return jsonError("AUTH_REQUIRED", "Missing session token.", {
        status: 401,
      });
    }

    const authState = await this.loadState();
    const nextState = revokeSessionToken(authState, token);
    await this.persistState(nextState);

    const response: LogoutResponse = {
      success: true,
      data: {
        revoked: true,
      },
    };

    return jsonSuccess(response.data);
  }

  private async handleCompleteOAuth(
    stateToken: string,
    discordUserId: string,
  ): Promise<Response> {
    const authState = await this.loadState();
    const existingRequest = findOAuthRequestByState(authState, stateToken);

    if (!existingRequest) {
      return jsonError("INVALID_AUTH", "OAuth state token is invalid.", {
        status: 401,
      });
    }

    const sessionToken = crypto.randomUUID();
    const upserted = upsertMapping(authState, {
      extensionUserId: existingRequest.extensionUserId,
      discordUserId,
      sessionToken,
      now: Date.now(),
    });
    const completed = completeOAuthRequest(upserted.state, {
      stateToken,
      mapping: upserted.mapping,
    });

    if (!completed.authRequest) {
      return jsonError("INVALID_AUTH", "OAuth state token is invalid.", {
        status: 401,
      });
    }

    await this.persistState(completed.state);

    return jsonSuccess({
      extensionUserId: completed.authRequest.mapping?.extensionUserId ?? "",
      discordUserId,
      sessionToken,
      expiresAt: completed.authRequest.mapping?.expiresAt ?? 0,
    });
  }

  private async loadState(): Promise<AuthState> {
    return (await this.state.storage.get<AuthState>(STORAGE_KEY)) ?? createInitialAuthState();
  }

  private async persistState(state: AuthState): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, state);
  }
}

const buildDiscordOAuthUrl = ({
  clientId,
  redirectUri,
  stateToken,
}: {
  clientId?: string;
  redirectUri?: string;
  stateToken: string;
}): string => {
  if (!clientId || !redirectUri) {
    return "";
  }

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", stateToken);

  return url.toString();
};

const getLastPathSegment = (pathname: string): string => {
  const segments = pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
};

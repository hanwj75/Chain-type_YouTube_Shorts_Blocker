import type { GetSessionResponse } from "@youtube-shorts-chain-blocker/api-contract";
import type { WorkerEnv } from "./cloudflare.js";

export type AuthenticatedClient =
  | {
      clientType: "extension";
      extensionUserId: string;
      discordUserId: string;
    }
  | {
      clientType: "discord";
    };

export const authenticateRequest = async (
  request: Request,
  env: WorkerEnv,
): Promise<AuthenticatedClient | null> => {
  const clientType = request.headers.get("x-client-type");
  const authorization = request.headers.get("authorization");

  if (!clientType || !authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (clientType === "discord" && token === env.DISCORD_API_TOKEN) {
    return { clientType };
  }

  if (clientType === "extension") {
    const session = await verifyExtensionSession(token, env);

    if (!session) {
      return null;
    }

    return {
      clientType,
      extensionUserId: session.extensionUserId,
      discordUserId: session.discordUserId,
    };
  }

  return null;
};

export const exchangeDiscordOAuthCode = async (
  code: string,
  env: WorkerEnv,
): Promise<{ accessToken: string } | null> => {
  if (
    !env.DISCORD_CLIENT_ID ||
    !env.DISCORD_CLIENT_SECRET ||
    !env.DISCORD_OAUTH_REDIRECT_URI
  ) {
    return null;
  }

  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: env.DISCORD_OAUTH_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { access_token?: string };

  if (!data.access_token) {
    return null;
  }

  return {
    accessToken: data.access_token,
  };
};

export const fetchDiscordUserIdentity = async (
  accessToken: string,
): Promise<{ discordUserId: string } | null> => {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { id?: string };

  if (!data.id) {
    return null;
  }

  return {
    discordUserId: data.id,
  };
};

const verifyExtensionSession = async (
  token: string,
  env: WorkerEnv,
): Promise<{
  extensionUserId: string;
  discordUserId: string;
  expiresAt: number;
} | null> => {
  const objectId = env.AUTH_DO.idFromName("auth");
  const stub = env.AUTH_DO.get(objectId);
  const response = await stub.fetch("https://auth-do/internal/auth/session/verify", {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as GetSessionResponse;

  return data.success ? data.data : null;
};

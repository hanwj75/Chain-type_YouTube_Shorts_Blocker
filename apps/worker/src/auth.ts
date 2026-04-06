import type { WorkerEnv } from "./cloudflare.js";

export type AuthenticatedClient = {
  clientType: "extension" | "discord";
};

export const authenticateRequest = (
  request: Request,
  env: WorkerEnv,
): AuthenticatedClient | null => {
  const clientType = request.headers.get("x-client-type");
  const authorization = request.headers.get("authorization");

  if (!clientType || !authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (clientType === "extension" && token === env.EXTENSION_API_TOKEN) {
    return { clientType };
  }

  if (clientType === "discord" && token === env.DISCORD_API_TOKEN) {
    return { clientType };
  }

  return null;
};

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
}

export interface DurableObjectId {
  readonly name: string;
}

export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type WorkerEnv = {
  GROUP_DO: DurableObjectNamespace;
  AUTH_DO: DurableObjectNamespace;
  GROUP_REGISTRY_DO: DurableObjectNamespace;
  GROUPS_JSON?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_API_TOKEN?: string;
  EXTENSION_API_TOKEN?: string;
  DISCORD_API_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_API_BASE_URL?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_OAUTH_REDIRECT_URI?: string;
};

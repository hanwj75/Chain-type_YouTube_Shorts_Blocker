import type { ApiError, ApiSuccess, ErrorCode } from "@youtube-shorts-chain-blocker/api-contract";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

export const jsonSuccess = <T>(
  data: T,
  init?: ResponseInit,
): Response => {
  const body: ApiSuccess<T> = {
    success: true,
    data,
  };

  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: mergeHeaders(init?.headers),
  });
};

export const jsonError = (
  errorCode: ErrorCode,
  message: string,
  init?: ResponseInit,
): Response => {
  const body: ApiError = {
    success: false,
    errorCode,
    message,
  };

  return new Response(JSON.stringify(body), {
    status: init?.status ?? 400,
    headers: mergeHeaders(init?.headers),
  });
};

export const withCors = (
  request: Request,
  response: Response,
  allowedOrigins?: string,
): Response => {
  const headers = new Headers(response.headers);
  const requestOrigin = request.headers.get("origin");
  const allowOrigin = getAllowedOrigin(requestOrigin, allowedOrigins);

  if (allowOrigin) {
    headers.set("access-control-allow-origin", allowOrigin);
  }

  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, x-client-type, x-group-id",
  );
  headers.set("vary", "origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const buildCorsPreflightResponse = (
  request: Request,
  allowedOrigins?: string,
): Response => {
  return withCors(
    request,
    new Response(null, {
      status: 204,
      headers: mergeHeaders(),
    }),
    allowedOrigins,
  );
};

const mergeHeaders = (headers?: HeadersInit): Headers => {
  const merged = new Headers(JSON_HEADERS);

  if (headers) {
    new Headers(headers).forEach((value, key) => merged.set(key, value));
  }

  return merged;
};

const getAllowedOrigin = (
  requestOrigin: string | null,
  allowedOrigins?: string,
): string => {
  const origins = normalizeAllowedOrigins(allowedOrigins);

  if (origins.includes("*")) {
    return "*";
  }

  if (requestOrigin && origins.includes(requestOrigin)) {
    return requestOrigin;
  }

  if (requestOrigin && origins.length === 0 && isExtensionOrigin(requestOrigin)) {
    return requestOrigin;
  }

  return origins[0] ?? (requestOrigin && isExtensionOrigin(requestOrigin) ? requestOrigin : "*");
};

const normalizeAllowedOrigins = (allowedOrigins?: string): string[] => {
  if (!allowedOrigins || allowedOrigins.trim() === "") {
    return [];
  }

  return allowedOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .filter((origin) => !isPlaceholderOrigin(origin))
    .filter((origin) => origin === "*" || isValidOrigin(origin));
};

const isPlaceholderOrigin = (origin: string): boolean => {
  return origin.includes("__YOUR_EXTENSION_ID__") || origin.includes("<your-subdomain>");
};

const isValidOrigin = (origin: string): boolean => {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "chrome-extension:" || parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const isExtensionOrigin = (origin: string): boolean => {
  return origin.startsWith("chrome-extension://");
};

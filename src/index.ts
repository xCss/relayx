export interface Env {
  ALLOWED_ORIGINS?: string;
}

type Fetcher = typeof fetch;

const ALLOWED_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "authorization, content-type";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);
const SENSITIVE_FORWARD_HEADERS = new Set(["cookie", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);

function getAllowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== "")
  );
}

function isOriginAllowed(request: Request, env: Env): boolean {
  const allowedOrigins = getAllowedOrigins(env);
  if (allowedOrigins.size === 0) {
    return true;
  }

  const origin = request.headers.get("Origin");
  if (origin === null) {
    return true;
  }

  return allowedOrigins.has(origin);
}

function getCorsHeaders(request: Request, originAllowed = true): Headers {
  const origin = request.headers.get("Origin") ?? "*";
  const requestHeaders = request.headers.get("Access-Control-Request-Headers") ?? DEFAULT_ALLOWED_HEADERS;
  const headers = new Headers();

  headers.set("Access-Control-Allow-Origin", originAllowed ? origin : "null");
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", requestHeaders);
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin, Access-Control-Request-Headers");

  return headers;
}

function withCors(request: Request, response: Response, originAllowed = true): Response {
  const headers = new Headers(response.headers);
  const corsHeaders = getCorsHeaders(request, originAllowed);

  corsHeaders.forEach((value, key) => {
    if (key.toLowerCase() === "vary") {
      headers.append(key, value);
      return;
    }

    headers.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonError(request: Request, message: string, status = 500, originAllowed = true): Response {
  return withCors(
    request,
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    }),
    originAllowed
  );
}

function extractTargetUrl(requestUrl: string): URL | Response {
  const incoming = new URL(requestUrl);
  const rawPath = incoming.pathname.replace(/^\/relay\//, "/").slice(1);

  if (rawPath.trim() === "") {
    return jsonError(new Request(requestUrl), "Target URL is required", 400);
  }

  let target: URL;
  try {
    target = new URL(decodeURIComponent(rawPath));
  } catch {
    return jsonError(new Request(requestUrl), "Target URL is invalid", 400);
  }

  if (target.protocol !== "https:") {
    return jsonError(new Request(requestUrl), "Target URL must use https", 400);
  }

  target.search = incoming.search;
  return target;
}

function buildForwardHeaders(request: Request): Headers {
  const headers = new Headers();

  request.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    const isSensitiveEdgeHeader = normalizedKey.startsWith("cf-") || normalizedKey.startsWith("x-forwarded-");

    if (
      !HOP_BY_HOP_HEADERS.has(normalizedKey) &&
      !SENSITIVE_FORWARD_HEADERS.has(normalizedKey) &&
      !isSensitiveEdgeHeader &&
      !normalizedKey.startsWith("access-control-")
    ) {
      headers.set(key, value);
    }
  });

  return headers;
}

async function forwardRequest(request: Request, env: Env, fetcher: Fetcher): Promise<Response> {
  const originAllowed = isOriginAllowed(request, env);
  if (!originAllowed) {
    return jsonError(request, "Origin is not allowed", 403, false);
  }

  const targetUrl = extractTargetUrl(request.url);
  if (targetUrl instanceof Response) {
    return withCors(request, targetUrl, originAllowed);
  }

  const init: RequestInit = {
    method: request.method,
    headers: buildForwardHeaders(request),
    redirect: "manual"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstreamRequest = new Request(targetUrl, init);
    const upstreamResponse = await fetcher(upstreamRequest);

    return withCors(request, upstreamResponse, originAllowed);
  } catch {
    return jsonError(request, "Unable to reach upstream", 502, originAllowed);
  }
}

export default {
  async fetch(request: Request, env: Env = {}, _ctx?: ExecutionContext, fetcher: Fetcher = fetch): Promise<Response> {
    if (request.method === "OPTIONS") {
      const originAllowed = isOriginAllowed(request, env);
      return new Response(null, {
        status: originAllowed ? 204 : 403,
        headers: getCorsHeaders(request, originAllowed)
      });
    }

    return forwardRequest(request, env, fetcher);
  }
};

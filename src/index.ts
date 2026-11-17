import {
  downloadAttachment, handleOneClickUnsubscribe, handleSendEmail, listMailsJsonCore,
  mailConfigJson, mailDetailJson, storeIncomingMail
} from "./handlers";
import { ApiError, authenticate, getMemberConfig, handleAuth, requestMailAccess, requireIdentity, requireSameOrigin } from "./auth";
import { handleMembers } from "./members";
import type { Env } from "./utils";
import { jsonError, readListParamsFromSearchParams } from "./utils";

function decodedId(value: string): string {
  try {
    const id = decodeURIComponent(value).trim();
    if (id) return id;
  } catch { /* Invalid URL encoding is a client error. */ }
  throw new ApiError(400, "INVALID_REQUEST");
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = getMemberConfig(env, url.hostname);
  // Public catch-all hosts never inspect cookies or member tables.
  const identity = config ? await authenticate(request, env, config) : null;
  const access = requestMailAccess(env, url.hostname, config, identity);

  if (url.pathname === "/api/config") {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED");
    return mailConfigJson(env, access);
  }
  if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/members" || url.pathname.startsWith("/api/members/")) {
    if (!config) throw new ApiError(404, "NOT_FOUND");
    return url.pathname.startsWith("/api/auth/")
      ? handleAuth(request, env, config, identity)
      : handleMembers(request, env, config, identity);
  }
  if (config) {
    requireIdentity(identity);
    if (request.method !== "GET") requireSameOrigin(request);
  }
  if (url.pathname === "/api/send") {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED");
    return handleSendEmail(request, env, access);
  }
  if (url.pathname === "/api/mails") {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED");
    const { page, q } = readListParamsFromSearchParams(url.searchParams);
    const folder = url.searchParams.get("folder") ?? "inbox";
    if (folder !== "inbox" && folder !== "sent") throw new ApiError(400, "INVALID_REQUEST");
    return listMailsJsonCore(env, access, page, q, folder);
  }
  const unsubscribe = url.pathname.match(/^\/api\/mails\/([^/]+)\/unsubscribe\/?$/);
  if (unsubscribe) {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED");
    return handleOneClickUnsubscribe(request, decodedId(unsubscribe[1]), env, url, access);
  }
  if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED");
  const attachment = url.pathname.match(/^\/api\/mails\/([^/]+)\/attachments\/([^/]+)\/?$/);
  if (attachment) return downloadAttachment(decodedId(attachment[1]), decodedId(attachment[2]), env, access);
  const detail = url.pathname.match(/^\/api\/mails\/([^/]+)\/?$/);
  if (detail) return mailDetailJson(decodedId(detail[1]), env, access);
  throw new ApiError(404, "NOT_FOUND");
}

const worker: ExportedHandler<Env> = {
  async email(message, env, ctx) {
    ctx.waitUntil(storeIncomingMail(message, env));
  },
  async fetch(request, env) {
    let response: Response;
    try {
      response = await routeRequest(request, env);
    } catch (error) {
      if (error instanceof ApiError) response = jsonError(error.message, error.status, error.code);
      else {
        console.error("Worker API failed", error instanceof Error ? error.name : "UnknownError");
        response = jsonError("Service Unavailable", 503, "SERVICE_UNAVAILABLE");
      }
    }
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  }
};

export default worker;

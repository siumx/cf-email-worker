import {
  downloadAttachment,
  handleOneClickUnsubscribe,
  handleSendEmail,
  listMailsJsonCore,
  mailConfigJson,
  mailDetailJson,
  storeIncomingMail
} from "./handlers";
import type { Env } from "./utils";
import { jsonError, readListParamsFromSearchParams } from "./utils";

const worker: ExportedHandler<Env> = {
  async email(message, env, ctx) {
    ctx.waitUntil(storeIncomingMail(message, env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config") {
      if (request.method !== "GET") {
        return jsonError("Method Not Allowed", 405);
      }
      return mailConfigJson(env, url.hostname);
    }

    if (url.pathname === "/api/send" && request.method === "POST") {
      return handleSendEmail(request, env, url.hostname);
    }

    if (url.pathname === "/api/mails") {
      if (request.method !== "GET") {
        return jsonError("Method Not Allowed", 405);
      }
      const { page, q } = readListParamsFromSearchParams(url.searchParams);
      return listMailsJsonCore(env, url.hostname, page, q);
    }

    const unsubscribeMatch = url.pathname.match(/^\/api\/mails\/([^/]+)\/unsubscribe\/?$/);
    if (unsubscribeMatch) {
      if (request.method !== "POST") {
        return jsonError("Method Not Allowed", 405);
      }

      let id = "";
      try {
        id = decodeURIComponent(unsubscribeMatch[1] ?? "").trim();
      } catch {
        return jsonError("Bad Request", 400);
      }
      if (!id) {
        return jsonError("Bad Request", 400);
      }
      return handleOneClickUnsubscribe(request, id, env, url);
    }

    if (request.method !== "GET") {
      return jsonError("Method Not Allowed", 405);
    }

    const attachmentMatch = url.pathname.match(/^\/api\/mails\/([^/]+)\/attachments\/([^/]+)\/?$/);
    if (attachmentMatch) {
      const id = decodeURIComponent(attachmentMatch[1] ?? "").trim();
      const attachmentId = decodeURIComponent(attachmentMatch[2] ?? "").trim();
      if (!id || !attachmentId) {
        return jsonError("Bad Request", 400);
      }
      return downloadAttachment(id, attachmentId, env, url.hostname);
    }

    const detailMatch = url.pathname.match(/^\/api\/mails\/([^/]+)\/?$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1] ?? "").trim();
      if (!id) {
        return jsonError("Bad Request", 400);
      }
      return mailDetailJson(id, env, url.hostname);
    }

    return jsonError("Not Found", 404);
  }
};

export default worker;

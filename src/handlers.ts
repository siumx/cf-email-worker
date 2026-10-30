import { EmailMessage } from "cloudflare:email";

import { storeMailToD1, storeSentAttachmentsToR2 } from "./db";
import type { Env, MailReference, SendAttachment, StoredAttachment } from "./utils";
import {
  LIST_PAGE_SIZE,
  buildContentDisposition,
  buildMailReference,
  buildMailView,
  cancelResponseBody,
  decodeMimeWords,
  escapeLikeForSql,
  extractAttachmentsFromRaw,
  getHeader,
  getToAddressLikePattern,
  headersToRecord,
  isAdminMailHost,
  isSameOriginUnsubscribeRequest,
  jsonError,
  jsonOk,
  parseSafeOneClickUrl,
  parseStoredAttachments,
  readRawEmailText,
  resolveDisplayFrom,
  rowToStoredMail,
  sanitizeFilename,
  supportsOneClickUnsubscribe
} from "./utils";

export function mailConfigJson(env: Env, hostname: string): Response {
  const canSend = isAdminMailHost(hostname, env.ADMIN_MAIL_HOSTS);
  const response = jsonOk({
    canSend,
    sendableDomains: canSend ? (env.SENDABLE_DOMAINS ?? []) : []
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function handleSendEmail(request: Request, env: Env, hostname: string): Promise<Response> {
  if (!isAdminMailHost(hostname, env.ADMIN_MAIL_HOSTS)) {
    return jsonError("Unauthorized", 403, "FORBIDDEN");
  }

  try {
    const body = await request.json() as {
      to?: string[];
      from?: string;
      name?: string;
      subject?: string;
      text?: string;
      cc?: string[];
      bcc?: string[];
      attachments?: SendAttachment[];
    };

    const toAddresses = body.to ?? [];
    if (!Array.isArray(toAddresses) || toAddresses.length === 0) {
      return jsonError("'to' must contain at least one address", 400, "RECIPIENT_REQUIRED");
    }

    // Sender address must be provided by the client
    const fromEmail = body.from?.trim();
    if (!fromEmail) {
      return jsonError("'from' is required", 400, "SENDER_REQUIRED");
    }
    const fromDomain = fromEmail.match(/^[^\s@]+@([a-z0-9.-]+)$/i)?.[1].toLowerCase() ?? "";
    if (!fromDomain || !(env.SENDABLE_DOMAINS ?? []).some((domain) => domain.trim().toLowerCase() === fromDomain)) {
      return jsonError("'from' domain is not allowed", 400, "SENDER_DOMAIN_NOT_ALLOWED");
    }
    const senderName = body.name?.trim() || "";
    const fromAddress = senderName ? `"${senderName}" <${fromEmail}>` : fromEmail;

    const subject = body.subject ?? "";
    const text = body.text ?? "";
    const ccAddresses = body.cc ?? [];
    const bccAddresses = body.bcc ?? [];
    const attachments = body.attachments ?? [];

    // Build MIME message
    const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
    const dateStr = new Date().toUTCString();

    const mimeHeaders: string[] = [
      `From: ${fromAddress}`,
      `To: ${toAddresses.join(", ")}`,
    ];
    if (ccAddresses.length > 0) {
      mimeHeaders.push(`Cc: ${ccAddresses.join(", ")}`);
    }
    mimeHeaders.push(
      `Subject: ${subject}`,
      `Date: ${dateStr}`,
      `MIME-Version: 1.0`,
      `Message-ID: ${messageId}`
    );

    let rawMessage: string;

    if (attachments.length > 0) {
      const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, "")}`;
      mimeHeaders.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

      const headerBlock = mimeHeaders.join("\r\n");
      const parts: string[] = [];

      // Text body part
      parts.push(
        `--${boundary}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `\r\n` +
        btoa(unescape(encodeURIComponent(text)))
      );

      // Attachment parts
      for (const att of attachments) {
        parts.push(
          `--${boundary}\r\n` +
          `Content-Type: ${att.type || "application/octet-stream"}; name="${att.filename}"\r\n` +
          `Content-Disposition: ${att.disposition || "attachment"}; filename="${att.filename}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n` +
          `\r\n` +
          att.content
        );
      }

      rawMessage = headerBlock + "\r\n\r\n" + parts.join("\r\n") + `\r\n--${boundary}--\r\n`;
    } else {
      mimeHeaders.push(`Content-Type: text/plain; charset=utf-8`);
      mimeHeaders.push(`Content-Transfer-Encoding: base64`);
      const headerBlock = mimeHeaders.join("\r\n");
      rawMessage = headerBlock + "\r\n\r\n" + btoa(unescape(encodeURIComponent(text)));
    }

    // Send to all recipients (to + cc + bcc), tracking successes and failures
    const allRecipients = [...toAddresses, ...ccAddresses, ...bccAddresses];
    const succeeded: string[] = [];
    const failed: { recipient: string; error: string }[] = [];

    for (const recipient of allRecipients) {
      try {
        const msg = new EmailMessage(fromEmail, recipient, rawMessage);
        await env.EMAIL.send(msg);
        succeeded.push(recipient);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ recipient, error: errMsg });
      }
    }

    // Prepare common metadata
    const sentTimestamp = Date.now();
    const sentReceivedAt = new Date(sentTimestamp).toISOString();
    const sentHeaders: Record<string, string> = {};
    for (const line of mimeHeaders) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        sentHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    }
    const sentReference: MailReference = {
      replyTo: "",
      envelopeFrom: fromEmail,
      inReplyTo: "",
      references: "",
      cc: ccAddresses
    };

    // If at least 1 recipient succeeded, store the sent mail record
    if (succeeded.length > 0) {
      const sentId = crypto.randomUUID();
      const storedAttachments = await storeSentAttachmentsToR2(env, sentId, attachments);
      await storeMailToD1(env, {
        id: sentId,
        messageId,
        receivedAt: sentReceivedAt,
        timestamp: sentTimestamp,
        fromAddress,
        toAddress: toAddresses.join(", "),
        subject,
        headersJson: JSON.stringify(sentHeaders),
        rawText: rawMessage,
        attachmentCount: storedAttachments.length,
        attachmentsJson: JSON.stringify(storedAttachments),
        referenceJson: JSON.stringify(sentReference),
        folder: "sent"
      });
    }

    // If any recipient failed, store a failure notification record
    if (failed.length > 0) {
      const failId = crypto.randomUUID();
      const failSubject = "寄件失敗通知";
      const failLines: string[] = [
        `寄件失敗通知`,
        ``,
        `原始主旨: ${subject}`,
        `寄件者: ${fromAddress}`,
        `寄件時間: ${sentReceivedAt}`,
        ``,
        `以下收件人寄送失敗:`,
      ];
      for (const f of failed) {
        failLines.push(`  - ${f.recipient}: ${f.error}`);
      }
      if (succeeded.length > 0) {
        failLines.push(``);
        failLines.push(`以下收件人寄送成功:`);
        for (const s of succeeded) {
          failLines.push(`  - ${s}`);
        }
      }
      const failBody = failLines.join("\n");

      const failReference: MailReference = {
        replyTo: "",
        envelopeFrom: "system",
        inReplyTo: messageId,
        references: messageId,
        cc: []
      };

      // 發送失敗時會寫到inbox, 此為系統通知信件
      await storeMailToD1(env, {
        id: failId,
        messageId: `<${crypto.randomUUID()}@system>`,
        receivedAt: sentReceivedAt,
        timestamp: sentTimestamp,
        fromAddress: "System <system@local>",
        toAddress: fromEmail,
        subject: failSubject,
        headersJson: JSON.stringify({}),
        rawText: failBody,
        attachmentCount: 0,
        attachmentsJson: JSON.stringify([]),
        referenceJson: JSON.stringify(failReference),
        folder: "inbox"
      });
    }

    // Return appropriate response
    if (failed.length === 0) {
      return jsonOk({ success: true });
    } else if (succeeded.length > 0) {
      return jsonOk({
        success: true,
        partial: true,
        failed: failed.map(f => ({ recipient: f.recipient, error: f.error }))
      });
    } else {
      return jsonError(
        `All recipients failed: ${failed.map(f => `${f.recipient} (${f.error})`).join(", ")}`,
        500,
        "SEND_FAILED"
      );
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return jsonError(`Failed to send email: ${errMsg}`, 500, "SEND_FAILED");
  }
}

export async function storeIncomingMail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const receivedAt = new Date(timestamp).toISOString();
  const rawText = await readRawEmailText(message);

  const headers = headersToRecord(message.headers);
  const subject = decodeMimeWords(message.headers.get("subject") ?? "(no subject)");
  const fromAddress = decodeMimeWords(resolveDisplayFrom(message));
  const messageId = (message.headers.get("message-id") ?? "").trim();
  const reference = buildMailReference(message);

  const extractedAttachments = extractAttachmentsFromRaw(rawText);
  const storedAttachments: StoredAttachment[] = [];
  for (const attachment of extractedAttachments) {
    const safeName = sanitizeFilename(attachment.filename || `${attachment.id}.bin`);
    const r2Key = `mail/${id}/${attachment.id}-${safeName}`;
    await env.R2.put(r2Key, attachment.bytes, {
      httpMetadata: { contentType: attachment.contentType }
    });
    storedAttachments.push({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.bytes.byteLength,
      r2Key,
      contentId: attachment.contentId,
      disposition: attachment.disposition
    });
  }

  await storeMailToD1(env, {
    id,
    messageId,
    receivedAt,
    timestamp,
    fromAddress,
    toAddress: message.to,
    subject,
    headersJson: JSON.stringify(headers),
    rawText,
    attachmentCount: storedAttachments.length,
    attachmentsJson: JSON.stringify(storedAttachments),
    referenceJson: JSON.stringify(reference),
    folder: "inbox"
  });
}

export async function listMailsJsonCore(env: Env, hostname: string, requestedPage: number, q: string): Promise<Response> {
  const toAddressLike = getToAddressLikePattern(hostname, env.ADMIN_MAIL_HOSTS);

  if (!toAddressLike) {
    return jsonOk({ mails: [], page: 1, totalPages: 0, total: 0 });
  }

  const hasQ = q.length > 0;
  const likePat = hasQ ? `%${escapeLikeForSql(q.toLowerCase())}%` : "";

  const whereTenant = "folder = 'inbox' AND to_address LIKE ?";
  const whereSearch = hasQ
    ? ` AND (LOWER(subject) LIKE ? ESCAPE '\\' OR LOWER(to_address) LIKE ? ESCAPE '\\' OR LOWER(from_address) LIKE ? ESCAPE '\\')`
    : "";

  const countSql = `SELECT COUNT(*) as total FROM mails WHERE ${whereTenant}${whereSearch}`;
  const countStmt = hasQ
    ? env.DB.prepare(countSql).bind(toAddressLike, likePat, likePat, likePat)
    : env.DB.prepare(countSql).bind(toAddressLike);

  const totalRow = await countStmt.first<{
    total: number;
  }>();
  const total = Number.parseInt(String(totalRow?.total ?? 0), 10);
  const totalPages = total === 0 ? 0 : Math.ceil(total / LIST_PAGE_SIZE);

  const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
  const offset = (page - 1) * LIST_PAGE_SIZE;

  const selectSql = `SELECT id, received_at, timestamp, from_address, to_address, subject
     FROM mails
     WHERE ${whereTenant}${whereSearch}
     ORDER BY timestamp DESC
     LIMIT ? OFFSET ?`;

  const selectStmt = hasQ
    ? env.DB.prepare(selectSql).bind(toAddressLike, likePat, likePat, likePat, LIST_PAGE_SIZE, offset)
    : env.DB.prepare(selectSql).bind(toAddressLike, LIST_PAGE_SIZE, offset);

  const { results } = await selectStmt.all<{
    id: string;
    received_at: string;
    timestamp: number;
    from_address: string;
    to_address: string;
    subject: string;
  }>();

  const mails = (results ?? []).map((row) => ({
    id: row.id,
    from: row.from_address,
    to: row.to_address,
    subject: row.subject,
    receivedAt: row.received_at,
    timestamp: row.timestamp
  }));

  return jsonOk({ mails, page, totalPages, total });
}

export async function handleOneClickUnsubscribe(
  request: Request,
  id: string,
  env: Env,
  requestUrl: URL
): Promise<Response> {
  if (!isSameOriginUnsubscribeRequest(request, requestUrl)) {
    return jsonError("Forbidden", 403, "FORBIDDEN");
  }

  const hostname = requestUrl.hostname.toLowerCase();
  const toAddressLike = getToAddressLikePattern(hostname, env.ADMIN_MAIL_HOSTS);
  if (!toAddressLike) {
    return jsonError("Mail Not Found", 404, "MAIL_NOT_FOUND");
  }

  const row = await env.DB.prepare(
    `SELECT headers_json
     FROM mails
     WHERE id = ? AND folder = 'inbox' AND to_address LIKE ?`
  )
    .bind(id, toAddressLike)
    .first<{ headers_json: string }>();

  if (!row) {
    return jsonError("Mail Not Found", 404, "MAIL_NOT_FOUND");
  }

  let headers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.headers_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError("Unsubscribe Not Available", 422, "UNSUBSCRIBE_UNAVAILABLE");
    }
    headers = parsed as Record<string, unknown>;
  } catch {
    return jsonError("Unsubscribe Not Available", 422, "UNSUBSCRIBE_UNAVAILABLE");
  }

  const postHeader = getHeader(headers, "list-unsubscribe-post");
  const unsubscribeHeader = getHeader(headers, "list-unsubscribe");
  if (!supportsOneClickUnsubscribe(postHeader)) {
    return jsonError("Unsubscribe Not Available", 422, "UNSUBSCRIBE_UNAVAILABLE");
  }

  const target = parseSafeOneClickUrl(unsubscribeHeader);
  if (!target) {
    return jsonError("Unsubscribe Not Available", 422, "UNSUBSCRIBE_UNAVAILABLE");
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      signal: AbortSignal.timeout(5000)
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.warn(JSON.stringify({
      message: "one-click unsubscribe request failed",
      mailId: id,
      targetHost: target.hostname,
      error: errorName
    }));
    const isTimeout = errorName === "TimeoutError" || errorName === "AbortError";
    return jsonError("Unsubscribe Request Failed", isTimeout ? 504 : 502, "UNSUBSCRIBE_FAILED");
  }

  const upstreamStatus = upstream.status;
  await cancelResponseBody(upstream);

  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    console.warn(JSON.stringify({
      message: "one-click unsubscribe upstream rejected request",
      mailId: id,
      targetHost: target.hostname,
      upstreamStatus
    }));
    return jsonError("Unsubscribe Request Failed", 502, "UNSUBSCRIBE_FAILED");
  }

  console.log(JSON.stringify({
    message: "one-click unsubscribe completed",
    mailId: id,
    targetHost: target.hostname,
    upstreamStatus
  }));
  return jsonOk({ success: true });
}

export async function mailDetailJson(id: string, env: Env, hostname: string): Promise<Response> {
  const toAddressLike = getToAddressLikePattern(hostname, env.ADMIN_MAIL_HOSTS);
  if (!toAddressLike) {
    return jsonError("Mail Not Found", 404, "MAIL_NOT_FOUND");
  }

  const row = await env.DB.prepare(
    `SELECT id, received_at, timestamp, from_address, to_address, subject, reference_json, attachments_json, headers_json, raw_text
     FROM mails
     WHERE id = ? AND folder = 'inbox' AND to_address LIKE ?`
  )
    .bind(id, toAddressLike)
    .first<{
      id: string;
      received_at: string;
      timestamp: number;
      from_address: string;
      to_address: string;
      subject: string;
      reference_json: string;
      attachments_json: string;
      headers_json: string;
      raw_text: string;
    }>();

  if (!row) {
    return jsonError("Mail Not Found", 404, "MAIL_NOT_FOUND");
  }

  const mail = rowToStoredMail(row);

  if (mail.rawText.startsWith("[[R2:") && mail.rawText.endsWith("]]")) {
    const r2Key = mail.rawText.slice(5, -2);
    const r2Obj = await env.R2.get(r2Key);
    if (r2Obj) {
      mail.rawText = await r2Obj.text();
    } else {
      mail.rawText = ""; // fallback
    }
  }

  const view = buildMailView(mail);

  return jsonOk({ mail, view });
}

export async function downloadAttachment(id: string, attachmentId: string, env: Env, hostname: string): Promise<Response> {
  const toAddressLike = getToAddressLikePattern(hostname, env.ADMIN_MAIL_HOSTS);
  if (!toAddressLike) {
    return jsonError("Mail Not Found", 404, "MAIL_NOT_FOUND");
  }

  const row = await env.DB.prepare(
    `SELECT attachments_json
     FROM mails
     WHERE id = ? AND folder = 'inbox' AND to_address LIKE ?`
  )
    .bind(id, toAddressLike)
    .first<{ attachments_json: string }>();

  if (!row) {
    return jsonError("Mail Not Found", 404, "MAIL_NOT_FOUND");
  }

  const attachments = parseStoredAttachments(row.attachments_json);
  const target = attachments.find((item) => item.id === attachmentId);
  if (!target) {
    return jsonError("Attachment Not Found", 404, "ATTACHMENT_NOT_FOUND");
  }

  const object = await env.R2.get(target.r2Key);
  if (!object || !object.body) {
    return jsonError("Attachment Not Found", 404, "ATTACHMENT_NOT_FOUND");
  }

  const headers = new Headers();
  headers.set("content-type", target.contentType || "application/octet-stream");
  headers.set("content-disposition", buildContentDisposition(target.filename));
  if (typeof object.size === "number") {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body, { status: 200, headers });
}

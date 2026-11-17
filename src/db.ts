import type { Env, MailFolder, SendAttachment, StoredAttachment } from "./utils";
import { decodeBase64ToBytes, sanitizeFilename } from "./utils";

/** Shared D1 insert + R2 offloading for mail with attachments or large raw_text. */
export async function storeMailToD1(env: Env, params: {
  id: string;
  messageId: string;
  receivedAt: string;
  timestamp: number;
  fromAddress: string;
  toAddress: string;
  subject: string;
  headersJson: string;
  rawText: string;
  attachmentCount: number;
  attachmentsJson: string;
  referenceJson: string;
  folder: MailFolder;
}): Promise<void> {
  let dbRawText = params.rawText;
  if (params.attachmentCount > 0 || params.rawText.length > 100000) {
    const r2Prefix = params.folder === "sent" ? "send" : "mail";
    const r2RawKey = `${r2Prefix}/${params.id}/raw.eml`;
    await env.R2.put(r2RawKey, params.rawText, {
      httpMetadata: { contentType: "message/rfc822" }
    });
    dbRawText = `[[R2:${r2RawKey}]]`;
  }

  await env.DB.prepare(
    `INSERT INTO mails (id, message_id, received_at, timestamp, from_address, to_address, subject, headers_json, raw_text, attachment_count, attachments_json, reference_json, folder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      params.id,
      params.messageId,
      params.receivedAt,
      params.timestamp,
      params.fromAddress,
      params.toAddress,
      params.subject,
      params.headersJson,
      dbRawText,
      params.attachmentCount,
      params.attachmentsJson,
      params.referenceJson,
      params.folder
    )
    .run();
}

/** Persist send-path attachments under R2 `send/` (separate copy from inbound `mail/`). */
export async function storeSentAttachmentsToR2(
  env: Env,
  sentId: string,
  attachments: SendAttachment[]
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];
  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i];
    if (!att) continue;
    const attId = `att-${i + 1}`;
    const filename = att.filename || `${attId}.bin`;
    const safeName = sanitizeFilename(filename);
    const contentType = att.type || "application/octet-stream";
    const disposition = att.disposition || "attachment";
    const bytes = decodeBase64ToBytes(att.content);
    const r2Key = `send/${sentId}/${attId}-${safeName}`;
    await env.R2.put(r2Key, bytes, {
      httpMetadata: { contentType }
    });
    stored.push({
      id: attId,
      filename,
      contentType,
      size: bytes.byteLength,
      r2Key,
      contentId: null,
      disposition
    });
  }
  return stored;
}

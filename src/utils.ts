export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  EMAIL: SendEmail;
  ADMIN_MAIL_HOSTS: string[];
  SENDABLE_DOMAINS: string[];
}

export interface SendAttachment {
  content: string;
  filename: string;
  type: string;
  disposition: string;
}

export interface StoredAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
  contentId: string | null;
  disposition: string | null;
}

export interface StoredMail {
  id: string;
  receivedAt: string;
  timestamp: number;
  from: string;
  to: string;
  subject: string;
  cc: string[];
  headers: Record<string, string>;
  attachments: StoredAttachment[];
  rawText: string;
}

export interface MailReference {
  replyTo: string;
  envelopeFrom: string;
  inReplyTo: string;
  references: string;
  cc: string[];
}

export interface ParsedMailContent {
  headersRaw: string;
  bodyRaw: string;
  renderedHtml: string | null;
  renderedText: string | null;
}

export interface MailViewJson {
  renderedHtml: string | null;
  renderedText: string | null;
}

export interface MimePart {
  headers: Record<string, string>;
  body: string;
}

export interface ExtractedAttachment {
  id: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  contentId: string | null;
  disposition: string | null;
}

/** inbox = received mail (+ failure notices); sent = outbound backup. */
export type MailFolder = "inbox" | "sent";

export const LIST_PAGE_SIZE = 30;
export const LIST_Q_MAX_LEN = 200;
export const MAX_UNSUBSCRIBE_URL_LENGTH = 4096;

export function isAdminMailHost(hostname: string, adminMailHosts: readonly string[] = []): boolean {
  const clean = hostname.trim().toLowerCase();
  return clean !== "" && adminMailHosts.some((host) => host.trim().toLowerCase() === clean);
}

/** admin host 可查全部收件，其餘依 domain 篩選 */
export function getToAddressLikePattern(hostname: string, adminMailHosts: readonly string[] = []): string {
  const clean = hostname.trim().toLowerCase();
  if (isAdminMailHost(clean, adminMailHosts)) {
    return "%";
  }
  const parts = clean.split(".");
  const stripped = parts.slice(1).join(".");

  if (!stripped || !stripped.includes(".") || /[^a-z0-9.-]/.test(stripped)) {
    return "";
  }
  return `%@${stripped}`;
}

export function normalizeListQuery(raw: string): string {
  return raw.trim().slice(0, LIST_Q_MAX_LEN);
}

/** 供 LIKE … ESCAPE '\\' 使用：跳脫 `\`、`%`、`_`。 */
export function escapeLikeForSql(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function readListParamsFromSearchParams(searchParams: URLSearchParams): { page: number; q: string } {
  const pageParam = searchParams.get("page");
  const parsedPage = pageParam ? Number.parseInt(pageParam, 10) : NaN;
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? Math.floor(parsedPage) : 1;
  const q = normalizeListQuery(searchParams.get("q") ?? "");
  return { page, q };
}

export function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/** 顯示用寄件者：優先 From 標頭（使用者看到的寄件者），否則信封 MAIL FROM。 */
export function resolveDisplayFrom(message: ForwardableEmailMessage): string {
  const fromHeader = message.headers.get("from")?.trim();
  if (fromHeader) {
    return fromHeader;
  }
  return message.from;
}

export function rowToStoredMail(row: {
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
}): StoredMail {
  const reference = parseMailReference(row.reference_json);
  return {
    id: row.id,
    receivedAt: row.received_at,
    timestamp: row.timestamp,
    from: row.from_address,
    to: row.to_address,
    subject: row.subject,
    cc: reference.cc,
    attachments: parseStoredAttachments(row.attachments_json),
    headers: JSON.parse(row.headers_json) as Record<string, string>,
    rawText: row.raw_text
  };
}

export function buildMailView(mail: StoredMail): MailViewJson {
  const parsed = parseMimeMail(mail.rawText);
  return {
    renderedHtml: parsed.renderedHtml,
    renderedText: parsed.renderedText
  };
}

export function supportsOneClickUnsubscribe(header: string): boolean {
  return /(?:^|[;\s])list-unsubscribe\s*=\s*one-click(?:$|[;\s])/i.test(header.trim());
}

export function isIpLiteral(hostname: string): boolean {
  const clean = hostname.toLowerCase();
  return clean.includes(":") ||
    clean.startsWith("[") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(clean);
}

export function parseSafeOneClickUrl(header: string): URL | null {
  for (const match of header.matchAll(/<([^>]+)>/g)) {
    const raw = (match[1] ?? "").trim();
    if (!raw || raw.length > MAX_UNSUBSCRIBE_URL_LENGTH) {
      continue;
    }

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      continue;
    }

    const hostname = target.hostname.toLowerCase();
    if (
      target.href.length > MAX_UNSUBSCRIBE_URL_LENGTH ||
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      (target.port && target.port !== "443") ||
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      isIpLiteral(hostname)
    ) {
      continue;
    }

    return target;
  }

  return null;
}

export function isSameOriginUnsubscribeRequest(request: Request, requestUrl: URL): boolean {
  if (request.headers.get("origin") !== requestUrl.origin) {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite.toLowerCase() !== "same-origin") {
    return false;
  }

  return request.headers.get("x-requested-with") === "cf-email-worker";
}

export async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The status is sufficient; failure to cancel an already-closed body is harmless.
  }
}


export async function readRawEmailText(message: ForwardableEmailMessage): Promise<string> {
  const unknownRaw = (message as unknown as { raw?: unknown }).raw;
  if (!unknownRaw) {
    return "";
  }

  if (typeof unknownRaw === "string") {
    return unknownRaw;
  }

  if (unknownRaw instanceof ReadableStream) {
    return await new Response(unknownRaw).text();
  }

  if (unknownRaw instanceof ArrayBuffer) {
    return new TextDecoder().decode(unknownRaw);
  }

  if (typeof unknownRaw === "object" && unknownRaw !== null && "text" in unknownRaw) {
    const textMethod = (unknownRaw as { text?: () => Promise<string> }).text;
    if (typeof textMethod === "function") {
      return await textMethod();
    }
  }

  return "";
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function buildMailReference(message: ForwardableEmailMessage): MailReference {
  return {
    replyTo: (message.headers.get("reply-to") ?? "").trim(),
    envelopeFrom: message.from.trim(),
    inReplyTo: (message.headers.get("in-reply-to") ?? "").trim(),
    references: (message.headers.get("references") ?? "").trim(),
    cc: parseAddressListHeader(message.headers.get("cc"))
  };
}

export function parseMailReference(input: string): MailReference {
  const empty: MailReference = {
    replyTo: "",
    envelopeFrom: "",
    inReplyTo: "",
    references: "",
    cc: []
  };
  try {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return empty;
    }
    const obj = parsed as Record<string, unknown>;
    return {
      replyTo: typeof obj.replyTo === "string" ? obj.replyTo : "",
      envelopeFrom: typeof obj.envelopeFrom === "string" ? obj.envelopeFrom : "",
      inReplyTo: typeof obj.inReplyTo === "string" ? obj.inReplyTo : "",
      references: typeof obj.references === "string" ? obj.references : "",
      cc: Array.isArray(obj.cc) ? obj.cc.filter((item): item is string => typeof item === "string") : []
    };
  } catch {
    return empty;
  }
}

export function parseAddressListHeader(raw: string | null): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseMimeMail(rawText: string): ParsedMailContent {
  const normalized = rawText.replaceAll("\r\n", "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  const headersRaw = separatorIndex >= 0 ? normalized.slice(0, separatorIndex).trim() : normalized.trim();
  const bodyRaw = separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : "";
  const topHeaders = parseHeaderBlock(headersRaw);
  const leafParts = collectMimeLeafParts(topHeaders, bodyRaw);

  const htmlPart = leafParts.find((part) => isRenderableTextPart(part, "text/html"));
  const textPart = leafParts.find((part) => isRenderableTextPart(part, "text/plain"));

  const html = htmlPart
    ? decodePartBody(htmlPart.body, getHeader(htmlPart.headers, "content-transfer-encoding"), getHeader(htmlPart.headers, "content-type"))
    : null;
  const renderedHtml = html ? sanitizeEmailHtml(resolveInlineImageSources(html, leafParts)) : null;
  const renderedText = textPart
    ? decodePartBody(textPart.body, getHeader(textPart.headers, "content-transfer-encoding"), getHeader(textPart.headers, "content-type"))
    : null;

  return {
    headersRaw,
    bodyRaw,
    renderedHtml: renderedHtml || null,
    renderedText: renderedText || null
  };
}

function resolveInlineImageSources(html: string, parts: MimePart[]): string {
  return html.replace(/(<img\b[^>]*?\ssrc\s*=\s*)(["']?)(cid:[^\s"'<>]+)\2/gi, (original, prefix: string, _quote: string, source: string) => {
    let contentId: string;
    try {
      contentId = decodeURIComponent(decodeBasicHtmlEntities(source.slice(4)));
    } catch {
      return original;
    }

    const part = parts.find((candidate) => normalizeContentId(getHeader(candidate.headers, "content-id")) === contentId);
    if (!part) return original;
    const contentType = readMediaType(getHeader(part.headers, "content-type"));
    if (!contentType || !/^image\/[a-z0-9.+-]+$/i.test(contentType)) return original;

    const bytes = decodeBodyToBytes(part.body, getHeader(part.headers, "content-transfer-encoding"));
    return `${prefix}"data:${contentType};base64,${encodeBytesToBase64(bytes)}"`;
  });
}

export function collectMimeLeafParts(headers: Record<string, string>, body: string): MimePart[] {
  const contentType = getHeader(headers, "content-type");
  if (!contentType.toLowerCase().includes("multipart/")) {
    return [{ headers, body }];
  }

  const boundary = readBoundary(contentType);
  if (!boundary) {
    return [{ headers, body }];
  }

  const parts = splitMultipart(body, boundary);
  const leafParts: MimePart[] = [];
  for (const part of parts) {
    leafParts.push(...collectMimeLeafParts(part.headers, part.body));
  }
  return leafParts;
}

export function splitMultipart(body: string, boundary: string): MimePart[] {
  const marker = `--${boundary}`;
  const rawParts = body
    .split(marker)
    .map((part) => part.trim())
    .filter((part) => part && part !== "--");

  return rawParts.map((part) => {
    const withoutClosing = part.endsWith("--") ? part.slice(0, -2).trim() : part;
    const idx = withoutClosing.indexOf("\n\n");
    const headerBlock = idx >= 0 ? withoutClosing.slice(0, idx).trim() : withoutClosing.trim();
    const bodyBlock = idx >= 0 ? withoutClosing.slice(idx + 2) : "";
    return { headers: parseHeaderBlock(headerBlock), body: bodyBlock };
  });
}

export function extractAttachmentsFromRaw(rawText: string): ExtractedAttachment[] {
  if (!rawText.trim()) {
    return [];
  }

  const normalized = rawText.replaceAll("\r\n", "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  const headersRaw = separatorIndex >= 0 ? normalized.slice(0, separatorIndex).trim() : normalized.trim();
  const bodyRaw = separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : "";
  const topHeaders = parseHeaderBlock(headersRaw);
  const leafParts = collectMimeLeafParts(topHeaders, bodyRaw);

  const attachments: ExtractedAttachment[] = [];
  let counter = 1;
  for (const part of leafParts) {
    const contentTypeRaw = getHeader(part.headers, "content-type");
    const dispositionRaw = getHeader(part.headers, "content-disposition");
    const dispositionLower = dispositionRaw.toLowerCase();
    const filename = readFilename(dispositionRaw) ?? readNameParam(contentTypeRaw);
    if (!dispositionLower.includes("attachment") && !filename) {
      continue;
    }

    const id = `att-${counter}`;
    counter += 1;
    attachments.push({
      id,
      filename: sanitizeFilename(filename ?? `${id}.bin`),
      contentType: readMediaType(contentTypeRaw) ?? "application/octet-stream",
      bytes: decodeBodyToBytes(part.body, getHeader(part.headers, "content-transfer-encoding")),
      contentId: normalizeContentId(getHeader(part.headers, "content-id")),
      disposition: dispositionRaw || null
    });
  }
  return attachments;
}

export function parseHeaderBlock(block: string): Record<string, string> {
  const lines = block.split("\n");
  const unfolded: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
      continue;
    }
    unfolded.push(line);
  }

  const headers: Record<string, string> = {};
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return headers;
}

export function getHeader(headers: Record<string, unknown>, key: string): string {
  const normalizedKey = key.toLowerCase();
  const directValue = headers[normalizedKey];
  if (typeof directValue === "string") {
    return directValue;
  }

  for (const [headerKey, value] of Object.entries(headers)) {
    if (headerKey.toLowerCase() === normalizedKey && typeof value === "string") {
      return value;
    }
  }
  return "";
}

export function readBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

export function isRenderableTextPart(part: MimePart, expectedType: string): boolean {
  const contentType = getHeader(part.headers, "content-type").toLowerCase();
  if (!contentType.includes(expectedType)) return false;
  const disposition = getHeader(part.headers, "content-disposition").toLowerCase();
  return !disposition.includes("attachment");
}

export function decodePartBody(body: string, encoding: string, contentType: string): string {
  const bytes = decodeBodyToBytes(body, encoding);
  return decodeBytesToString(bytes, readCharset(contentType));
}

export function decodeBodyToBytes(body: string, encoding: string): Uint8Array {
  const normalized = encoding.toLowerCase();
  if (normalized.includes("base64")) {
    return decodeBase64ToBytes(body);
  }
  if (normalized.includes("quoted-printable")) {
    return decodeQuotedPrintableToBytes(body);
  }
  return new TextEncoder().encode(body);
}

export function decodeBase64ToBytes(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, "");
  if (!cleaned) return new Uint8Array();
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new TextEncoder().encode(input);
  }
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  // Chunk the conversion to stay below JavaScript's function argument limit.
  const chunkSize = 32768;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function decodeQuotedPrintableToBytes(input: string): Uint8Array {
  const softBreakRemoved = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < softBreakRemoved.length; i += 1) {
    const ch = softBreakRemoved[i];
    if (ch === "=" && i + 2 < softBreakRemoved.length) {
      const hex = softBreakRemoved.slice(i + 1, i + 3);
      if (/^[A-Fa-f0-9]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(softBreakRemoved.charCodeAt(i));
  }
  return Uint8Array.from(bytes);
}

export function decodeBytesToString(bytes: Uint8Array, charset: string | null): string {
  if (bytes.byteLength === 0) {
    return "";
  }
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // fallback
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function readCharset(contentType: string): string | null {
  const match = contentType.match(/charset="?([^";]+)"?/i);
  return match?.[1]?.trim() ?? null;
}

export function readFilename(disposition: string): string | null {
  const match = disposition.match(/filename\*?="?([^";]+)"?/i);
  if (!match?.[1]) return null;
  const raw = match[1].trim();
  let decoded = raw;
  if (raw.includes("''")) {
    const encoded = raw.split("''")[1] ?? "";
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      decoded = encoded;
    }
  }
  return decodeMimeWords(decoded);
}

export function readNameParam(contentType: string): string | null {
  const match = contentType.match(/name="?([^";]+)"?/i);
  if (!match?.[1]) return null;
  return decodeMimeWords(match[1].trim());
}

export function decodeMimeWords(text: string): string {
  if (!text || !text.includes('=?')) return text;
  
  // RFC 2047: space between adjacent encoded words is ignored
  const noSpace = text.replace(/\?=\s+=\?/g, '?==?');
  return noSpace.replace(/=\?([^?]+)\?([B|Q|b|q])\?([^?]+)\?=/g, (match, charset, encoding, data) => {
    try {
      const enc = encoding.toUpperCase();
      if (enc === 'B') {
        const bytes = decodeBase64ToBytes(data);
        return decodeBytesToString(bytes, charset);
      } else if (enc === 'Q') {
        const qData = data.replace(/_/g, ' ');
        const bytes = decodeQuotedPrintableToBytes(qData);
        return decodeBytesToString(bytes, charset);
      }
    } catch {
      // fallback to original if decoding fails
    }
    return match;
  });
}

export function readMediaType(contentType: string): string | null {
  const mediaType = contentType.split(";")[0]?.trim();
  return mediaType || null;
}

export function normalizeContentId(contentId: string): string | null {
  const trimmed = contentId.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^<|>$/g, "");
}

export function sanitizeFilename(input: string): string {
  const cleaned = input.trim().replaceAll("\\", "_").replaceAll("/", "_").replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned || "attachment.bin";
}

export function parseStoredAttachments(input: string): StoredAttachment[] {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredAttachment => {
      if (typeof item !== "object" || item === null) return false;
      const obj = item as Record<string, unknown>;
      return (
        typeof obj.id === "string"
        && typeof obj.filename === "string"
        && typeof obj.contentType === "string"
        && typeof obj.size === "number"
        && typeof obj.r2Key === "string"
      );
    });
  } catch {
    return [];
  }
}

export function buildContentDisposition(filename: string): string {
  const safe = filename.replaceAll("\"", "");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function decodeBasicHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function escapeHtmlAttr(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function getHtmlTagAttr(attrs: string, name: string): string | null {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(attrs);
  if (quoted) return quoted[2] ?? null;
  const unquoted = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i").exec(attrs);
  return unquoted?.[1] ?? null;
}

export function stripHtmlTagAttrs(attrs: string, names: string[]): string {
  let next = attrs;
  for (const name of names) {
    next = next.replace(new RegExp(`\\s*\\b${name}\\s*=\\s*(["'])[\\s\\S]*?\\1`, "gi"), "");
    next = next.replace(new RegExp(`\\s*\\b${name}\\s*=\\s*[^\\s>]+`, "gi"), "");
  }
  return next;
}

/** 僅允許 http(s)/mailto/tel；其餘（含 javascript:、相對路徑）移除。 */
export function sanitizeHref(raw: string | null): string | null {
  if (raw == null) return null;
  const href = decodeBasicHtmlEntities(raw).trim();
  if (!href) return null;

  const lower = href.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:")
  ) {
    return null;
  }

  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
    return href;
  }

  if (href.startsWith("//") && href.length > 2) {
    return `https:${href}`;
  }

  return null;
}

export function rewriteAnchorTags(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (_match, attrs: string) => {
    const safeHref = sanitizeHref(getHtmlTagAttr(attrs, "href"));
    const cleaned = stripHtmlTagAttrs(attrs, ["href", "target", "rel"]).trim();
    const prefix = cleaned ? ` ${cleaned}` : "";
    if (!safeHref) {
      return `<a${prefix}>`;
    }
    return `<a${prefix} href="${escapeHtmlAttr(safeHref)}" target="_blank" rel="noopener noreferrer">`;
  });
}

export function sanitizeEmailHtml(html: string): string {
  const noScript = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  const noIframe = noScript.replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "");
  const noBase = noIframe.replace(/<base\b[^>]*>/gi, "");
  const noMetaRefresh = noBase.replace(/<meta\b[^>]*http-equiv\s*=\s*(['"]?)refresh\1[^>]*>/gi, "");
  const noQuotedHandlers = noMetaRefresh.replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, "");
  const noEventHandlers = noQuotedHandlers.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  return rewriteAnchorTags(noEventHandlers).trim();
}

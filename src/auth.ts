import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./utils";
import { isAdminMailHost, jsonError, jsonOk } from "./utils";
import type { Identity, MailAccess } from "./access";
import { legacyMailAccess, publicIdentity } from "./access";
import { createPasswordRecord, equalPassword, validPassword, verifyPassword } from "./passwords";

const COOKIE = "__Host-mail-session";
const ISSUER = "cf-email-worker";
const SESSION_SECONDS = 3600;
const PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message); }
}

export interface MemberConfig {
  admin: string;
  adminPassword: string;
  pepper: string;
  jwtSecret: Uint8Array;
  receiveDomains: string[];
  sendDomains: string[];
}

export interface MemberRow {
  id: string;
  prefix: string;
  password_record: string | null;
  status: "active" | "disabled" | "deleted";
  role: "user" | "admin";
  must_change_password: number;
  auth_version: number;
  created_at: string;
  updated_at: string;
}

export function normalizePrefix(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_PREFIX");
  const prefix = value.trim().toLowerCase();
  if (!PREFIX_PATTERN.test(prefix) || prefix.includes("..")) throw new ApiError(400, "INVALID_PREFIX");
  return prefix;
}

export function configuredDomains(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new ApiError(503, "MEMBER_CONFIG_INVALID");
  const domains = value.map((domain: unknown) => {
    if (typeof domain !== "string") throw new ApiError(503, "MEMBER_CONFIG_INVALID");
    const normalized = domain.trim().toLowerCase();
    if (normalized.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
      throw new ApiError(503, "MEMBER_CONFIG_INVALID");
    }
    return normalized;
  });
  return [...new Set(domains)];
}

export function getMemberConfig(env: Env, hostname: string): MemberConfig | null {
  if (!isAdminMailHost(hostname, env.ADMIN_MAIL_HOSTS) || env.MEMBER === undefined) return null;
  const setting = env.MEMBER;
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) throw new ApiError(503, "MEMBER_CONFIG_INVALID");
  if (setting.enable === false || setting.enable === undefined || setting.admin === undefined || setting.admin === "") return null;
  if (setting.enable !== true) throw new ApiError(503, "MEMBER_CONFIG_INVALID");
  try {
    const admin = normalizePrefix(setting.admin);
    if (!validPassword(setting.password) || !env.MEMBER_PASSWORD_PEPPER || !env.MEMBER_JWT_SECRET) throw new Error("Missing secrets");
    return {
      admin, adminPassword: setting.password, pepper: env.MEMBER_PASSWORD_PEPPER,
      jwtSecret: new TextEncoder().encode(env.MEMBER_JWT_SECRET),
      receiveDomains: configuredDomains(env.RECEIVABLE_DOMAINS), sendDomains: configuredDomains(env.SENDABLE_DOMAINS)
    };
  } catch {
    throw new ApiError(503, "MEMBER_CONFIG_INVALID");
  }
}

function bootstrapSubject(config: MemberConfig): string {
  return `admin:${config.admin}`;
}

function credentialVersion(config: MemberConfig, bootstrap: boolean): string {
  return createHash("sha256").update(JSON.stringify(bootstrap
    ? [config.admin, config.adminPassword, config.pepper]
    : [config.pepper])).digest("hex");
}

export function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin ||
    (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") ||
    request.headers.get("x-requested-with") !== "cf-email-worker") throw new ApiError(403, "FORBIDDEN");
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(400, "INVALID_REQUEST");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new ApiError(413, "INVALID_REQUEST"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_REQUEST");
  } finally { reader.releaseLock(); }
}

export function requireMethod(request: Request, method: string): void {
  if (request.method !== method) throw new ApiError(405, "METHOD_NOT_ALLOWED");
}

export async function memberIdentity(env: Env, config: MemberConfig, member: MemberRow): Promise<Identity> {
  const role = member.role === "admin" ? "admin" : "user";
  if (role === "admin") {
    return {
      id: member.id, prefix: member.prefix, role, authVersion: member.auth_version,
      mustChangePassword: Boolean(member.must_change_password),
      receiveDomains: config.receiveDomains, sendDomains: config.sendDomains
    };
  }
  const { results } = await env.DB.prepare("SELECT domain, can_receive, can_send FROM member_domains WHERE member_id = ?")
    .bind(member.id).all<{ domain: string; can_receive: number; can_send: number }>();
  return {
    id: member.id, prefix: member.prefix, role, authVersion: member.auth_version,
    mustChangePassword: Boolean(member.must_change_password),
    receiveDomains: results.filter((row) => row.can_receive && config.receiveDomains.includes(row.domain)).map((row) => row.domain),
    sendDomains: results.filter((row) => row.can_send && config.sendDomains.includes(row.domain)).map((row) => row.domain)
  };
}

export async function authenticate(request: Request, env: Env, config: MemberConfig): Promise<Identity | null> {
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || token.length > 4096) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, config.jwtSecret, {
      algorithms: ["HS256"], issuer: ISSUER, audience: new URL(request.url).origin,
      requiredClaims: ["sub", "av", "cv", "iat", "exp"]
    }));
  } catch { return null; }
  if (typeof payload.sub !== "string" || typeof payload.cv !== "string" || !Number.isInteger(payload.av) ||
    (payload.role !== "admin" && payload.role !== "user")) return null;
  const bootstrap = payload.sub === bootstrapSubject(config);
  if (payload.cv !== credentialVersion(config, bootstrap)) return null;
  if (bootstrap) {
    if (payload.role !== "admin" || payload.av !== 0) return null;
    return { id: payload.sub, prefix: config.admin, role: "admin", authVersion: 0,
      mustChangePassword: false, receiveDomains: config.receiveDomains, sendDomains: config.sendDomains };
  }
  const member = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND status = 'active' AND auth_version = ?")
    .bind(payload.sub, payload.av).first<MemberRow>();
  if (!member) return null;
  return memberIdentity(env, config, member);
}

export function requireIdentity(identity: Identity | null, allowPasswordChange = false): Identity {
  if (!identity) throw new ApiError(401, "AUTH_REQUIRED");
  if (identity.mustChangePassword && !allowPasswordChange) throw new ApiError(403, "PASSWORD_CHANGE_REQUIRED");
  return identity;
}

export function requestMailAccess(env: Env, hostname: string, config: MemberConfig | null, identity: Identity | null): MailAccess {
  if (!config) return legacyMailAccess(env, hostname);
  return { memberEnabled: true, identity, toAddressLike: "", canSend: Boolean(identity && !identity.mustChangePassword && identity.sendDomains.length),
    sendableDomains: identity && !identity.mustChangePassword ? identity.sendDomains : [] };
}

function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function startSession(request: Request, env: Env, config: MemberConfig, identity: Identity): Promise<Response> {
  const bootstrap = identity.id === bootstrapSubject(config);
  if (!bootstrap) {
    const row = await env.DB.prepare("SELECT 1 AS ok FROM members WHERE id = ? AND status = 'active' AND auth_version = ?")
      .bind(identity.id, identity.authVersion).first();
    if (!row) throw new ApiError(401, "AUTH_REQUIRED");
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ role: identity.role, av: identity.authVersion, cv: credentialVersion(config, bootstrap) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(identity.id).setIssuer(ISSUER)
    .setAudience(new URL(request.url).origin).setIssuedAt(now).setExpirationTime(now + SESSION_SECONDS).sign(config.jwtSecret);
  const response = jsonOk({ identity: publicIdentity(identity) });
  response.headers.set("set-cookie", sessionCookie(token));
  return response;
}

export async function handleAuth(request: Request, env: Env, config: MemberConfig, identity: Identity | null): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/me") {
    requireMethod(request, "GET");
    return jsonOk({ identity: publicIdentity(requireIdentity(identity, true)) });
  }
  requireMethod(request, "POST");
  requireSameOrigin(request);
  if (path === "/api/auth/logout") {
    const response = jsonOk({ success: true });
    response.headers.set("set-cookie", sessionCookie("", 0));
    return response;
  }
  if (path === "/api/auth/login") {
    const body = await readJson(request);
    const prefix = normalizePrefix(body.prefix);
    if (typeof body.password !== "string" || body.password.length > 128) throw new ApiError(401, "INVALID_CREDENTIALS");
    const member = await env.DB.prepare("SELECT * FROM members WHERE prefix = ?").bind(prefix).first<MemberRow>();
    if (prefix === config.admin && member) throw new ApiError(503, "MEMBER_CONFIG_INVALID");
    const matches = prefix === config.admin
      ? equalPassword(body.password, config.adminPassword)
      : Boolean(member?.password_record) && await verifyPassword(body.password, member!.password_record!, config.pepper);
    if (!matches || (prefix !== config.admin && (!member || member.status !== "active"))) throw new ApiError(401, "INVALID_CREDENTIALS");
    const signedIn: Identity = prefix === config.admin
      ? { id: bootstrapSubject(config), prefix, role: "admin", authVersion: 0, mustChangePassword: false,
        receiveDomains: config.receiveDomains, sendDomains: config.sendDomains }
      : await memberIdentity(env, config, member!);
    return startSession(request, env, config, signedIn);
  }
  if (path === "/api/auth/password") {
    const current = requireIdentity(identity, true);
    if (current.id === bootstrapSubject(config)) throw new ApiError(403, "FORBIDDEN");
    const body = await readJson(request);
    if (typeof body.currentPassword !== "string" || body.currentPassword.length > 128 || !validPassword(body.password)) throw new ApiError(400, "INVALID_PASSWORD");
    const member = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND status = 'active'").bind(current.id).first<MemberRow>();
    if (!member?.password_record || !await verifyPassword(body.currentPassword, member.password_record, config.pepper)) throw new ApiError(400, "CURRENT_PASSWORD_INVALID");
    if (body.currentPassword === body.password) throw new ApiError(400, "PASSWORD_UNCHANGED");
    const password = await createPasswordRecord(body.password, config.pepper);
    const result = await env.DB.prepare(`UPDATE members SET password_record = ?, must_change_password = 0, auth_version = auth_version + 1, updated_at = ?
      WHERE id = ? AND status = 'active' AND auth_version = ?`).bind(password, new Date().toISOString(), current.id, current.authVersion).run();
    if (!result.meta.changes) throw new ApiError(401, "AUTH_REQUIRED");
    return startSession(request, env, config, { ...current, authVersion: current.authVersion + 1, mustChangePassword: false });
  }
  return jsonError("Not Found", 404, "NOT_FOUND");
}

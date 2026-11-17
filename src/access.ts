import type { Env, MailFolder } from "./utils";
import { getToAddressLikePattern, isAdminMailHost } from "./utils";

export interface Identity {
  id: string;
  prefix: string;
  role: "admin" | "user";
  authVersion: number;
  mustChangePassword: boolean;
  receiveDomains: string[];
  sendDomains: string[];
}

export interface MailAccess {
  memberEnabled: boolean;
  identity: Identity | null;
  toAddressLike: string;
  canSend: boolean;
  sendableDomains: string[];
}

export function publicIdentity(identity: Identity | null): object | null {
  if (!identity) return null;
  return { id: identity.id, prefix: identity.prefix, role: identity.role, mustChangePassword: identity.mustChangePassword,
    receiveDomains: identity.receiveDomains, sendDomains: identity.sendDomains };
}

export function memberModeEnabled(env: Env, hostname: string): boolean {
  return isAdminMailHost(hostname, env.ADMIN_MAIL_HOSTS) && env.MEMBER?.enable === true &&
    typeof env.MEMBER.admin === "string" && env.MEMBER.admin.trim().length > 0;
}

export function legacyMailAccess(env: Env, hostname: string): MailAccess {
  // A caller without an authenticated identity cannot fall back to legacy admin access.
  const memberEnabled = memberModeEnabled(env, hostname);
  return {
    memberEnabled,
    identity: null,
    toAddressLike: memberEnabled ? "" : getToAddressLikePattern(hostname, env.ADMIN_MAIL_HOSTS),
    canSend: !memberEnabled && isAdminMailHost(hostname, env.ADMIN_MAIL_HOSTS),
    sendableDomains: !memberEnabled && isAdminMailHost(hostname, env.ADMIN_MAIL_HOSTS) ? (env.SENDABLE_DOMAINS ?? []) : []
  };
}

export function mailWhere(access: MailAccess, folder?: MailFolder): { sql: string; values: string[] } {
  const identity = access.identity;
  if (!access.memberEnabled) {
    return { sql: "folder = 'inbox' AND to_address LIKE ?", values: [access.toAddressLike] };
  }
  if (!identity || identity.mustChangePassword) return { sql: "0", values: [] };
  if (identity.role === "admin") {
    return folder ? { sql: "folder = ?", values: [folder] } : { sql: "folder IN ('inbox', 'sent')", values: [] };
  }
  if (folder === "sent") return { sql: "folder = 'sent' AND owner_member_id = ?", values: [identity.id] };
  const addresses = identity.receiveDomains.map((domain) => `${identity.prefix}@${domain}`);
  const received = addresses.length
    ? `owner_member_id IS NULL AND LOWER(TRIM(to_address)) IN (${addresses.map(() => "?").join(", ")})`
    : "0";
  return {
    sql: folder === "inbox"
      ? `folder = 'inbox' AND (owner_member_id = ? OR (${received}))`
      : `(owner_member_id = ? OR (folder = 'inbox' AND ${received}))`,
    values: [identity.id, ...addresses]
  };
}

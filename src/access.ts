import type { Env, MailFolder } from "./utils";
import { escapeLikeForSql, getToAddressLikePattern, isAdminMailHost } from "./utils";

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

function mailboxes(prefix: string, domains: string[]): string[] {
  return domains.map((domain) => `${prefix}@${domain}`);
}

function addressIn(column: string, addresses: string[]): { sql: string; values: string[] } {
  if (!addresses.length) return { sql: "0", values: [] };
  return { sql: `${column} IN (${addresses.map(() => "?").join(", ")})`, values: addresses };
}

function sentFrom(addresses: string[]): { sql: string; values: string[] } {
  if (!addresses.length) return { sql: "0", values: [] };
  return {
    sql: addresses.map(() => "(LOWER(from_address) = ? OR LOWER(from_address) LIKE '%<' || ? || '>' ESCAPE '\\')").join(" OR "),
    values: addresses.flatMap((address) => [address, escapeLikeForSql(address)])
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
  const inbox = addressIn("LOWER(TRIM(to_address))", [...new Set([...mailboxes(identity.prefix, identity.receiveDomains), ...mailboxes(identity.prefix, identity.sendDomains)])]);
  const sent = sentFrom(mailboxes(identity.prefix, identity.sendDomains));
  if (folder === "inbox") return { sql: `folder = 'inbox' AND (${inbox.sql})`, values: inbox.values };
  if (folder === "sent") return { sql: `folder = 'sent' AND (${sent.sql})`, values: sent.values };
  return {
    sql: `((folder = 'inbox' AND (${inbox.sql})) OR (folder = 'sent' AND (${sent.sql})))`,
    values: [...inbox.values, ...sent.values]
  };
}

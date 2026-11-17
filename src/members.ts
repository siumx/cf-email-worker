import type { Env } from "./utils";
import { escapeLikeForSql, jsonOk, LIST_PAGE_SIZE, readListParamsFromSearchParams } from "./utils";
import type { Identity } from "./access";
import type { MemberConfig, MemberRow } from "./auth";
import { ApiError, normalizePrefix, readJson, requireIdentity, requireSameOrigin } from "./auth";
import { createPasswordRecord, generatePassword, validPassword } from "./passwords";

function requestedRole(value: unknown): "user" | "admin" | undefined {
  if (value === undefined) return undefined;
  if (value === "user" || value === "admin") return value;
  throw new ApiError(400, "INVALID_REQUEST");
}

function assignedDomains(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((domain) => typeof domain !== "string")) throw new ApiError(400, "DOMAIN_NOT_ALLOWED");
  const domains = [...new Set((value as string[]).map((domain) => domain.trim().toLowerCase()))];
  if (domains.some((domain) => !allowed.includes(domain))) throw new ApiError(400, "DOMAIN_NOT_ALLOWED");
  return domains;
}

function domainStatements(env: Env, id: string, receive: string[], send: string[]): D1PreparedStatement[] {
  const domains = [...new Set([...receive, ...send])];
  return [env.DB.prepare("DELETE FROM member_domains WHERE member_id = ?").bind(id),
    ...domains.map((domain) => env.DB.prepare(`INSERT INTO member_domains (member_id, domain, can_receive, can_send)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND status != 'deleted')`)
      .bind(id, domain, Number(receive.includes(domain)), Number(send.includes(domain)), id))];
}

async function listMembers(env: Env, config: MemberConfig, url: URL): Promise<Response> {
  const { page: requestedPage, q } = readListParamsFromSearchParams(url.searchParams);
  const search = q ? " AND (prefix LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM member_domains d WHERE d.member_id = members.id AND d.domain LIKE ? ESCAPE '\\'))" : "";
  const values = q ? [`%${escapeLikeForSql(q)}%`, `%${escapeLikeForSql(q)}%`] : [];
  const counts = await env.DB.prepare(`SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM members WHERE status != 'deleted'${search}`)
    .bind(...values).first<{ total: number; active: number }>();
  const total = Number(counts?.total ?? 0);
  const totalPages = Math.ceil(total / LIST_PAGE_SIZE);
  const page = Math.min(requestedPage, totalPages || 1);
  const { results: rows } = await env.DB.prepare(`SELECT id, prefix, status, role, must_change_password, created_at, updated_at
    FROM members WHERE status != 'deleted'${search} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
    .bind(...values, LIST_PAGE_SIZE, (page - 1) * LIST_PAGE_SIZE).all<MemberRow>();
  const ids = rows.map((row) => row.id);
  const domains = ids.length ? (await env.DB.prepare(`SELECT member_id, domain, can_receive, can_send FROM member_domains WHERE member_id IN (${ids.map(() => "?").join(", ")})`)
    .bind(...ids).all<{ member_id: string; domain: string; can_receive: number; can_send: number }>()).results : [];
  return jsonOk({ members: rows.map((row) => ({
    id: row.id, prefix: row.prefix, status: row.status, role: row.role === "admin" ? "admin" : "user",
    mustChangePassword: Boolean(row.must_change_password), createdAt: row.created_at, updatedAt: row.updated_at,
    receiveDomains: domains.filter((domain) => domain.member_id === row.id && domain.can_receive).map((domain) => domain.domain),
    sendDomains: domains.filter((domain) => domain.member_id === row.id && domain.can_send).map((domain) => domain.domain)
  })), receiveDomains: config.receiveDomains, sendDomains: config.sendDomains,
  page, totalPages, total, active: Number(counts?.active ?? 0) });
}

export async function handleMembers(request: Request, env: Env, config: MemberConfig, identity: Identity | null): Promise<Response> {
  if (requireIdentity(identity).role !== "admin") throw new ApiError(403, "FORBIDDEN");
  const url = new URL(request.url);
  if (url.pathname === "/api/members" && request.method === "GET") return listMembers(env, config, url);
  requireSameOrigin(request);
  if (url.pathname === "/api/members" && request.method === "POST") {
    const body = await readJson(request);
    const prefix = normalizePrefix(body.prefix);
    if (prefix === config.admin) throw new ApiError(400, "PREFIX_RESERVED");
    const role = requestedRole(body.role) ?? "user";
    const receive = role === "admin" ? [] : assignedDomains(body.receiveDomains, config.receiveDomains);
    const send = role === "admin" ? [] : assignedDomains(body.sendDomains, config.sendDomains);
    if (role === "user" && !receive.length && !send.length) throw new ApiError(400, "DOMAIN_REQUIRED");
    const password = body.password === undefined || body.password === "" ? generatePassword() : body.password;
    if (!validPassword(password)) throw new ApiError(400, "INVALID_PASSWORD");
    const record = await createPasswordRecord(password, config.pepper);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO members (id, prefix, password_record, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(id, prefix, record, role, now, now), ...domainStatements(env, id, receive, send)
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: members.prefix")) throw new ApiError(409, "PREFIX_TAKEN");
      throw error;
    }
    return jsonOk({ success: true, id, initialPassword: password });
  }
  const match = url.pathname.match(/^\/api\/members\/([a-f0-9-]+)(\/password)?$/i);
  if (!match) throw new ApiError(404, "NOT_FOUND");
  const id = match[1];
  const member = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND status != 'deleted'").bind(id).first<MemberRow>();
  if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND");
  if (match[2]) {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED");
    const body = await readJson(request);
    const password = body.password === undefined || body.password === "" ? generatePassword() : body.password;
    if (!validPassword(password)) throw new ApiError(400, "INVALID_PASSWORD");
    const record = await createPasswordRecord(password, config.pepper);
    const result = await env.DB.prepare(`UPDATE members SET password_record = ?, must_change_password = 1, auth_version = auth_version + 1, updated_at = ?
      WHERE id = ? AND status != 'deleted'`).bind(record, new Date().toISOString(), id).run();
    if (!result.meta.changes) throw new ApiError(404, "MEMBER_NOT_FOUND");
    return jsonOk({ success: true, initialPassword: password });
  }
  if (request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET status = 'deleted', password_record = NULL, auth_version = auth_version + 1, updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), id),
      env.DB.prepare("DELETE FROM member_domains WHERE member_id = ?").bind(id)
    ]);
    return jsonOk({ success: true });
  }
  if (request.method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED");
  const body = await readJson(request);
  const role = requestedRole(body.role);
  if ((body.prefix !== undefined && body.prefix !== member.prefix) ||
    (body.status !== undefined && body.status !== "active" && body.status !== "disabled")) throw new ApiError(400, "INVALID_REQUEST");
  const nextRole = role ?? (member.role === "admin" ? "admin" : "user");
  const changes: D1PreparedStatement[] = [env.DB.prepare(`UPDATE members SET status = COALESCE(?, status), role = COALESCE(?, role),
    auth_version = auth_version + CASE WHEN (? IS NOT NULL AND status != ?) OR (? IS NOT NULL AND role != ?) THEN 1 ELSE 0 END, updated_at = ?
    WHERE id = ? AND status != 'deleted'`).bind(body.status ?? null, role ?? null, body.status ?? null, body.status ?? null, role ?? null, role ?? null, new Date().toISOString(), id)];
  if (nextRole === "admin") changes.push(env.DB.prepare("DELETE FROM member_domains WHERE member_id = ?").bind(id));
  else if (body.receiveDomains !== undefined || body.sendDomains !== undefined || (role === "user" && member.role === "admin")) {
    if (role === "user" && member.role === "admin" && (!Array.isArray(body.receiveDomains) || !Array.isArray(body.sendDomains))) throw new ApiError(400, "DOMAIN_REQUIRED");
    const receive = assignedDomains(body.receiveDomains, config.receiveDomains);
    const send = assignedDomains(body.sendDomains, config.sendDomains);
    if (!receive.length && !send.length) throw new ApiError(400, "DOMAIN_REQUIRED");
    changes.push(...domainStatements(env, id, receive, send));
  }
  const results = await env.DB.batch(changes);
  if (!results[0]?.meta.changes) throw new ApiError(404, "MEMBER_NOT_FOUND");
  return jsonOk({ success: true });
}

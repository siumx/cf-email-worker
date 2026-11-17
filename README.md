# Cloudflare Email Worker

[中文](docs/README_zh.md)

![Cloudflare Email Worker](docs/images/cover.jpg)

Receives mail through Cloudflare Email Routing and serves webmail from a Worker. D1 stores message data. R2 stores attachments and larger raw messages.

## Try it

Open [https://demo.emailwk.itdog.ai](https://demo.emailwk.itdog.ai). 
That host lists mail for `demo@emailwk.itdog.ai`. (not catch-all)

## Features

- Inbox paging, search by subject, sender, or recipient, and automatic refresh.
- HTML and plain-text bodies, remote and CID inline images, raw source, full headers, and attachment downloads.
- Admin hosts can send plain-text mail with CC, BCC, and attachments. A successful send is stored in `sent`. A failed send is written to the inbox as a notice.
- Accepts messages that include a one-click unsubscribe header.
- Optional member login on admin hosts, with separate receive/send domain permissions, password initialization, member management, and sent-mail browsing.

## First-time setup

Requires Node.js 22.18 or newer, and Email Routing enabled on the Cloudflare zone.

Sending from the Worker requires a Workers Paid plan. After that, set the sending domain in the Cloudflare dashboard so the Worker can send directly.

```bash
git clone https://github.com/siumx/cf-email-worker.git
cp package.json.example package.json
cp wrangler.toml.example wrangler.toml
npx wrangler login
npm run init
npm run deploy
```

- `wrangler.toml`: set the site hostnames. Before `npm run init`, check that this Cloudflare account does not already have a D1 named `email-worker-db` or an R2 bucket named `email-worker`. 
- `ADMIN_MAIL_HOSTS`: full hostnames that can read every inbox and send mail. Any other host drops its first label and only shows mail for the remaining recipient domain. `mail.example.com` therefore matches `*@example.com`.
- `SENDABLE_DOMAINS`: sender domains this Worker may use. Sending is disabled when the value is unset or an empty array.
- `RECEIVABLE_DOMAINS`: domains that an admin may assign to members for reading mail. This does not change Email Routing ingestion or other hosts' catch-all views.

After deploy, point the destination addresses or the catch-all in Cloudflare Email Routing at this Worker. Walkthrough: [Cloudflare Email Routing Setup](docs/Cloudflare_Email_Routing_Setup.md).

## Optional members

Member mode applies **only to `ADMIN_MAIL_HOSTS`**. Other route hosts retain their existing catch-all view and cannot send, even with an admin session. They can still display all recipients in their matching domain, including member addresses. Without member mode, continue protecting admin hosts with Cloudflare Access.

Enable member mode in the config, and set the receive and send domains separately:

```toml
[vars]
ADMIN_MAIL_HOSTS = ["mailadmin.example.com"]
MEMBER = { enable = true, admin = "admin", password = "admin"} # <-- bootstrap admin; turn it off after setup
RECEIVABLE_DOMAINS = ["example.com", "abc.com"]
SENDABLE_DOMAINS = ["example.com", "notify.example.com"]
```

Deploy with the existing command. If `MEMBER` is unset or `enable = false`, the original mode stays. Omitting `admin` does not turn member mode off. When member mode is enabled but a Secret is missing or malformed, the Worker returns a configuration error and does not grant anonymous admin access.

The `MEMBER` admin is not stored in the member table. That account can read all stored mail, use every send domain, and create, disable, and delete members, assign domains, and reset passwords. Sign in and create the first member. A member account is a fixed mailbox prefix and is not case-sensitive. For example, `user` with receive access to `example.com` and `abc.com` can read only `user@example.com` and `user@abc.com`. Send domains are assigned separately. Removing a domain from the global list takes effect on the next request.

New members, and members whose passwords were reset, must change the initial password before using the mailbox. Passwords use scrypt (`N=16384, r=8, p=5`) with a random salt, then HMAC-SHA256 with the pepper in a Worker Secret. Login uses a one-hour HS256 JWT in a host-only, Secure, HttpOnly, SameSite cookie. The server does not store login state.

## Layout

- `src/`: Worker. `index.ts` routes requests, `handlers.ts` handles mail, `db.ts` talks to D1. `npm run init` applies `src/SQL/schema.sql` first, then the other SQL files in `src/SQL/`.
- `public/`: webmail UI, served as Worker assets.
- `migrations/`: D1 upgrades for existing installations. `scripts/member-admin.mjs` initializes or updates admin secrets.
- `wrangler.toml.example`: config template. Copy it to `wrangler.toml`.

## API

Routes are in `src/index.ts`. Callers must handle `400`, `401`, `403`, `404`, `405`, `409`, and `503`. Member APIs are unavailable outside enabled admin hosts. Writes require a matching `Origin` and `X-Requested-With: cf-email-worker`; browser sessions use the same-origin cookie. Private API responses are not cached.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Host mode, login state, identity and allowed sender domains; public bootstrap |
| `GET` | `/api/mails?page=&q=&folder=inbox` | Scoped list; member mode also supports `folder=sent` |
| `GET` | `/api/mails/:id` | One message |
| `GET` | `/api/mails/:id/attachments/:attachmentId` | Attachment download |
| `POST` | `/api/mails/:id/unsubscribe` | One-click unsubscribe |
| `POST` | `/api/send` | Send mail. Admin hosts only |
| `POST` | `/api/auth/login` | `{prefix, password}` → identity and session cookie |
| `POST` | `/api/auth/logout` | Clear the session cookie; the token stays valid until it expires |
| `GET` | `/api/auth/me` | Current identity, including the initial-password flag |
| `POST` | `/api/auth/password` | User only: `{currentPassword, password}`; reject old tokens and issue a new one |
| `GET` | `/api/members?page=&q=` | Admin only: paged members, counts and domain choices |
| `POST` | `/api/members` | Admin only: `{prefix, password?, receiveDomains, sendDomains}` → ID and one-time initial password |
| `PATCH` | `/api/members/:id` | Admin only: `{status?}` and/or both domain arrays; prefix is immutable |
| `DELETE` | `/api/members/:id` | Admin only: revoke access and reserve the prefix |
| `POST` | `/api/members/:id/password` | Admin only: `{password?}` → one-time initial password and reject existing tokens |

## Limits

- Member isolation applies only to enabled admin hosts. Other hosts keep their existing catch-all access. Use Cloudflare Access for any hosts that should not be publicly readable.
- Message HTML is shown in a sandboxed iframe. Layout and images stay; scripts and event handlers are removed. Remote images load directly, so the sender can tell that the message was opened.

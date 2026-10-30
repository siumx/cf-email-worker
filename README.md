# Cloudflare Email Worker

[中文](docs/README_zh.md)

![Cloudflare Email Worker](docs/images/cover.jpg)

Receives mail through Cloudflare Email Routing and serves webmail from a Worker. D1 stores message data. R2 stores attachments and larger raw messages.

## Features

- Inbox paging, search by subject, sender, or recipient, and automatic refresh.
- HTML and plain-text bodies, remote and CID inline images, raw source, full headers, and attachment downloads.
- Admin hosts can send plain-text mail with CC, BCC, and attachments. A successful send is stored in `sent`. A failed send is written to the inbox as a notice.
- Accepts messages that include a one-click unsubscribe header. The web UI lists `inbox` only.

## First-time setup

Requires Node.js 22 or newer, and Email Routing enabled on the Cloudflare zone.

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

After deploy, point the destination addresses or the catch-all in Cloudflare Email Routing at this Worker. Walkthrough: [Cloudflare Email Routing Setup](docs/Cloudflare_Email_Routing_Setup.md).

## Layout

- `src/`: Worker. `index.ts` routes requests, `handlers.ts` handles mail, `db.ts` talks to D1, `SQL/schema.sql` is the schema applied by `npm run init`.
- `public/`: webmail UI, served as Worker assets.
- `wrangler.toml.example`: config template. Copy it to `wrangler.toml`.

## API

There is no separate API document. Routes are in `src/index.ts`. Callers must handle `400`, `404`, and `405`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Whether this host may send, and its allowed sender domains |
| `GET` | `/api/mails?page=&q=` | Inbox list for the current host |
| `GET` | `/api/mails/:id` | One message |
| `GET` | `/api/mails/:id/attachments/:attachmentId` | Attachment download |
| `POST` | `/api/mails/:id/unsubscribe` | One-click unsubscribe |
| `POST` | `/api/send` | Send mail. Admin hosts only |

## Limits

- There is no built-in login. Host settings only limit which mail a visitor can see and who can send. Put the site and the API behind Cloudflare Access.
- Message HTML is shown in a sandboxed iframe. Layout and images stay; scripts and event handlers are removed. Remote images load directly, so the sender can tell that the message was opened.

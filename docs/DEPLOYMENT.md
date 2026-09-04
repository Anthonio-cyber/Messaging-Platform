# Deploying Veylo

Veylo is a Node.js API with an attached Socket.IO server and a static React bundle, backed by
PostgreSQL and S3-compatible object storage. It deploys as one container or as a split
frontend and backend.

---

## Before you start

You need:

- **PostgreSQL 14 or newer** — Neon, Supabase, RDS, Render, Railway, or your own
- **S3-compatible object storage** — AWS S3, Cloudflare R2, Backblaze B2, or MinIO
- **A domain with TLS** — Veylo refuses to boot in production unless `COOKIE_SECURE=true`
- **An SMTP provider** — for password resets, address confirmation and security alerts

WebSockets must survive your proxy. Serverless platforms that terminate long-lived
connections (classic Vercel or Netlify functions) cannot host the realtime server; put the API
on a platform that supports persistent processes and, if you like, host the static bundle
anywhere.

---

## Choose a shape

### One container (simplest)

The included `Dockerfile` builds the API and the web bundle, and the server serves the bundle
with SPA fallback routing. One origin, no CORS to configure, no cookie-domain puzzle.

```bash
docker build -t veylo .
docker run --env-file .env -p 4000:4000 veylo
```

Point your load balancer at port 4000 and terminate TLS there.

### Split frontend and backend

Serve `web/dist` from a CDN and run the API separately. Both must be on the **same site** for
the session cookie to be sent, since it is `SameSite=Lax`:

```
APP_URL=https://app.veylo.chat
API_URL=https://api.veylo.chat
COOKIE_DOMAIN=.veylo.chat
CORS_ORIGINS=https://app.veylo.chat
```

Build the frontend with `VITE_API_URL=https://api.veylo.chat` so it calls the right origin.

Different registrable domains will not work: the browser will withhold the cookie. That is a
deliberate constraint — it is what makes the CSRF posture sound.

---

## DNS

For `IDENTITY_DOMAIN=veylo.chat`:

| Record | Points at | Purpose |
| --- | --- | --- |
| `app.veylo.chat` | The web app | Where people use Veylo |
| `api.veylo.chat` | The API | HTTP and WebSocket traffic |
| `veylo.chat` | Landing page (or the app) | Marketing and legal pages |

`IDENTITY_DOMAIN` is only the suffix on user addresses. Veylo does **not** run a mail server,
and `anagkazo@veylo.chat` is not an email address — it is a Veylo identity. If you also want
to receive email at that domain, configure MX records for your mail provider separately; the
two do not conflict.

---

## Environment

Copy `.env.example` and fill it in. The server validates everything at boot and refuses to
start on a bad configuration.

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # DATA_ENCRYPTION_KEY  (must differ)
```

A production checklist:

```bash
NODE_ENV=production
DATABASE_URL=postgres://…            # with ?sslmode=require on most managed providers
DATABASE_SSL=true
AUTH_SECRET=…                        # 32+ bytes
DATA_ENCRYPTION_KEY=…                # 32+ bytes, different from AUTH_SECRET
APP_URL=https://app.veylo.chat
API_URL=https://api.veylo.chat
IDENTITY_DOMAIN=veylo.chat
COOKIE_DOMAIN=.veylo.chat
COOKIE_SECURE=true                   # mandatory; the server will not boot without it
TRUST_PROXY=true                     # behind a load balancer
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
STORAGE_BUCKET=veylo-attachments
STORAGE_ACCESS_KEY=…
STORAGE_SECRET_KEY=…
SMTP_URL=smtps://apikey:SG.xxxx@smtp.sendgrid.net:465
MAIL_FROM=Veylo <no-reply@veylo.chat>
RATE_LIMIT_TRUSTED_IPS=<your uptime checker's IP>
ADMIN_BOOTSTRAP_ADDRESS=you@veylo.chat   # remove after the first admin exists
```

### On the two secrets

- **`AUTH_SECRET`** signs session tokens and blind indexes. Rotating it signs everyone out and
  makes recovery-email lookups fail until each address is re-saved.
- **`DATA_ENCRYPTION_KEY`** encrypts recovery emails at rest. Rotating it makes existing
  recovery addresses permanently unreadable, which silently breaks password resets. Rotate it
  only with a migration that re-encrypts the column.

Neither key can decrypt message content. Losing both is survivable; losing the database is not.

### The first administrator

Set `ADMIN_BOOTSTRAP_ADDRESS` to the identity you intend to register, create that account, and
it is promoted to `admin` on creation. **Remove the variable afterwards** — otherwise anyone
who guesses the identity and registers it first inherits the role.

To promote someone later, an existing admin uses the dashboard, or:

```sql
UPDATE users SET role = 'admin' WHERE username = 'you';
```

---

## Object storage

Create a **private** bucket. Veylo signs short-lived URLs (five minutes) or proxies downloads
through the authorising API route; either way, public bucket access is never required and
should be off.

Attachments arrive already encrypted by the sender's browser, so a storage-side breach
exposes ciphertext. Server-side encryption is enabled on AWS S3 as defence in depth.

CORS on the bucket is only needed if you let browsers follow signed URLs directly:

```json
[{ "AllowedOrigins": ["https://app.veylo.chat"],
   "AllowedMethods": ["GET"],
   "AllowedHeaders": ["*"],
   "MaxAgeSeconds": 3000 }]
```

---

## Migrations

```bash
npm run build
node server/dist/db/migrate.js
```

Run this before the new version takes traffic. The compose file does exactly that in its
start command.

Migrations are immutable: the runner stores a SHA-256 of each file and refuses to start if an
applied migration has changed. To alter the schema, add a new numbered file. This catches the
classic "edited a migration that production already ran" failure at boot instead of in
production.

---

## Reverse proxy

WebSockets need upgrade headers passed through, and `TRUST_PROXY=true` so client IPs are read
from `X-Forwarded-For`.

**nginx:**

```nginx
location / {
  proxy_pass http://127.0.0.1:4000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 300s;
}
```

**Caddy:**

```
app.veylo.chat {
  reverse_proxy 127.0.0.1:4000
}
```

Caddy handles TLS and WebSocket upgrades without extra configuration.

---

## Scaling

Veylo runs fine on a single instance for a long time. When you outgrow one:

1. **Socket.IO needs an adapter.** Events are emitted to rooms; with several instances, a user
   connected to instance B will not receive an event emitted on instance A. Add
   `@socket.io/redis-adapter` and attach it in `server/src/realtime/socket.ts`.
2. **Rate limiting needs a shared store.** The in-memory limiter multiplies the effective
   limit by the instance count. The `login_attempts` table already works across instances, so
   sign-in protection stays correct — but move the fast path to Redis.
3. **Storage must not be local.** `STORAGE_DRIVER=local` writes to a container filesystem that
   does not survive a redeploy and is not shared. Use S3.
4. **Database connections.** `DATABASE_POOL_MAX` is per instance. Multiply by instance count
   and keep the total under your provider's limit; add PgBouncer if that gets tight.

---

## Backups

The database is the only thing you cannot rebuild. Object storage holds ciphertext that is
useless without the message keys in the database.

- Automated daily snapshots with point-in-time recovery
- **Test a restore.** A backup you have never restored is a hypothesis
- Store `AUTH_SECRET` and `DATA_ENCRYPTION_KEY` in a secret manager, versioned. Restoring a
  database without its `DATA_ENCRYPTION_KEY` loses every recovery email

---

## Monitoring

`GET /api/health` returns `200` with `{"status":"ok","database":"ok"}`, or `503` when the
database is unreachable. Point your load balancer's health check at it, and add its IP to
`RATE_LIMIT_TRUSTED_IPS`.

Worth alerting on:

- `/api/health` returning non-200
- Sustained 429s (an attack, or limits set too low)
- `security_events` rows with `severity = 'critical'`
- Database connection saturation
- Growth in `attachments` rows with `message_id IS NULL` — uploads that were never attached
  to a message and are candidates for cleanup

---

## Housekeeping

The server purges long-expired sessions hourly. Two jobs are worth adding as your data grows:

```sql
-- Uploads abandoned before being attached to a message
DELETE FROM attachments WHERE message_id IS NULL AND created_at < now() - interval '24 hours';

-- Sign-in attempt records past their usefulness for abuse detection
DELETE FROM login_attempts WHERE created_at < now() - interval '30 days';
```

Delete the corresponding objects from storage when removing orphaned attachment rows.

---

## Legal and operational obligations

Before letting real people use this:

1. **Review `docs/SECURITY.md`** and confirm the claims match your deployment
2. **Review the Privacy Policy and Terms** in `web/src/pages/Legal.tsx`. They describe what
   this codebase does; they are not legal advice, and they must be checked against your
   jurisdiction, your hosting arrangement and your retention practice
3. **Publish a security contact** and a vulnerability disclosure policy
4. **Decide your law-enforcement posture** in advance. You can produce account records and
   delivery metadata; you cannot produce message content
5. **Staff the report queue.** Message content is encrypted, so moderation depends on user
   reports. An unattended queue is an unmoderated platform

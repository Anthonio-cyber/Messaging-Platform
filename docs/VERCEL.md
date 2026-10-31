# Deploying Veylo to Vercel

Vercel serves the built bundle from its CDN and runs the API as a serverless function. Nothing
has to wake up, so there is no container cold start.

**One trade-off, stated up front:** a serverless function cannot hold a WebSocket open, so
Socket.IO does not run here. The browser detects that and falls back to polling `/api/sync`.
Messages arrive within about three seconds instead of instantly, and typing indicators and
live presence are unavailable. The sidebar says which mode is active. Every persistent host —
the Docker image, a VPS, Fly, Render — keeps the WebSocket and true push with no code change.

Everything Vercel needs is already committed: `vercel.json`, `api/index.mjs`, and a build that
applies database migrations before the new version serves traffic.

---

## 1. Import the repository

In the Vercel dashboard: **Add New → Project → Import Git Repository**, and choose this
repository.

If it does not appear in the list, Vercel's GitHub App has not been granted access to it.
Click **Adjust GitHub App Permissions** at the bottom of the import list, add this repository
to the installation, and it will show up. Vercel's API cannot grant itself that access, which
is why this step is manual.

Leave the framework preset as **Other**. `vercel.json` supplies the build command, the output
directory and the function settings.

## 2. Provision a database

Any PostgreSQL 14+ instance works. [Neon](https://neon.tech) has a free tier that suits this
well: its compute suspends when idle and wakes in well under a second, so it does not
reintroduce the cold start you avoided by using Vercel.

Copy the connection string. It looks like:

```
postgresql://USER:PASSWORD@HOST.neon.tech/DATABASE?sslmode=require
```

## 3. Set the environment variables

**Project → Settings → Environment Variables.** Add these for *Production*, *Preview* and
*Development*, then redeploy.

```bash
DATABASE_URL=postgresql://…            # from step 2
DATABASE_SSL=true

# Generate each separately: openssl rand -base64 32
AUTH_SECRET=…                          # signs session tokens and blind indexes
DATA_ENCRYPTION_KEY=…                  # encrypts recovery emails at rest — must differ

APP_URL=https://your-project.vercel.app
API_URL=https://your-project.vercel.app
IDENTITY_DOMAIN=veylo.chat             # the suffix on user addresses
COOKIE_SECURE=true                     # mandatory; the server refuses to boot without it
TRUST_PROXY=true                       # Vercel sits in front of the function

# Optional. Without SMTP, password-reset links are written to the function log
# instead of being emailed, which is fine for a trial and not for real users.
SMTP_URL=
MAIL_FROM=Veylo <no-reply@example.com>

# Promotes this identity to admin on first registration. Remove it afterwards,
# or whoever registers that name first inherits the role.
ADMIN_BOOTSTRAP_ADDRESS=you@veylo.chat
```

`APP_URL` and `API_URL` are the same value here, because one Vercel deployment serves both the
app and the API.

There are no build-time secrets: `npm run build` runs `tsc` and `vite`, neither of which reads
them. A project missing its variables still builds, then fails at request time — which is the
intended behaviour rather than a silently half-configured deployment.

## 4. Deploy

Push to the production branch, or hit **Redeploy**. The build compiles both workspaces and
then runs the migrations, so the schema is current before the new version serves traffic. The
migration runner takes a Postgres advisory lock, so concurrent builds cannot race.

Check `/api/health` — it returns `{"status":"ok","database":"ok"}` when the database is
reachable, and `503` when it is not.

## 5. Object storage for attachments

Attachments need S3-compatible storage. Without it, uploads fail; everything else works.

Vercel's filesystem is read-only apart from `/tmp`, so `STORAGE_DRIVER=local` is not an option
here. Point it at Cloudflare R2, AWS S3, or Backblaze B2:

```bash
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_BUCKET=veylo-attachments
STORAGE_ACCESS_KEY=…
STORAGE_SECRET_KEY=…
STORAGE_FORCE_PATH_STYLE=true
```

Keep the bucket **private**. Veylo signs short-lived URLs or proxies downloads through the
authorising route; public access is never required. Attachments arrive already encrypted by
the sender's browser, so a storage breach exposes ciphertext.

## 6. A custom domain

Add it under **Project → Settings → Domains**, then update:

```bash
APP_URL=https://app.privchat.com
API_URL=https://app.privchat.com
IDENTITY_DOMAIN=privchat.com
```

`IDENTITY_DOMAIN` is only the suffix on user addresses. Veylo does not run a mail server, and
`you@privchat.com` is a Veylo identity, not an email address. Configuring MX records for real
email at the same domain does not conflict with it.

---

## Watch this as usage grows

Polling costs one function invocation per connected client every few seconds. That is
comfortable for a small deployment and is the first thing to check against your plan's limits
as traffic grows. Moving the API to a persistent host removes both the polling and its cost,
and restores instant push.

The in-memory rate limiter is also per-instance, and serverless means many instances. The
sign-in protection that matters is backed by the `login_attempts` table, which every instance
shares, so brute-force defence stays correct — but the general limiter is effectively looser
than its configured number. `docs/DEPLOYMENT.md` covers moving it to Redis.

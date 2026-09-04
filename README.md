# Veylo

**Private messaging with an identity instead of a phone number.**

Veylo is a full-stack messaging platform where accounts are created without a phone number.
Every user gets a custom address — `anagkazo@veylo.chat` — that doubles as their sign-in name
and the only thing anyone needs in order to reach them.

Messages are encrypted in the browser before they are sent. The server stores ciphertext and
one copy of each message key sealed to each recipient's public key; it holds no key that
opens any of them.

```
you@veylo.chat  ←  the only thing you share
```

---

## What is actually built

| Area | Status |
| --- | --- |
| Authentication | Registration, sign-in by username **or** address, sign-out, sign-out-everywhere, password change, password reset over email, recovery codes, recovery-address verification, account deletion |
| Encryption | Argon2id key derivation in the browser, X25519 identity keys, XSalsa20-Poly1305 message encryption, sealed-box key wrapping per recipient, client-side file encryption |
| Messaging | Direct and group conversations, replies, edits, deletes (for me / for everyone), reactions, pins, forwards, copy, attachments, message search over decrypted history |
| Message requests | A first approach queues as a request; accept, decline, or block. Nothing lands in an inbox uninvited |
| Groups | Owner/admin/member roles, permission matrix, invite links, add/remove, ownership transfer, leave, delete |
| Realtime | Socket.IO with per-socket authorisation, typing indicators, presence, delivery and read receipts, live notifications |
| Privacy | Who can contact you, discovery, online status, last seen, avatar, profile visibility, read receipts, typing indicators — enforced in the serializer and in SQL |
| Safety | Blocking, abuse reports with optional reporter-supplied excerpts, report queue |
| Admin | Role-gated dashboard: stats, user management, suspend/ban/restore, role changes, report review, security feed, audit log |
| Security | CSRF double-submit, CORS allowlist, CSP, HSTS, layered rate limiting, durable brute-force detection, session expiry and idle timeout, unfamiliar-login alerts |
| Storage | S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO) with a local-disk driver for development |

---

## Quick start

**Requirements:** Node.js 20.10+, PostgreSQL 14+.

```bash
git clone <your-fork> veylo && cd veylo
npm install

cp .env.example .env
# Generate the two secrets and paste them into .env:
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # DATA_ENCRYPTION_KEY

createdb veylo                 # or point DATABASE_URL at any Postgres instance
npm run migrate
npm run seed                   # development accounts, optional

npm run dev                    # API on :4000, web app on :5173
```

Open <http://localhost:5173>.

`npm run seed` prints the sign-in details it created. Those accounts exist only for local
development — the seed script refuses to run when `NODE_ENV=production`.

### With Docker

```bash
cp .env.example .env    # fill in AUTH_SECRET and DATA_ENCRYPTION_KEY
docker compose up --build
```

This brings up PostgreSQL, MinIO for object storage, and Veylo on <http://localhost:4000>,
running migrations before the server accepts traffic.

---

## How the encryption works

The design goal is narrow and testable: **the server must never be able to read a message,
even with full database access.**

### Passwords never reach the server

The browser derives two independent keys from the passphrase with Argon2id:

```
authenticator = Argon2id(passphrase, auth_salt)    → sent to the server
vaultKey      = Argon2id(passphrase, vault_salt)   → never leaves the device
```

The server treats `authenticator` as an opaque secret and stores only `scrypt(authenticator)`.
`vaultKey` unseals the account's X25519 private key, which is what makes messages readable.
Because the server never sees the passphrase or the vault key, it cannot derive the identity
key even if it wanted to.

The salt lookup endpoint returns stable, deterministic decoy salts for identities that do not
exist, so it cannot be used to enumerate accounts.

### Messages

```
messageKey  = 32 random bytes
ciphertext  = XSalsa20-Poly1305(payload, nonce, messageKey)      crypto_secretbox
wrappedKey  = sealed box of messageKey to each member's pubkey   crypto_box_seal
```

The server stores the ciphertext and one wrapped key per member. It can see *who holds a key*
— that is how delivery works — but cannot open any of them. Deleting a message for everyone
drops the keys, which makes the stored bytes permanently unrecoverable.

All primitives come from [libsodium](https://doc.libsodium.org/); nothing is hand-rolled.

### What this does not cover

Stated plainly, because a security claim that overreaches is worse than none:

- **Metadata is visible to the server.** Who talks to whom, when, and how large a message is.
  Any service that routes messages can see this.
- **Profiles are not encrypted.** Usernames, addresses, display names, bios, avatars, group
  names and emoji reactions are stored in the clear.
- **The unlocked key sits in `sessionStorage`** so a page refresh does not demand the
  passphrase again. It is cleared when the tab closes, when you lock, and when you sign out —
  but a cross-site-scripting flaw in this app could read it. Settings → Security says this to
  the user, and offers "Lock this device now".
- **Forward secrecy is not implemented.** Veylo uses long-term identity keys, not a ratchet.
  Compromising a device's key exposes the messages it can still decrypt. A Double Ratchet is
  the right next step; see `docs/SECURITY.md`.
- **Recipients are not bound by cryptography.** Anyone in a conversation can screenshot or
  copy what you send.

`docs/SECURITY.md` sets out the full threat model.

---

## Project layout

```
veylo/
├── server/                    Node.js + Express + Socket.IO + PostgreSQL
│   ├── src/
│   │   ├── config/env.ts      Validated environment; fails fast on misconfiguration
│   │   ├── db/                Pool, migration runner, SQL migrations, seed
│   │   ├── lib/               Password hashing, crypto, storage, mail, HTTP helpers
│   │   ├── middleware/        Auth, RBAC, CSRF, CORS, headers, rate limits, errors
│   │   ├── services/          Domain logic: auth, users, conversations, messages,
│   │   │                      requests, moderation, notifications, sessions, security
│   │   ├── routes/            HTTP surface
│   │   └── realtime/          Socket.IO server and the emitter services publish through
│   └── test/                  Integration tests against a real PostgreSQL database
├── web/                       React + TypeScript + Vite + Tailwind
│   └── src/
│       ├── lib/crypto.ts      The canonical client cryptography
│       ├── store/             Auth and chat state (Zustand)
│       ├── components/        Design system
│       └── pages/             Landing, auth, messenger, settings, admin, legal
└── docs/                      Deployment, security model, API reference
```

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web app together, with hot reload |
| `npm run build` | Compile the server and build the web bundle |
| `npm start` | Run the compiled server (serves `web/dist` if present) |
| `npm run migrate` | Apply pending migrations |
| `npm run seed` | Development fixtures (refuses to run in production) |
| `npm test` | Integration tests against PostgreSQL |
| `npm run e2e` | Browser end-to-end suite (needs `npm run dev` running) |
| `npm run typecheck` | Type-check both workspaces |

### Tests

The suite drives the real HTTP stack against a real database — no mocks, no fake transport.
It covers registration, sign-in by both identifiers, account enumeration resistance, CSRF,
message requests, authorisation on conversation ids, privacy settings, group permissions,
blocking, moderation, and a full encrypt → send → decrypt round trip that asserts the stored
database row does not contain the plaintext.

```bash
createdb veylo_test
npm test
```

Set `TEST_DATABASE_URL` to point somewhere else.

`npm run e2e` adds the check no server-side test can make: it drives two real browsers and
asserts that a message encrypted in one is decryptable in the other, arriving in realtime.
See `e2e/README.md`.

Both suites, plus a type-check, a production build and a migrations-from-empty check, run in
CI on every push — see `.github/workflows/ci.yml`.

---

## Configuration

Every setting is an environment variable, documented in `.env.example`. The server validates
them at boot and refuses to start on a bad configuration rather than failing later.

The ones that matter most:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Any PostgreSQL 14+ instance |
| `AUTH_SECRET` | Signs session tokens and blind indexes. 32+ bytes |
| `DATA_ENCRYPTION_KEY` | Encrypts recovery emails at rest. Rotating it makes existing ones unreadable |
| `IDENTITY_DOMAIN` | The domain identities are minted under: `username@IDENTITY_DOMAIN` |
| `APP_URL` / `API_URL` | Where the app and API are served |
| `COOKIE_SECURE` | Must be `true` in production; the server refuses to boot otherwise |
| `STORAGE_*` | S3-compatible object storage for attachments |
| `SMTP_URL` | Transactional email. Unset in development, messages go to the log |

Deploying under your own domain is a matter of setting four variables:

```
IDENTITY_DOMAIN=privchat.com
APP_URL=https://app.privchat.com
API_URL=https://api.privchat.com
COOKIE_DOMAIN=.privchat.com
```

Never commit a `.env`. `.gitignore` excludes it; `.env.example` carries placeholders only.

See `docs/DEPLOYMENT.md` for hosting, TLS, scaling and backups.

---

## API

`docs/API.md` documents every endpoint, the authentication model, and the exact shape a client
must produce for an encrypted message.

---

## Licence

No licence is granted by default. Add one before publishing this repository.

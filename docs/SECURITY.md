# Veylo security model

This document describes what Veylo protects, what it does not, and how each protection is
implemented. It is written to be checkable against the code rather than reassuring.

---

## 1. Threat model

### Protected against

| Adversary | Protection |
| --- | --- |
| **A passive network observer** | TLS in transit (enforced by the deployment), plus message content that is already ciphertext before it reaches the network |
| **The server operator reading message content** | Messages are encrypted client-side; the server holds no key that opens them |
| **A database dump** | Message bodies, attachment contents and attachment filenames are ciphertext. Recovery emails are AES-256-GCM encrypted. Passwords are absent entirely — only scrypt verifiers over a client-derived authenticator |
| **Credential stuffing and brute force** | Argon2id client-side + scrypt server-side, per-IP and per-identifier rate limits, durable failed-attempt tracking shared across instances, account lockout after 10 failures |
| **Account enumeration** | The salt endpoint returns stable decoy salts for unknown identities; sign-in failures are byte-identical for "no such account" and "wrong password", and burn comparable CPU |
| **Unwanted contact** | Message requests are the default. A stranger's first message queues for approval rather than landing in an inbox |
| **Cross-site request forgery** | `SameSite=Lax` session cookie plus a double-submit CSRF token on every state-changing request |
| **Session theft via XSS** | The session cookie is `httpOnly` and unreachable from JavaScript |
| **Horizontal privilege escalation** | Every conversation-scoped route passes through one membership gate that returns 404 (not 403) for non-members, so ids cannot be probed |
| **Privilege escalation to staff** | Role-based access control on every admin route, checked server-side. The client-side guard is cosmetic |

### Not protected against

| Threat | Why |
| --- | --- |
| **Metadata analysis** | The server sees who messages whom, when, and message sizes. Delivering a message requires knowing where to deliver it. Hiding this needs sealed sender or mixing, neither of which is implemented |
| **A compromised endpoint** | Malware, a hostile browser extension, or someone with your unlocked device reads your messages after decryption. No server-side design changes this |
| **A malicious or compromised server serving hostile JavaScript** | This is the structural weakness of browser-delivered end-to-end encryption. A server that wanted your plaintext could ship a build that exfiltrates it. Subresource integrity and reproducible builds narrow this; they do not close it. Native clients with signed binaries are the real answer |
| **Compromise of a long-term identity key** | There is no forward secrecy — see §5 |
| **A recipient betraying you** | Screenshots, copies and forwards are outside cryptography's reach |
| **Traffic analysis by timing or size** | No padding, no cover traffic |

---

## 2. Authentication

### Key derivation

The passphrase never leaves the browser.

```
authenticator = Argon2id(passphrase, auth_salt,  ops=3, mem=64 MiB, 32 bytes)
vaultKey      = Argon2id(passphrase, vault_salt, ops=3, mem=64 MiB, 32 bytes)
```

`authenticator` is sent as the login secret; the server stores `scrypt(authenticator)` with
N=2¹⁵, r=8, p=1 — roughly 32 MB and ~100 ms per verification, in the range OWASP recommends
for interactive logins.

`vaultKey` never leaves the device. It seals the account's X25519 private key with
`crypto_secretbox`.

The two salts are independent and per-account. They are public by necessity (the client needs
them before it can authenticate) and useless without the passphrase.

**Parameter choice.** Argon2id at MODERATE (256 MiB) would be stronger but stalls low-end
phones. ops=3 / 64 MiB takes roughly a second on a mid-range device while still making offline
guessing very expensive. `web/src/lib/crypto.ts` is the single place to change this.

### Sessions

- 32 random bytes, stored only as an HMAC-SHA-256 hash keyed by `AUTH_SECRET`
- `httpOnly`, `Secure` (mandatory in production), `SameSite=Lax`, scoped by `COOKIE_DOMAIN`
- Absolute expiry (`SESSION_TTL_HOURS`, default 30 days) and idle timeout
  (`SESSION_IDLE_TIMEOUT_HOURS`, default 7 days)
- Revoked immediately on password change (except the initiating device), password reset,
  sign-out-everywhere, suspension and ban — including live sockets, which are force-disconnected

### Brute force

Two independent layers:

1. **In-memory fixed-window counters** per IP for sign-in, registration, reset and search.
   Correct for a single instance; a horizontally scaled deployment should back these with
   Redis. `server/src/middleware/rateLimit.ts` documents this.
2. **A `login_attempts` table** counting failures per identifier hash and per IP hash over 15
   minutes. Every instance writes to and reads from the same table, so this layer is
   correct under horizontal scaling regardless.

Identifiers and IPs are stored only as keyed hashes, so the abuse-detection data is not itself
a log of who signed in from where.

---

## 3. Message encryption

```
messageKey  = randombytes(32)
ciphertext  = crypto_secretbox(JSON.stringify(payload), nonce, messageKey)
wrappedKey  = crypto_box_seal(messageKey, recipientPublicKey)      per member
```

The payload carries the text and, for attachments, each file's own key and nonce — so one
sealed key per member covers the message and everything attached to it.

The server enforces two invariants when a message is written:

- Keys may not be minted for anyone outside the conversation (`403`)
- Every current member with a published key must receive one (`400`)

Both are covered by tests. The message, its keys and its delivery rows are written in one
transaction, because a message nobody holds a key for would be unreadable forever.

### Consequences worth stating

- **A new group member cannot read history.** Sealed keys are per message; nothing sent before
  they joined was sealed to them. This is correct behaviour, and the UI says so.
- **Server-side message search is impossible.** Conversation search runs client-side over
  decrypted history. Global search covers the user directory only.
- **Moderators cannot read reported messages** unless the reporter chooses to attach an
  excerpt from their own device. The report dialog makes that an explicit, unticked choice.

---

## 4. Key storage on the client

The unlocked private key is held in `sessionStorage`, base64-encoded.

**Why:** without it, every page refresh would demand the passphrase and a full Argon2id
derivation. That is unusable in practice, and users respond to it by choosing weaker
passphrases.

**The cost:** an XSS flaw in the app could read the key. The mitigations are the ones that
prevent XSS in the first place — a strict CSP with no `unsafe-inline` for scripts, React's
default escaping, no `dangerouslySetInnerHTML` anywhere in the codebase, and validated,
length-capped input on every endpoint.

The key is cleared when the tab closes, on "Lock this device now", and on sign-out. Settings →
Security states this trade-off to the user in plain language rather than burying it.

A stronger design would keep the key in a non-extractable `CryptoKey` in IndexedDB. WebCrypto
does not expose X25519 sealed boxes, so that would mean replacing libsodium's construction with
a WebCrypto-native one — a worthwhile change, not a small one.

---

## 5. Forward secrecy

**Veylo does not implement forward secrecy.** Long-term X25519 identity keys are used
directly. Someone who obtains a device's private key can decrypt every message still stored
that was sealed to it.

The right fix is a Double Ratchet (X3DH + symmetric ratcheting, as in the Signal protocol),
which would give per-message keys and post-compromise recovery. That means prekey bundles,
session state per conversation pair, out-of-order handling and a real multi-device story. It
is the single largest security improvement available to this codebase.

Rotating an identity key is supported today (`PUT /api/users/me/keys`) and limits future
exposure, but it does not retroactively protect messages already sealed to the old key.

---

## 6. Web security

**Content Security Policy** (production, single-image deployment):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:;
object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

`'wasm-unsafe-eval'` is required because libsodium compiles a WebAssembly module. It permits
WebAssembly compilation only — it does not re-enable `eval()` or inline script, which
`'unsafe-eval'` would. There is no `'unsafe-inline'` for scripts.

**Other headers:** HSTS with preload in production, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
same-site`, `Cross-Origin-Opener-Policy: same-origin`.

**CORS** is an explicit allowlist built from `APP_URL` and `CORS_ORIGINS`. Unknown origins are
refused.

**SQL injection** is structurally prevented: every query in the codebase is parameterised.
There is no string interpolation of user input into SQL anywhere. `LIKE` patterns escape
`%`, `_` and `\` explicitly.

**Output escaping** is React's default. `dangerouslySetInnerHTML` appears nowhere.

**Input validation** uses Zod schemas on every request body and query string, with length caps
on every string field.

---

## 7. File handling

- Attachments are encrypted client-side; the server receives opaque bytes
- Storage keys are random UUIDs under a per-conversation prefix — unguessable, and
  authorisation is still checked on every download
- Downloads require conversation membership *and*, once a file is attached to a message, a
  message key for that message
- Filenames never reach the server; they travel inside the encrypted payload
- Size caps (`MAX_UPLOAD_BYTES`, default 25 MB; avatars 2 MB) and a blocked-extension list
- Avatars are validated by magic bytes, not by declared type, and are served with
  `nosniff`. Only the *current* avatar key resolves, so a replaced image stops being served
  immediately
- The local-disk driver confines every key to the storage root, rejecting traversal

**Malware scanning** has a hook (`scanUpload`) but no scanner wired in. Uploads are marked
`skipped`, not `clean` — deliberately, because reporting an unscanned file as clean would be
a lie. Content scanning is also structurally impossible here: the server only ever sees
ciphertext. Scanning must happen on the recipient's device after decryption.

---

## 8. Privacy enforcement

Privacy settings are applied in two places, and both are server-side:

1. **In the serializer** (`toPublicProfile`) — hidden fields come back `null` rather than
   being omitted, so response shape does not leak the hidden value
2. **In SQL** — directory search filters on `discoverable` and excludes blocked pairs in the
   query itself, so a non-discoverable account never appears in a result set

Blocking is never disclosed to the blocked party: `hasBlockedYou` is always `false`, and being
blocked is indistinguishable from a strict privacy setting.

---

## 9. Operational security

- Secrets come from the environment only. No secret appears in client code — the browser
  bundle contains no credentials, and `/api/config` exposes only non-secret display values
- Stack traces are never returned to clients in production
- Security events are recorded with severity for the user's own review and for the admin feed
- Unfamiliar sign-ins raise an in-app alert and, where a verified recovery address exists,
  an email
- Admin actions are written to an append-only audit table

---

## 10. Known gaps

Listed rather than omitted, because a security document that only lists strengths is not a
security document.

1. **No forward secrecy** (§5) — the largest gap
2. **In-memory rate limiting** does not aggregate across instances; the DB-backed layer does,
   but the fast path should move to Redis before scaling out
3. **No malware scanning** (§7)
4. **No two-factor authentication** — TOTP would be a natural addition, since recovery-code
   infrastructure already exists
5. **Key fingerprints are shown but not tracked** — the UI displays a fingerprint for
   out-of-band verification, but does not warn when a contact's key changes. Change detection
   is a small, high-value addition
6. **No sealed sender** — the server sees sender identity on every message
7. **`sessionStorage` key custody** (§4)

---

## Reporting a vulnerability

Whoever operates a Veylo deployment should publish a security contact and a disclosure policy.
Please do not open a public issue for a vulnerability before that contact has had a chance to
respond.

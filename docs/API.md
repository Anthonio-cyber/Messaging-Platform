# Veylo API

Base URL: `${API_URL}` — `http://localhost:4000` in development.
All request and response bodies are JSON unless noted.

---

## Authentication model

Sessions ride on an `httpOnly` cookie (`veylo_session`), so no token is ever exposed to
JavaScript. Every state-changing request must also echo the CSRF token from the readable
`veylo_csrf` cookie in the `x-veylo-csrf` header.

A client's first call should be `GET /api/auth/csrf`, which issues the cookie and returns the
token.

`Authorization: Bearer <token>` is also accepted and skips the CSRF check, since a bearer
token is not ambient credentials. The web app does not use this path.

### The one thing a client must get right

**The server never receives a password.** A client derives two keys with Argon2id and sends
only the first:

```
authenticator = Argon2id(passphrase, authSalt,  ops=3, mem=64 MiB, 32 bytes) → base64
vaultKey      = Argon2id(passphrase, vaultSalt, ops=3, mem=64 MiB, 32 bytes) → stays local
```

`web/src/lib/crypto.ts` is the reference implementation.

### Errors

```json
{ "error": { "code": "bad_request", "message": "Human-readable sentence.",
             "details": [{ "field": "username", "message": "…" }] } }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Validation failed; `details` names the fields |
| 401 | `unauthorized` | No session, or bad credentials |
| 403 | `forbidden` | Authenticated but not permitted; also CSRF failure |
| 404 | `not_found` | Missing — or present but not yours (conversations return 404 to non-members so ids cannot be probed) |
| 409 | `conflict` | Already taken, or already exists |
| 413 | `payload_too_large` | Upload over the cap |
| 429 | `rate_limited` | `details.retryAfterSeconds`, plus a `Retry-After` header |
| 500 | `server_error` | Unexpected. No stack traces in production |

---

## Public

### `GET /api/health`
`200` with `{"status":"ok","database":"ok"}`, or `503` when the database is unreachable.

### `GET /api/config`
Non-secret values the browser needs: `brandName`, `identityDomain`, `appUrl`,
`maxUploadBytes`, `realtimePath`.

---

## Auth — `/api/auth`

### `GET /csrf`
Issues the CSRF cookie. → `{ csrfToken }`

### `GET /availability?username=`
→ `{ username, customAddress, available, reason }`

### `POST /register`
```json
{ "username": "anagkazo", "displayName": "Anagkazo",
  "authenticator": "<base64>", "authSalt": "<base64>", "vaultSalt": "<base64>",
  "publicKey": "<base64 X25519>", "encryptedPrivateKey": "<base64 nonce||sealed>",
  "recoveryEmail": "optional@example.com" }
```
`201` → `{ user, csrfToken, identityDomain }`, and sets the session cookie.

### `POST /salt`
```json
{ "identifier": "anagkazo" }
```
→ `{ authSalt, vaultSalt }`

Unknown identities receive stable, deterministic decoy salts, so this endpoint cannot be used
to discover which accounts exist.

### `POST /login`
```json
{ "identifier": "anagkazo@veylo.chat", "authenticator": "<base64>" }
```
→ `{ user, csrfToken, identityDomain, unfamiliarDevice }`

`identifier` accepts a bare username or a full address.

### `POST /logout` · `POST /logout-all`
Ends this session, or every session plus all live sockets.

### `GET /session`
→ `{ user, identityDomain }`, with `user: null` when signed out.

### `POST /password/change`
`{ currentAuthenticator, authenticator, authSalt, vaultSalt, encryptedPrivateKey }`

The client re-seals the *same* identity key under the new vault key, so history stays
readable. Every other device is signed out.

### `POST /password/forgot`
`{ email }` → always `200` with the same message, whether or not the address is on file.

### `POST /password/reset/context`
`{ token }` → `{ username, currentVaultSalt, publicKey, encryptedPrivateKey, recoveryCodesAvailable }`

The sealed private key is returned so a recovery code can re-open it in the browser. It is
useless without the vault key, and only the holder of the emailed token reaches this endpoint.

### `POST /recovery/redeem`
`{ token, code }` → `{ wrappedVaultKey }` — the vault key sealed under that recovery code.

### `POST /password/reset`
`{ token, authenticator, authSalt, vaultSalt, encryptedPrivateKey, publicKey? }`

With a redeemed recovery code the client re-seals the existing identity key and history
survives. Without one it must generate a new key, and earlier messages stay unreadable.

### `POST /recovery/codes` · `GET /recovery/codes`
Store a fresh set of `{ code, wrappedVaultKey }` (replacing any previous set), or read how many
remain unused.

### `POST /email/set` · `POST /email/verify`
Set a recovery address (sends a confirmation link), then confirm it with the token.

### `DELETE /account`
`{ authenticator, confirmation: "DELETE" }` — soft-deletes and scrubs the account.

---

## Users — `/api/users`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/me` | Your own record, including `privacy` and `encryptedPrivateKey` |
| `PATCH` | `/me` | `{ displayName?, bio? }` |
| `PATCH` | `/me/privacy` | Any subset of the privacy settings |
| `PUT` | `/me/keys` | Publish a rotated identity key |
| `POST` | `/me/presence` | `{ presence }` heartbeat for clients without a socket |
| `GET` | `/search?q=&limit=` | Directory search over username, address and display name |
| `GET` | `/lookup?identifier=` | Exact identity lookup |
| `GET` | `/sessions` · `DELETE /sessions/:id` | List and revoke devices |
| `GET` | `/security-events` | Your own security log |
| `GET` | `/:username` | A profile, rendered through that person's privacy settings |

Search returns only accounts that opted into discovery, and excludes blocked pairs in SQL.
Hidden profile fields come back `null` rather than being omitted, so response shape does not
leak the hidden value.

---

## Conversations — `/api/conversations`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/?archived=` | Sidebar list with unread counts and the last message |
| `POST` | `/direct` | `{ identifier }` or `{ userId }` — opens a thread, filing a message request when the recipient requires approval |
| `POST` | `/groups` | `{ title, description?, memberIds[], permissions? }` |
| `GET` | `/:id` | Conversation, members and pinned messages |
| `PATCH` | `/:id` | Title, description, permission matrix |
| `PATCH` | `/:id/state` | Your own view state: `{ mutedUntil?, archived?, pinned?, unread? }` |
| `GET`/`POST` | `/:id/members` | List, or add |
| `PATCH`/`DELETE` | `/:id/members/:userId` | Change role, or remove/leave |
| `DELETE` | `/:id` | Delete a group (owner), or leave a direct thread |
| `GET`/`POST` | `/:id/invites` | List or create invite links |
| `DELETE` | `/:id/invites/:inviteId` | Revoke a link |
| `POST` | `/invites/:code/join` | Redeem a link |

`POST /direct` returns `requiresRequest` and, when one was filed, `requestId`.

Group permissions are `who_can_send`, `who_can_add`, `who_can_edit_info` and
`who_can_invite`, each `"everyone"` or `"admins"`.

---

## Messages — `/api/chat`

### `GET /:conversationId/messages?limit=&before=&after=`
→ `{ messages, hasMore, nextCursor }`, oldest first.

Each message carries `ciphertext`, `nonce` and **your** `wrappedKey`. Fetching also marks
inbound messages delivered.

### `POST /:conversationId/messages`
```json
{ "ciphertext": "<base64>", "nonce": "<base64>",
  "keys": [{ "userId": "<uuid>", "wrappedKey": "<base64>" }],
  "kind": "text", "replyToId": null, "attachmentIds": [], "mentions": [] }
```

The server rejects a key addressed outside the conversation (`403`) and a key set that omits a
current member (`400`).

### Other message routes

| Method | Path | Purpose |
| --- | --- | --- |
| `PATCH` | `/messages/:id` | Edit — new ciphertext and a full new key set |
| `DELETE` | `/messages/:id?scope=me\|everyone` | `everyone` drops the keys, making the bytes unrecoverable |
| `POST` | `/messages/:id/reactions` | `{ emoji }`, toggles |
| `POST` | `/messages/:id/forward` | `{ conversationId, ciphertext, nonce, keys }` |
| `POST` | `/:conversationId/read` | `{ messageId }` — marks everything up to it read |
| `POST` | `/messages/delivered` | `{ messageIds }` |
| `GET`/`POST` | `/:conversationId/pins` · `/:conversationId/pins/:messageId` | List, or toggle a pin |
| `GET` | `/:conversationId/context/:messageId` | A window around one message, for jumping to a search hit |

There is no server-side message search: the server holds only ciphertext. Clients search their
own decrypted history.

---

## Requests, safety, notifications

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/requests?direction=incoming\|outgoing\|both` | Pending message requests |
| `GET` | `/api/requests/count` | Badge count |
| `POST` | `/api/requests/:id/respond` | `{ decision: "accepted" \| "declined" \| "blocked" }` |
| `DELETE` | `/api/requests/:id` | Withdraw one you sent |
| `GET`/`POST` | `/api/safety/blocks` | List, or block `{ userId }` |
| `DELETE` | `/api/safety/blocks/:userId` | Unblock |
| `POST` | `/api/safety/reports` | File a report |
| `GET` | `/api/safety/reports/categories` | Category list |
| `GET` | `/api/notifications` | Recent notifications and unread count |
| `GET` | `/api/notifications/summary` | Badge counts in one call |
| `POST` | `/api/notifications/read` | `{ ids }`, or `null` for all |

A report may include `includeExcerpt` and `excerpt`. Because messages are end-to-end
encrypted, that excerpt is the only way a moderator can see reported content — and it exists
only because the reporter chose to attach it.

---

## Files — `/api/files`

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/attachments/:conversationId?category=&filename=` | Raw encrypted bytes. → `{ attachment: { id, byteSize, category, scanStatus } }` |
| `GET` | `/attachments/:id` | Streams the ciphertext back, or redirects to a five-minute signed URL |
| `POST`/`DELETE` | `/avatar` | Upload or remove a profile picture |
| `GET` | `/:key` | Serves the current avatar, subject to the owner's visibility setting |

Bodies are `application/octet-stream`. Attachments are encrypted client-side; the filename
travels inside the encrypted message payload, never in the request. Download requires
conversation membership and, once attached to a message, a message key for it.

---

## Admin — `/api/admin`

Requires `moderator`; the marked routes require `admin`.

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/overview` | moderator |
| `GET` | `/users` · `/users/:id` | moderator |
| `POST` | `/users/:id/actions` — `{ action: "suspend"\|"ban"\|"restore", days?, note? }` | **admin** |
| `POST` | `/users/:id/sessions/revoke` | **admin** |
| `PATCH` | `/users/:id/role` | **admin** |
| `GET` | `/reports` · `PATCH /reports/:id` | moderator |
| `GET` | `/security` | moderator |
| `GET` | `/audit` | **admin** |
| `POST` | `/maintenance/purge-sessions` | **admin** |

No admin route exposes message content — the server cannot decrypt it.

---

## Realtime

Two transports carry the same events. Clients prefer the socket and fall back automatically.

### `GET /api/sync?since=<ISO timestamp>`

The polling transport, for hosts that cannot hold a WebSocket. Returns everything addressed to
the caller that changed since `since`:

```json
{ "now": "2026-09-04T22:00:00.000Z",
  "messages": [{ "conversationId": "…", "message": { "…": "with your own wrappedKey" } }],
  "deleted": [{ "conversationId": "…", "messageId": "…" }],
  "notifications": [ … ],
  "pendingRequests": 0,
  "revision": "…" }
```

`revision` is a cheap fingerprint of the caller's conversation list; when it changes, refetch
the sidebar. Every row is scoped to the caller's own membership — this endpoint never returns a
message they hold no key for.

Typing indicators and live presence have no polling equivalent; they are socket-only.

### Socket.IO

At path `/realtime`, authenticated by the session cookie during the handshake. An
unauthenticated socket never connects.

**Emitted by the server**

| Event | Payload |
| --- | --- |
| `ready` | `{ userId, conversations }` |
| `message:new` | `{ conversationId, message }` — personalised, carrying that recipient's key |
| `message:updated` | Edits and reaction changes |
| `message:deleted` | `{ conversationId, messageId }` |
| `message:delivered` · `message:read` | `{ conversationId, recipientId\|readerId, messageIds }` |
| `typing:update` | `{ conversationId, userId, displayName, typing }` |
| `presence:update` | `{ userId, presence }` |
| `conversation:new` · `conversation:updated` · `conversation:removed` | `{ conversationId }` |
| `request:new` · `request:accepted` · `request:resolved` | Message-request lifecycle |
| `notification:new` | A full notification object |

**Accepted from the client**

`conversation:join`, `conversation:leave`, `typing:start`, `typing:stop`, `message:read`,
`presence:set`.

Every client event re-checks membership server-side; a socket cannot subscribe to a room it
has no access to. Read receipts and typing indicators are suppressed when the sender has
turned them off in privacy settings.

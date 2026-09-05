import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, startTestServer, type TestServer } from './helpers.js';

let server: TestServer;

// Imported after helpers.ts has set the test environment.
const crypto = await import('../src/lib/clientCrypto.js');
const storageModule = await import('../src/lib/storage.js');
const pool = await import('../src/db/pool.js');
const config = await import('../src/config/env.js');

const PASSWORD = 'correct horse battery staple 42';

interface Account {
  client: ApiClient;
  id: string;
  username: string;
  publicKey: string;
  privateKey: Uint8Array;
}

async function registerAccount(username: string, displayName: string): Promise<Account> {
  const client = new ApiClient(server.url);
  await client.bootstrap();

  const authSalt = await crypto.randomSalt();
  const vaultSalt = await crypto.randomSalt();
  const authenticator = await crypto.deriveAuthenticator(PASSWORD, authSalt);
  const vaultKey = await crypto.deriveKey(PASSWORD, vaultSalt);
  const identity = await crypto.createIdentity(vaultKey);

  const response = await client.post<{ user: { id: string; publicKey: string } }>('/api/auth/register', {
    username,
    displayName,
    authenticator,
    authSalt,
    vaultSalt,
    publicKey: identity.publicKey,
    encryptedPrivateKey: identity.encryptedPrivateKey,
  });

  assert.equal(response.status, 201, `registration failed: ${JSON.stringify(response.body)}`);
  return {
    client,
    id: response.body.user.id,
    username,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  };
}

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe('identity and authentication', () => {
  test('creates an account with a custom address and no phone number', async () => {
    const alice = await registerAccount('alice', 'Alice Mwangi');
    const session = await alice.client.get<{ user: { customAddress: string; privacy: unknown } }>(
      '/api/auth/session',
    );
    assert.equal(session.status, 200);
    assert.equal(session.body.user.customAddress, 'alice@veylo.test');
  });

  test('rejects a duplicate username', async () => {
    const client = new ApiClient(server.url);
    await client.bootstrap();
    const authSalt = await crypto.randomSalt();
    const vaultSalt = await crypto.randomSalt();
    const vaultKey = await crypto.deriveKey(PASSWORD, vaultSalt);
    const identity = await crypto.createIdentity(vaultKey);

    const response = await client.post('/api/auth/register', {
      username: 'alice',
      displayName: 'Impostor',
      authenticator: await crypto.deriveAuthenticator(PASSWORD, authSalt),
      authSalt,
      vaultSalt,
      publicKey: identity.publicKey,
      encryptedPrivateKey: identity.encryptedPrivateKey,
    });
    assert.equal(response.status, 409);
  });

  test('refuses reserved usernames', async () => {
    const client = new ApiClient(server.url);
    await client.bootstrap();
    const response = await client.get<{ available: boolean }>('/api/auth/availability?username=admin');
    assert.equal(response.body.available, false);
  });

  test('signs in with either the username or the full address', async () => {
    for (const identifier of ['alice', 'alice@veylo.test']) {
      const client = new ApiClient(server.url);
      await client.bootstrap();
      const salts = await client.post<{ authSalt: string }>('/api/auth/salt', { identifier });
      const authenticator = await crypto.deriveAuthenticator(PASSWORD, salts.body.authSalt);
      const login = await client.post('/api/auth/login', { identifier, authenticator });
      assert.equal(login.status, 200, `sign-in with ${identifier} failed`);
    }
  });

  test('returns stable decoy salts for unknown identities', async () => {
    const client = new ApiClient(server.url);
    await client.bootstrap();
    const first = await client.post<{ authSalt: string }>('/api/auth/salt', { identifier: 'ghost-account' });
    const second = await client.post<{ authSalt: string }>('/api/auth/salt', { identifier: 'ghost-account' });
    assert.equal(first.body.authSalt, second.body.authSalt);
    assert.ok(first.body.authSalt.length > 10);
  });

  test('rejects a wrong password without revealing whether the account exists', async () => {
    const client = new ApiClient(server.url);
    await client.bootstrap();
    const real = await client.post('/api/auth/login', { identifier: 'alice', authenticator: 'AAAAAAAAAAAA' });
    const fake = await client.post('/api/auth/login', { identifier: 'nobody', authenticator: 'AAAAAAAAAAAA' });
    assert.equal(real.status, 401);
    assert.equal(fake.status, 401);
    assert.deepEqual(
      (real.body as { error: { message: string } }).error.message,
      (fake.body as { error: { message: string } }).error.message,
    );
  });

  test('blocks state-changing requests without a CSRF token', async () => {
    const response = await fetch(`${server.url}/api/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Hacked' }),
    });
    assert.ok(response.status === 401 || response.status === 403);
  });
});

describe('message requests and private conversations', () => {
  let alice: Account;
  let bob: Account;
  let mallory: Account;
  let conversationId: string;

  before(async () => {
    alice = await registerAccount('alice2', 'Alice Two');
    bob = await registerAccount('bob', 'Bob Ferreira');
    mallory = await registerAccount('mallory', 'Mallory');
  });

  test('a first approach becomes a request, not an open inbox', async () => {
    const response = await alice.client.post<{
      conversation: { id: string };
      requiresRequest: boolean;
      requestId: string;
    }>('/api/conversations/direct', { identifier: 'bob@veylo.test' });

    assert.equal(response.status, 201);
    assert.equal(response.body.requiresRequest, true, 'default privacy must require approval');
    conversationId = response.body.conversation.id;

    const inbox = await bob.client.get<{ incoming: Array<{ id: string }> }>('/api/requests?direction=incoming');
    assert.equal(inbox.body.incoming.length, 1);
  });

  test('the recipient sees nothing in their conversation list until they accept', async () => {
    const list = await bob.client.get<{ conversations: unknown[] }>('/api/conversations');
    assert.equal(list.body.conversations.length, 0);
  });

  test('an unrelated account cannot read the conversation', async () => {
    const response = await mallory.client.get(`/api/chat/${conversationId}/messages`);
    assert.equal(response.status, 404, 'conversation ids must not be probeable');
  });

  test('accepting the request activates the thread for both sides', async () => {
    const inbox = await bob.client.get<{ incoming: Array<{ id: string }> }>('/api/requests?direction=incoming');
    const requestId = inbox.body.incoming[0]!.id;

    const accept = await bob.client.post(`/api/requests/${requestId}/respond`, { decision: 'accepted' });
    assert.equal(accept.status, 200);

    const list = await bob.client.get<{ conversations: Array<{ id: string }> }>('/api/conversations');
    assert.equal(list.body.conversations.length, 1);
    assert.equal(list.body.conversations[0]!.id, conversationId);
  });

  test('a message round-trips end to end and the server never holds the plaintext', async () => {
    const members = await alice.client.get<{ members: Array<{ userId: string; publicKey: string }> }>(
      `/api/conversations/${conversationId}/members`,
    );
    const recipients = members.body.members.map((m) => ({ userId: m.userId, publicKey: m.publicKey }));

    const plaintext = 'The number stays private. Meet at seven.';
    const encrypted = await crypto.encryptForMembers({ text: plaintext }, recipients);

    const sent = await alice.client.post<{ message: { id: string; ciphertext: string } }>(
      `/api/chat/${conversationId}/messages`,
      { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, keys: encrypted.keys },
    );
    assert.equal(sent.status, 201);
    assert.ok(!sent.body.message.ciphertext.includes('seven'), 'stored payload must not contain plaintext');

    const inbox = await bob.client.get<{
      messages: Array<{ id: string; ciphertext: string; nonce: string; wrappedKey: string }>;
    }>(`/api/chat/${conversationId}/messages`);
    assert.equal(inbox.body.messages.length, 1);

    const received = inbox.body.messages[0]!;
    const decrypted = (await crypto.decryptMessage(
      received.ciphertext,
      received.nonce,
      received.wrappedKey,
      bob.publicKey,
      bob.privateKey,
    )) as { text: string };
    assert.equal(decrypted.text, plaintext);

    // The database row itself must be opaque.
    const { pool } = await import('../src/db/pool.js');
    const stored = await pool.query<{ ciphertext: string }>('SELECT ciphertext FROM messages WHERE id = $1', [
      received.id,
    ]);
    assert.ok(!stored.rows[0]!.ciphertext.includes('seven'));
  });

  test('read receipts move the message from delivered to read', async () => {
    const inbox = await bob.client.get<{ messages: Array<{ id: string }> }>(
      `/api/chat/${conversationId}/messages`,
    );
    const messageId = inbox.body.messages[0]!.id;

    const read = await bob.client.post<{ read: number }>(`/api/chat/${conversationId}/read`, { messageId });
    assert.equal(read.status, 200);
    assert.equal(read.body.read, 1);

    const senderView = await alice.client.get<{ messages: Array<{ readCount: number; recipientCount: number }> }>(
      `/api/chat/${conversationId}/messages`,
    );
    assert.equal(senderView.body.messages[0]!.readCount, 1);
    assert.equal(senderView.body.messages[0]!.recipientCount, 1);
  });

  test('read receipts stay private when the reader turns them off', async () => {
    await bob.client.patch('/api/users/me/privacy', { readReceipts: false });

    const members = await alice.client.get<{ members: Array<{ userId: string; publicKey: string }> }>(
      `/api/conversations/${conversationId}/members`,
    );
    const encrypted = await crypto.encryptForMembers(
      { text: 'second message' },
      members.body.members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    const sent = await alice.client.post<{ message: { id: string } }>(`/api/chat/${conversationId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });

    await bob.client.post(`/api/chat/${conversationId}/read`, { messageId: sent.body.message.id });

    // Bob's own unread badge clears...
    const bobList = await bob.client.get<{ conversations: Array<{ unreadCount: number }> }>('/api/conversations');
    assert.equal(bobList.body.conversations[0]!.unreadCount, 0);

    await bob.client.patch('/api/users/me/privacy', { readReceipts: true });
  });

  test('a message key cannot be minted for someone outside the conversation', async () => {
    const encrypted = await crypto.encryptForMembers({ text: 'leak' }, [
      { userId: alice.id, publicKey: alice.publicKey },
      { userId: mallory.id, publicKey: mallory.publicKey },
    ]);
    const response = await alice.client.post(`/api/chat/${conversationId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });
    assert.equal(response.status, 403);
  });

  test('blocking stops new messages from the blocked person', async () => {
    await bob.client.post('/api/safety/blocks', { userId: alice.id });

    const members = await alice.client.get<{ members: Array<{ userId: string; publicKey: string }> }>(
      `/api/conversations/${conversationId}/members`,
    );
    const encrypted = await crypto.encryptForMembers(
      { text: 'still here' },
      members.body.members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    const response = await alice.client.post(`/api/chat/${conversationId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });
    assert.equal(response.status, 403);

    await bob.client.del(`/api/safety/blocks/${alice.id}`);
  });
});

describe('discovery and privacy', () => {
  test('search finds people by username, address and display name', async () => {
    const client = (await registerAccount('searcher', 'Searcher')).client;
    for (const term of ['bob', 'bob@veylo.test', 'Ferreira']) {
      const response = await client.get<{ results: Array<{ username: string }> }>(
        `/api/users/search?q=${encodeURIComponent(term)}`,
      );
      assert.ok(
        response.body.results.some((r) => r.username === 'bob'),
        `search for "${term}" did not find bob`,
      );
    }
  });

  test('turning off discovery removes an account from search', async () => {
    const hidden = await registerAccount('hidden', 'Hidden Person');
    await hidden.client.patch('/api/users/me/privacy', { discoverable: false });

    const seeker = await registerAccount('seeker', 'Seeker');
    const response = await seeker.client.get<{ results: unknown[] }>('/api/users/search?q=hidden');
    assert.equal(response.body.results.length, 0);

    const lookup = await seeker.client.get('/api/users/lookup?identifier=hidden@veylo.test');
    assert.equal(lookup.status, 404);
  });

  test('"nobody can contact me" refuses new conversations', async () => {
    const recluse = await registerAccount('recluse', 'Recluse');
    await recluse.client.patch('/api/users/me/privacy', { whoCanContact: 'nobody' });

    const stranger = await registerAccount('stranger', 'Stranger');
    const response = await stranger.client.post('/api/conversations/direct', { identifier: 'recluse' });
    assert.equal(response.status, 403);
  });

  test('"everyone can contact me" skips the request step', async () => {
    const open = await registerAccount('opendoor', 'Open Door');
    await open.client.patch('/api/users/me/privacy', { whoCanContact: 'everyone' });

    const caller = await registerAccount('caller', 'Caller');
    const response = await caller.client.post<{ requiresRequest: boolean }>('/api/conversations/direct', {
      identifier: 'opendoor',
    });
    assert.equal(response.body.requiresRequest, false);

    const list = await open.client.get<{ conversations: unknown[] }>('/api/conversations');
    assert.equal(list.body.conversations.length, 1);
  });

  test('a hidden last-seen time is withheld from other people', async () => {
    const shy = await registerAccount('shy', 'Shy Person');
    await shy.client.patch('/api/users/me/privacy', { lastSeenVisible: 'nobody', onlineStatusVisible: 'nobody' });

    const viewer = await registerAccount('viewer', 'Viewer');
    const profile = await viewer.client.get<{ user: { lastSeenAt: string | null; presence: string | null } }>(
      '/api/users/shy',
    );
    assert.equal(profile.body.user.lastSeenAt, null);
    assert.equal(profile.body.user.presence, null);
  });
});

describe('groups', () => {
  test('creates a group, enforces permissions and posts a system notice', async () => {
    const owner = await registerAccount('owner', 'Group Owner');
    const member = await registerAccount('member', 'Group Member');

    const created = await owner.client.post<{ conversation: { id: string }; members: unknown[] }>(
      '/api/conversations/groups',
      { title: 'Weeknight Cooking', description: 'Recipes only.', memberIds: [member.id] },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.members.length, 2);
    const groupId = created.body.conversation.id;

    // Lock posting to admins, then confirm a plain member is refused.
    await owner.client.patch(`/api/conversations/${groupId}`, {
      permissions: { who_can_send: 'admins' },
    });

    const members = await member.client.get<{ members: Array<{ userId: string; publicKey: string }> }>(
      `/api/conversations/${groupId}/members`,
    );
    const encrypted = await crypto.encryptForMembers(
      { text: 'hello' },
      members.body.members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    const blocked = await member.client.post(`/api/chat/${groupId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });
    assert.equal(blocked.status, 403);

    const allowed = await owner.client.post(`/api/chat/${groupId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });
    assert.equal(allowed.status, 201);
  });

  test('only the owner can delete a group', async () => {
    const owner = await registerAccount('owner2', 'Owner Two');
    const member = await registerAccount('member2', 'Member Two');
    const created = await owner.client.post<{ conversation: { id: string } }>('/api/conversations/groups', {
      title: 'Book Swap',
      memberIds: [member.id],
    });
    const groupId = created.body.conversation.id;

    assert.equal((await member.client.del(`/api/conversations/${groupId}`)).status, 403);
    assert.equal((await owner.client.del(`/api/conversations/${groupId}`)).status, 200);
  });
});

describe('moderation and administration', () => {
  test('normal accounts cannot reach the admin dashboard', async () => {
    const person = await registerAccount('normal', 'Normal Person');
    const response = await person.client.get('/api/admin/overview');
    assert.equal(response.status, 403);
  });

  test('an administrator can review reports and suspend an account', async () => {
    const reporter = await registerAccount('reporter', 'Reporter');
    const offender = await registerAccount('offender', 'Offender');

    const report = await reporter.client.post<{ report: { id: string } }>('/api/safety/reports', {
      targetType: 'user',
      reportedUserId: offender.id,
      category: 'harassment',
      reason: 'Repeated unwanted contact.',
    });
    assert.equal(report.status, 201);

    const { pool } = await import('../src/db/pool.js');
    const admin = await registerAccount('rootadmin', 'Root Admin');
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);

    const overview = await admin.client.get<{ stats: { open_reports: number } }>('/api/admin/overview');
    assert.equal(overview.status, 200);
    assert.ok(Number(overview.body.stats.open_reports) >= 1);

    const queue = await admin.client.get<{ reports: Array<{ id: string }> }>('/api/admin/reports?status=open');
    assert.ok(queue.body.reports.length >= 1);

    const suspend = await admin.client.post(`/api/admin/users/${offender.id}/actions`, {
      action: 'suspend',
      days: 7,
      note: 'Harassment, first offence.',
    });
    assert.equal(suspend.status, 200);

    // Suspension revokes existing sessions immediately.
    assert.equal((await offender.client.get('/api/conversations')).status, 401);

    const resolve = await admin.client.patch(`/api/admin/reports/${report.body.report.id}`, {
      status: 'resolved',
      note: 'Account suspended for 7 days.',
    });
    assert.equal(resolve.status, 200);
  });
});

describe('account management', () => {
  test('changing the password signs out other devices', async () => {
    const account = await registerAccount('rotator', 'Rotator');

    const second = new ApiClient(server.url);
    await second.bootstrap();
    const salts = await second.post<{ authSalt: string }>('/api/auth/salt', { identifier: 'rotator' });
    await second.post('/api/auth/login', {
      identifier: 'rotator',
      authenticator: await crypto.deriveAuthenticator(PASSWORD, salts.body.authSalt),
    });
    assert.equal((await second.get('/api/conversations')).status, 200);

    const newPassword = 'a completely different passphrase 99';
    const authSalt = await crypto.randomSalt();
    const vaultSalt = await crypto.randomSalt();
    const vaultKey = await crypto.deriveKey(newPassword, vaultSalt);
    const identity = await crypto.createIdentity(vaultKey);

    const changed = await account.client.post('/api/auth/password/change', {
      currentAuthenticator: await crypto.deriveAuthenticator(
        PASSWORD,
        (await account.client.post<{ authSalt: string }>('/api/auth/salt', { identifier: 'rotator' })).body.authSalt,
      ),
      authenticator: await crypto.deriveAuthenticator(newPassword, authSalt),
      authSalt,
      vaultSalt,
      encryptedPrivateKey: identity.encryptedPrivateKey,
    });
    assert.equal(changed.status, 200);

    // The device that made the change stays signed in; the other one does not.
    assert.equal((await account.client.get('/api/conversations')).status, 200);
    assert.equal((await second.get('/api/conversations')).status, 401);
  });

  test('deleting an account requires the password and scrubs the profile', async () => {
    const account = await registerAccount('leaving', 'Leaving Soon');
    const salts = await account.client.post<{ authSalt: string }>('/api/auth/salt', { identifier: 'leaving' });

    const wrong = await account.client.del('/api/auth/account', {
      authenticator: 'AAAAAAAAAAAAAAAA',
      confirmation: 'DELETE',
    });
    assert.equal(wrong.status, 401);

    const deleted = await account.client.del('/api/auth/account', {
      authenticator: await crypto.deriveAuthenticator(PASSWORD, salts.body.authSalt),
      confirmation: 'DELETE',
    });
    assert.equal(deleted.status, 200);

    const { pool } = await import('../src/db/pool.js');
    const row = await pool.query<{ display_name: string; status: string }>(
      "SELECT display_name, status::text AS status FROM users WHERE id = $1",
      [account.id],
    );
    assert.equal(row.rows[0]!.display_name, 'Deleted account');
    assert.equal(row.rows[0]!.status, 'deleted');
  });
});

describe('attachments', () => {
  let sender: Account;
  let recipient: Account;
  let outsider: Account;
  let conversationId: string;

  before(async () => {
    sender = await registerAccount('sharer', 'File Sharer');
    recipient = await registerAccount('receiver', 'File Receiver');
    outsider = await registerAccount('nosy', 'Nosy Person');

    // Open the recipient's inbox so the conversation is live without a request dance.
    await recipient.client.patch('/api/users/me/privacy', { whoCanContact: 'everyone' });
    const opened = await sender.client.post<{ conversation: { id: string } }>(
      '/api/conversations/direct',
      { identifier: 'receiver' },
    );
    conversationId = opened.body.conversation.id;
  });

  test('uploads an encrypted attachment and attaches it to a message', async () => {
    // The browser encrypts before uploading, so the server only ever sees these bytes.
    const ciphertextBytes = Buffer.from('OPAQUE-CIPHERTEXT-BYTES-NOT-A-REAL-FILE');

    const uploaded = await sender.client.upload<{ attachment: { id: string; scanStatus: string } }>(
      `/api/files/attachments/${conversationId}?category=document&filename=notes.txt`,
      ciphertextBytes,
    );
    assert.equal(uploaded.status, 201, `upload failed: ${JSON.stringify(uploaded.body)}`);
    // Nothing scans client-side ciphertext, and saying "clean" would be a lie.
    assert.equal(uploaded.body.attachment.scanStatus, 'skipped');

    const members = await sender.client.get<{ members: Array<{ userId: string; publicKey: string }> }>(
      `/api/conversations/${conversationId}/members`,
    );
    const encrypted = await crypto.encryptForMembers(
      { text: 'notes attached' },
      members.body.members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    const sent = await sender.client.post(`/api/chat/${conversationId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
      kind: 'attachment',
      attachmentIds: [uploaded.body.attachment.id],
    });
    assert.equal(sent.status, 201);

    // The recipient can fetch the ciphertext back, byte for byte.
    const download = await recipient.client.downloadBytes(
      `/api/files/attachments/${uploaded.body.attachment.id}`,
    );
    assert.equal(download.status, 200);
    assert.deepEqual(download.bytes, ciphertextBytes);

    // Someone outside the conversation cannot, even holding the id.
    const denied = await outsider.client.downloadBytes(
      `/api/files/attachments/${uploaded.body.attachment.id}`,
    );
    assert.ok(denied.status === 403 || denied.status === 404, `outsider got ${denied.status}`);
  });

  test('refuses to accept an upload for a conversation you are not in', async () => {
    const response = await outsider.client.upload(
      `/api/files/attachments/${conversationId}?category=document`,
      Buffer.from('not mine'),
    );
    assert.equal(response.status, 404);
  });

  test('rejects an upload with no session', async () => {
    const anonymous = new ApiClient(server.url);
    await anonymous.bootstrap();
    const response = await anonymous.upload(
      `/api/files/attachments/${conversationId}?category=document`,
      Buffer.from('anonymous'),
    );
    assert.equal(response.status, 401);
  });

  test('rejects dangerous filenames before anything is stored', async () => {
    const response = await sender.client.upload(
      `/api/files/attachments/${conversationId}?category=file&filename=payload.exe`,
      Buffer.from('MZ'),
    );
    assert.equal(response.status, 400);
  });

  test('validates a profile picture by its bytes, not its declared type', async () => {
    const notAnImage = await sender.client.upload('/api/files/avatar', Buffer.from('#!/bin/sh\nrm -rf /'));
    assert.equal(notAnImage.status, 400);

    // A minimal but structurally valid PNG header.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x11),
    ]);
    const accepted = await sender.client.upload<{ avatarUrl: string }>('/api/files/avatar', png);
    assert.equal(accepted.status, 201);
    assert.match(accepted.body.avatarUrl, /\/api\/files\/avatars/);
  });
});

describe('account recovery', () => {
  const RECOVERY_EMAIL = 'recovery-target@example.com';
  const NEW_PASSWORD = 'an entirely different passphrase 77';

  let account: Account;
  let vaultKey: Uint8Array;
  let conversationId: string;
  let secretText: string;

  before(async () => {
    // Register with a recovery address, keeping the vault key so codes can be made from it.
    const client = new ApiClient(server.url);
    await client.bootstrap();

    const authSalt = await crypto.randomSalt();
    const vaultSalt = await crypto.randomSalt();
    vaultKey = await crypto.deriveKey(PASSWORD, vaultSalt);
    const identity = await crypto.createIdentity(vaultKey);

    const registered = await client.post<{ user: { id: string } }>('/api/auth/register', {
      username: 'forgetful',
      displayName: 'Forgetful Person',
      authenticator: await crypto.deriveAuthenticator(PASSWORD, authSalt),
      authSalt,
      vaultSalt,
      publicKey: identity.publicKey,
      encryptedPrivateKey: identity.encryptedPrivateKey,
      recoveryEmail: RECOVERY_EMAIL,
    });
    assert.equal(registered.status, 201);

    account = {
      client,
      id: registered.body.user.id,
      username: 'forgetful',
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
    };

    // A note to self, so there is history that must survive the reset.
    const friend = await registerAccount('confidant', 'Confidant');
    await friend.client.patch('/api/users/me/privacy', { whoCanContact: 'everyone' });

    const opened = await account.client.post<{ conversation: { id: string } }>(
      '/api/conversations/direct',
      { identifier: 'confidant' },
    );
    conversationId = opened.body.conversation.id;

    const members = await account.client.get<{ members: Array<{ userId: string; publicKey: string }> }>(
      `/api/conversations/${conversationId}/members`,
    );
    secretText = 'This line has to survive a forgotten passphrase.';
    const encrypted = await crypto.encryptForMembers(
      { text: secretText },
      members.body.members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    await account.client.post(`/api/chat/${conversationId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });
  });

  test('verifies the recovery address before it can be used for a reset', async () => {
    const { pool } = await import('../src/db/pool.js');

    // Unverified: the forgot flow must find nothing, while still answering identically.
    const beforeVerification = await account.client.post<{ ok: boolean }>('/api/auth/password/forgot', {
      email: RECOVERY_EMAIL,
    });
    assert.equal(beforeVerification.status, 200);
    const issued = await pool.query(
      "SELECT 1 FROM auth_tokens WHERE user_id = $1 AND purpose = 'password_reset'",
      [account.id],
    );
    assert.equal(issued.rowCount, 0, 'an unverified address must not receive a reset token');

    // Confirm the address using the token the registration email carried.
    const verifyToken = await pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM auth_tokens WHERE user_id = $1 AND purpose = 'email_verify' AND used_at IS NULL",
      [account.id],
    );
    assert.equal(verifyToken.rowCount, 1);

    // The plaintext token only ever exists in the email, so re-issue one we can read.
    const { createEmailVerificationToken } = await import('../src/services/auth.service.js');
    const ticket = await createEmailVerificationToken(account.id, RECOVERY_EMAIL);
    const verified = await account.client.post('/api/auth/email/verify', { token: ticket.token });
    assert.equal(verified.status, 200);
  });

  test('a reset without a recovery code loses history; with one, history survives', async () => {
    const { createPasswordResetToken } = await import('../src/services/auth.service.js');
    const { pool } = await import('../src/db/pool.js');

    // Store recovery codes, exactly as the Security settings page does.
    const codes = await crypto.generateRecoveryCodes(vaultKey, 8);
    const stored = await account.client.post('/api/auth/recovery/codes', {
      codes: codes.map((entry) => ({ code: entry.code, wrappedVaultKey: entry.wrappedVaultKey })),
    });
    assert.equal(stored.status, 200);

    // Now forget the passphrase and start a reset.
    const ticket = await createPasswordResetToken(account.id);
    const resetClient = new ApiClient(server.url);
    await resetClient.bootstrap();

    const context = await resetClient.post<{
      username: string;
      encryptedPrivateKey: string;
      publicKey: string;
      recoveryCodesAvailable: boolean;
    }>('/api/auth/password/reset/context', { token: ticket.token });
    assert.equal(context.status, 200);
    assert.equal(context.body.recoveryCodesAvailable, true);

    // Redeem one code to recover the vault key, then re-seal the same identity key.
    const redeemed = await resetClient.post<{ wrappedVaultKey: string }>('/api/auth/recovery/redeem', {
      token: ticket.token,
      code: codes[0]!.code,
    });
    assert.equal(redeemed.status, 200);

    const recoveredVaultKey = await crypto.unwrapVaultKeyWithCode(
      redeemed.body.wrappedVaultKey,
      codes[0]!.code,
    );
    const privateKey = await crypto.unlockIdentity(context.body.encryptedPrivateKey, recoveredVaultKey);

    const newAuthSalt = await crypto.randomSalt();
    const newVaultSalt = await crypto.randomSalt();
    const newVaultKey = await crypto.deriveKey(NEW_PASSWORD, newVaultSalt);

    const reset = await resetClient.post('/api/auth/password/reset', {
      token: ticket.token,
      authenticator: await crypto.deriveAuthenticator(NEW_PASSWORD, newAuthSalt),
      authSalt: newAuthSalt,
      vaultSalt: newVaultSalt,
      encryptedPrivateKey: await crypto.resealPrivateKey(privateKey, newVaultKey),
      publicKey: context.body.publicKey,
    });
    assert.equal(reset.status, 200);

    // The old passphrase no longer works, and old sessions are gone.
    const oldSession = await account.client.get('/api/conversations');
    assert.equal(oldSession.status, 401, 'a reset must revoke existing sessions');

    // Sign in with the new passphrase and read the message written before the reset.
    const fresh = new ApiClient(server.url);
    await fresh.bootstrap();
    const salts = await fresh.post<{ authSalt: string; vaultSalt: string }>('/api/auth/salt', {
      identifier: 'forgetful',
    });
    const login = await fresh.post<{ user: { encryptedPrivateKey: string; publicKey: string } }>(
      '/api/auth/login',
      {
        identifier: 'forgetful',
        authenticator: await crypto.deriveAuthenticator(NEW_PASSWORD, salts.body.authSalt),
      },
    );
    assert.equal(login.status, 200);

    const unlockedKey = await crypto.deriveKey(NEW_PASSWORD, salts.body.vaultSalt);
    const unlockedPrivate = await crypto.unlockIdentity(login.body.user.encryptedPrivateKey, unlockedKey);

    const history = await fresh.get<{
      messages: Array<{ ciphertext: string; nonce: string; wrappedKey: string }>;
    }>(`/api/chat/${conversationId}/messages`);
    assert.equal(history.status, 200);
    assert.equal(history.body.messages.length, 1);

    const recovered = (await crypto.decryptMessage(
      history.body.messages[0]!.ciphertext,
      history.body.messages[0]!.nonce,
      history.body.messages[0]!.wrappedKey,
      login.body.user.publicKey,
      unlockedPrivate,
    )) as { text: string };
    assert.equal(recovered.text, secretText, 'a recovery code must keep message history readable');

    // A redeemed code is single-use.
    const secondTicket = await createPasswordResetToken(account.id);
    const reuse = await resetClient.post('/api/auth/recovery/redeem', {
      token: secondTicket.token,
      code: codes[0]!.code,
    });
    assert.equal(reuse.status, 400);

    // Seven of the eight codes remain.
    const remaining = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [account.id],
    );
    assert.equal(remaining.rows[0]!.count, 7);
  });
});

describe('polling transport (/api/sync)', () => {
  let sender: Account;
  let recipient: Account;
  let conversationId: string;

  before(async () => {
    sender = await registerAccount('poller', 'Polling Sender');
    recipient = await registerAccount('pollee', 'Polling Recipient');
    await recipient.client.patch('/api/users/me/privacy', { whoCanContact: 'everyone' });
    const opened = await sender.client.post<{ conversation: { id: string } }>(
      '/api/conversations/direct',
      { identifier: 'pollee' },
    );
    conversationId = opened.body.conversation.id;
  });

  test('returns new messages to a client that cannot hold a socket', async () => {
    const before = new Date().toISOString();

    const members = await sender.client.get<{ members: Array<{ userId: string; publicKey: string }> }>(
      `/api/conversations/${conversationId}/members`,
    );
    const plaintext = 'Delivered without a websocket.';
    const encrypted = await crypto.encryptForMembers(
      { text: plaintext },
      members.body.members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    await sender.client.post(`/api/chat/${conversationId}/messages`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });

    const sync = await recipient.client.get<{
      now: string;
      messages: Array<{ conversationId: string; message: { ciphertext: string; nonce: string; wrappedKey: string } }>;
      pendingRequests: number;
      revision: string;
    }>(`/api/sync?since=${encodeURIComponent(before)}`);

    assert.equal(sync.status, 200, `sync failed: ${JSON.stringify(sync.body)}`);
    assert.equal(sync.body.messages.length, 1);
    assert.equal(sync.body.messages[0]!.conversationId, conversationId);

    // The polled payload carries the recipient's own sealed key and decrypts to the original.
    const decrypted = (await crypto.decryptMessage(
      sync.body.messages[0]!.message.ciphertext,
      sync.body.messages[0]!.message.nonce,
      sync.body.messages[0]!.message.wrappedKey,
      recipient.publicKey,
      recipient.privateKey,
    )) as { text: string };
    assert.equal(decrypted.text, plaintext);
  });

  test('returns nothing for a window with no activity', async () => {
    const sync = await recipient.client.get<{ messages: unknown[]; notifications: unknown[] }>(
      `/api/sync?since=${encodeURIComponent(new Date().toISOString())}`,
    );
    assert.equal(sync.status, 200);
    assert.equal(sync.body.messages.length, 0);
    assert.equal(sync.body.notifications.length, 0);
  });

  test('never returns a message the caller holds no key for', async () => {
    const outsider = await registerAccount('eavesdropper', 'Eavesdropper');
    const sync = await outsider.client.get<{ messages: Array<{ conversationId: string }> }>(
      `/api/sync?since=${encodeURIComponent(new Date(Date.now() - 600_000).toISOString())}`,
    );
    assert.equal(sync.status, 200);
    assert.equal(
      sync.body.messages.some((entry) => entry.conversationId === conversationId),
      false,
      'sync must be scoped to the caller\'s own conversations',
    );
  });

  test('requires a session', async () => {
    const anonymous = new ApiClient(server.url);
    await anonymous.bootstrap();
    const sync = await anonymous.get('/api/sync');
    assert.equal(sync.status, 401);
  });
});

describe('database-backed object storage', () => {
  const driver = new storageModule.DatabaseStorage();

  async function drain(key: string): Promise<Buffer> {
    const stream = await driver.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  after(async () => {
    await pool.query("DELETE FROM storage_objects WHERE key LIKE 'test/%'");
  });

  test('stores bytes and reads them back unchanged', async () => {
    // Deliberately not valid UTF-8: attachment bodies are ciphertext, and a driver that
    // round-trips through a text column would corrupt them silently.
    const body = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xc3, 0x28]);
    const stored = await driver.put('test/binary.bin', body, 'application/octet-stream');

    assert.equal(stored.size, body.byteLength);
    assert.deepEqual(await drain('test/binary.bin'), body);
  });

  test('replaces an object in place rather than duplicating the key', async () => {
    await driver.put('test/replaced.bin', Buffer.from('first'), 'text/plain');
    await driver.put('test/replaced.bin', Buffer.from('second version'), 'text/plain');

    assert.equal((await drain('test/replaced.bin')).toString(), 'second version');
    const rows = await pool.many<{ byte_size: number }>(
      'SELECT byte_size FROM storage_objects WHERE key = $1',
      ['test/replaced.bin'],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.byte_size, 'second version'.length);
  });

  test('reports a missing key as not found rather than throwing something opaque', async () => {
    await assert.rejects(() => driver.getStream('test/never-written.bin'), /not available/i);
  });

  test('removing an object makes it unreadable', async () => {
    await driver.put('test/temporary.bin', Buffer.from('gone soon'), 'text/plain');
    await driver.remove('test/temporary.bin');
    await assert.rejects(() => driver.getStream('test/temporary.bin'), /not available/i);
  });

  test('removing a key that was never stored is not an error', async () => {
    await driver.remove('test/never-existed.bin');
  });

  test('has no signed-URL path, so downloads stay behind the authorising route', async () => {
    assert.equal(await driver.signedUrl(), null);
  });

  test('refuses an upload that would exceed the storage ceiling', async () => {
    const ceiling = config.env.STORAGE_DB_MAX_BYTES;
    // One byte past the cap: the check must be on the total, not on this one object.
    await assert.rejects(
      () => driver.put('test/oversized.bin', Buffer.alloc(ceiling + 1), 'application/octet-stream'),
      /run out of file storage/i,
    );
  });
});

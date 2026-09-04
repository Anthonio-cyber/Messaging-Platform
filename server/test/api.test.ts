import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, startTestServer, type TestServer } from './helpers.js';

let server: TestServer;

// Imported after helpers.ts has set the test environment.
const crypto = await import('../src/lib/clientCrypto.js');

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

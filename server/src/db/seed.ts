/**
 * Development seed data.
 *
 * Creates a small, realistic world: a few accounts with working passwords, a direct
 * conversation, a pending message request and a group. Every account is created through the
 * same crypto path a real browser uses, so the seeded users can genuinely sign in and read
 * their own encrypted history.
 *
 * Never run this against a production database — it refuses to when NODE_ENV=production.
 */
import { env } from '../config/env.js';
import { pool, closePool, query } from './pool.js';
import { hashSecret } from '../lib/password.js';
import { blindIndex, encryptField } from '../lib/crypto.js';
import {
  createIdentity,
  deriveAuthenticator,
  deriveKey,
  encryptForMembers,
  randomSalt,
  ready,
} from '../lib/clientCrypto.js';
import { runMigrations } from './migrate.js';

const PASSWORD = 'Seed-Passphrase-2024!';

interface SeedUser {
  username: string;
  displayName: string;
  bio: string;
  role: 'user' | 'moderator' | 'admin';
  recoveryEmail?: string;
}

const PEOPLE: SeedUser[] = [
  {
    username: 'anagkazo',
    displayName: 'Anagkazo',
    bio: 'Building quiet things. Reachable here, nowhere else.',
    role: 'admin',
    recoveryEmail: 'anagkazo@example.com',
  },
  { username: 'mira', displayName: 'Mira Adeyemi', bio: 'Photographer. Ask before you forward.', role: 'user' },
  { username: 'tobi', displayName: 'Tobi Iwu', bio: 'Backend engineer, part-time cyclist.', role: 'user' },
  { username: 'devika', displayName: 'Devika Rao', bio: 'Research. Coffee. Long walks.', role: 'moderator' },
  { username: 'lars', displayName: 'Lars Nyberg', bio: '', role: 'user' },
];

interface CreatedUser {
  id: string;
  username: string;
  publicKey: string;
}

async function createUser(person: SeedUser): Promise<CreatedUser> {
  const authSalt = await randomSalt();
  const vaultSalt = await randomSalt();
  const authenticator = await deriveAuthenticator(PASSWORD, authSalt);
  const vaultKey = await deriveKey(PASSWORD, vaultSalt);
  const identity = await createIdentity(vaultKey);
  const passwordHash = await hashSecret(authenticator);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (username, custom_address, display_name, bio, password_hash, auth_salt, vault_salt,
                        public_key, encrypted_private_key, role, recovery_email_enc, recovery_email_index,
                        recovery_email_verified, presence, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'offline', now() - interval '2 hours')
     RETURNING id`,
    [
      person.username,
      `${person.username}@${env.IDENTITY_DOMAIN}`,
      person.displayName,
      person.bio,
      passwordHash,
      authSalt,
      vaultSalt,
      identity.publicKey,
      identity.encryptedPrivateKey,
      person.role,
      person.recoveryEmail ? encryptField(person.recoveryEmail) : null,
      person.recoveryEmail ? blindIndex(person.recoveryEmail) : null,
      Boolean(person.recoveryEmail),
    ],
  );

  const id = rows[0]!.id;
  await query('INSERT INTO privacy_settings (user_id) VALUES ($1)', [id]);
  return { id, username: person.username, publicKey: identity.publicKey };
}

async function sendSeedMessage(
  conversationId: string,
  sender: CreatedUser,
  members: CreatedUser[],
  text: string,
  minutesAgo: number,
): Promise<string> {
  const encrypted = await encryptForMembers(
    { text, sentAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() },
    members.map((m) => ({ userId: m.id, publicKey: m.publicKey })),
  );

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, sender_id, kind, ciphertext, nonce, created_at)
     VALUES ($1,$2,'text',$3,$4, now() - ($5 || ' minutes')::interval) RETURNING id`,
    [conversationId, sender.id, encrypted.ciphertext, encrypted.nonce, String(minutesAgo)],
  );
  const messageId = rows[0]!.id;

  for (const key of encrypted.keys) {
    await query('INSERT INTO message_keys (message_id, user_id, wrapped_key) VALUES ($1,$2,$3)', [
      messageId,
      key.userId,
      key.wrappedKey,
    ]);
  }
  for (const member of members) {
    const isSender = member.id === sender.id;
    await query(
      `INSERT INTO message_status (message_id, user_id, delivered_at, read_at)
       VALUES ($1,$2,$3,$4)`,
      [
        messageId,
        member.id,
        isSender ? new Date() : new Date(Date.now() - minutesAgo * 60_000 + 5_000),
        isSender ? new Date() : minutesAgo > 30 ? new Date(Date.now() - minutesAgo * 60_000 + 60_000) : null,
      ],
    );
  }
  await query('UPDATE conversations SET last_message_at = now() - ($2 || \' minutes\')::interval WHERE id = $1', [
    conversationId,
    String(minutesAgo),
  ]);
  return messageId;
}

async function main(): Promise<void> {
  if (env.isProduction) {
    throw new Error('Refusing to seed a production database.');
  }

  await ready();
  await runMigrations();

  const existing = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM users');
  if ((existing.rows[0]?.count ?? 0) > 0) {
    console.log('[seed] users already exist — wipe the database first if you want a fresh seed');
    return;
  }

  console.log('[seed] creating accounts (Argon2id key derivation, this takes a moment)…');
  const users: Record<string, CreatedUser> = {};
  for (const person of PEOPLE) {
    users[person.username] = await createUser(person);
    console.log(`[seed]   ${person.username}@${env.IDENTITY_DOMAIN}`);
  }

  const anagkazo = users.anagkazo!;
  const mira = users.mira!;
  const tobi = users.tobi!;
  const devika = users.devika!;
  const lars = users.lars!;

  // An accepted direct conversation with real history.
  const directKey = [anagkazo.id, mira.id].sort().join(':');
  const { rows: directRows } = await pool.query<{ id: string }>(
    `INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct',$1,$2) RETURNING id`,
    [directKey, anagkazo.id],
  );
  const directId = directRows[0]!.id;
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id, is_active) VALUES ($1,$2,TRUE),($1,$3,TRUE)`,
    [directId, anagkazo.id, mira.id],
  );
  await query('INSERT INTO contacts (user_id, contact_id) VALUES ($1,$2),($2,$1)', [anagkazo.id, mira.id]);

  const directMembers = [anagkazo, mira];
  await sendSeedMessage(directId, anagkazo, directMembers, 'Hey — found you through your address. This is Anagkazo.', 240);
  await sendSeedMessage(directId, mira, directMembers, 'Perfect. No phone number, no spam. I like it already.', 236);
  await sendSeedMessage(directId, anagkazo, directMembers, 'That was the whole idea. Shall we move the photo review here?', 230);
  await sendSeedMessage(directId, mira, directMembers, 'Yes. Sending the contact sheet tomorrow morning.', 12);

  // A pending message request: Lars has reached out to Anagkazo and is waiting.
  const requestKey = [lars.id, anagkazo.id].sort().join(':');
  const { rows: requestRows } = await pool.query<{ id: string }>(
    `INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct',$1,$2) RETURNING id`,
    [requestKey, lars.id],
  );
  const requestConversationId = requestRows[0]!.id;
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id, is_active) VALUES ($1,$2,TRUE),($1,$3,FALSE)`,
    [requestConversationId, lars.id, anagkazo.id],
  );
  await query(
    `INSERT INTO message_requests (sender_id, recipient_id, conversation_id) VALUES ($1,$2,$3)`,
    [lars.id, anagkazo.id, requestConversationId],
  );
  await sendSeedMessage(
    requestConversationId,
    lars,
    [lars, anagkazo],
    'Hi — Lars from the Thursday reading group. Is this the right place to reach you?',
    90,
  );
  await query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1,'message_request','New message request',$2,$3)`,
    [
      anagkazo.id,
      `Lars Nyberg (lars@${env.IDENTITY_DOMAIN}) wants to message you.`,
      JSON.stringify({ conversationId: requestConversationId }),
    ],
  );

  // A group with mixed roles.
  const { rows: groupRows } = await pool.query<{ id: string }>(
    `INSERT INTO conversations (type, title, description, created_by)
     VALUES ('group','Thursday Reading Group','Books, arguments, and the occasional tangent.',$1) RETURNING id`,
    [devika.id],
  );
  const groupId = groupRows[0]!.id;
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, is_active) VALUES
       ($1,$2,'owner',TRUE), ($1,$3,'admin',TRUE), ($1,$4,'member',TRUE), ($1,$5,'member',TRUE)`,
    [groupId, devika.id, anagkazo.id, tobi.id, mira.id],
  );
  const groupMembers = [devika, anagkazo, tobi, mira];
  await sendSeedMessage(groupId, devika, groupMembers, 'Next week: chapters four through seven. No spoilers here.', 300);
  await sendSeedMessage(groupId, tobi, groupMembers, 'I am two chapters behind and pretending otherwise.', 180);
  await sendSeedMessage(groupId, anagkazo, groupMembers, 'Same. Moving the meeting to Friday helps nobody but me.', 60);

  for (const member of groupMembers) {
    if (member.id === devika.id) continue;
    await query(
      `INSERT INTO contacts (user_id, contact_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING`,
      [devika.id, member.id],
    );
  }

  console.log('');
  console.log('[seed] done. Development sign-in details:');
  console.log('');
  for (const person of PEOPLE) {
    console.log(`  ${person.username}@${env.IDENTITY_DOMAIN}`.padEnd(34) + `${person.role}`);
  }
  console.log('');
  console.log(`  password for every seeded account:  ${PASSWORD}`);
  console.log('');
  console.log('  These accounts exist only for local development. Do not seed a real deployment.');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[seed] failed:', error);
    await closePool().catch(() => {});
    process.exit(1);
  });

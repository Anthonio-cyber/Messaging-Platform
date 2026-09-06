/**
 * End-to-end smoke test.
 *
 * Drives two real browser sessions against a running Veylo stack and asserts the things unit
 * tests cannot reach: that one browser's ciphertext is decryptable by another browser, that
 * realtime delivery works without a reload, and that the encrypted attachment path survives a
 * full round trip.
 *
 *   npm run dev          # in one terminal
 *   npm run e2e          # in another
 *
 * Set E2E_BASE_URL to point at a deployed environment instead of localhost. Accounts are
 * created with a random suffix, so repeated runs do not collide — but do not run this against
 * a production database.
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const HEADLESS = process.env.E2E_HEADED !== 'true';
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PASSPHRASE = 'a quiet place to talk 2026';
const suffix = Math.random().toString(36).slice(2, 7);

let checks = 0;
const pass = (label) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};

function step(title) {
  console.log(`\n${title}`);
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: EXECUTABLE });

  const problems = [];
  async function open(name) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => problems.push(`[${name}] ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`[${name}] ${message.text()}`);
    });
    return page;
  }

  async function register(page, username, displayName) {
    await page.goto(`${BASE}/sign-up`, { waitUntil: 'networkidle' });
    await page.fill('input[autocomplete="username"]', username);
    await page.fill('input[autocomplete="name"]', displayName);
    const passwords = page.locator('input[type="password"]');
    await passwords.nth(0).fill(PASSPHRASE);
    await passwords.nth(1).fill(PASSPHRASE);
    await page.waitForSelector('text=is yours', { timeout: 20_000 });
    await page.click('button[type="submit"]:has-text("Create account")');
    await page.waitForURL('**/app', { timeout: 60_000 });
  }

  try {
    const alice = await open('alice');
    const bob = await open('bob');
    const aliceName = `alice${suffix}`;
    const bobName = `bob${suffix}`;

    step('Accounts');
    await alice.goto(BASE, { waitUntil: 'networkidle' });
    if (!(await alice.title()).includes('Veylo')) throw new Error('landing page did not render');
    pass('landing page renders');

    await register(alice, aliceName, 'Alice Mwangi');
    await register(bob, bobName, 'Bob Ferreira');
    pass('two accounts created without a phone number');

    step('Message requests');
    await alice.click('button[aria-label="New message"]');
    await alice.fill('input[aria-label="Search for someone"]', bobName);
    await alice.waitForSelector(`text=${bobName}@veylo.chat`, { timeout: 20_000 });
    pass('directory search finds an account by username');

    await alice.click(`button:has-text("${bobName}@veylo.chat")`);
    await alice.waitForURL('**/app/c/**', { timeout: 30_000 });
    await alice.waitForSelector('textarea[aria-label="Message"]', { timeout: 20_000 });

    const bobInboxBefore = await bob.locator('button:has-text("Alice Mwangi")').count();
    if (bobInboxBefore !== 0) throw new Error('an unaccepted sender reached the inbox');
    pass('an unaccepted sender does not appear in the inbox');

    const secret = 'Found you through your address, not a number.';
    await alice.fill('textarea[aria-label="Message"]', secret);
    await alice.click('button[aria-label="Send message"]');
    await alice.waitForSelector(`text=${secret}`, { timeout: 30_000 });

    await bob.click('button:has-text("Requests")');
    await bob.waitForSelector('text=Alice Mwangi', { timeout: 20_000 });
    await bob.click('button:has-text("Accept")');
    await bob.waitForTimeout(1500);
    await bob.click('button:has-text("All")');
    await bob.waitForSelector('button:has-text("Alice Mwangi")', { timeout: 20_000 });
    await bob.click('button:has-text("Alice Mwangi")');
    await bob.waitForURL('**/app/c/**', { timeout: 20_000 });
    pass('accepting a request activates the conversation');

    step('End-to-end encryption');
    await bob.waitForSelector(`text=${secret}`, { timeout: 30_000 });
    pass("one browser decrypts the other browser's message");

    await bob.fill('textarea[aria-label="Message"]', 'No phone number needed. Good.');
    await bob.click('button[aria-label="Send message"]');
    await alice.waitForSelector('text=No phone number needed', { timeout: 30_000 });
    pass('realtime delivery arrives without a reload');

    step('Message actions');
    await alice.locator('li:has-text("No phone number needed")').first().hover();
    await alice
      .locator('li:has-text("No phone number needed") button[aria-label="More actions"]')
      .first()
      .click();
    await alice.click('button[aria-label="React with 👍"]');
    await bob.waitForSelector('text=👍', { timeout: 20_000 });
    pass('reactions propagate');

    await alice.locator(`li:has-text("${secret}")`).first().hover();
    await alice.locator(`li:has-text("${secret}") button[aria-label="More actions"]`).first().click();
    await alice.click('button[role="menuitem"]:has-text("Edit")');
    await alice.fill('textarea[aria-label="Message"]', 'Found you through your address (edited).');
    await alice.click('button[aria-label="Save changes"]');
    await bob.waitForSelector('text=(edited)', { timeout: 30_000 });
    pass('edits are re-encrypted and re-decrypted by the recipient');

    step('Attachments');
    await alice.setInputFiles('input[type="file"]', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`Attachment round trip ${suffix}`),
    });
    await alice.waitForSelector('text=notes.txt', { timeout: 10_000 });
    await alice.fill('textarea[aria-label="Message"]', 'Notes attached.');
    await alice.click('button[aria-label="Send message"]');
    await alice.waitForSelector('text=Notes attached', { timeout: 30_000 });
    await bob.waitForSelector('text=Notes attached', { timeout: 30_000 });
    await bob.waitForSelector('text=notes.txt', { timeout: 20_000 });
    pass('the filename inside the encrypted payload reaches the recipient');

    step('Groups');
    await alice.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await alice.click('button[aria-label="New group"]');
    await alice.getByLabel('Group name').fill('Weeknight Cooking');
    await alice.getByLabel('Add people').fill(bobName);
    await alice.waitForSelector(`button:has-text("${bobName}@veylo.chat")`, { timeout: 20_000 });
    await alice.click(`button:has-text("${bobName}@veylo.chat")`);
    await alice.locator('[role="dialog"] button:has-text("Create group")').click();
    await alice.waitForURL('**/app/c/**', { timeout: 30_000 });
    await alice.waitForTimeout(1500);
    await alice.fill('textarea[aria-label="Message"]', 'Recipes only in here, please.');
    await alice.click('button[aria-label="Send message"]');
    await alice.waitForSelector('text=Recipes only in here', { timeout: 20_000 });

    await bob.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await bob.waitForSelector('button:has-text("Weeknight Cooking")', { timeout: 30_000 });
    await bob.click('button:has-text("Weeknight Cooking")');
    await bob.waitForSelector('text=Recipes only in here', { timeout: 30_000 });
    pass('a second group member decrypts a group message');

    // Adding people to a group used to be impossible from the UI: the API route existed and
    // the info panel listed members, but nothing rendered a control to add one.
    const carolName = `carol${suffix}`;
    const carol = await open('carol');
    await register(carol, carolName, 'Carol Adds');

    await alice.click('button[aria-label="Conversation details"]');
    await alice.waitForSelector('button:has-text("Add people")', { timeout: 20_000 });
    await alice.click('button:has-text("Add people")');
    await alice.fill('input[aria-label="Search for someone to add"]', carolName);
    await alice.waitForSelector(`[role="dialog"] button:has-text("${carolName}@veylo.chat")`, {
      timeout: 20_000,
    });
    await alice.click(`[role="dialog"] button:has-text("${carolName}@veylo.chat")`);
    await alice.locator('[role="dialog"] button:has-text("Add to group")').click();
    await alice.waitForSelector('text=Added 1 person to the group', { timeout: 20_000 });
    pass('an admin can add someone to an existing group');

    await alice.fill('textarea[aria-label="Message"]', 'Carol has joined us.');
    await alice.click('button[aria-label="Send message"]');

    await carol.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await carol.waitForSelector('button:has-text("Weeknight Cooking")', { timeout: 30_000 });
    await carol.click('button:has-text("Weeknight Cooking")');
    await carol.waitForSelector('text=Carol has joined us', { timeout: 30_000 });
    pass('the added member receives and decrypts messages sent after they joined');

    // Messages sent before she was added were encrypted without a key for her, so they are
    // not merely hidden — there is nothing on the server that could decrypt them for her.
    const beforeVisible = await carol
      .waitForSelector('text=Recipes only in here', { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (beforeVisible) throw new Error('a newly added member could read history from before they joined');
    pass('history from before they joined stays unreadable, as the dialog promises');

    step('Privacy and settings');
    await alice.goto(`${BASE}/app/settings/privacy`, { waitUntil: 'networkidle' });
    await alice.waitForSelector('text=Who can reach you', { timeout: 20_000 });
    await alice.getByLabel('Let people find me in search').click();
    await alice.waitForTimeout(1500);

    const searcher = await open('searcher');
    await register(searcher, `finder${suffix}`, 'Finder');
    await searcher.click('button[aria-label="New message"]');
    await searcher.fill('input[aria-label="Search for someone"]', aliceName);
    await searcher.waitForSelector('text=Nobody matches that', { timeout: 20_000 });
    pass('turning off discovery removes an account from search');

    step('Session');
    await alice.goto(`${BASE}/app/settings/security`, { waitUntil: 'networkidle' });
    await alice.waitForSelector('text=Signed-in devices', { timeout: 20_000 });
    await alice.reload({ waitUntil: 'networkidle' });
    await alice.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await alice.click('button:has-text("Weeknight Cooking")');
    await alice.waitForSelector('text=Recipes only in here', { timeout: 30_000 });
    pass('a page reload keeps messages readable without re-entering the passphrase');

    // Console noise that is not an assertion failure is still worth surfacing.
    if (problems.length > 0) {
      console.log('\nBrowser console reported:');
      for (const problem of [...new Set(problems)].slice(0, 10)) console.log(`  · ${problem}`);
    }

    console.log(`\n${checks} checks passed.`);
    console.log(`Accounts created: ${aliceName}@veylo.chat, ${bobName}@veylo.chat`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('\nE2E FAILED:', error.message);
  process.exit(1);
});

/**
 * Status posting end-to-end test.
 *
 * Drives two browsers through the real flow: one posts, the other sees it in the tray, opens
 * it, and the poster sees the view recorded. That last step is the one worth a browser — the
 * status is sealed on the poster's device and opened on the viewer's, so a passing run proves
 * the key wrapping works between two separate sodium instances, not just within one.
 *
 *   npm run dev          # in one terminal
 *   npm run e2e:status   # in another
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const HEADLESS = process.env.E2E_HEADED !== 'true';
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PASSPHRASE = 'a quiet place to talk 2026';
const suffix = Math.random().toString(36).slice(2, 7);

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: EXECUTABLE });

  async function open(name) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.log(`[${name} pageerror]`, error.message));
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
    const poster = await open('poster');
    const viewer = await open('viewer');
    const posterName = `sp${suffix}`;
    const viewerName = `sv${suffix}`;

    console.log('\nSetup');
    await register(poster, posterName, 'Status Poster');
    await register(viewer, viewerName, 'Status Viewer');

    // Becoming contacts is what puts someone in the audience, and that happens when a message
    // request is accepted — so the two have to go through that first.
    await poster.click('button[aria-label="New message"]');
    await poster.fill('input[aria-label="Search for someone"]', viewerName);
    await poster.waitForSelector(`text=${viewerName}@veylo.chat`, { timeout: 20_000 });
    await poster.click(`button:has-text("${viewerName}@veylo.chat")`);
    await poster.waitForURL('**/app/c/**', { timeout: 30_000 });
    await poster.fill('textarea[aria-label="Message"]', 'hello, accept me');
    await poster.click('button[aria-label="Send message"]');

    await viewer.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await viewer.click('button:has-text("Requests")');
    await viewer.waitForSelector('button:has-text("Accept")', { timeout: 30_000 });
    await viewer.click('button:has-text("Accept")');
    await viewer.waitForTimeout(1500);
    check('the two accounts are now contacts', true);

    console.log('\nPosting a status');
    await poster.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await poster.click('button[aria-label="Add a status"]');
    await poster.waitForSelector('[role="dialog"]', { timeout: 20_000 });

    // The composer must state reach before anything is posted, not after.
    const reachShown = await poster
      .waitForSelector('text=/Encrypted on this device for your 1 contact/', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check('the composer says how far the post will reach', reachShown);

    await poster.getByLabel('Caption').fill('testing one two three');
    await poster.locator('[role="dialog"] button:has-text("Post")').click();
    await poster.waitForSelector('text=Status posted', { timeout: 30_000 });
    check('the status posts', true);

    console.log('\nThe contact sees it');
    await viewer.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    const inTray = await viewer
      .waitForSelector(`button[aria-label="View Status Poster's status"]`, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    check('it appears in the contact\'s status tray', inTray);

    await viewer.click(`button[aria-label="View Status Poster's status"]`);
    // The real assertion: text sealed in one browser, opened in another.
    const decrypted = await viewer
      .waitForSelector('text=testing one two three', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check('the other browser decrypts the status body', decrypted);

    await viewer.click('button[aria-label="Close status"]');
    await viewer.waitForTimeout(1200);

    console.log('\nThe poster sees the view');
    await poster.reload({ waitUntil: 'networkidle' });
    await poster.click('button[aria-label="View your status"]');
    const viewCount = await poster
      .waitForSelector('text=/1 view/', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check('the poster sees the view counted', viewCount);

    await poster.click('button:has-text("1 view")');
    const namedViewer = await poster
      .waitForSelector('text=Status Viewer', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    check('the viewer is named in the list', namedViewer);

    console.log('\nAn outsider sees nothing');
    const outsider = await open('outsider');
    await register(outsider, `so${suffix}`, 'Status Outsider');
    await outsider.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await outsider.waitForTimeout(2000);
    const leaked = await outsider.locator('button[aria-label*="status"]').count();
    // Only the "Add a status" button of their own should exist.
    const othersVisible = await outsider.locator(`button[aria-label^="View "]`).count();
    check('a non-contact sees no statuses at all', othersVisible === 0, `${leaked} own button(s)`);

    console.log('\nDeleting');
    // One Escape closes the viewer list; the status behind it must stay open, which is exactly
    // what broke the first time this ran — both layers listened for Escape on the document.
    await poster.keyboard.press('Escape');
    await poster.waitForTimeout(600);
    check(
      'closing the viewer list leaves the status open',
      await poster.locator('button[aria-label="Delete this status"]').count() > 0,
    );
    await poster.click('button[aria-label="Delete this status"]');
    await poster.waitForTimeout(1500);
    await viewer.reload({ waitUntil: 'networkidle' });
    await viewer.waitForTimeout(2000);
    const gone =
      (await viewer.locator(`button[aria-label="View Status Poster's status"]`).count()) === 0;
    check('a deleted status disappears for the contact too', gone);

    console.log(`\n${failures === 0 ? 'All status checks passed.' : `${failures} check(s) failed.`}`);
  } finally {
    await browser.close();
  }

  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\nSTATUS E2E FAILED:', error.message);
  process.exit(1);
});

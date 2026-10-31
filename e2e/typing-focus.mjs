/**
 * Typing focus test.
 *
 * The composer and the dialog search boxes have to keep the caret while someone types. That
 * sounds too obvious to test, which is exactly why it broke: the rest of the suite fills
 * fields with page.fill(), which sets .value in one shot and never exercises the case where a
 * re-render lands between two keystrokes.
 *
 * Two things conspired to steal focus. Modal ran its focus-trap effect with onClose in the
 * dependency array, and every caller passes an inline arrow, so any re-render of the parent
 * tore the effect down — and its cleanup calls previous?.focus(), throwing the caret back to
 * whatever was focused before the dialog opened. Meanwhile the store's typing sweep called
 * set() on a timer whether or not anything had expired, and since returning {} from a zustand
 * updater still notifies every subscriber, that supplied a re-render every couple of seconds
 * for the first bug to act on. Typing a name meant clicking back into the box for each letter.
 *
 * So each check here types slowly enough to cross several sweep ticks. Typing fast would pass
 * against the broken build.
 *
 *   npm run dev              # in one terminal
 *   npm run e2e:typing       # in another
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const HEADLESS = process.env.E2E_HEADED !== 'true';
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PASSPHRASE = 'a quiet place to talk 2026';
const suffix = Math.random().toString(36).slice(2, 7);

/** Long enough to span several of the store's 2s timers, which is where the bug lived. */
const KEY_DELAY_MS = 260;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));

  async function register(username, displayName) {
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

  /**
   * Types one character at a time and reports whether the field held focus and every keystroke
   * throughout. Returns the value it ended up with so the caller can compare.
   */
  async function typeSlowly(target, word) {
    const field = typeof target === 'string' ? page.locator(target) : target;
    await field.click();
    let keptFocus = true;
    for (const character of word) {
      await page.keyboard.type(character);
      await page.waitForTimeout(KEY_DELAY_MS);
      const focused = await field.evaluate((element) => element === document.activeElement);
      if (!focused) keptFocus = false;
    }
    return { keptFocus, value: await field.inputValue() };
  }

  try {
    await register(`focus${suffix}`, 'Focus Tester');

    console.log('\nThe "new message" search');
    await page.click('button[aria-label="New message"]');
    await page.waitForSelector('input[aria-label="Search for someone"]', { timeout: 20_000 });
    const search = await typeSlowly('input[aria-label="Search for someone"]', 'someone');
    check('the caret stays in the box for every letter', search.keptFocus);
    check('every letter reaches the field', search.value === 'someone', JSON.stringify(search.value));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    console.log('\nThe "new group" dialog');
    await page.click('button[aria-label="New group"]');
    await page.waitForSelector('[role="dialog"]', { timeout: 20_000 });
    const name = await typeSlowly(page.locator('[role="dialog"] input').nth(0), 'Book club');
    check('the group name keeps focus', name.keptFocus);
    check('the group name is complete', name.value === 'Book club', JSON.stringify(name.value));

    // The people search sits below the name field, and is the one that has to survive the
    // dialog re-rendering as results come back.
    const people = await typeSlowly(page.locator('[role="dialog"] input').nth(1), 'nobody here');
    check('the people search keeps focus while results load', people.keptFocus);
    check('the people search is complete', people.value === 'nobody here', JSON.stringify(people.value));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    console.log('\nThe composer');
    // Reach a conversation by creating a group with only yourself in it.
    await page.click('button[aria-label="New group"]');
    await page.waitForSelector('[role="dialog"]', { timeout: 20_000 });
    await page.locator('[role="dialog"] input').nth(0).fill(`Focus ${suffix}`);
    await page.locator('[role="dialog"] button:has-text("Create group")').click();
    await page.waitForURL('**/app/c/**', { timeout: 30_000 });
    await page.waitForTimeout(1500);

    const composer = await typeSlowly('textarea[aria-label="Message"]', 'a slow sentence');
    check('the composer keeps focus while typing', composer.keptFocus);
    check(
      'the composer holds the whole sentence',
      composer.value === 'a slow sentence',
      JSON.stringify(composer.value),
    );

    console.log('\nThe "add people" dialog');
    await page.click('button[aria-label="Conversation details"]');
    await page.waitForSelector('button:has-text("Add people")', { timeout: 20_000 });
    await page.click('button:has-text("Add people")');
    await page.waitForSelector('input[aria-label="Search for someone to add"]', { timeout: 20_000 });
    const adding = await typeSlowly('input[aria-label="Search for someone to add"]', 'a friend');
    check('the add-people search keeps focus', adding.keptFocus);
    check('the add-people search is complete', adding.value === 'a friend', JSON.stringify(adding.value));

    console.log(`\n${failures === 0 ? 'All typing focus checks passed.' : `${failures} check(s) failed.`}`);
  } finally {
    await browser.close();
  }

  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\nTYPING FOCUS E2E FAILED:', error.message);
  process.exit(1);
});

/**
 * Mobile on-screen keyboard regression test.
 *
 * The bug this guards against: the app shell was sized with `height: 100%`, which follows the
 * *layout* viewport. iOS Safari does not shrink the layout viewport when the keyboard opens —
 * it leaves it full height and slides the keyboard over the top. So the composer ended up
 * behind the keyboard, Safari tried to scroll the focused input into view, the shell's
 * `overflow: hidden` fought it, and the view snapped back down every time you tapped to type.
 *
 * Headless Chromium has no soft keyboard, so this simulates the exact iOS shape: the layout
 * viewport stays put while `visualViewport.height` shrinks. That is the case that broke, and
 * it is the case the fix has to handle.
 *
 *   npm run dev            # in one terminal
 *   npm run e2e:mobile     # in another
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const HEADLESS = process.env.E2E_HEADED !== 'true';
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PASSPHRASE = 'a quiet place to talk 2026';
const suffix = Math.random().toString(36).slice(2, 7);

/** Roughly the height of the iOS keyboard on a 390x844 screen. */
const KEYBOARD_PX = 336;
const SCREEN = { width: 390, height: 844 };

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: EXECUTABLE });
  const page = await browser.newPage({ viewport: SCREEN, isMobile: true, hasTouch: true });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));

  try {
    // A real account, so the messenger renders its actual shell rather than a redirect.
    await page.goto(`${BASE}/sign-up`, { waitUntil: 'networkidle' });
    await page.fill('input[autocomplete="username"]', `kb${suffix}`);
    await page.fill('input[autocomplete="name"]', 'Keyboard Tester');
    const passwords = page.locator('input[type="password"]');
    await passwords.nth(0).fill(PASSPHRASE);
    await passwords.nth(1).fill(PASSPHRASE);
    await page.waitForSelector('text=is yours', { timeout: 20_000 });
    await page.click('button[type="submit"]:has-text("Create account")');
    await page.waitForURL('**/app', { timeout: 60_000 });

    console.log('\nScrolling pages are left alone');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    check(
      'the marketing page is not locked, so it still scrolls',
      !(await page.evaluate(() => document.body.classList.contains('app-locked'))),
    );

    console.log('\nMessenger shell at rest');
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.app-shell', { timeout: 20_000 });

    check(
      'the document is locked so the page cannot be scrolled away',
      await page.evaluate(() => document.body.classList.contains('app-locked')),
    );

    const atRest = await page.evaluate(() => ({
      appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
      shellHeight: Math.round(document.querySelector('.app-shell').getBoundingClientRect().height),
      visual: Math.round(window.visualViewport.height),
      keyboard: document.documentElement.dataset.keyboard,
    }));

    check('--app-height is published', atRest.appHeight !== '', atRest.appHeight);
    check(
      'the shell matches the visual viewport',
      Math.abs(atRest.shellHeight - atRest.visual) <= 1,
      `shell ${atRest.shellHeight}px vs visual ${atRest.visual}px`,
    );
    check('the keyboard reads as closed', atRest.keyboard === 'closed', atRest.keyboard);

    console.log('\nWith the keyboard open (iOS shape: layout viewport unchanged)');
    await page.evaluate((keyboard) => {
      const viewport = window.visualViewport;
      const full = viewport.height;
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => full - keyboard });
      viewport.dispatchEvent(new Event('resize'));
    }, KEYBOARD_PX);
    await page.waitForTimeout(300);

    const open = await page.evaluate(() => {
      const rect = document.querySelector('.app-shell').getBoundingClientRect();
      return {
        shellHeight: Math.round(rect.height),
        shellBottom: Math.round(rect.bottom),
        layout: window.innerHeight,
        visual: Math.round(window.visualViewport.height),
        keyboard: document.documentElement.dataset.keyboard,
      };
    });

    check(
      'the layout viewport did not shrink, exactly as on iOS',
      open.layout === SCREEN.height,
      `${open.layout}px`,
    );
    check(
      'the shell shrank to the visual viewport regardless',
      Math.abs(open.shellHeight - open.visual) <= 1,
      `shell ${open.shellHeight}px vs visual ${open.visual}px`,
    );
    check(
      'the shell stops where the keyboard starts',
      open.shellBottom <= open.layout - KEYBOARD_PX + 1,
      `shell bottom ${open.shellBottom}px, keyboard at ${open.layout - KEYBOARD_PX}px`,
    );
    check('the keyboard is detected as open', open.keyboard === 'open', open.keyboard);

    const inset = await page.evaluate(() => {
      const el = document.querySelector('.safe-bottom');
      return el ? getComputedStyle(el).paddingBottom : null;
    });
    check(
      'the safe-area inset collapses, leaving no dead strip above the keyboard',
      inset === null || inset === '0px',
      inset ?? 'no bottom-edge element on this screen',
    );

    console.log('\nWith iOS also scrolling the visual viewport up');
    // The other half of what iOS does: as well as shrinking the visible area, it scrolls that
    // area up inside the layout viewport to lift the focused field clear of the keyboard.
    // `position: fixed` is anchored to the *layout* viewport, so a shell that ignores this
    // stays where it was while the visible window slides out from under it — the app appears
    // to drop back down behind the keyboard, which is precisely the reported symptom.
    const OFFSET_PX = 96;
    await page.evaluate((offset) => {
      const viewport = window.visualViewport;
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => offset });
      viewport.dispatchEvent(new Event('scroll'));
    }, OFFSET_PX);
    await page.waitForTimeout(300);

    const scrolled = await page.evaluate(() => {
      const rect = document.querySelector('.app-shell').getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        offsetTop: Math.round(window.visualViewport.offsetTop),
        appTop: getComputedStyle(document.documentElement).getPropertyValue('--app-top').trim(),
      };
    });

    check('--app-top follows the visual viewport offset', scrolled.appTop === `${OFFSET_PX}px`, scrolled.appTop);
    check(
      'the shell moves with the visible area instead of sliding out from under it',
      Math.abs(scrolled.top - scrolled.offsetTop) <= 1,
      `shell top ${scrolled.top}px vs visible top ${scrolled.offsetTop}px`,
    );

    const widget = await page.evaluate(
      () => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
    );
    check(
      'the viewport meta asks Chrome to resize the layout viewport for the keyboard',
      widget.includes('interactive-widget=resizes-content'),
      widget,
    );

    console.log(`\n${failures === 0 ? 'All keyboard checks passed.' : `${failures} check(s) failed.`}`);
  } finally {
    await browser.close();
  }

  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\nMOBILE KEYBOARD E2E FAILED:', error.message);
  process.exit(1);
});

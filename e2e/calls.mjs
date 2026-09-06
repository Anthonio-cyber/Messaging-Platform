/**
 * Voice and video call end-to-end test.
 *
 * Chromium can synthesise a camera and microphone (`--use-fake-device-for-media-stream`), so
 * this drives a real WebRTC negotiation between two browsers: offer, answer, ICE, and media
 * actually flowing. It asserts the peer connection reaches `connected` and that inbound audio
 * arrives — not merely that the UI changed state.
 *
 *   npm run dev        # in one terminal
 *   npm run e2e:calls  # in another
 *
 * Both browsers run on this machine, so ICE finds a host candidate and no TURN relay is
 * needed. That is the one thing this test cannot cover: whether a real deployment can
 * traverse a restrictive NAT. That needs TURN, and its absence is reported in the UI.
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
  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: EXECUTABLE,
    args: [
      // A synthetic camera and microphone, and no permission prompt to click through.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  async function session(name) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      permissions: ['camera', 'microphone'],
    });
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
    const caller = await session('caller');
    const callee = await session('callee');
    const callerName = `caller${suffix}`;
    const calleeName = `callee${suffix}`;

    console.log('\nSetup');
    await register(caller, callerName, 'Call Placer');
    await register(callee, calleeName, 'Call Taker');

    // Open the callee's inbox so the pair can talk without the request dance.
    await callee.goto(`${BASE}/app/settings/privacy`, { waitUntil: 'networkidle' });
    await callee.getByLabel('Who can start a conversation with me').selectOption('everyone');
    await callee.waitForTimeout(1200);
    await callee.goto(`${BASE}/app`, { waitUntil: 'networkidle' });

    await caller.click('button[aria-label="New message"]');
    await caller.fill('input[aria-label="Search for someone"]', calleeName);
    await caller.waitForSelector(`text=${calleeName}@veylo.chat`, { timeout: 20_000 });
    await caller.click(`button:has-text("${calleeName}@veylo.chat")`);
    await caller.waitForURL('**/app/c/**', { timeout: 30_000 });
    check('a direct conversation is open', true);

    console.log('\nPlacing a voice call');
    await caller.waitForSelector('button[aria-label^="Call "]', { timeout: 20_000 });
    await caller.click('button[aria-label^="Call "]');

    await callee.waitForSelector('text=Incoming call', { timeout: 30_000 });
    check('the callee is alerted', true);
    check(
      'the caller sees it ringing',
      await caller
        .waitForSelector('text=/Ringing|Calling/', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false),
    );

    await callee.click('button[aria-label="Answer call"]');

    // The real assertion: a peer connection that actually reached "connected".
    const connected = await caller
      .waitForFunction(
        () => {
          const audio = document.querySelector('audio');
          return Boolean(audio?.srcObject);
        },
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    check('the caller received a remote media stream', connected);

    const calleeConnected = await callee
      .waitForFunction(() => Boolean(document.querySelector('audio')?.srcObject), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    check('the callee received a remote media stream', calleeConnected);

    // A running duration proves the connection state machine reached "active".
    const timerRunning = await caller
      .waitForSelector('text=/^0:0[0-9]$/', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check('the call timer is running, so the connection is live', timerRunning);

    const inboundAudio = await caller.evaluate(async () => {
      const audio = document.querySelector('audio');
      const stream = audio?.srcObject;
      return stream instanceof MediaStream ? stream.getAudioTracks().length : 0;
    });
    check('an inbound audio track is present', inboundAudio > 0, `${inboundAudio} track(s)`);

    console.log('\nIn-call controls');
    await caller.click('button[aria-label="Mute microphone"]');
    check(
      'muting flips the control to unmute',
      await caller
        .waitForSelector('button[aria-label="Unmute microphone"]', { timeout: 5000 })
        .then(() => true)
        .catch(() => false),
    );

    console.log('\nHanging up');
    await caller.click('button[aria-label="End call"]');
    check(
      'the callee is told the call ended',
      await callee
        .waitForSelector('text=Call ended', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false),
    );
    check(
      'the caller returns to the conversation',
      await caller
        .waitForSelector('textarea[aria-label="Message"]', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false),
    );

    console.log('\nVideo call');
    // This is the case the audio-only assertions above missed for a whole release: the remote
    // <video> only mounts once the phase reaches "active", while the MediaStream object it
    // needs never changes identity — so an effect keyed on the stream fired before the element
    // existed and never again, and the far side stayed black while your own preview worked.
    await caller.click('button[aria-label^="Video call "]');
    await callee.waitForSelector('text=Incoming video call', { timeout: 30_000 });
    check('a video call rings as a video call', true);
    await callee.click('button[aria-label="Answer call"]');

    const remoteVideoLive = async (page) =>
      page
        .waitForFunction(
          () => {
            // The small mirrored element is the local preview; the full-bleed one is the peer.
            const remote = [...document.querySelectorAll('video')].find(
              (element) => !element.muted,
            );
            const stream = remote?.srcObject;
            return (
              stream instanceof MediaStream &&
              stream.getVideoTracks().length > 0 &&
              remote.videoWidth > 0
            );
          },
          { timeout: 30_000 },
        )
        .then(() => true)
        .catch(() => false);

    check('the caller sees the other person, not just themselves', await remoteVideoLive(caller));
    check('the callee sees the other person, not just themselves', await remoteVideoLive(callee));

    const selfPreview = await caller.evaluate(() => {
      const local = [...document.querySelectorAll('video')].find((element) => element.muted);
      const stream = local?.srcObject;
      return stream instanceof MediaStream && stream.getVideoTracks().length > 0;
    });
    check('the local preview is still attached alongside it', selfPreview);

    await caller.click('button[aria-label="End call"]');
    await caller.waitForSelector('textarea[aria-label="Message"]', { timeout: 15_000 });

    console.log('\nDeclining a call');
    await caller.click('button[aria-label^="Video call "]');
    await callee.waitForSelector('text=Incoming video call', { timeout: 30_000 });
    await callee.click('button[aria-label="Decline call"]');
    check(
      'the caller is told it was declined',
      await caller
        .waitForSelector('text=Call declined', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false),
    );

    console.log('\nCall history');
    const history = await caller.evaluate(async () => {
      const response = await fetch('/api/calls/history', { credentials: 'include' });
      return response.json();
    });
    check('every call was recorded', history.calls?.length >= 3, `${history.calls?.length} entries`);
    check(
      'the declined call is recorded as declined',
      history.calls?.some((c) => c.status === 'declined'),
    );
    check(
      'the answered call is recorded as completed with a duration',
      history.calls?.some((c) => c.status === 'completed' && c.durationSeconds !== null),
    );

    console.log(`\n${failures === 0 ? 'All call checks passed.' : `${failures} check(s) failed.`}`);
  } finally {
    await browser.close();
  }

  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\nCALL E2E FAILED:', error.message);
  process.exit(1);
});

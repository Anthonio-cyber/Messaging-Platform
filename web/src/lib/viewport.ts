/**
 * Keeps the app sized to the *visual* viewport rather than the layout viewport.
 *
 * When a phone's on-screen keyboard opens, iOS Safari does not shrink the layout viewport —
 * it leaves it full height and slides the keyboard over the top. A shell sized with
 * `height: 100%` therefore keeps its full height, the composer ends up behind the keyboard,
 * and Safari's attempt to scroll the focused input into view fights the shell's
 * `overflow: hidden`, so the view snaps back down.
 *
 * `window.visualViewport` reports the area actually visible above the keyboard, on both iOS
 * and Android. Publishing its height as `--app-height` and sizing the shell from that keeps
 * the composer sitting directly on top of the keyboard on every platform.
 */

/** Below this much lost height, a viewport change is a browser chrome bar, not a keyboard. */
const KEYBOARD_THRESHOLD_PX = 120;

export function installViewportSync(): () => void {
  const root = document.documentElement;
  const viewport = window.visualViewport;

  const apply = (): void => {
    const height = viewport?.height ?? window.innerHeight;
    root.style.setProperty('--app-height', `${Math.round(height)}px`);

    // The keyboard is up when the visual viewport is meaningfully shorter than the layout
    // one. Used to drop the safe-area padding, which would otherwise add a dead strip
    // between the composer and the keyboard.
    const keyboardOpen = viewport ? window.innerHeight - viewport.height > KEYBOARD_THRESHOLD_PX : false;
    root.dataset.keyboard = keyboardOpen ? 'open' : 'closed';
  };

  apply();

  viewport?.addEventListener('resize', apply);
  // iOS also fires scroll on the visual viewport as the keyboard animates in.
  viewport?.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
  window.addEventListener('resize', apply);

  return () => {
    viewport?.removeEventListener('resize', apply);
    viewport?.removeEventListener('scroll', apply);
    window.removeEventListener('orientationchange', apply);
    window.removeEventListener('resize', apply);
    root.style.removeProperty('--app-height');
    delete root.dataset.keyboard;
  };
}

/** True while the on-screen keyboard is covering part of the viewport. */
export function isKeyboardOpen(): boolean {
  return document.documentElement.dataset.keyboard === 'open';
}

/**
 * Locks the page behind the messenger so the document itself cannot scroll. Without this,
 * focusing the composer lets iOS scroll the whole page up and leave the header stranded
 * off-screen. Scrolling pages (landing, legal, settings) never call this.
 */
export function lockAppShell(): () => void {
  document.body.classList.add('app-locked');
  return () => document.body.classList.remove('app-locked');
}

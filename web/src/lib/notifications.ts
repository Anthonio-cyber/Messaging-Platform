/**
 * Browser notifications.
 *
 * Two mechanisms, for two different situations:
 *
 *   - Veylo open, tab in the background → the page raises the notification itself, with text
 *     written from the *decrypted* message. Nothing about it leaves the device.
 *   - Veylo closed → a push, relayed by the browser vendor's push service and shown by the
 *     service worker. Its text is generic ("Sent you a message") because the server composes
 *     it and the server holds only ciphertext.
 *
 * Permission is only ever requested from an explicit action in Settings — never on page load,
 * which browsers penalise and people resent.
 */
import { api } from './api';

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  return Notification.requestPermission();
}

export function showDesktopNotification(input: { title: string; body: string; tag?: string }): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // Nothing to announce about a tab the person is already looking at.
  if (document.visibilityState === 'visible') return;

  try {
    const notification = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      icon: '/favicon.svg',
      silent: false,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    /* some browsers require a service worker; failing quietly is correct here */
  }
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    window.isSecureContext
  );
}

/**
 * VAPID keys travel as base64url; PushManager wants raw bytes.
 *
 * Typed as Uint8Array<ArrayBuffer> rather than the default: applicationServerKey will not take
 * a view that might be backed by a SharedArrayBuffer, and the plain Uint8Array type admits one.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export interface PushState {
  supported: boolean;
  enabledOnServer: boolean;
  subscribed: boolean;
  devices: number;
}

export async function pushState(): Promise<PushState> {
  const supported = pushSupported();
  if (!supported) return { supported: false, enabledOnServer: false, subscribed: false, devices: 0 };

  try {
    const config = await api.get<{ enabled: boolean; publicKey: string | null; devices: number }>(
      '/api/notifications/push/key',
    );
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    return {
      supported: true,
      enabledOnServer: config.enabled,
      subscribed: Boolean(subscription),
      devices: config.devices,
    };
  } catch {
    return { supported: true, enabledOnServer: false, subscribed: false, devices: 0 };
  }
}

/**
 * Subscribes this browser to push.
 *
 * Returns the reason on failure rather than throwing, because every step here fails for
 * mundane reasons worth telling the person about: permission refused, no keys configured on
 * the deployment, or a browser that will not register a worker on this origin.
 */
export async function subscribeToPush(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!pushSupported()) {
    return { ok: false, reason: 'This browser cannot receive push notifications.' };
  }

  const config = await api.get<{ enabled: boolean; publicKey: string | null }>(
    '/api/notifications/push/key',
  );
  if (!config.enabled || !config.publicKey) {
    return { ok: false, reason: 'Push notifications are not configured on this deployment.' };
  }

  const permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'Your browser is blocking notifications for Veylo.' };
  }

  const registration = await registerServiceWorker();
  if (!registration) return { ok: false, reason: 'Could not register the notification worker.' };
  // A freshly installed worker is not controlling the page yet; subscribing before it is ready
  // fails on some browsers.
  await navigator.serviceWorker.ready;

  try {
    const existing = await registration.pushManager.getSubscription();
    // userVisibleOnly is mandatory in Chrome: a push must result in something the person sees.
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      }));

    const raw = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys.auth) {
      return { ok: false, reason: 'The browser returned an incomplete subscription.' };
    }

    await api.post('/api/notifications/push/subscribe', {
      endpoint: raw.endpoint,
      keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Could not subscribe.' };
  }
}

/** Unsubscribes this browser, both here and on the server, so delivery actually stops. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => {});
  // Server side too: an endpoint left behind would keep being pushed to until the push service
  // started rejecting it.
  await api.post('/api/notifications/push/unsubscribe', { endpoint }).catch(() => {});
}

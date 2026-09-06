/**
 * Browser notifications. Permission is only ever requested from an explicit user action in
 * Settings — never on page load, which browsers penalise and users resent.
 */
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

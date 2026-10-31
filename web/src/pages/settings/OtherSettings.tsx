import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { deriveAuthenticator } from '../../lib/crypto';
import {
  notificationPermission,
  pushState,
  requestNotificationPermission,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from '../../lib/notifications';
import { formatTimestamp } from '../../lib/format';
import { Avatar, Button, ErrorNotice, Field, Icon, Modal, Toggle, useToast } from '../../components/ui';
import { SettingsSection } from './Settings';

export function NotificationSettingsPage() {
  const toast = useToast();
  const [permission, setPermission] = useState(notificationPermission());
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('veylo.sound') !== 'off');
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushState().then(setPush);
  }, []);

  async function enable() {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'denied') {
      toast.push('Your browser is blocking notifications. Change it in site settings.', 'error');
    }
  }

  async function togglePush(wanted: boolean) {
    setBusy(true);
    try {
      if (wanted) {
        const result = await subscribeToPush();
        if (!result.ok) {
          toast.push(result.reason, 'error');
        } else {
          toast.push('This device will now be notified when Veylo is closed.', 'success');
          setPermission(notificationPermission());
        }
      } else {
        await unsubscribeFromPush();
        toast.push('This device will no longer be notified when Veylo is closed.', 'success');
      }
      setPush(await pushState());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection
        title="Desktop notifications"
        description="Veylo can show a notification when a message arrives while this tab is in the background."
      >
        {permission === 'unsupported' ? (
          <p className="text-sm text-muted">This browser does not support desktop notifications.</p>
        ) : permission === 'granted' ? (
          <p className="flex items-center gap-2 text-sm text-ok">
            <Icon name="check" className="h-4 w-4" />
            Notifications are on for this browser.
          </p>
        ) : permission === 'denied' ? (
          <p className="flex items-start gap-2 text-sm text-warn">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            This browser is blocking notifications for Veylo. Re-enable them in your browser's site
            settings, then reload.
          </p>
        ) : (
          <Button variant="secondary" onClick={enable}>
            <Icon name="bell" className="h-4 w-4" />
            Turn on notifications
          </Button>
        )}
        <p className="mt-3 text-sm leading-relaxed text-faint">
          While Veylo is open, notification text is written on this device from the decrypted message.
          Veylo's servers never see it and it never leaves your browser.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Notifications while Veylo is closed"
        description="Messages and calls can reach this device even when Veylo is not open in any tab."
      >
        {push === null ? (
          <p className="text-sm text-muted">Checking this browser…</p>
        ) : !push.supported ? (
          <p className="text-sm text-muted">
            This browser cannot receive notifications while Veylo is closed. On iPhone and iPad this
            needs Veylo added to the Home Screen first.
          </p>
        ) : !push.enabledOnServer ? (
          <p className="flex items-start gap-2 text-sm text-warn">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            This deployment has no push keys configured, so Veylo can only notify you while it is open.
          </p>
        ) : (
          <>
            <Toggle
              label="Notify this device when Veylo is closed"
              description={
                push.devices > 0
                  ? `${push.devices} ${push.devices === 1 ? 'device is' : 'devices are'} set up on your account.`
                  : undefined
              }
              checked={push.subscribed}
              disabled={busy}
              onChange={(value) => void togglePush(value)}
            />
            <div className="mt-3 space-y-2 text-sm leading-relaxed text-faint">
              <p>
                This is the one part of Veylo that relies on someone else's infrastructure. Turning it on
                registers this browser with its vendor's push service — Google's, Mozilla's or Apple's,
                depending on the browser.
              </p>
              <p>
                <span className="font-medium text-muted">What they cannot see:</span> the contents of the
                notification. It is encrypted to this browser's own keys before it leaves Veylo, and only
                this browser can open it. Message text is never in it at all — Veylo's servers hold only
                ciphertext, so a push says &ldquo;Sent you a message&rdquo; and the full text appears once
                you open the app.
              </p>
              <p>
                <span className="font-medium text-muted">What they can see:</span> that your device was
                sent a notification, and when. Over time that reveals the rhythm of when you are being
                contacted, though not by whom or about what. That is inherent to how push works on the web,
                not a choice Veylo made, and it is the reason this is off until you switch it on.
              </p>
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="In-app">
        <Toggle
          label="Play a sound for new messages"
          checked={soundOn}
          onChange={(value) => {
            setSoundOn(value);
            localStorage.setItem('veylo.sound', value ? 'on' : 'off');
          }}
        />
        <p className="mt-2 text-sm text-muted">
          Mute an individual conversation from its details panel — that setting is per conversation and
          syncs across your devices.
        </p>
      </SettingsSection>
    </>
  );
}

interface BlockedPerson {
  id: string;
  username: string;
  customAddress: string;
  displayName: string;
  avatarUrl: string | null;
  blockedAt: string;
}

export function BlockedSettingsPage() {
  const toast = useToast();
  const [blocked, setBlocked] = useState<BlockedPerson[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ blocked: BlockedPerson[] }>('/api/safety/blocks')
      .then((response) => setBlocked(response.blocked))
      .catch(() => setBlocked([]))
      .finally(() => setLoading(false));
  }, []);

  async function unblock(id: string) {
    try {
      await api.del(`/api/safety/blocks/${id}`);
      setBlocked((current) => current.filter((person) => person.id !== id));
      toast.push('Unblocked.', 'success');
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not unblock.', 'error');
    }
  }

  return (
    <SettingsSection
      title="Blocked people"
      description="Blocked accounts cannot message you or send you a request. They are not told that you blocked them."
    >
      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : blocked.length === 0 ? (
        <p className="text-sm text-muted">You have not blocked anyone.</p>
      ) : (
        <ul className="divide-y divide-line">
          {blocked.map((person) => (
            <li key={person.id} className="flex items-center gap-3 py-3">
              <Avatar name={person.displayName} src={person.avatarUrl} seed={person.id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text">{person.displayName}</p>
                <p className="truncate font-mono text-[11px] text-faint">{person.customAddress}</p>
              </div>
              <span className="hidden shrink-0 text-xs text-faint sm:block">
                {formatTimestamp(person.blockedAt)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => unblock(person.id)}>
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

export function AccountSettingsPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const toast = useToast();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const salts = await api.post<{ authSalt: string }>('/api/auth/salt', {
        identifier: user!.username,
      });
      await api.del('/api/auth/account', {
        authenticator: await deriveAuthenticator(password, salts.authSalt),
        confirmation: 'DELETE',
      });
      toast.push('Your account has been deleted.', 'success');
      await signOut();
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete your account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection title="Sign out">
        <Button
          variant="secondary"
          onClick={async () => {
            await signOut();
            navigate('/', { replace: true });
          }}
        >
          <Icon name="logout" className="h-4 w-4" />
          Sign out of this device
        </Button>
      </SettingsSection>

      <SettingsSection
        title="Delete your account"
        description="This cannot be undone. Your username and address are retired and cannot be claimed again."
      >
        <ul className="mb-4 space-y-2 text-sm leading-relaxed text-muted">
          {[
            'Your profile, bio and picture are erased.',
            'Your recovery email and every session are erased.',
            'Your encryption keys are erased, so nothing you sent can ever be decrypted again.',
            'Messages already delivered stay in other people’s conversations — that copy is theirs, and it is unreadable to us either way.',
          ].map((line) => (
            <li key={line} className="flex gap-2.5">
              <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
              {line}
            </li>
          ))}
        </ul>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          Delete my account
        </Button>
      </SettingsSection>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete your account?"
        description="Confirm with your passphrase. There is no undo and no grace period."
      >
        <form onSubmit={deleteAccount} className="space-y-4">
          {error && <ErrorNotice message={error} />}
          <Field
            data-autofocus
            label="Your passphrase"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <Field
            label="Type DELETE to confirm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder="DELETE"
            autoCapitalize="characters"
            required
          />
          <Button
            type="submit"
            variant="danger"
            fullWidth
            loading={busy}
            disabled={confirmation !== 'DELETE' || !password}
          >
            Permanently delete my account
          </Button>
        </form>
      </Modal>
    </>
  );
}

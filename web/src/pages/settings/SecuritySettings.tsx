import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { deriveKey, generateRecoveryCodes, unlockIdentity, VaultUnlockError } from '../../lib/crypto';
import { formatTimestamp, MIN_PASSWORD_LENGTH, passwordStrength } from '../../lib/format';
import { Button, ErrorNotice, Field, Icon, Modal, useToast } from '../../components/ui';
import { SettingsSection } from './Settings';

interface SessionRow {
  id: string;
  device: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
}

interface SecurityEvent {
  id: number;
  event_type: string;
  severity: string;
  created_at: string;
}

const EVENT_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.logout_all': 'Signed out of all devices',
  'auth.failed_login': 'Failed sign-in attempt',
  'auth.password_changed': 'Passphrase changed',
  'auth.password_reset': 'Passphrase reset',
  'auth.password_reset_requested': 'Passphrase reset requested',
  'auth.recovery_codes_generated': 'Recovery codes generated',
  'auth.recovery_code_used': 'Recovery code used',
  'account.created': 'Account created',
  'account.recovery_email_set': 'Recovery email updated',
  'privacy.updated': 'Privacy settings changed',
  'session.revoked': 'Device signed out',
  'keys.rotated': 'Encryption key rotated',
};

export function SecuritySettingsPage() {
  const { user, changePassword, signOutEverywhere, lock } = useAuth();
  const toast = useToast();

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [remainingCodes, setRemainingCodes] = useState<number | null>(null);

  const [changeOpen, setChangeOpen] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);
  const [confirmCodesOpen, setConfirmCodesOpen] = useState(false);
  const [codePassword, setCodePassword] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState(user?.recoveryEmail ?? '');
  const [savingEmail, setSavingEmail] = useState(false);

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    try {
      const [sessionResponse, eventResponse, codeResponse] = await Promise.all([
        api.get<{ sessions: SessionRow[] }>('/api/users/sessions'),
        api.get<{ events: SecurityEvent[] }>('/api/users/security-events'),
        api.get<{ remaining: number }>('/api/auth/recovery/codes'),
      ]);
      setSessions(sessionResponse.sessions);
      setEvents(eventResponse.events);
      setRemainingCodes(codeResponse.remaining);
    } catch {
      /* the sections render empty rather than blocking the page */
    }
  }

  async function revoke(id: string) {
    try {
      await api.del(`/api/users/sessions/${id}`);
      setSessions((current) => current.filter((session) => session.id !== id));
      toast.push('That device was signed out.', 'success');
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not sign out that device.', 'error');
    }
  }

  async function submitPasswordChange(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (nextPassword !== confirmPassword) {
      setError('The two passphrases do not match.');
      return;
    }
    if (nextPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      await changePassword(currentPassword, nextPassword);
      setChangeOpen(false);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      toast.push('Passphrase changed. Other devices were signed out.', 'success');
      await reload();
    } catch (caught) {
      setError(
        caught instanceof VaultUnlockError
          ? 'Unlock your encryption key on this device before changing your passphrase.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not change your passphrase.',
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Recovery codes seal a copy of the vault key, so the passphrase is required to make them.
   * Deriving it here — rather than reusing the unlocked private key — keeps the code path
   * identical to what a reset will later have to reverse.
   */
  async function createRecoveryCodes(event: React.FormEvent) {
    event.preventDefault();
    setCodeError(null);
    setBusy(true);
    try {
      const salts = await api.post<{ vaultSalt: string }>('/api/auth/salt', {
        identifier: user!.username,
      });
      const vaultKey = await deriveKey(codePassword, salts.vaultSalt);

      // Confirm the passphrase really is the one guarding this account before storing codes
      // that claim to unlock it.
      if (user?.encryptedPrivateKey) {
        await unlockIdentity(user.encryptedPrivateKey, vaultKey);
      }

      const codes = await generateRecoveryCodes(vaultKey, 8);
      await api.post('/api/auth/recovery/codes', {
        codes: codes.map((entry) => ({ code: entry.code, wrappedVaultKey: entry.wrappedVaultKey })),
      });

      setGeneratedCodes(codes.map((entry) => entry.code));
      setRemainingCodes(codes.length);
      setConfirmCodesOpen(false);
      setCodePassword('');
      setCodesOpen(true);
      await reload();
    } catch (caught) {
      setCodeError(
        caught instanceof VaultUnlockError
          ? 'That passphrase is not correct.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not generate recovery codes.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveRecoveryEmail() {
    setSavingEmail(true);
    try {
      const response = await api.post<{ delivered: boolean }>('/api/auth/email/set', {
        email: email.trim(),
      });
      toast.push(
        response.delivered
          ? 'Confirmation email sent. Click the link to finish.'
          : 'Saved. Check the server log for the confirmation link in development.',
        'success',
      );
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not save that address.', 'error');
    } finally {
      setSavingEmail(false);
    }
  }

  const strength = passwordStrength(nextPassword);

  return (
    <>
      <SettingsSection
        title="Passphrase"
        description="Your passphrase both signs you in and unlocks your messages. Changing it re-seals your encryption key; your history stays readable."
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setChangeOpen(true)}>
            Change passphrase
          </Button>
          <Button variant="ghost" onClick={lock}>
            <Icon name="lock" className="h-4 w-4" />
            Lock this device now
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Recovery"
        description="Without a recovery route, a forgotten passphrase means a lost account and unreadable history. There is no back door for us to open."
      >
        <div className="space-y-4">
          <div>
            <Field
              label="Recovery email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              hint={
                user?.recoveryEmailVerified
                  ? 'Confirmed. Never shown to other people.'
                  : user?.recoveryEmail
                    ? 'Saved, but not confirmed yet. Check your inbox.'
                    : 'Optional, and never shown to other people.'
              }
            />
            <Button
              className="mt-2"
              size="sm"
              variant="secondary"
              onClick={saveRecoveryEmail}
              loading={savingEmail}
              disabled={!email.trim() || email.trim() === user?.recoveryEmail}
            >
              {user?.recoveryEmail ? 'Update and re-confirm' : 'Save and confirm'}
            </Button>
          </div>

          <div className="border-t border-line pt-4">
            <p className="text-sm font-medium text-text">Recovery codes</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {remainingCodes === null
                ? 'Checking…'
                : remainingCodes > 0
                  ? `${remainingCodes} unused ${remainingCodes === 1 ? 'code' : 'codes'} remaining.`
                  : 'You have no recovery codes.'}{' '}
              A code is the only way a passphrase reset can keep your old messages readable. Generating a
              new set invalidates the previous one.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="secondary"
              onClick={() => {
                setCodeError(null);
                setCodePassword('');
                setConfirmCodesOpen(true);
              }}
            >
              <Icon name="key" className="h-3.5 w-3.5" />
              {remainingCodes ? 'Generate new codes' : 'Generate recovery codes'}
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Signed-in devices"
        description="Every browser or device with a live session. Sign out anything you do not recognise."
      >
        <ul className="divide-y divide-line">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-3 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised text-muted">
                <Icon name="key" className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {session.device}
                  {session.current && <span className="ml-2 text-xs font-normal text-accent">This device</span>}
                </p>
                <p className="text-xs text-faint">
                  Active {formatTimestamp(session.lastActiveAt)} · started{' '}
                  {formatTimestamp(session.createdAt)}
                </p>
              </div>
              {!session.current && (
                <Button size="sm" variant="ghost" onClick={() => revoke(session.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
        <Button
          className="mt-4"
          variant="danger"
          size="sm"
          onClick={() => {
            void signOutEverywhere();
          }}
        >
          <Icon name="logout" className="h-3.5 w-3.5" />
          Sign out everywhere
        </Button>
      </SettingsSection>

      <SettingsSection title="Recent security activity">
        {events.length === 0 ? (
          <p className="text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.slice(0, 20).map((event) => (
              <li key={event.id} className="flex items-center gap-3 py-2.5">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    event.severity === 'critical'
                      ? 'bg-danger'
                      : event.severity === 'warning'
                        ? 'bg-warn'
                        : 'bg-faint'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  {EVENT_LABELS[event.event_type] ?? event.event_type}
                </span>
                <span className="shrink-0 text-xs text-faint">{formatTimestamp(event.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title="How your key is stored on this device">
        <p className="text-sm leading-relaxed text-muted">
          Your unlocked encryption key is held in this tab's session storage so a page refresh does not ask
          for your passphrase again. It is cleared when you close the tab, lock this device, or sign out.
          It is never sent to Veylo. This is a deliberate trade-off: it is convenient, but a
          cross-site-scripting flaw in this app could read it. Use “Lock this device now” on a shared
          computer.
        </p>
      </SettingsSection>

      <Modal
        open={changeOpen}
        onClose={() => setChangeOpen(false)}
        title="Change your passphrase"
        description="Your encryption key is re-sealed with the new passphrase, so your message history stays readable. Other devices are signed out."
      >
        <form onSubmit={submitPasswordChange} className="space-y-4">
          {error && <ErrorNotice message={error} />}
          <Field
            data-autofocus
            label="Current passphrase"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <div>
            <Field
              label="New passphrase"
              type="password"
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
            {nextPassword && (
              <p className="mt-1.5 text-sm text-faint">
                <span className="text-muted">{strength.label}.</span> {strength.hint}
              </p>
            )}
          </div>
          <Field
            label="Confirm new passphrase"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <Button type="submit" fullWidth loading={busy}>
            Change passphrase
          </Button>
        </form>
      </Modal>

      <Modal
        open={confirmCodesOpen}
        onClose={() => setConfirmCodesOpen(false)}
        title="Confirm your passphrase"
        description="Recovery codes are sealed with your passphrase, so we need it once to create them."
      >
        <form onSubmit={createRecoveryCodes} className="space-y-4">
          {codeError && <ErrorNotice message={codeError} />}
          <Field
            data-autofocus
            label="Passphrase"
            type="password"
            value={codePassword}
            onChange={(e) => setCodePassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <Button type="submit" fullWidth loading={busy} disabled={!codePassword}>
            Generate 8 codes
          </Button>
        </form>
      </Modal>

      <Modal
        open={codesOpen}
        onClose={() => setCodesOpen(false)}
        title="Save these recovery codes"
        description="Each code works once. Store them somewhere safe and offline — a password manager or a piece of paper."
        footer={
          <Button
            onClick={() => {
              navigator.clipboard.writeText(generatedCodes?.join('\n') ?? '').catch(() => {});
              toast.push('Codes copied.', 'success');
            }}
          >
            Copy all codes
          </Button>
        }
      >
        <ul className="grid grid-cols-2 gap-2">
          {generatedCodes?.map((code) => (
            <li
              key={code}
              className="select-all rounded-lg border border-line bg-raised px-3 py-2 text-center font-mono text-sm text-text"
            >
              {code}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-relaxed text-warn">
          This is the only time these codes are shown. Veylo stores only a hash of each one and cannot
          show them again.
        </p>
      </Modal>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../lib/format';
import { useAuth } from '../store/auth';
import { AuthShell } from './AuthShell';
import { Button, ErrorNotice, Field, Icon } from '../components/ui';

type Availability =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; address: string }
  | { state: 'taken'; reason: string };

export function SignUpPage() {
  const navigate = useNavigate();
  // Carried through from an invite link, so joining a group does not require signing in
  // first and then hunting for the link again.
  const [params] = useSearchParams();
  const next = params.get('next');
  const signUp = useAuth((s) => s.signUp);
  const identityDomain = useAuth((s) => s.identityDomain);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [availability, setAvailability] = useState<Availability>({ state: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  const strength = passwordStrength(password);

  // Debounced availability check so the address is confirmed before submitting.
  useEffect(() => {
    const candidate = username.trim().toLowerCase();
    abortRef.current?.abort();

    if (candidate.length < 3) {
      setAvailability({ state: 'idle' });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setAvailability({ state: 'checking' });

    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<{ available: boolean; reason: string | null; customAddress: string }>(
          `/api/auth/availability?username=${encodeURIComponent(candidate)}`,
          controller.signal,
        );
        setAvailability(
          response.available
            ? { state: 'available', address: response.customAddress }
            : { state: 'taken', reason: response.reason ?? 'That name cannot be used.' },
        );
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return;
        setAvailability({
          state: 'taken',
          reason: caught instanceof ApiError ? caught.message : 'Could not check that name.',
        });
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [username]);

  const canSubmit =
    availability.state === 'available' &&
    displayName.trim().length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password === confirm &&
    !submitting;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    if (password !== confirm) {
      setFieldErrors({ confirm: 'The two passphrases do not match.' });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldErrors({ password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }

    setSubmitting(true);
    try {
      await signUp({
        username: username.trim().toLowerCase(),
        displayName: displayName.trim(),
        password,
        recoveryEmail: recoveryEmail.trim() || undefined,
      });
      navigate(next || '/app', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        const mapped: Record<string, string> = {};
        for (const detail of caught.details ?? []) mapped[detail.field] = detail.message;
        setFieldErrors(mapped);
      } else {
        setError('Could not create your account. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create your Veylo account"
      subtitle="Pick a name. It becomes your address and your sign-in. No phone number required."
      footer={
        <>
          Already have an account?{' '}
          <Link to={next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in'} className="link font-medium">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <ErrorNotice message={error} />}

        <Field
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
          placeholder="anagkazo"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={32}
          error={fieldErrors.username ?? (availability.state === 'taken' ? availability.reason : null)}
          hint={
            availability.state === 'available' ? (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <Icon name="check" className="h-3.5 w-3.5" />
                <span className="font-mono">{availability.address}</span> is yours
              </span>
            ) : availability.state === 'checking' ? (
              'Checking availability…'
            ) : (
              <>
                Your address will be{' '}
                <span className="font-mono">
                  {username.trim().toLowerCase() || 'username'}@{identityDomain}
                </span>
              </>
            )
          }
        />

        <Field
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Anagkazo"
          autoComplete="name"
          required
          maxLength={60}
          error={fieldErrors.displayName}
          hint="What people see in conversations. Change it any time."
        />

        <div>
          <Field
            label="Passphrase"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            error={fieldErrors.password}
          />
          {password.length > 0 && (
            <div className="mt-2">
              <div className="flex gap-1" aria-hidden="true">
                {[0, 1, 2, 3].map((index) => (
                  <span
                    key={index}
                    className={`h-1 flex-1 rounded-full transition ${
                      index < strength.score
                        ? strength.score <= 1
                          ? 'bg-danger'
                          : strength.score === 2
                            ? 'bg-warn'
                            : 'bg-ok'
                        : 'bg-line'
                    }`}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-sm text-faint">
                <span className="text-muted">{strength.label}.</span> {strength.hint}
              </p>
            </div>
          )}
        </div>

        <Field
          label="Confirm passphrase"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          error={fieldErrors.confirm}
        />

        <Field
          label="Recovery email"
          type="email"
          value={recoveryEmail}
          onChange={(e) => setRecoveryEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          error={fieldErrors.recoveryEmail}
          hint="Optional, and never shown to other people. Without it, a forgotten passphrase cannot be reset."
        />

        <div className="rounded-xl border border-warn/30 bg-warn/10 p-3.5 text-sm leading-relaxed text-warn">
          <span className="font-medium">Your passphrase is the key to your messages.</span> It never leaves
          this device, so nobody at Veylo can recover it or read your conversations for you.
        </div>

        <Button type="submit" size="lg" fullWidth loading={submitting} disabled={!canSubmit}>
          Create account
        </Button>

        <p className="text-center text-sm text-faint">
          By creating an account you agree to the{' '}
          <Link to="/terms" className="link">
            Terms
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="link">
            Privacy Policy
          </Link>
          .
        </p>
      </form>
    </AuthShell>
  );
}

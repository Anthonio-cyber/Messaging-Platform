import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import {
  createIdentity,
  deriveLoginKeys,
  randomSalt,
  resealPrivateKey,
  unlockIdentity,
  unwrapVaultKeyWithCode,
} from '../lib/crypto';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../lib/format';
import { AuthShell } from './AuthShell';
import { Button, ErrorNotice, Field, Icon, Spinner } from '../components/ui';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/api/auth/password/forgot', { email: email.trim() });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send that email.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="If that address is on file as a verified recovery address, a reset link is on its way. The link expires in 30 minutes."
        footer={
          <Link to="/sign-in" className="link font-medium">
            Back to sign in
          </Link>
        }
      >
        <div className="rounded-xl border border-line bg-raised p-4 text-sm leading-relaxed text-muted">
          <p className="mb-2 font-medium text-text">One thing to know before you reset</p>
          <p>
            Your passphrase is what unlocks your messages. Resetting it without a recovery code gives you
            your account back, but past conversations stay encrypted and unreadable. If you saved recovery
            codes, have one ready — the reset page will ask for it.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your passphrase"
      subtitle="Enter the recovery email on your account. We never show this address to other people."
      footer={
        <Link to="/sign-in" className="link font-medium">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <ErrorNotice message={error} />}
        <Field
          label="Recovery email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
          autoFocus
        />
        <Button type="submit" size="lg" fullWidth loading={submitting} disabled={!email}>
          Send reset link
        </Button>
      </form>
    </AuthShell>
  );
}

interface ResetContext {
  username: string;
  currentVaultSalt: string;
  publicKey: string | null;
  encryptedPrivateKey: string | null;
  recoveryCodesAvailable: boolean;
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [context, setContext] = useState<ResetContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);

  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveredVaultKey, setRecoveredVaultKey] = useState<Uint8Array | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = passwordStrength(password);

  useEffect(() => {
    if (!token) {
      setContextError('This reset link is missing its token.');
      setLoading(false);
      return;
    }
    api
      .post<ResetContext>('/api/auth/password/reset/context', { token })
      .then(setContext)
      .catch((caught) =>
        setContextError(caught instanceof ApiError ? caught.message : 'This reset link is not valid.'),
      )
      .finally(() => setLoading(false));
  }, [token]);

  /** Redeeming a code recovers the old vault key, which keeps message history readable. */
  async function redeemCode(event: React.FormEvent) {
    event.preventDefault();
    setCodeError(null);
    setRedeeming(true);
    try {
      const response = await api.post<{ wrappedVaultKey: string | null }>('/api/auth/recovery/redeem', {
        token,
        code: recoveryCode.trim().replace(/\s+/g, '').toLowerCase(),
      });
      if (!response.wrappedVaultKey) {
        setCodeError('That code is valid but carries no key backup. Your history cannot be recovered.');
        return;
      }
      setRecoveredVaultKey(await unwrapVaultKeyWithCode(response.wrappedVaultKey, recoveryCode));
    } catch (caught) {
      setCodeError(caught instanceof ApiError ? caught.message : 'That code could not be redeemed.');
    } finally {
      setRedeeming(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!context) return;

    if (password !== confirm) {
      setError('The two passphrases do not match.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      const [authSalt, vaultSalt] = await Promise.all([randomSalt(), randomSalt()]);
      const { authenticator, vaultKey } = await deriveLoginKeys(password, authSalt, vaultSalt);

      let encryptedPrivateKey: string;
      let publicKey: string | undefined;

      if (recoveredVaultKey && context.encryptedPrivateKey && context.publicKey) {
        // Re-open the existing identity key with the recovered vault key, then seal it under
        // the new passphrase. The same key means the same message history stays readable.
        const privateKey = await unlockIdentity(context.encryptedPrivateKey, recoveredVaultKey);
        encryptedPrivateKey = await resealPrivateKey(privateKey, vaultKey);
        publicKey = context.publicKey;
      } else {
        // No recovery code: a brand-new identity key. Old messages stay sealed.
        const identity = await createIdentity(vaultKey);
        encryptedPrivateKey = identity.encryptedPrivateKey;
        publicKey = identity.publicKey;
      }

      await api.post('/api/auth/password/reset', {
        token,
        authenticator,
        authSalt,
        vaultSalt,
        encryptedPrivateKey,
        publicKey,
      });
      navigate(`/sign-in?identity=${encodeURIComponent(context.username)}`, { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reset your passphrase.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <AuthShell title="Checking your link">
        <div className="flex items-center gap-3 text-muted">
          <Spinner />
          One moment…
        </div>
      </AuthShell>
    );
  }

  if (contextError || !context) {
    return (
      <AuthShell
        title="This link is no longer valid"
        subtitle={contextError ?? 'Reset links expire after 30 minutes and can be used only once.'}
        footer={
          <Link to="/forgot-password" className="link font-medium">
            Request a new link
          </Link>
        }
      >
        <ErrorNotice message={contextError ?? 'Request a fresh reset link to continue.'} />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Choose a new passphrase`}
      subtitle={`Resetting the account @${context.username}.`}
      footer={
        <Link to="/sign-in" className="link font-medium">
          Back to sign in
        </Link>
      }
    >
      <div className="space-y-5">
        {context.recoveryCodesAvailable && !recoveredVaultKey && (
          <form onSubmit={redeemCode} className="rounded-xl border border-line bg-raised p-4">
            <p className="text-sm font-medium text-text">Have a recovery code?</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              A code restores the key to your past conversations. Without one, this account keeps working
              but old messages stay unreadable.
            </p>
            {codeError && <p className="mt-3 text-sm text-danger">{codeError}</p>}
            <div className="mt-3 flex gap-2">
              <input
                className="field font-mono"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="xxxxxxxxxx"
                autoCapitalize="none"
                spellCheck={false}
              />
              <Button type="submit" variant="secondary" loading={redeeming} disabled={!recoveryCode.trim()}>
                Use code
              </Button>
            </div>
          </form>
        )}

        {recoveredVaultKey && (
          <div className="flex items-start gap-2.5 rounded-xl border border-ok/30 bg-ok/10 p-3.5 text-sm text-ok">
            <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Recovery code accepted. Your past conversations will still open after the reset.</span>
          </div>
        )}

        {!recoveredVaultKey && (
          <div className="rounded-xl border border-warn/30 bg-warn/10 p-3.5 text-sm leading-relaxed text-warn">
            You are resetting without a recovery code. Your account and contacts stay, but every message
            sent before this reset will stay encrypted and unreadable — including to us.
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <ErrorNotice message={error} />}
          <div>
            <Field
              label="New passphrase"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
            {password.length > 0 && (
              <p className="mt-1.5 text-sm text-faint">
                <span className="text-muted">{strength.label}.</span> {strength.hint}
              </p>
            )}
          </div>
          <Field
            label="Confirm new passphrase"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={submitting}
            disabled={!password || password !== confirm}
          >
            Reset passphrase
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setState('failed');
      setMessage('This confirmation link is missing its token.');
      return;
    }
    api
      .post('/api/auth/email/verify', { token })
      .then(() => setState('done'))
      .catch((caught) => {
        setState('failed');
        setMessage(caught instanceof ApiError ? caught.message : 'This link is no longer valid.');
      });
  }, [token]);

  return (
    <AuthShell
      title={
        state === 'working'
          ? 'Confirming your address'
          : state === 'done'
            ? 'Recovery address confirmed'
            : 'That link did not work'
      }
      subtitle={
        state === 'done'
          ? 'You can now use this address to reset your passphrase. It is never shown to other people.'
          : undefined
      }
      footer={
        <Link to="/app" className="link font-medium">
          Go to Veylo
        </Link>
      }
    >
      {state === 'working' && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner />
          One moment…
        </div>
      )}
      {state === 'done' && (
        <div className="flex items-start gap-2.5 text-sm text-ok">
          <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>All set. Nothing else to do here.</span>
        </div>
      )}
      {state === 'failed' && <ErrorNotice message={message} />}
    </AuthShell>
  );
}

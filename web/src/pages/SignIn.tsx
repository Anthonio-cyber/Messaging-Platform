import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import { AuthShell } from './AuthShell';
import { Button, ErrorNotice, Field } from '../components/ui';

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const signIn = useAuth((s) => s.signIn);

  const [identifier, setIdentifier] = useState(params.get('identity') ?? '');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(identifier.trim(), password);
      navigate(params.get('next') || '/app', { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not sign you in. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Sign in to Veylo"
      subtitle="Use your username or your full address."
      footer={
        <>
          No account yet?{' '}
          <Link
            to={params.get('next') ? `/sign-up?next=${encodeURIComponent(params.get('next')!)}` : '/sign-up'}
            className="link font-medium"
          >
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <ErrorNotice message={error} />}

        <Field
          label="Username or address"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="anagkazo or anagkazo@veylo.chat"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
        />

        <div>
          <Field
            label="Passphrase"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <div className="mt-2 text-right">
            <Link to="/forgot-password" className="text-sm text-muted transition hover:text-text">
              Forgot your passphrase?
            </Link>
          </div>
        </div>

        <Button type="submit" size="lg" fullWidth loading={submitting} disabled={!identifier || !password}>
          Sign in
        </Button>

        <p className="text-center text-sm text-faint">
          Signing in unlocks your encryption key in this browser. It takes a moment.
        </p>
      </form>
    </AuthShell>
  );
}

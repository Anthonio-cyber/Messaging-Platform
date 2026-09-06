import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import { Button, Icon, Logo, Spinner } from '../components/ui';

/**
 * Redeems a group invite link.
 *
 * The server mints these as `${APP_URL}/invite/<code>`, so this is where they land. Anyone
 * arriving signed out is sent through sign-in or sign-up with the code carried along, and
 * comes back here to redeem it — losing the invite because you did not happen to be signed
 * in already would make every link a coin toss.
 *
 * Joining does not open the group's past. Every message was sealed to the keys of the people
 * in the group when it was sent, and there is no key for a new member on any of them — not on
 * the server, not anywhere. The page says so before it says anything else, because the
 * alternative is someone assuming they can scroll up and finding out otherwise.
 */
export function InvitePage() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const status = useAuth((s) => s.status);

  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(true);
  // React mounts effects twice in StrictMode. Redeeming twice is harmless on the server — the
  // second call finds the membership already there — but it burns a use against maxUses, and
  // an invite limited to one use would then be spent by the act of accepting it.
  const attempted = useRef(false);

  useEffect(() => {
    if (status !== 'authenticated' || attempted.current) return;
    attempted.current = true;

    void (async () => {
      try {
        const response = await api.post<{ conversation: { id: string } }>(
          `/api/conversations/invites/${encodeURIComponent(code)}/join`,
          {},
        );
        navigate(`/app/c/${response.conversation.id}`, { replace: true });
      } catch (caught) {
        setError(
          caught instanceof ApiError ? caught.message : 'That invite link could not be used.',
        );
        setJoining(false);
      }
    })();
  }, [status, code, navigate]);

  if (status === 'anonymous') {
    const next = encodeURIComponent(`/invite/${code}`);
    return (
      <InviteShell title="You have been invited to a group">
        <p className="text-sm text-muted">
          Sign in to join, or create an account first. Veylo identities need no phone number.
        </p>
        <div className="mt-6 flex flex-col gap-2.5">
          <Link to={`/sign-up?next=${next}`}>
            <Button className="w-full">Create an account</Button>
          </Link>
          <Link to={`/sign-in?next=${next}`}>
            <Button variant="secondary" className="w-full">
              I already have one
            </Button>
          </Link>
        </div>
        <p className="mt-6 text-xs text-faint">
          Messages sent before you join stay unreadable. They were encrypted for the people in
          the group at the time, and no key for them exists on any server.
        </p>
      </InviteShell>
    );
  }

  if (joining) {
    return (
      <InviteShell title="Joining the group…">
        <Spinner className="mx-auto mt-2 h-5 w-5 text-muted" />
      </InviteShell>
    );
  }

  return (
    <InviteShell title="That invite did not work">
      <p className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-3 text-left text-sm text-danger">
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{error}</span>
      </p>
      <p className="mt-4 text-sm text-muted">
        Invite links can expire, be revoked, or run out of uses. Ask whoever sent it for a new
        one.
      </p>
      <Link to="/app" className="link mt-6 inline-block text-sm font-medium">
        Go to your messages
      </Link>
    </InviteShell>
  );
}

function InviteShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-ink px-5 py-12">
      <div className="w-full max-w-sm text-center">
        <Logo className="mx-auto h-10 w-10" />
        <h1 className="mt-5 text-xl font-semibold text-text">{title}</h1>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

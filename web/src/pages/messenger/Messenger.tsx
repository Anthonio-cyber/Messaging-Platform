import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../store/auth';
import { useChat } from '../../store/chat';
import { Button, EmptyState, Field, Icon, Logo, useToast } from '../../components/ui';
import { Sidebar } from './Sidebar';
import { ConversationPanel } from './ConversationPanel';
import { NewGroupDialog, NewMessageDialog } from './Dialogs';
import { VaultUnlockError } from '../../lib/crypto';

export function Messenger() {
  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId } = useParams();
  const toast = useToast();

  const { init, teardown, loadConversations, loadRequests, loadNotifications, openConversation, closeConversation } =
    useChat();
  const locked = useAuth((s) => s.locked);

  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  useEffect(() => {
    init();
    void loadConversations();
    void loadRequests();
    void loadNotifications();
    return () => teardown();
  }, [init, teardown, loadConversations, loadRequests, loadNotifications]);

  useEffect(() => {
    if (conversationId) void openConversation(conversationId);
    else closeConversation();
  }, [conversationId, openConversation, closeConversation]);

  // Nothing decrypts until the key is unlocked, so ask for it before showing an empty app.
  if (locked) return <UnlockScreen />;

  const isSubRoute = location.pathname.startsWith('/app/settings') || location.pathname.startsWith('/app/notifications') || location.pathname.startsWith('/app/admin');

  return (
    <div className="flex h-full overflow-hidden bg-ink">
      {/* One pane at a time on phones; side by side from md up. */}
      <div className={`${conversationId || isSubRoute ? 'hidden md:flex' : 'flex'} h-full w-full md:w-auto`}>
        <Sidebar
          onNewMessage={() => setNewMessageOpen(true)}
          onNewGroup={() => setNewGroupOpen(true)}
          onSelect={(id) => navigate(`/app/c/${id}`)}
        />
      </div>

      <main className={`${conversationId || isSubRoute ? 'flex' : 'hidden md:flex'} min-w-0 flex-1`}>
        {isSubRoute ? (
          <Outlet />
        ) : conversationId ? (
          <ConversationPanel conversationId={conversationId} onBack={() => navigate('/app')} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="text-center">
              <Logo className="mx-auto h-12 w-12" />
              <EmptyState
                title="Choose a conversation"
                description="Or start a new one. Your first message to someone arrives as a request they can accept or decline."
                action={
                  <Button onClick={() => setNewMessageOpen(true)}>
                    <Icon name="compose" className="h-4 w-4" />
                    New message
                  </Button>
                }
              />
            </div>
          </div>
        )}
      </main>

      <NewMessageDialog
        open={newMessageOpen}
        onClose={() => setNewMessageOpen(false)}
        onOpened={(id, requiresRequest) => {
          navigate(`/app/c/${id}`);
          if (requiresRequest) {
            toast.push('Message request sent. The conversation opens once they accept.', 'success');
          }
        }}
      />

      <NewGroupDialog
        open={newGroupOpen}
        onClose={() => setNewGroupOpen(false)}
        onCreated={(id) => navigate(`/app/c/${id}`)}
      />
    </div>
  );
}

/**
 * Signed in, but the encryption key is not loaded in this browser — a fresh tab after the
 * session storage was cleared. Nothing can be read until the passphrase re-derives it.
 */
function UnlockScreen() {
  const { unlock, signOut, user } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
    } catch (caught) {
      setError(
        caught instanceof VaultUnlockError
          ? 'That passphrase did not unlock your key.'
          : 'Could not unlock. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ink px-5">
      <div className="pane w-full max-w-sm p-6">
        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Icon name="lock" className="h-5 w-5" />
        </span>
        <h1 className="text-lg font-semibold text-text">Unlock your messages</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Your encryption key is not loaded in this browser. Enter your passphrase to unlock it — it stays
          on this device.
        </p>
        <form onSubmit={submit} className="mt-5 space-y-3">
          <Field
            type="password"
            label={`Passphrase for ${user?.customAddress ?? 'your account'}`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            error={error}
          />
          <Button type="submit" fullWidth size="lg" loading={busy} disabled={!password}>
            Unlock
          </Button>
          <Button type="button" variant="ghost" fullWidth onClick={() => void signOut()}>
            Sign out instead
          </Button>
        </form>
      </div>
    </div>
  );
}

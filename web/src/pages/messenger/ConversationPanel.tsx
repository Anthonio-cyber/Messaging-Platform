import { useEffect, useMemo, useState } from 'react';
import { useChat, type DecryptedMessage } from '../../store/chat';
import { useAuth } from '../../store/auth';
import { formatLastSeen } from '../../lib/format';
import { Avatar, Button, Icon, useToast } from '../../components/ui';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { InfoPanel } from './InfoPanel';
import { ForwardDialog, ReportDialog } from './Dialogs';
import { ApiError } from '../../lib/api';
import { useCall } from '../../store/call';
import { isCallingSupported } from '../../lib/webrtc';


export function ConversationPanel({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const user = useAuth((s) => s.user);
  const toast = useToast();
  const {
    conversations,
    members: memberMap,
    messages,
    typing,
    respondToRequest,
    setConversationFlag,
  } = useChat();

  const conversation = conversations.find((c) => c.id === conversationId);
  const members = memberMap[conversationId] ?? [];

  const [infoOpen, setInfoOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<DecryptedMessage | null>(null);
  const [editing, setEditing] = useState<DecryptedMessage | null>(null);
  const [forwarding, setForwarding] = useState<DecryptedMessage | null>(null);
  const [reporting, setReporting] = useState<DecryptedMessage | null>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const startCall = useCall((s) => s.startCall);
  const callPhase = useCall((s) => s.phase);
  // Read the transport from the store rather than asking the client directly: the socket
  // connects a moment after mount, and a plain function call is not reactive, so the buttons
  // would only appear if some unrelated state change happened to re-render this component.
  const transport = useChat((s) => s.transport);
  // Signalling needs the WebSocket; on a polling deployment the buttons stay hidden rather
  // than offering a call that cannot connect.
  const callingAvailable = isCallingSupported() && transport === 'socket';
  const callBusy = callPhase !== 'idle';

  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    setSearchOpen(false);
    setSearch('');
    setHighlightId(null);
  }, [conversationId]);

  /**
   * Conversation search runs here, over messages this device has already decrypted.
   * The server only ever holds ciphertext, so it cannot do this for us — and should not.
   */
  const searchResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term.length < 2) return [];
    return (messages[conversationId] ?? [])
      .filter((message) => message.payload?.text?.toLowerCase().includes(term))
      .slice(-40)
      .reverse();
  }, [search, messages, conversationId]);

  function startCallWith(kind: 'audio' | 'video') {
    const other = conversation?.otherMember;
    if (!other) return;
    void startCall(conversationId, kind, {
      id: other.id,
      displayName: other.displayName,
      customAddress: other.customAddress,
      avatarUrl: other.avatarUrl,
    });
  }

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Icon name="chat" className="mr-2 h-4 w-4" />
        Loading conversation…
      </div>
    );
  }

  const title =
    conversation.type === 'group'
      ? (conversation.title ?? 'Group')
      : (conversation.otherMember?.displayName ?? 'Unknown');

  const subtitle =
    conversation.type === 'group'
      ? `${conversation.memberCount} ${conversation.memberCount === 1 ? 'member' : 'members'}`
      : conversation.otherMember?.presence === 'online'
        ? 'Online now'
        : formatLastSeen(null);

  const typingNow = (typing[conversationId] ?? []).filter((entry) => entry.userId !== user?.id);
  const pending = conversation.pendingRequest;
  const composerDisabled =
    (pending?.direction === 'incoming' && pending.status === 'pending') ||
    (conversation.type === 'group' &&
      conversation.permissions?.who_can_send === 'admins' &&
      conversation.myRole === 'member');

  const composerReason =
    pending?.direction === 'incoming'
      ? 'Accept this message request to reply.'
      : 'Only admins can post in this group.';

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-ink">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2.5">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text md:hidden"
          >
            <Icon name="back" />
          </button>

          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 text-left transition hover:bg-raised"
          >
            <Avatar
              name={title}
              src={conversation.type === 'group' ? conversation.avatarUrl : conversation.otherMember?.avatarUrl}
              seed={conversation.type === 'group' ? conversation.id : conversation.otherMember?.id}
              presence={conversation.type === 'direct' ? conversation.otherMember?.presence : null}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-text">{title}</span>
              <span className="block truncate text-xs text-muted">
                {typingNow.length > 0 ? (
                  <span className="text-accent">
                    {typingNow.length === 1 ? `${typingNow[0]!.displayName} is typing…` : 'Several people are typing…'}
                  </span>
                ) : conversation.type === 'direct' ? (
                  <span className="font-mono">{conversation.otherMember?.customAddress}</span>
                ) : (
                  subtitle
                )}
              </span>
            </span>
          </button>

          <div className="flex items-center gap-0.5">
            {/* Calls are one-to-one: peer-to-peer WebRTC does not scale past two people. */}
            {conversation.type === 'direct' && conversation.otherMember && callingAvailable && (
              <>
                <button
                  type="button"
                  onClick={() => startCallWith('audio')}
                  aria-label={`Call ${title}`}
                  title={`Call ${title}`}
                  disabled={callBusy}
                  className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
                >
                  <Icon name="phone" />
                </button>
                <button
                  type="button"
                  onClick={() => startCallWith('video')}
                  aria-label={`Video call ${title}`}
                  title={`Video call ${title}`}
                  disabled={callBusy}
                  className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
                >
                  <Icon name="video" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              aria-label="Search this conversation"
              aria-pressed={searchOpen}
              className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text"
            >
              <Icon name="search" />
            </button>
            <button
              type="button"
              onClick={() =>
                setConversationFlag(conversationId, {
                  mutedUntil: conversation.mutedUntil
                    ? null
                    : new Date(Date.now() + 8 * 3600_000).toISOString(),
                }).catch(() => toast.push('Could not change mute setting.', 'error'))
              }
              aria-label={conversation.mutedUntil ? 'Unmute conversation' : 'Mute for 8 hours'}
              className={`rounded-lg p-2 transition hover:bg-raised ${
                conversation.mutedUntil ? 'text-accent' : 'text-muted hover:text-text'
              }`}
            >
              <Icon name="mute" />
            </button>
            <button
              type="button"
              onClick={() => setInfoOpen((v) => !v)}
              aria-label="Conversation details"
              className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text"
            >
              <Icon name="info" />
            </button>
          </div>
        </header>

        {searchOpen && (
          <div className="border-b border-line bg-surface px-4 py-2.5">
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
              />
              <input
                autoFocus
                className="field pl-9"
                placeholder="Search messages you have loaded"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search this conversation"
              />
            </div>
            {search.trim().length >= 2 && (
              <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-line">
                {searchResults.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted">
                    No matches in the messages loaded so far. Scroll up to load more history.
                  </p>
                ) : (
                  <ul>
                    {searchResults.map((message) => (
                      <li key={message.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setHighlightId(message.id);
                            document
                              .getElementById(`message-${message.id}`)
                              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            window.setTimeout(() => setHighlightId(null), 2500);
                          }}
                          className="block w-full truncate px-3 py-2 text-left text-sm text-muted transition hover:bg-raised hover:text-text"
                        >
                          {message.payload?.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {pending?.direction === 'incoming' && pending.status === 'pending' && (
          <div className="border-b border-line bg-accent-soft/40 px-4 py-3">
            <p className="text-sm text-text">
              <span className="font-medium">{title}</span> wants to start a conversation. They cannot see
              whether you have read this.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => respondToRequest(pending.id, 'accepted')}>
                Accept
              </Button>
              <Button size="sm" variant="secondary" onClick={() => respondToRequest(pending.id, 'declined')}>
                Decline
              </Button>
              <Button size="sm" variant="ghost" onClick={() => respondToRequest(pending.id, 'blocked')}>
                Block
              </Button>
            </div>
          </div>
        )}

        {pending?.direction === 'outgoing' && pending.status === 'pending' && (
          <div className="border-b border-line bg-raised px-4 py-2.5 text-sm text-muted">
            Waiting for {title} to accept your message request. You can send a few messages until then.
          </div>
        )}

        <MessageList
          conversation={conversation}
          members={members}
          highlightId={highlightId}
          actions={{
            onReply: (message) => {
              setEditing(null);
              setReplyTo(message);
            },
            onEdit: (message) => {
              setReplyTo(null);
              setEditing(message);
            },
            onForward: setForwarding,
            onReport: setReporting,
          }}
        />

        <Composer
          conversationId={conversationId}
          disabled={composerDisabled}
          disabledReason={composerReason}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
        />
      </div>

      <InfoPanel
        conversation={conversation}
        members={members}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
      />

      <ForwardDialog
        message={forwarding}
        onClose={() => setForwarding(null)}
        onSent={() => toast.push('Message forwarded.', 'success')}
        onError={(error) =>
          toast.push(error instanceof ApiError ? error.message : 'Could not forward that message.', 'error')
        }
      />

      <ReportDialog
        open={Boolean(reporting)}
        onClose={() => setReporting(null)}
        target={
          reporting
            ? {
                type: 'message',
                messageId: reporting.id,
                conversationId,
                userId: reporting.senderId,
                excerpt: reporting.payload?.text ?? null,
              }
            : null
        }
        onSubmitted={() => toast.push('Report received. Our moderation team will review it.', 'success')}
      />
    </div>
  );
}

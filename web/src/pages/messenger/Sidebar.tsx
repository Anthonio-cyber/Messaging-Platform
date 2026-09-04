import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useChat } from '../../store/chat';
import { useAuth } from '../../store/auth';
import { formatTimestamp } from '../../lib/format';
import { Avatar, Button, EmptyState, Icon, Skeleton, Wordmark } from '../../components/ui';
import type { ConversationSummary } from '../../lib/api';

type Tab = 'all' | 'groups' | 'requests';

export function Sidebar({
  onNewMessage,
  onNewGroup,
  onSelect,
}: {
  onNewMessage: () => void;
  onNewGroup: () => void;
  onSelect: (id: string) => void;
}) {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const {
    conversations,
    previews,
    activeId,
    loadingConversations,
    requests,
    unreadNotifications,
    showArchived,
    setShowArchived,
    connected,
  } = useChat();

  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (tab === 'groups' && conversation.type !== 'group') return false;
      if (!term) return true;
      // Sidebar search covers names and addresses. Message bodies are searched inside a
      // conversation, where this device holds the keys to read them.
      const haystack = [
        conversation.title,
        conversation.otherMember?.displayName,
        conversation.otherMember?.username,
        conversation.otherMember?.customAddress,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [conversations, query, tab]);

  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <aside className="flex h-full w-full flex-col border-r border-line bg-surface md:w-[336px] md:shrink-0">
      <header className="flex items-center justify-between gap-2 px-4 py-3.5">
        <Wordmark />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onNewGroup}
            title="New group"
            aria-label="New group"
            className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text"
          >
            <Icon name="users" />
          </button>
          <button
            type="button"
            onClick={onNewMessage}
            title="New message"
            aria-label="New message"
            className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text"
          >
            <Icon name="compose" />
          </button>
        </div>
      </header>

      <div className="px-4 pb-3">
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            className="field pl-9"
            placeholder="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search conversations"
          />
        </div>
      </div>

      <nav className="flex gap-1 border-b border-line px-3 pb-2" aria-label="Conversation filters">
        <TabButton active={tab === 'all'} onClick={() => setTab('all')} label="All" count={totalUnread} />
        <TabButton active={tab === 'groups'} onClick={() => setTab('groups')} label="Groups" />
        <TabButton
          active={tab === 'requests'}
          onClick={() => setTab('requests')}
          label="Requests"
          count={requests.incoming.length}
        />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'requests' ? (
          <RequestList />
        ) : loadingConversations && conversations.length === 0 ? (
          <div className="space-y-1 p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex gap-3 p-2">
                <Skeleton className="h-11 w-11 rounded-full" />
                <div className="flex-1 space-y-2 py-1">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={query ? 'search' : 'chat'}
            title={
              query
                ? 'Nothing matches that'
                : showArchived
                  ? 'No archived conversations'
                  : 'No conversations yet'
            }
            description={
              query
                ? 'Try a different name or address.'
                : showArchived
                  ? 'Conversations you archive will appear here.'
                  : 'Search for someone by their username or address to send your first message request.'
            }
            action={
              !query && !showArchived ? (
                <Button size="sm" onClick={onNewMessage}>
                  <Icon name="compose" className="h-3.5 w-3.5" />
                  New message
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="p-2">
            {filtered.map((conversation) => (
              <li key={conversation.id}>
                <ConversationRow
                  conversation={conversation}
                  preview={previews[conversation.id]}
                  active={conversation.id === activeId}
                  currentUserId={user?.id ?? ''}
                  onClick={() => onSelect(conversation.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="border-t border-line p-2">
        <button
          type="button"
          onClick={() => setShowArchived(!showArchived)}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-muted transition hover:bg-raised hover:text-text"
        >
          <Icon name="archive" />
          {showArchived ? 'Back to inbox' : 'Archived'}
        </button>

        <div className="mt-1 flex items-center gap-2">
          <NavLink
            to="/app/settings"
            className={({ isActive }) =>
              `flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2 transition ${
                isActive ? 'bg-raised text-text' : 'text-muted hover:bg-raised hover:text-text'
              }`
            }
          >
            <Avatar
              name={user?.displayName ?? '?'}
              src={user?.avatarUrl}
              seed={user?.id}
              size="sm"
              presence={connected ? 'online' : null}
            />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-medium text-text">{user?.displayName}</span>
              <span className="block truncate font-mono text-[11px] text-faint">{user?.customAddress}</span>
            </span>
          </NavLink>
          <button
            type="button"
            onClick={() => navigate('/app/notifications')}
            aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ''}`}
            className="relative rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text"
          >
            <Icon name="bell" />
            {unreadNotifications > 0 && (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent" />
            )}
          </button>
        </div>

        {!connected && (
          <p className="px-3 pb-1 pt-2 text-xs text-warn" role="status">
            Reconnecting…
          </p>
        )}
      </footer>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        active ? 'bg-raised text-text' : 'text-muted hover:text-text'
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-ink">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

function ConversationRow({
  conversation,
  preview,
  active,
  currentUserId,
  onClick,
}: {
  conversation: ConversationSummary;
  preview?: string;
  active: boolean;
  currentUserId: string;
  onClick: () => void;
}) {
  const name =
    conversation.type === 'group'
      ? (conversation.title ?? 'Group')
      : (conversation.otherMember?.displayName ?? 'Unknown');

  const muted = conversation.mutedUntil && new Date(conversation.mutedUntil) > new Date();
  const unread = conversation.unreadCount > 0 || conversation.manuallyUnread;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition ${
        active ? 'bg-raised' : 'hover:bg-raised/60'
      }`}
    >
      <Avatar
        name={name}
        src={conversation.type === 'group' ? conversation.avatarUrl : conversation.otherMember?.avatarUrl}
        seed={conversation.type === 'group' ? conversation.id : conversation.otherMember?.id}
        presence={conversation.type === 'direct' ? conversation.otherMember?.presence : null}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-sm text-text ${unread ? 'font-semibold' : 'font-medium'}`}
          >
            {name}
          </span>
          {conversation.pinnedAt && <Icon name="pin" className="h-3 w-3 shrink-0 text-faint" />}
          {muted && <Icon name="mute" className="h-3 w-3 shrink-0 text-faint" />}
          <span className="shrink-0 text-[11px] text-faint">
            {conversation.lastMessageAt ? formatTimestamp(conversation.lastMessageAt) : ''}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13px] ${unread ? 'text-text' : 'text-muted'}`}>
            {previewText(conversation, currentUserId, preview)}
          </span>
          {conversation.unreadCount > 0 && (
            <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold leading-none text-accent-ink">
              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
            </span>
          )}
          {conversation.unreadCount === 0 && conversation.manuallyUnread && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
          )}
        </span>
      </span>
    </button>
  );
}

function previewText(
  conversation: ConversationSummary,
  currentUserId: string,
  decrypted?: string,
): string {
  const message = conversation.lastMessage;
  if (!message) return conversation.type === 'group' ? 'No messages yet' : 'Say hello';
  if (message.deletedAt) return 'Message deleted';
  if (message.kind === 'system') return systemMessageSummary(message.systemPayload);

  const prefix = message.senderId === currentUserId ? 'You: ' : '';
  // Falls back to a neutral label when this device holds no key for the message.
  const body =
    decrypted ?? (message.attachments.length > 0 ? 'Attachment' : 'Message you cannot open here');
  return `${prefix}${body}`;
}

export function systemMessageSummary(payload: Record<string, unknown> | null): string {
  const event = payload?.event as string | undefined;
  const actor = (payload?.actorName as string | undefined) ?? 'Someone';
  switch (event) {
    case 'group_created':
      return `${actor} created the group`;
    case 'group_renamed':
      return `${actor} renamed the group to “${payload?.title as string}”`;
    case 'members_added':
      return `${actor} added ${payload?.count as number} ${(payload?.count as number) === 1 ? 'person' : 'people'}`;
    case 'member_joined':
      return `${actor} joined the group`;
    case 'member_left':
      return `${actor} left the group`;
    case 'member_removed':
      return `${actor} removed someone from the group`;
    default:
      return 'Group updated';
  }
}

function RequestList() {
  const { requests, respondToRequest } = useChat();
  const [busy, setBusy] = useState<string | null>(null);

  async function respond(id: string, decision: 'accepted' | 'declined' | 'blocked') {
    setBusy(id);
    try {
      await respondToRequest(id, decision);
    } finally {
      setBusy(null);
    }
  }

  if (requests.incoming.length === 0 && requests.outgoing.length === 0) {
    return (
      <EmptyState
        icon="inbox"
        title="No message requests"
        description="When someone you have not spoken to reaches out, their request waits here instead of landing in your inbox."
      />
    );
  }

  return (
    <div className="p-3">
      {requests.incoming.length > 0 && (
        <>
          <h2 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-faint">
            Waiting for you
          </h2>
          <ul className="space-y-2">
            {requests.incoming.map((request) => (
              <li key={request.id} className="rounded-xl border border-line bg-raised p-3">
                <div className="flex items-center gap-2.5">
                  <Avatar
                    name={request.counterpart.displayName}
                    src={request.counterpart.avatarUrl}
                    seed={request.counterpart.id}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">
                      {request.counterpart.displayName}
                    </p>
                    <p className="truncate font-mono text-[11px] text-faint">
                      {request.counterpart.customAddress}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => respond(request.id, 'accepted')}
                    loading={busy === request.id}
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => respond(request.id, 'declined')}
                    disabled={busy === request.id}
                  >
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => respond(request.id, 'blocked')}
                    disabled={busy === request.id}
                    title="Decline and block this person"
                  >
                    Block
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {requests.outgoing.length > 0 && (
        <>
          <h2 className="px-1 pb-2 pt-5 text-xs font-semibold uppercase tracking-wide text-faint">
            Sent by you
          </h2>
          <ul className="space-y-2">
            {requests.outgoing.map((request) => (
              <li
                key={request.id}
                className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2.5"
              >
                <Avatar
                  name={request.counterpart.displayName}
                  src={request.counterpart.avatarUrl}
                  seed={request.counterpart.id}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text">{request.counterpart.displayName}</p>
                  <p className="truncate text-[11px] text-faint">Waiting for a reply</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

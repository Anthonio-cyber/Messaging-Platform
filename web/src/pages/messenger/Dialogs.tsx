import { useEffect, useState } from 'react';
import { api, ApiError, type PublicUser } from '../../lib/api';
import { useChat, type DecryptedMessage } from '../../store/chat';
import { Avatar, Button, ErrorNotice, Field, Icon, Modal, Spinner, TextArea } from '../../components/ui';

const REPORT_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'spam', label: 'Spam or unwanted advertising' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate_speech', label: 'Hate speech' },
  { value: 'violence_or_threats', label: 'Violence or threats' },
  { value: 'sexual_content', label: 'Unwanted sexual content' },
  { value: 'child_safety', label: 'Child safety' },
  { value: 'scam_or_fraud', label: 'Scam or fraud' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'self_harm', label: 'Self-harm concern' },
  { value: 'other', label: 'Something else' },
];

/** Directory search, then a message request. */
export function NewMessageDialog({
  open,
  onClose,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  onOpened: (conversationId: string, requiresRequest: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<{ results: PublicUser[] }>(
          `/api/users/search?q=${encodeURIComponent(term)}`,
          controller.signal,
        );
        setResults(response.results);
        setError(null);
      } catch (caught) {
        if ((caught as Error).name !== 'AbortError') {
          setError(caught instanceof ApiError ? caught.message : 'Search failed.');
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function start(user: PublicUser) {
    setStarting(user.id);
    setError(null);
    try {
      const response = await api.post<{ conversation: { id: string }; requiresRequest: boolean }>(
        '/api/conversations/direct',
        { userId: user.id },
      );
      onOpened(response.conversation.id, response.requiresRequest);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start that conversation.');
    } finally {
      setStarting(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New message"
      description="Find someone by their username, address, or display name."
    >
      <div className="space-y-3">
        {error && <ErrorNotice message={error} />}
        <Field
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="anagkazo or anagkazo@veylo.chat"
          autoCapitalize="none"
          spellCheck={false}
          aria-label="Search for someone"
        />

        {searching && (
          <div className="flex items-center gap-2 py-2 text-sm text-muted">
            <Spinner className="h-4 w-4" />
            Searching…
          </div>
        )}

        {!searching && query.trim().length >= 2 && results.length === 0 && (
          <p className="py-3 text-sm text-muted">
            Nobody matches that. People who turned off discovery will not appear here — ask them for
            their exact address.
          </p>
        )}

        <ul className="space-y-1">
          {results.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                onClick={() => start(person)}
                disabled={starting !== null}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-raised disabled:opacity-60"
              >
                <Avatar
                  name={person.displayName}
                  src={person.avatarUrl}
                  seed={person.id}
                  presence={person.presence}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">{person.displayName}</span>
                  <span className="block truncate font-mono text-xs text-faint">{person.customAddress}</span>
                </span>
                {starting === person.id ? (
                  <Spinner className="h-4 w-4 text-muted" />
                ) : person.isContact ? (
                  <span className="chip shrink-0">Contact</span>
                ) : (
                  <Icon name="plus" className="h-4 w-4 shrink-0 text-faint" />
                )}
              </button>
            </li>
          ))}
        </ul>

        <p className="border-t border-line pt-3 text-xs leading-relaxed text-faint">
          If this is your first message to someone, it arrives as a request. They decide whether to open
          the conversation.
        </p>
      </div>
    </Modal>
  );
}

export function NewGroupDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTitle('');
      setDescription('');
      setQuery('');
      setResults([]);
      setSelected([]);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<{ results: PublicUser[] }>(
          `/api/users/search?q=${encodeURIComponent(term)}`,
          controller.signal,
        );
        setResults(response.results);
      } catch {
        /* leave the previous results in place */
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const response = await api.post<{ conversation: { id: string } }>('/api/conversations/groups', {
        title: title.trim(),
        description: description.trim() || undefined,
        memberIds: selected.map((person) => person.id),
      });
      onCreated(response.conversation.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create that group.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New group"
      description="Group messages are encrypted for the people in the group at the time they are sent."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} loading={creating} disabled={!title.trim()}>
            Create group
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNotice message={error} />}
        <Field
          data-autofocus
          label="Group name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Thursday Reading Group"
          maxLength={80}
        />
        <TextArea
          label="Description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this group for?"
          maxLength={500}
        />

        {selected.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {selected.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  onClick={() => setSelected(selected.filter((p) => p.id !== person.id))}
                  className="chip hover:border-faint"
                >
                  {person.displayName}
                  <Icon name="close" className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <Field
          label="Add people"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or address"
          autoCapitalize="none"
        />

        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {results
            .filter((person) => !selected.some((s) => s.id === person.id))
            .map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected([...selected, person]);
                    setQuery('');
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-raised"
                >
                  <Avatar name={person.displayName} src={person.avatarUrl} seed={person.id} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{person.displayName}</span>
                    <span className="block truncate font-mono text-[11px] text-faint">
                      {person.customAddress}
                    </span>
                  </span>
                  <Icon name="plus" className="h-4 w-4 shrink-0 text-faint" />
                </button>
              </li>
            ))}
        </ul>
      </div>
    </Modal>
  );
}

export function ForwardDialog({
  message,
  onClose,
  onSent,
  onError,
}: {
  message: DecryptedMessage | null;
  onClose: () => void;
  onSent: () => void;
  onError: (error: unknown) => void;
}) {
  const { conversations, forwardMessage } = useChat();
  const [busy, setBusy] = useState<string | null>(null);

  async function forward(targetId: string) {
    if (!message) return;
    setBusy(targetId);
    try {
      await forwardMessage(message, targetId);
      onSent();
      onClose();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={Boolean(message)}
      onClose={onClose}
      title="Forward message"
      description="The message is re-encrypted for the people in the conversation you choose."
    >
      <ul className="space-y-1">
        {conversations
          .filter((conversation) => conversation.id !== message?.conversationId)
          .map((conversation) => {
            const name =
              conversation.type === 'group'
                ? (conversation.title ?? 'Group')
                : (conversation.otherMember?.displayName ?? 'Unknown');
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => forward(conversation.id)}
                  disabled={busy !== null}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-raised disabled:opacity-60"
                >
                  <Avatar
                    name={name}
                    src={
                      conversation.type === 'group'
                        ? conversation.avatarUrl
                        : conversation.otherMember?.avatarUrl
                    }
                    seed={conversation.type === 'group' ? conversation.id : conversation.otherMember?.id}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{name}</span>
                  {busy === conversation.id && <Spinner className="h-4 w-4 text-muted" />}
                </button>
              </li>
            );
          })}
      </ul>
      {conversations.length <= 1 && (
        <p className="py-3 text-sm text-muted">You have no other conversations to forward this to.</p>
      )}
    </Modal>
  );
}

export interface ReportTarget {
  type: 'user' | 'message' | 'conversation';
  userId?: string | null;
  messageId?: string;
  conversationId?: string;
  excerpt?: string | null;
}

export function ReportDialog({
  open,
  onClose,
  target,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  target: ReportTarget | null;
  onSubmitted: () => void;
}) {
  const [category, setCategory] = useState('harassment');
  const [reason, setReason] = useState('');
  const [includeExcerpt, setIncludeExcerpt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCategory('harassment');
      setReason('');
      setIncludeExcerpt(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/safety/reports', {
        targetType: target.type,
        reportedUserId: target.userId ?? null,
        messageId: target.messageId ?? null,
        conversationId: target.conversationId ?? null,
        category,
        reason: reason.trim(),
        includeExcerpt,
        excerpt: includeExcerpt ? (target.excerpt ?? undefined) : undefined,
      });
      onSubmitted();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send that report.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Report to moderation"
      description="Reports go to Veylo's moderation team. The person you report is not told who reported them."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} loading={submitting}>
            Send report
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNotice message={error} />}

        <fieldset>
          <legend className="label">What is happening?</legend>
          <div className="space-y-1">
            {REPORT_CATEGORIES.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text transition hover:bg-raised"
              >
                <input
                  type="radio"
                  name="report-category"
                  value={option.value}
                  checked={category === option.value}
                  onChange={() => setCategory(option.value)}
                  className="h-4 w-4 accent-[rgb(var(--accent))]"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <TextArea
          label="Anything else our team should know?"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
          placeholder="Optional"
        />

        {target?.excerpt && (
          <div className="rounded-xl border border-line bg-raised p-3">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={includeExcerpt}
                onChange={(e) => setIncludeExcerpt(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
              />
              <span className="text-sm">
                <span className="font-medium text-text">Include the message text</span>
                <span className="mt-1 block leading-relaxed text-muted">
                  Messages are end-to-end encrypted, so moderators cannot read this conversation. Attaching
                  the text is the only way they can see what you are reporting — and it only happens if you
                  tick this box.
                </span>
              </span>
            </label>
            {includeExcerpt && (
              <p className="mt-2.5 line-clamp-3 rounded-lg bg-surface px-2.5 py-2 text-xs text-muted">
                {target.excerpt}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

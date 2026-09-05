import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChat, type DecryptedMessage } from '../../store/chat';
import { useAuth } from '../../store/auth';
import { formatDayDivider, formatTime, formatBytes } from '../../lib/format';
import { Avatar, Button, Icon, Spinner } from '../../components/ui';
import { systemMessageSummary } from './Sidebar';
import type { ConversationMember, ConversationSummary } from '../../lib/api';
import { api } from '../../lib/api';
import { decryptFile } from '../../lib/crypto';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

export interface MessageAction {
  onReply: (message: DecryptedMessage) => void;
  onEdit: (message: DecryptedMessage) => void;
  onForward: (message: DecryptedMessage) => void;
  onReport: (message: DecryptedMessage) => void;
}

export function MessageList({
  conversation,
  members,
  actions,
  highlightId,
}: {
  conversation: ConversationSummary;
  members: ConversationMember[];
  actions: MessageAction;
  highlightId?: string | null;
}) {
  const user = useAuth((s) => s.user);
  const { messages, hasMore, loadingMessages, loadOlderMessages, typing, deleteMessage, react, togglePin } =
    useChat();

  const list = messages[conversation.id] ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const previousCount = useRef(0);

  const memberById = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );

  // Stay pinned to the newest message unless the reader has scrolled up to read history.
  useLayoutEffect(() => {
    const grew = list.length > previousCount.current;
    previousCount.current = list.length;
    if (grew && atBottom) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [list.length, atBottom]);

  useEffect(() => {
    previousCount.current = 0;
    setAtBottom(true);
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
  }, [conversation.id]);

  // The on-screen keyboard shrinks the visible area from underneath the thread. Re-pin to
  // the newest message so what you were reading is not left behind the keyboard.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const onViewportChange = () => {
      if (atBottom) requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
    };
    viewport.addEventListener('resize', onViewportChange);
    return () => viewport.removeEventListener('resize', onViewportChange);
  }, [atBottom]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance < 120);
    if (element.scrollTop < 200 && hasMore[conversation.id] && !loadingMessages[conversation.id]) {
      const previousHeight = element.scrollHeight;
      void loadOlderMessages(conversation.id).then(() => {
        requestAnimationFrame(() => {
          // Keep the reader's place when older messages are prepended.
          element.scrollTop = element.scrollHeight - previousHeight;
        });
      });
    }
  }

  const typingNow = (typing[conversation.id] ?? []).filter((entry) => entry.userId !== user?.id);

  if (loadingMessages[conversation.id] && list.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }

  let lastDay = '';

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4">
        {hasMore[conversation.id] && (
          <div className="flex justify-center pb-4">
            {loadingMessages[conversation.id] ? (
              <Spinner className="h-4 w-4 text-faint" />
            ) : (
              <Button size="sm" variant="ghost" onClick={() => loadOlderMessages(conversation.id)}>
                Load earlier messages
              </Button>
            )}
          </div>
        )}

        {list.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-raised text-accent">
              <Icon name="lock" className="h-5 w-5" />
            </span>
            <p className="text-[15px] font-medium text-text">This conversation is empty</p>
            <p className="mt-1.5 max-w-xs text-sm text-muted">
              Messages here are encrypted on your device before they are sent.
            </p>
          </div>
        )}

        <ol className="space-y-0.5">
          {list.map((message, index) => {
            const day = formatDayDivider(message.createdAt);
            const showDay = day !== lastDay;
            lastDay = day;

            const previous = list[index - 1];
            const mine = message.senderId === user?.id;
            const grouped =
              !showDay &&
              previous?.senderId === message.senderId &&
              message.kind !== 'system' &&
              previous?.kind !== 'system' &&
              new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;

            return (
              <li key={message.id} id={`message-${message.id}`}>
                {showDay && (
                  <div className="flex items-center gap-3 py-4">
                    <span className="h-px flex-1 bg-line" />
                    <span className="text-xs font-medium text-faint">{day}</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                {message.kind === 'system' ? (
                  <p className="py-2 text-center text-xs text-faint">
                    {systemMessageSummary(message.systemPayload)}
                  </p>
                ) : (
                  <MessageRow
                    message={message}
                    mine={mine}
                    grouped={grouped}
                    highlighted={highlightId === message.id}
                    sender={message.senderId ? memberById.get(message.senderId) : undefined}
                    replyTo={message.replyToId ? list.find((m) => m.id === message.replyToId) : undefined}
                    isGroup={conversation.type === 'group'}
                    canModerate={conversation.myRole !== 'member'}
                    onReact={(emoji) => react(message.id, emoji)}
                    onDelete={(scope) => deleteMessage(message, scope)}
                    onPin={() => togglePin(conversation.id, message.id)}
                    actions={actions}
                  />
                )}
              </li>
            );
          })}
        </ol>

        {typingNow.length > 0 && (
          <div className="flex items-center gap-2 px-1 pt-3 text-sm text-muted" aria-live="polite">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-faint" />
              <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-faint [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-faint [animation-delay:300ms]" />
            </span>
            {typingNow.length === 1
              ? `${typingNow[0]!.displayName} is typing`
              : `${typingNow.length} people are typing`}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
          className="absolute bottom-4 right-4 rounded-full border border-line bg-surface p-2.5 text-muted shadow-pop transition hover:text-text"
          aria-label="Jump to latest messages"
        >
          <Icon name="back" className="h-4 w-4 -rotate-90" />
        </button>
      )}
    </div>
  );
}

function MessageRow({
  message,
  mine,
  grouped,
  highlighted,
  sender,
  replyTo,
  isGroup,
  canModerate,
  onReact,
  onDelete,
  onPin,
  actions,
}: {
  message: DecryptedMessage;
  mine: boolean;
  grouped: boolean;
  highlighted: boolean;
  sender?: ConversationMember;
  replyTo?: DecryptedMessage;
  isGroup: boolean;
  canModerate: boolean;
  onReact: (emoji: string) => void;
  onDelete: (scope: 'me' | 'everyone') => void;
  onPin: () => void;
  actions: MessageAction;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const deleted = Boolean(message.deletedAt);
  const body = deleted
    ? 'This message was deleted'
    : message.decryptionFailed
      ? 'This message cannot be decrypted on this device'
      : (message.payload?.text ?? '');

  async function copyText() {
    if (!message.payload?.text) return;
    try {
      await navigator.clipboard.writeText(message.payload.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
    setMenuOpen(false);
  }

  return (
    <div
      className={`group flex gap-2 py-0.5 ${mine ? 'flex-row-reverse' : ''} ${
        highlighted ? 'rounded-xl bg-accent/10' : ''
      }`}
    >
      <div className="w-8 shrink-0">
        {!mine && !grouped && isGroup && sender && (
          <Avatar name={sender.displayName} src={sender.avatarUrl} seed={sender.userId} size="sm" />
        )}
      </div>

      <div className={`flex min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {!grouped && isGroup && !mine && sender && (
          <span className="mb-0.5 px-1 text-xs font-medium text-muted">{sender.displayName}</span>
        )}

        {replyTo && (
          <div
            className={`mb-1 max-w-[min(480px,72vw)] truncate rounded-lg border-l-2 px-2.5 py-1 text-xs ${
              mine ? 'border-accent/60 bg-raised text-muted' : 'border-line bg-raised text-muted'
            }`}
          >
            <span className="font-medium">Replying to </span>
            {replyTo.deletedAt
              ? 'a deleted message'
              : (replyTo.payload?.text?.slice(0, 90) ?? 'an encrypted message')}
          </div>
        )}

        <div className="flex items-end gap-1.5">
          {/* Hover actions sit outside the bubble so they never overlap the text. */}
          <div
            className={`flex shrink-0 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 ${
              mine ? 'order-first' : 'order-last'
            }`}
          >
            {!deleted && (
              <>
                <IconAction label="Reply" icon="reply" onClick={() => actions.onReply(message)} />
                <div className="relative">
                  <IconAction label="More actions" icon="more" onClick={() => setMenuOpen((v) => !v)} />
                  {menuOpen && (
                    <MessageMenu
                      mine={mine}
                      canModerate={canModerate}
                      copied={copied}
                      hasText={Boolean(message.payload?.text)}
                      onClose={() => setMenuOpen(false)}
                      onCopy={copyText}
                      onEdit={() => {
                        actions.onEdit(message);
                        setMenuOpen(false);
                      }}
                      onForward={() => {
                        actions.onForward(message);
                        setMenuOpen(false);
                      }}
                      onPin={() => {
                        onPin();
                        setMenuOpen(false);
                      }}
                      onReport={() => {
                        actions.onReport(message);
                        setMenuOpen(false);
                      }}
                      onDelete={(scope) => {
                        onDelete(scope);
                        setMenuOpen(false);
                      }}
                      onReact={(emoji) => {
                        onReact(emoji);
                        setMenuOpen(false);
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </div>

          <div
            className={`bubble ${
              deleted || message.decryptionFailed
                ? 'border border-dashed border-line bg-transparent italic text-faint'
                : mine
                  ? 'bubble-mine'
                  : 'bubble-theirs'
            }`}
          >
            {body}
            {message.attachments.length > 0 && !deleted && (
              <div className="mt-2 space-y-1.5">
                {message.attachments.map((attachment) => (
                  <AttachmentTile
                    key={attachment.id}
                    attachmentId={attachment.id}
                    size={attachment.byteSize}
                    meta={message.payload?.attachments?.find((a) => a.id === attachment.id)}
                  />
                ))}
              </div>
            )}
            <span
              className={`ml-2 inline-flex translate-y-px items-center gap-1 align-bottom text-[11px] ${
                mine ? 'opacity-70' : 'text-faint'
              }`}
            >
              {message.editedAt && !deleted && <span title="Edited">edited</span>}
              {formatTime(message.createdAt)}
              {mine && !deleted && <DeliveryTicks message={message} />}
            </span>
          </div>
        </div>

        {message.reactions.length > 0 && (
          <div className={`mt-1 flex flex-wrap gap-1 ${mine ? 'justify-end' : ''}`}>
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                onClick={() => onReact(reaction.emoji)}
                aria-pressed={reaction.mine}
                className={`rounded-full border px-2 py-0.5 text-xs transition ${
                  reaction.mine
                    ? 'border-accent/50 bg-accent/15 text-accent'
                    : 'border-line bg-raised text-muted hover:border-faint'
                }`}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IconAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: 'reply' | 'more';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-lg p-1.5 text-faint transition hover:bg-raised hover:text-text"
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
    </button>
  );
}

function MessageMenu({
  mine,
  canModerate,
  copied,
  hasText,
  onClose,
  onCopy,
  onEdit,
  onForward,
  onPin,
  onReport,
  onDelete,
  onReact,
}: {
  mine: boolean;
  canModerate: boolean;
  copied: boolean;
  hasText: boolean;
  onClose: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onForward: () => void;
  onPin: () => void;
  onReport: () => void;
  onDelete: (scope: 'me' | 'everyone') => void;
  onReact: (emoji: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute right-0 z-20 mt-1 w-52 animate-scale-in rounded-xl border border-line bg-surface p-1 shadow-pop"
    >
      <div className="flex gap-0.5 border-b border-line px-1 pb-1.5">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onReact(emoji)}
            className="rounded-lg px-1.5 py-1 text-base transition hover:bg-raised"
            aria-label={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
      <MenuItem icon="copy" label={copied ? 'Copied' : 'Copy text'} onClick={onCopy} disabled={!hasText} />
      <MenuItem icon="forward" label="Forward" onClick={onForward} />
      <MenuItem icon="pin" label="Pin to conversation" onClick={onPin} />
      {mine && <MenuItem icon="edit" label="Edit" onClick={onEdit} disabled={!hasText} />}
      {!mine && <MenuItem icon="flag" label="Report message" onClick={onReport} />}
      <div className="my-1 h-px bg-line" />
      <MenuItem icon="trash" label="Delete for me" onClick={() => onDelete('me')} />
      {(mine || canModerate) && (
        <MenuItem icon="trash" label="Delete for everyone" tone="danger" onClick={() => onDelete('everyone')} />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  tone,
}: {
  icon: 'copy' | 'forward' | 'pin' | 'edit' | 'trash' | 'flag';
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition disabled:opacity-40 ${
        tone === 'danger' ? 'text-danger hover:bg-danger/10' : 'text-text hover:bg-raised'
      }`}
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/** Sending → Sent → Delivered → Read, drawn the way people already read these marks. */
function DeliveryTicks({ message }: { message: DecryptedMessage }) {
  if (message.recipientCount === 0) return null;
  const read = message.readCount >= message.recipientCount;
  const delivered = message.deliveredCount >= message.recipientCount;

  return (
    <span
      title={read ? 'Read' : delivered ? 'Delivered' : 'Sent'}
      className={read ? 'text-violet' : ''}
      aria-label={read ? 'Read' : delivered ? 'Delivered' : 'Sent'}
    >
      <Icon name={delivered || read ? 'doubleCheck' : 'check'} className="h-3.5 w-3.5" />
    </span>
  );
}

/** Attachments are downloaded as ciphertext and opened in the browser. */
function AttachmentTile({
  attachmentId,
  size,
  meta,
}: {
  attachmentId: string;
  size: number;
  meta?: { name: string; mimeType: string; key: string; nonce: string };
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  async function open() {
    if (!meta) return;
    if (objectUrl) {
      window.open(objectUrl, '_blank', 'noopener');
      return;
    }
    setState('loading');
    try {
      const ciphertext = await api.download(`/api/files/attachments/${attachmentId}`);
      const plaintext = await decryptFile(ciphertext, meta.key, meta.nonce);
      const url = URL.createObjectURL(
        new Blob([plaintext as unknown as BlobPart], { type: meta.mimeType }),
      );
      setObjectUrl(url);
      setState('ready');
      window.open(url, '_blank', 'noopener');
    } catch {
      setState('error');
    }
  }

  const isImage = meta?.mimeType.startsWith('image/');

  if (isImage && objectUrl) {
    return (
      <img
        src={objectUrl}
        alt={meta?.name ?? 'Attachment'}
        className="max-h-72 w-auto rounded-lg border border-line"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={!meta || state === 'loading'}
      className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface/60 px-2.5 py-2 text-left transition hover:border-faint disabled:opacity-60"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-muted">
        {state === 'loading' ? <Spinner className="h-4 w-4" /> : <Icon name="download" className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-text">
          {meta?.name ?? 'Encrypted attachment'}
        </span>
        <span className="block text-[11px] text-faint">
          {state === 'error' ? 'Could not open this file' : formatBytes(size)}
        </span>
      </span>
    </button>
  );
}

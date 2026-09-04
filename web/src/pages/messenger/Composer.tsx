import { useEffect, useRef, useState } from 'react';
import { useChat, type DecryptedMessage } from '../../store/chat';
import { Button, Icon, useToast } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { ApiError } from '../../lib/api';
import { VoiceRecorder, isVoiceRecordingSupported } from './VoiceRecorder';

const EMOJI_GROUPS: Array<{ label: string; emoji: string[] }> = [
  { label: 'Reactions', emoji: ['👍', '👎', '❤️', '🔥', '🎉', '😂', '😮', '😢', '🙏', '👀'] },
  { label: 'Faces', emoji: ['🙂', '😊', '😅', '😉', '😍', '🤔', '😴', '🤯', '😬', '🥲'] },
  { label: 'Objects', emoji: ['✅', '❌', '⚠️', '📌', '📎', '🔒', '📷', '🎧', '☕', '🌙'] },
];

const MAX_FILES = 5;

export function Composer({
  conversationId,
  disabled,
  disabledReason,
  replyTo,
  onCancelReply,
  editing,
  onCancelEdit,
}: {
  conversationId: string;
  disabled?: boolean;
  disabledReason?: string;
  replyTo: DecryptedMessage | null;
  onCancelReply: () => void;
  editing: DecryptedMessage | null;
  onCancelEdit: () => void;
}) {
  const { sendMessage, editMessage, sendTyping, sending } = useChat();
  const toast = useToast();

  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef(false);
  const typingTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setText(editing?.payload?.text ?? '');
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  // Reset the draft when switching conversations so text never lands in the wrong thread.
  useEffect(() => {
    setText('');
    setFiles([]);
  }, [conversationId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(
    () => () => {
      window.clearTimeout(typingTimer.current);
      if (typingRef.current) sendTyping(conversationId, false);
    },
    [conversationId, sendTyping],
  );

  function onType(value: string) {
    setText(value);
    if (disabled) return;

    if (!typingRef.current && value.length > 0) {
      typingRef.current = true;
      sendTyping(conversationId, true);
    }
    window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      typingRef.current = false;
      sendTyping(conversationId, false);
    }, 2500);
  }

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    const next = [...files, ...Array.from(incoming)].slice(0, MAX_FILES);
    if (files.length + incoming.length > MAX_FILES) {
      toast.push(`You can attach up to ${MAX_FILES} files at a time.`, 'error');
    }
    setFiles(next);
  }

  async function submit() {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || sending || disabled) return;

    window.clearTimeout(typingTimer.current);
    if (typingRef.current) {
      typingRef.current = false;
      sendTyping(conversationId, false);
    }

    try {
      if (editing) {
        await editMessage(editing, trimmed);
        onCancelEdit();
      } else {
        await sendMessage(conversationId, trimmed, {
          replyToId: replyTo?.id ?? null,
          files,
        });
        onCancelReply();
      }
      setText('');
      setFiles([]);
    } catch (caught) {
      toast.push(
        caught instanceof ApiError ? caught.message : 'Could not send that message. Try again.',
        'error',
      );
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
    if (event.key === 'Escape') {
      if (editing) onCancelEdit();
      else if (replyTo) onCancelReply();
    }
  }

  if (disabled) {
    return (
      <div className="border-t border-line bg-surface px-4 py-4">
        <p className="rounded-xl border border-line bg-raised px-4 py-3 text-center text-sm text-muted">
          {disabledReason ?? 'You cannot send messages in this conversation.'}
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-line bg-surface">
      {(replyTo || editing) && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <Icon name={editing ? 'edit' : 'reply'} className="h-3.5 w-3.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-accent">{editing ? 'Editing message' : 'Replying to'}</p>
            <p className="truncate text-xs text-muted">
              {(editing ?? replyTo)?.payload?.text?.slice(0, 120) ?? 'an encrypted message'}
            </p>
          </div>
          <button
            type="button"
            onClick={editing ? onCancelEdit : onCancelReply}
            aria-label={editing ? 'Cancel edit' : 'Cancel reply'}
            className="rounded-lg p-1.5 text-faint transition hover:bg-raised hover:text-text"
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5 py-1.5"
            >
              <Icon name="paperclip" className="h-3.5 w-3.5 text-faint" />
              <span className="max-w-[160px] truncate text-xs text-text">{file.name}</span>
              <span className="text-[11px] text-faint">{formatBytes(file.size)}</span>
              <button
                type="button"
                onClick={() => setFiles(files.filter((_, i) => i !== index))}
                aria-label={`Remove ${file.name}`}
                className="rounded p-0.5 text-faint transition hover:text-danger"
              >
                <Icon name="close" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="flex items-end gap-2 px-3 py-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="relative">
          <button
            type="button"
            onClick={() => setEmojiOpen((v) => !v)}
            aria-label="Insert emoji"
            aria-expanded={emojiOpen}
            className="rounded-lg p-2.5 text-muted transition hover:bg-raised hover:text-text"
          >
            <Icon name="emoji" />
          </button>
          {emojiOpen && (
            <EmojiPicker
              onPick={(emoji) => {
                setText((current) => current + emoji);
                setEmojiOpen(false);
                textareaRef.current?.focus();
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </div>

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a file"
          className="rounded-lg p-2.5 text-muted transition hover:bg-raised hover:text-text"
        >
          <Icon name="paperclip" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {/* A recording becomes an ordinary attachment, so it takes the same encrypted path. */}
        {isVoiceRecordingSupported() && (
          <VoiceRecorder
            disabled={files.length >= MAX_FILES}
            onRecorded={(file) => setFiles((current) => [...current, file].slice(0, MAX_FILES))}
          />
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={editing ? 'Edit your message' : 'Write a message'}
          aria-label="Message"
          className="field max-h-[180px] flex-1 resize-none py-2.5"
        />

        <Button
          onClick={submit}
          loading={sending}
          disabled={(!text.trim() && files.length === 0) || sending}
          aria-label={editing ? 'Save changes' : 'Send message'}
          className="h-10 w-10 !px-0"
        >
          {!sending && <Icon name={editing ? 'check' : 'send'} />}
        </Button>
      </div>

      <p className="px-4 pb-2 text-[11px] text-faint">
        <Icon name="lock" className="mr-1 inline h-3 w-3 align-[-2px] text-accent" />
        Encrypted on this device before sending. Enter to send, Shift+Enter for a new line.
      </p>
    </div>
  );
}

function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
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
      className="absolute bottom-full left-0 z-30 mb-2 w-64 animate-scale-in rounded-xl border border-line bg-surface p-3 shadow-pop"
    >
      {EMOJI_GROUPS.map((group) => (
        <div key={group.label} className="mb-2 last:mb-0">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">{group.label}</p>
          <div className="grid grid-cols-10 gap-0.5">
            {group.emoji.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onPick(emoji)}
                className="rounded-md py-1 text-lg transition hover:bg-raised"
                aria-label={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

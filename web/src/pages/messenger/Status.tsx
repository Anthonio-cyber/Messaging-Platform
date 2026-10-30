import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../../store/chat';
import { useAuth } from '../../store/auth';
import {
  buildReels,
  useStatus,
  type DecryptedStatus,
  type StatusReel,
  type StatusViewer,
} from '../../store/status';
import { formatTimestamp } from '../../lib/format';
import { ApiError } from '../../lib/api';
import { Avatar, Button, Icon, Modal, Spinner, TextArea, useToast } from '../../components/ui';

/**
 * Statuses: the tray along the top of the sidebar, the composer, and the full-screen viewer.
 *
 * The one thing this UI has to be honest about is reach. A status is encrypted for a fixed
 * list of people, computed when it is posted, so "who can see this" is not a vague setting —
 * it is a number, and the composer shows it.
 */

/** How long each status is held on screen before the viewer advances. */
const SLIDE_MS = 5000;

const BACKGROUNDS = [
  { name: 'Slate', value: '#1f2933' },
  { name: 'Plum', value: '#4c2a4d' },
  { name: 'Forest', value: '#1f3d2b' },
  { name: 'Ember', value: '#5a2b1d' },
  { name: 'Ocean', value: '#1b3a52' },
  { name: 'Ink', value: '#111418' },
];

export function StatusTray() {
  const user = useAuth((s) => s.user);
  const { conversations, members } = useChat();
  const { statuses, load } = useStatus();

  const [composerOpen, setComposerOpen] = useState(false);
  const [openReel, setOpenReel] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Names and avatars for status authors come from conversations and group member lists, which
   * are already loaded. A status carries no profile of its own — the server would otherwise be
   * handing out a directory of everyone's contacts.
   */
  const people = useMemo(() => {
    const map = new Map<string, { displayName: string; avatarUrl: string | null }>();
    if (user) map.set(user.id, { displayName: user.displayName, avatarUrl: user.avatarUrl });
    for (const conversation of conversations) {
      const other = conversation.otherMember;
      if (other) map.set(other.id, { displayName: other.displayName, avatarUrl: other.avatarUrl });
    }
    for (const list of Object.values(members)) {
      for (const member of list) {
        if (!map.has(member.userId)) {
          map.set(member.userId, { displayName: member.displayName, avatarUrl: member.avatarUrl });
        }
      }
    }
    return map;
  }, [conversations, members, user]);

  const reels = useMemo(
    () => buildReels(statuses, people, user?.id ?? null),
    [statuses, people, user?.id],
  );

  const mine = reels.find((reel) => reel.authorId === user?.id);
  const others = reels.filter((reel) => reel.authorId !== user?.id);
  const active = reels.find((reel) => reel.authorId === openReel) ?? null;

  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <ul className="flex items-start gap-3 overflow-x-auto pb-1" aria-label="Statuses">
          <li className="shrink-0">
            <button
              type="button"
              onClick={() => (mine ? setOpenReel(user?.id ?? null) : setComposerOpen(true))}
              className="flex w-16 flex-col items-center gap-1.5 text-center"
              aria-label={mine ? 'View your status' : 'Add a status'}
            >
              <span className="relative">
                <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} seed={user?.id} />
                <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-accent text-accent-ink">
                  <Icon name="plus" className="h-3 w-3" />
                </span>
              </span>
              <span className="w-full truncate text-[11px] text-muted">
                {mine ? 'Your status' : 'Add status'}
              </span>
            </button>
          </li>

          {others.map((reel) => (
            <li key={reel.authorId} className="shrink-0">
              <button
                type="button"
                onClick={() => setOpenReel(reel.authorId)}
                className="flex w-16 flex-col items-center gap-1.5 text-center"
                aria-label={`View ${reel.displayName}'s status`}
              >
                {/* An unseen reel gets a ring; a seen one does not. That is the whole signal. */}
                <span
                  className={`rounded-full p-[2px] ${
                    reel.allViewed ? 'bg-line' : 'bg-gradient-to-br from-accent to-accent/40'
                  }`}
                >
                  <span className="block rounded-full border-2 border-surface">
                    <Avatar name={reel.displayName} src={reel.avatarUrl} seed={reel.authorId} />
                  </span>
                </span>
                <span className="w-full truncate text-[11px] text-muted">{reel.displayName}</span>
              </button>
            </li>
          ))}

          {mine && (
            <li className="shrink-0">
              <button
                type="button"
                onClick={() => setComposerOpen(true)}
                className="flex w-16 flex-col items-center gap-1.5 text-center"
                aria-label="Add another status"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-faint text-faint">
                  <Icon name="plus" className="h-4 w-4" />
                </span>
                <span className="w-full truncate text-[11px] text-muted">Add</span>
              </button>
            </li>
          )}
        </ul>
      </div>

      <StatusComposer open={composerOpen} onClose={() => setComposerOpen(false)} />
      {active && <StatusViewerOverlay reel={active} onClose={() => setOpenReel(null)} />}
    </>
  );
}

function StatusComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { post, posting } = useStatus();

  const [caption, setCaption] = useState('');
  const [background, setBackground] = useState(BACKGROUNDS[0]!.value);
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [reach, setReach] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setCaption('');
      setImage(null);
      setPreview(null);
      return;
    }
    // Shown before anything is posted: people should know how far this goes beforehand, not
    // find out from a view count afterwards.
    void import('../../lib/api').then(({ api }) =>
      api
        .get<{ reach: number }>('/api/statuses/audience')
        .then((response) => setReach(response.reach))
        .catch(() => setReach(null)),
    );
  }, [open]);

  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  async function submit() {
    try {
      await post({ caption: caption.trim(), background: image ? undefined : background, image });
      toast.push('Status posted. It disappears after 24 hours.', 'success');
      onClose();
    } catch (error) {
      toast.push(
        error instanceof ApiError ? error.message : 'Could not post that status.',
        'error',
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add to your status"
      description="Visible for 24 hours, then deleted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={posting} disabled={!caption.trim() && !image}>
            Post
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {preview ? (
          <div className="relative overflow-hidden rounded-xl border border-line">
            <img src={preview} alt="" className="max-h-64 w-full object-contain bg-black" />
            <button
              type="button"
              onClick={() => setImage(null)}
              aria-label="Remove image"
              className="absolute right-2 top-2 rounded-lg bg-black/60 p-1.5 text-white"
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div
            className="flex min-h-32 items-center justify-center rounded-xl px-4 py-6 text-center"
            style={{ background }}
          >
            <p className="whitespace-pre-wrap break-words text-lg font-medium text-white">
              {caption.trim() || 'Your status'}
            </p>
          </div>
        )}

        <TextArea
          data-autofocus
          label="Caption"
          rows={3}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Say something"
          maxLength={700}
        />

        {!image && (
          <div>
            <span className="label">Background</span>
            <div className="flex flex-wrap gap-2">
              {BACKGROUNDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setBackground(option.value)}
                  aria-label={option.name}
                  aria-pressed={background === option.value}
                  className={`h-8 w-8 rounded-full border-2 transition ${
                    background === option.value ? 'border-accent' : 'border-line'
                  }`}
                  style={{ background: option.value }}
                />
              ))}
            </div>
          </div>
        )}

        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              setImage(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <Icon name="paperclip" className="h-4 w-4" />
            {image ? 'Choose a different image' : 'Add an image'}
          </Button>
        </div>

        <p className="rounded-xl border border-line bg-raised px-3.5 py-3 text-sm leading-relaxed text-muted">
          <Icon name="lock" className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-accent" />
          {reach === null
            ? 'Encrypted on this device for your contacts.'
            : reach === 0
              ? 'Nobody will see this yet — you have no contacts, so there is no one to encrypt it for.'
              : `Encrypted on this device for your ${reach} ${reach === 1 ? 'contact' : 'contacts'}. Anyone who becomes a contact later will not be able to read it.`}
        </p>
      </div>
    </Modal>
  );
}

/**
 * The full-screen viewer. Advances through one author's statuses, pausing while held.
 */
function StatusViewerOverlay({ reel, onClose }: { reel: StatusReel; onClose: () => void }) {
  const user = useAuth((s) => s.user);
  const toast = useToast();
  const { markViewed, remove, listViewers, loadMedia } = useStatus();

  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [viewers, setViewers] = useState<StatusViewer[] | null>(null);

  const status = reel.statuses[index];
  const isMine = reel.authorId === user?.id;

  // A reel that empties under us (deleted its last status) has nothing left to show.
  useEffect(() => {
    if (reel.statuses.length === 0) onClose();
  }, [reel.statuses.length, onClose]);

  useEffect(() => {
    setElapsed(0);
    if (status) void markViewed(status.id);
  }, [status?.id, markViewed]);

  useEffect(() => {
    setMediaUrl(null);
    if (!status?.payload?.media) return;
    let cancelled = false;
    let created: string | null = null;

    void loadMedia(status).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      created = url;
      setMediaUrl(url);
    });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [status?.id, status, loadMedia]);

  // The progress bar and the advance are the same clock, so they cannot drift apart.
  useEffect(() => {
    if (paused || !status) return;
    const started = Date.now() - elapsed;
    const timer = window.setInterval(() => {
      const next = Date.now() - started;
      if (next >= SLIDE_MS) {
        window.clearInterval(timer);
        if (index + 1 < reel.statuses.length) {
          setIndex(index + 1);
        } else {
          onClose();
        }
        return;
      }
      setElapsed(next);
    }, 50);
    return () => window.clearInterval(timer);
    // `elapsed` is deliberately absent: including it would restart the interval every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, index, status?.id, reel.statuses.length, onClose]);

  useEffect(() => {
    // Suspended while the viewer list is open. Both that dialog and this overlay listen on the
    // document, so one Escape would otherwise close the list and the status behind it in the
    // same keystroke — the person meant to dismiss the list and ends up back at the inbox.
    if (viewers !== null) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, reel.statuses.length - 1));
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, reel.statuses.length, viewers]);

  if (!status) return null;

  const payload = status.payload;
  const background = payload?.background ?? '#111418';

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black/95" role="dialog" aria-modal="true">
      <div className="flex gap-1 px-3 pt-3">
        {reel.statuses.map((entry, position) => (
          <span key={entry.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/25">
            <span
              className="block h-full bg-white"
              style={{
                width:
                  position < index ? '100%' : position === index ? `${(elapsed / SLIDE_MS) * 100}%` : '0%',
              }}
            />
          </span>
        ))}
      </div>

      <header className="flex items-center gap-3 px-4 py-3">
        <Avatar name={reel.displayName} src={reel.avatarUrl} seed={reel.authorId} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-white">{reel.displayName}</span>
          <span className="block text-[11px] text-white/60">{formatTimestamp(status.createdAt)}</span>
        </span>
        {isMine && (
          <button
            type="button"
            onClick={async () => {
              await remove(status.id).catch(() => toast.push('Could not delete that status.', 'error'));
              onClose();
            }}
            aria-label="Delete this status"
            className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <Icon name="trash" className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close status"
          className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </header>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onPointerDown={() => setPaused(true)}
        onPointerUp={() => setPaused(false)}
        onPointerLeave={() => setPaused(false)}
      >
        {/* Tap zones: left goes back, right goes forward. */}
        <button
          type="button"
          aria-label="Previous status"
          className="absolute inset-y-0 left-0 z-10 w-1/3"
          onClick={() => (index > 0 ? setIndex(index - 1) : undefined)}
        />
        <button
          type="button"
          aria-label="Next status"
          className="absolute inset-y-0 right-0 z-10 w-1/3"
          onClick={() =>
            index + 1 < reel.statuses.length ? setIndex(index + 1) : onClose()
          }
        />

        {payload === null ? (
          <p className="max-w-sm px-6 text-center text-sm text-white/70">
            This status cannot be read on this device. It was encrypted for a key this device does
            not hold.
          </p>
        ) : payload.media ? (
          mediaUrl ? (
            <img src={mediaUrl} alt={payload.caption} className="max-h-full max-w-full object-contain" />
          ) : (
            <Spinner className="h-6 w-6 text-white/60" />
          )
        ) : (
          <div
            className="flex h-full w-full items-center justify-center px-8"
            style={{ background }}
          >
            <p className="max-w-lg whitespace-pre-wrap break-words text-center text-2xl font-medium text-white">
              {payload.caption}
            </p>
          </div>
        )}

        {payload?.media && payload.caption && (
          <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-6 pb-6 pt-12 text-center text-white">
            {payload.caption}
          </p>
        )}
      </div>

      {isMine && (
        <footer className="safe-bottom border-t border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={async () => {
              setPaused(true);
              setViewers(await listViewers(status.id).catch(() => []));
            }}
            className="flex items-center gap-2 text-sm text-white/80 transition hover:text-white"
          >
            <Icon name="users" className="h-4 w-4" />
            {status.viewCount === 0
              ? 'No views yet'
              : `${status.viewCount} ${status.viewCount === 1 ? 'view' : 'views'}`}
          </button>
        </footer>
      )}

      <ViewerList
        viewers={viewers}
        onClose={() => {
          setViewers(null);
          setPaused(false);
        }}
      />
    </div>
  );
}

function ViewerList({
  viewers,
  onClose,
}: {
  viewers: StatusViewer[] | null;
  onClose: () => void;
}) {
  return (
    <Modal open={viewers !== null} onClose={onClose} title="Viewed by" size="sm">
      {viewers?.length === 0 ? (
        <p className="text-sm text-muted">
          Nobody has opened this yet. People who turn off read receipts never appear here, so this
          list can be shorter than the real number.
        </p>
      ) : (
        <ul className="space-y-1">
          {viewers?.map((viewer) => (
            <li key={viewer.userId} className="flex items-center gap-2.5 px-1 py-1.5">
              <Avatar name={viewer.displayName} src={viewer.avatarUrl} seed={viewer.userId} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">{viewer.displayName}</span>
                <span className="block truncate font-mono text-[11px] text-faint">
                  {viewer.customAddress}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-faint">{formatTimestamp(viewer.viewedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export type { DecryptedStatus };

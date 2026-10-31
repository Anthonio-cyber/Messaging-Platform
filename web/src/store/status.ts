import { create } from 'zustand';
import { api } from '../lib/api';
import { realtime } from '../lib/realtime';
import {
  decryptFile,
  decryptMessage,
  encryptFile,
  encryptForMembers,
  type KeyRecipient,
  type StatusPayload,
} from '../lib/crypto';
import { useAuth } from './auth';

/**
 * Statuses: short posts that expire after a day.
 *
 * Encrypted exactly as group messages are, which decides the audience: keys are wrapped per
 * recipient, so a status goes to the author's contacts and the list is fixed when it is posted.
 * The composer says so out loud rather than leaving people to discover it.
 */

export interface ApiStatus {
  id: string;
  authorId: string;
  kind: 'text' | 'image';
  ciphertext: string;
  nonce: string;
  wrappedKey: string | null;
  mediaId: string | null;
  createdAt: string;
  expiresAt: string;
  viewed: boolean;
  viewCount: number | null;
}

export interface DecryptedStatus extends ApiStatus {
  payload: StatusPayload | null;
}

/** One author's statuses, grouped the way the tray and the viewer both want them. */
export interface StatusReel {
  authorId: string;
  displayName: string;
  avatarUrl: string | null;
  statuses: DecryptedStatus[];
  allViewed: boolean;
}

export interface StatusViewer {
  userId: string;
  displayName: string;
  customAddress: string;
  avatarUrl: string | null;
  viewedAt: string;
}

interface StatusState {
  statuses: DecryptedStatus[];
  loading: boolean;
  posting: boolean;
  /** Who this device would wrap keys for, and therefore how far a post actually reaches. */
  reach: number | null;

  load: () => Promise<void>;
  post: (input: { caption: string; background?: string; image?: File | null }) => Promise<void>;
  markViewed: (statusId: string) => Promise<void>;
  remove: (statusId: string) => Promise<void>;
  listViewers: (statusId: string) => Promise<StatusViewer[]>;
  loadMedia: (status: DecryptedStatus) => Promise<string | null>;
  reset: () => void;
}

async function decryptStatus(status: ApiStatus): Promise<DecryptedStatus> {
  const identity = useAuth.getState().identity;
  if (!identity) return { ...status, payload: null };
  const payload = await decryptMessage<StatusPayload>(status, identity);
  return { ...status, payload };
}

export const useStatus = create<StatusState>((set, get) => ({
  statuses: [],
  loading: false,
  posting: false,
  reach: null,

  async load() {
    set({ loading: true });
    try {
      const response = await api.get<{ statuses: ApiStatus[] }>('/api/statuses');
      const decrypted = await Promise.all(response.statuses.map(decryptStatus));
      set({ statuses: decrypted });
    } finally {
      set({ loading: false });
    }
  },

  async post({ caption, background, image }) {
    set({ posting: true });
    try {
      // The server owns the audience: it depends on the contact list, the block list and the
      // author's own privacy setting, none of which this device can be trusted to recompute.
      const { audience, reach } = await api.get<{ audience: KeyRecipient[]; reach: number }>(
        '/api/statuses/audience',
      );
      set({ reach });

      const me = useAuth.getState().user;
      const identity = useAuth.getState().identity;
      if (!me || !identity) throw new Error('Unlock Veylo before posting a status.');

      let media: StatusPayload['media'] | undefined;
      if (image) {
        // Encrypted here, then uploaded as opaque bytes — the server stores an image it cannot
        // view, and the key to it travels inside the sealed status payload.
        const encrypted = await encryptFile(await image.arrayBuffer());
        const uploaded = await api.upload<{ mediaId: string }>('/api/statuses/media', encrypted.blob);
        media = {
          id: uploaded.mediaId,
          key: encrypted.key,
          nonce: encrypted.nonce,
          mimeType: image.type || 'image/jpeg',
        };
      }

      const payload: StatusPayload = {
        caption,
        ...(background ? { background } : {}),
        ...(media ? { media } : {}),
      };

      // Always including yourself: otherwise you could not re-read your own post, which is
      // where the view count lives.
      const recipients: KeyRecipient[] = [
        { userId: me.id, publicKey: identity.publicKey },
        ...audience.filter((entry) => entry.userId !== me.id),
      ];

      const encrypted = await encryptForMembers<StatusPayload>(payload, recipients);
      await api.post('/api/statuses', {
        kind: media ? 'image' : 'text',
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keys: encrypted.keys,
        mediaId: media?.id ?? null,
      });

      await get().load();
    } finally {
      set({ posting: false });
    }
  },

  async markViewed(statusId) {
    // Optimistic: the ring around an avatar should go dim the moment it is opened, not after a
    // round trip. A failed call costs nothing here — the server is the source of truth for the
    // author's view list, and this flag is only local decoration.
    set((current) => ({
      statuses: current.statuses.map((status) =>
        status.id === statusId ? { ...status, viewed: true } : status,
      ),
    }));
    await api.post(`/api/statuses/${statusId}/view`, {}).catch(() => {});
  },

  async remove(statusId) {
    await api.del(`/api/statuses/${statusId}`);
    set((current) => ({ statuses: current.statuses.filter((status) => status.id !== statusId) }));
  },

  async listViewers(statusId) {
    const response = await api.get<{ viewers: StatusViewer[] }>(`/api/statuses/${statusId}/viewers`);
    return response.viewers;
  },

  async loadMedia(status) {
    const media = status.payload?.media;
    if (!media) return null;
    try {
      const encrypted = await api.download(`/api/statuses/media/${media.id}`);
      const bytes = await decryptFile(encrypted, media.key, media.nonce);
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: media.mimeType }));
    } catch {
      // Expired mid-view, swept, or sealed to a key this device no longer holds. The viewer
      // shows the caption without the image rather than an error.
      return null;
    }
  },

  reset() {
    set({ statuses: [], reach: null });
  },
}));

/**
 * Groups statuses into one reel per author, yours first, then unseen authors, then seen.
 * That ordering is the whole point of the tray: the thing worth tapping sits on the left.
 */
export function buildReels(
  statuses: DecryptedStatus[],
  people: Map<string, { displayName: string; avatarUrl: string | null }>,
  selfId: string | null,
): StatusReel[] {
  const byAuthor = new Map<string, DecryptedStatus[]>();
  for (const status of statuses) {
    const list = byAuthor.get(status.authorId) ?? [];
    list.push(status);
    byAuthor.set(status.authorId, list);
  }

  const reels: StatusReel[] = [...byAuthor.entries()].map(([authorId, list]) => ({
    authorId,
    displayName: authorId === selfId ? 'Your status' : (people.get(authorId)?.displayName ?? 'Someone'),
    avatarUrl: people.get(authorId)?.avatarUrl ?? null,
    statuses: [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    // Your own reel never shows as unseen: you posted it.
    allViewed: authorId === selfId || list.every((status) => status.viewed),
  }));

  return reels.sort((a, b) => {
    if (a.authorId === selfId) return -1;
    if (b.authorId === selfId) return 1;
    if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1;
    const aLatest = a.statuses[a.statuses.length - 1]?.createdAt ?? '';
    const bLatest = b.statuses[b.statuses.length - 1]?.createdAt ?? '';
    return bLatest.localeCompare(aLatest);
  });
}

/** Re-reads the tray when someone in your contacts posts. */
export function bindStatusRealtime(): void {
  realtime.on('status:new', () => {
    void useStatus.getState().load();
  });
}

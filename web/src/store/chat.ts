import { create } from 'zustand';
import {
  api,
  type ApiMessage,
  type AppNotification,
  type ConversationMember,
  type ConversationSummary,
  type MessageRequest,
} from '../lib/api';
import { realtime, type RealtimeHandlers, type TransportMode } from '../lib/realtime';
import {
  decryptMessage,
  encryptForMembers,
  encryptFile,
  type MessagePayload,
} from '../lib/crypto';
import { useAuth, type Identity } from './auth';
import { showDesktopNotification } from '../lib/notifications';

export interface DecryptedMessage extends ApiMessage {
  /** null while decryption is pending; undefined text means it could not be opened. */
  payload: MessagePayload | null;
  decryptionFailed: boolean;
}

interface TypingEntry {
  userId: string;
  displayName: string;
  expiresAt: number;
}

interface ChatState {
  conversations: ConversationSummary[];
  /** Decrypted last-message text, keyed by conversation id, for the sidebar. */
  previews: Record<string, string>;
  activeId: string | null;
  messages: Record<string, DecryptedMessage[]>;
  members: Record<string, ConversationMember[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, TypingEntry[]>;
  presence: Record<string, string>;
  requests: { incoming: MessageRequest[]; outgoing: MessageRequest[] };
  notifications: AppNotification[];
  unreadNotifications: number;
  loadingConversations: boolean;
  loadingMessages: Record<string, boolean>;
  sending: boolean;
  connected: boolean;
  /** Which transport is live. "polling" means the host cannot hold a WebSocket. */
  transport: TransportMode;
  showArchived: boolean;

  init: () => void;
  teardown: () => void;
  loadConversations: (options?: { archived?: boolean }) => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  closeConversation: () => void;
  loadOlderMessages: (id: string) => Promise<void>;
  sendMessage: (
    conversationId: string,
    text: string,
    options?: { replyToId?: string | null; files?: File[]; mentions?: string[] },
  ) => Promise<void>;
  editMessage: (message: DecryptedMessage, text: string) => Promise<void>;
  deleteMessage: (message: DecryptedMessage, scope: 'me' | 'everyone') => Promise<void>;
  forwardMessage: (message: DecryptedMessage, targetConversationId: string) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;
  togglePin: (conversationId: string, messageId: string) => Promise<void>;
  markConversationRead: (conversationId: string) => Promise<void>;
  setConversationFlag: (
    id: string,
    flags: { archived?: boolean; pinned?: boolean; unread?: boolean; mutedUntil?: string | null },
  ) => Promise<void>;
  sendTyping: (conversationId: string, typing: boolean) => void;
  loadRequests: () => Promise<void>;
  respondToRequest: (id: string, decision: 'accepted' | 'declined' | 'blocked') => Promise<void>;
  loadNotifications: () => Promise<void>;
  markNotificationsRead: (ids?: string[]) => Promise<void>;
  setShowArchived: (value: boolean) => void;
  reloadMembers: (conversationId: string) => Promise<void>;
}

function identity(): Identity | null {
  return useAuth.getState().identity;
}

async function decrypt(message: ApiMessage): Promise<DecryptedMessage> {
  if (message.kind === 'system' || message.deletedAt) {
    return { ...message, payload: null, decryptionFailed: false };
  }
  const id = identity();
  if (!id) return { ...message, payload: null, decryptionFailed: true };

  const payload = await decryptMessage(message, id);
  return { ...message, payload, decryptionFailed: payload === null };
}

async function decryptAll(messages: ApiMessage[]): Promise<DecryptedMessage[]> {
  return Promise.all(messages.map(decrypt));
}

function mergeMessage(list: DecryptedMessage[], incoming: DecryptedMessage): DecryptedMessage[] {
  const index = list.findIndex((m) => m.id === incoming.id);
  if (index === -1) {
    return [...list, incoming].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }
  const next = [...list];
  next[index] = incoming;
  return next;
}

let socketBound = false;
let typingSweep: number | undefined;

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  previews: {},
  activeId: null,
  messages: {},
  members: {},
  hasMore: {},
  typing: {},
  presence: {},
  requests: { incoming: [], outgoing: [] },
  notifications: [],
  unreadNotifications: 0,
  loadingConversations: false,
  loadingMessages: {},
  sending: false,
  connected: false,
  transport: 'connecting',
  showArchived: false,

  init() {
    if (socketBound) return;
    socketBound = true;

    // One set of handlers, fed by whichever transport is live — a WebSocket where the host
    // can hold one, polling where it cannot.
    const handlers: RealtimeHandlers = {
      'message:new': async ({ conversationId, message }: { conversationId: string; message: ApiMessage }) => {
        const state = get();
        const existing = state.messages[conversationId] ?? [];
        // Polling re-reports recent messages; skip anything already shown unchanged.
        const already = existing.find((m) => m.id === message.id);
        if (already && already.editedAt === message.editedAt && already.readCount === message.readCount) {
          return;
        }

        const decrypted = await decrypt(message);
        const isActive = state.activeId === conversationId;

        set((current) => ({
          messages: {
            ...current.messages,
            [conversationId]: mergeMessage(current.messages[conversationId] ?? [], decrypted),
          },
        }));

        void get().loadConversations({ archived: get().showArchived });

        const me = useAuth.getState().user;
        if (already || !message.senderId || !me || message.senderId === me.id) return;

        if (isActive && document.visibilityState === 'visible') {
          void get().markConversationRead(conversationId);
          return;
        }

        const conversation = state.conversations.find((c) => c.id === conversationId);
        const muted = conversation?.mutedUntil && new Date(conversation.mutedUntil) > new Date();
        if (muted) return;

        const sender =
          conversation?.type === 'group'
            ? (state.members[conversationId]?.find((m) => m.userId === message.senderId)?.displayName ??
              'Someone')
            : (conversation?.otherMember?.displayName ?? 'New message');
        showDesktopNotification({
          title: conversation?.type === 'group' ? `${sender} · ${conversation.title}` : sender,
          body: decrypted.payload?.text?.slice(0, 140) ?? 'Sent you a message.',
          tag: conversationId,
        });
      },

      'message:updated': async ({ conversationId, message }: { conversationId: string; message: ApiMessage }) => {
        const decrypted = await decrypt(message);
        set((current) => ({
          messages: {
            ...current.messages,
            [conversationId]: mergeMessage(current.messages[conversationId] ?? [], decrypted),
          },
        }));
      },

      'message:deleted': ({ conversationId, messageId }: { conversationId: string; messageId: string }) => {
        set((current) => ({
          messages: {
            ...current.messages,
            [conversationId]: (current.messages[conversationId] ?? []).map((m) =>
              m.id === messageId
                ? { ...m, deletedAt: m.deletedAt ?? new Date().toISOString(), payload: null, decryptionFailed: false }
                : m,
            ),
          },
        }));
        void get().loadConversations({ archived: get().showArchived });
      },

      'message:read': ({ conversationId, messageIds }: { conversationId: string; messageIds: string[] }) => {
        const ids = new Set(messageIds);
        set((current) => ({
          messages: {
            ...current.messages,
            [conversationId]: (current.messages[conversationId] ?? []).map((m) =>
              ids.has(m.id) ? { ...m, readCount: Math.min(m.readCount + 1, m.recipientCount) } : m,
            ),
          },
        }));
      },

      'message:delivered': ({ conversationId, messageIds }: { conversationId: string; messageIds: string[] }) => {
        const ids = new Set(messageIds);
        set((current) => ({
          messages: {
            ...current.messages,
            [conversationId]: (current.messages[conversationId] ?? []).map((m) =>
              ids.has(m.id) ? { ...m, deliveredCount: Math.min(m.deliveredCount + 1, m.recipientCount) } : m,
            ),
          },
        }));
      },

      'typing:update': ({
        conversationId,
        userId,
        displayName,
        typing,
      }: {
        conversationId: string;
        userId: string;
        displayName?: string;
        typing: boolean;
      }) => {
        set((current) => {
          const existing = (current.typing[conversationId] ?? []).filter(
            (entry) => entry.userId !== userId && entry.expiresAt > Date.now(),
          );
          const next = typing
            ? [...existing, { userId, displayName: displayName ?? 'Someone', expiresAt: Date.now() + 6000 }]
            : existing;
          return { typing: { ...current.typing, [conversationId]: next } };
        });
      },

      'presence:update': ({ userId, presence }: { userId: string; presence: string }) => {
        set((current) => ({ presence: { ...current.presence, [userId]: presence } }));
      },

      'conversation:new': () => {
        void get().loadConversations({ archived: get().showArchived });
      },

      'conversation:updated': ({ conversationId }: { conversationId: string }) => {
        void get().loadConversations({ archived: get().showArchived });
        if (conversationId && get().activeId === conversationId) void get().reloadMembers(conversationId);
      },

      'conversation:removed': ({ conversationId }: { conversationId: string }) => {
        set((current) => ({
          conversations: current.conversations.filter((c) => c.id !== conversationId),
          activeId: current.activeId === conversationId ? null : current.activeId,
        }));
      },

      'request:new': () => {
        void get().loadRequests();
        void get().loadNotifications();
      },

      'request:accepted': () => {
        void get().loadConversations({ archived: get().showArchived });
        void get().loadRequests();
      },

      'request:resolved': () => void get().loadRequests(),

      'notification:new': (notification: AppNotification) => {
        set((current) =>
          current.notifications.some((n) => n.id === notification.id)
            ? {}
            : {
                notifications: [notification, ...current.notifications].slice(0, 60),
                unreadNotifications: current.unreadNotifications + 1,
              },
        );
      },
    };

    realtime.start(handlers as RealtimeHandlers, (mode) => {
      set({ transport: mode, connected: mode === 'socket' || mode === 'polling' });
    });

    // Expire stale typing indicators even if the "stopped" event is lost.
    //
    // The check happens before set(), not inside it. Returning {} from an updater is not a
    // no-op: zustand still builds a new state object and notifies every subscriber, so this
    // timer was re-rendering the whole messenger twice a second-and-a-half whether or not
    // anything had expired. Components that pass an inline callback into a child's effect —
    // Modal is the one that bit — were being torn down and rebuilt on that beat, which threw
    // focus out of whatever field someone was typing in.
    typingSweep = window.setInterval(() => {
      const now = Date.now();
      const current = get().typing;
      let changed = false;
      const next: Record<string, TypingEntry[]> = {};

      for (const [key, entries] of Object.entries(current)) {
        const live = entries.filter((entry) => entry.expiresAt > now);
        if (live.length !== entries.length) changed = true;
        next[key] = live;
      }

      if (changed) set({ typing: next });
    }, 2000);
  },

  teardown() {
    window.clearInterval(typingSweep);
    realtime.stop();
    socketBound = false;
    set({
      conversations: [],
      previews: {},
      activeId: null,
      messages: {},
      members: {},
      typing: {},
      requests: { incoming: [], outgoing: [] },
      notifications: [],
      unreadNotifications: 0,
      connected: false,
      transport: 'offline',
    });
  },

  async loadConversations(options) {
    set({ loadingConversations: true });
    try {
      const archived = options?.archived ?? get().showArchived;
      const response = await api.get<{ conversations: ConversationSummary[] }>(
        `/api/conversations?archived=${archived ? 'true' : 'false'}`,
      );

      // Previews arrive as ciphertext like everything else. Decrypt them here so the
      // sidebar shows the real last line instead of a placeholder.
      const previews: Record<string, string> = {};
      await Promise.all(
        response.conversations.map(async (conversation) => {
          if (!conversation.lastMessage) return;
          const decrypted = await decrypt(conversation.lastMessage);
          if (decrypted.payload?.text) previews[conversation.id] = decrypted.payload.text;
        }),
      );

      set({ conversations: response.conversations, previews, loadingConversations: false });
    } catch {
      set({ loadingConversations: false });
    }
  },

  async openConversation(id) {
    set((current) => ({ activeId: id, loadingMessages: { ...current.loadingMessages, [id]: true } }));
    realtime.emit('conversation:join', { conversationId: id });

    // A conversation opened straight after creation — or reached by a deep link — is not in
    // the sidebar list yet, and the panel renders from that list. Fetch it first.
    if (!get().conversations.some((conversation) => conversation.id === id)) {
      await get().loadConversations();
    }

    try {
      const [detail, page] = await Promise.all([
        api.get<{ members: ConversationMember[] }>(`/api/conversations/${id}`),
        api.get<{ messages: ApiMessage[]; hasMore: boolean }>(`/api/chat/${id}/messages?limit=50`),
      ]);

      const decrypted = await decryptAll(page.messages);
      set((current) => ({
        members: { ...current.members, [id]: detail.members },
        messages: { ...current.messages, [id]: decrypted },
        hasMore: { ...current.hasMore, [id]: page.hasMore },
        loadingMessages: { ...current.loadingMessages, [id]: false },
      }));

      const last = decrypted[decrypted.length - 1];
      if (last) void get().markConversationRead(id);
    } catch {
      set((current) => ({ loadingMessages: { ...current.loadingMessages, [id]: false } }));
    }
  },

  closeConversation() {
    const id = get().activeId;
    if (id) realtime.emit('conversation:leave', { conversationId: id });
    set({ activeId: null });
  },

  async loadOlderMessages(id) {
    const existing = get().messages[id] ?? [];
    const oldest = existing[0];
    if (!oldest || get().loadingMessages[id]) return;

    set((current) => ({ loadingMessages: { ...current.loadingMessages, [id]: true } }));
    try {
      const page = await api.get<{ messages: ApiMessage[]; hasMore: boolean }>(
        `/api/chat/${id}/messages?limit=40&before=${oldest.id}`,
      );
      const decrypted = await decryptAll(page.messages);
      set((current) => ({
        messages: { ...current.messages, [id]: [...decrypted, ...(current.messages[id] ?? [])] },
        hasMore: { ...current.hasMore, [id]: page.hasMore },
        loadingMessages: { ...current.loadingMessages, [id]: false },
      }));
    } catch {
      set((current) => ({ loadingMessages: { ...current.loadingMessages, [id]: false } }));
    }
  },

  async sendMessage(conversationId, text, options) {
    const members = get().members[conversationId] ?? [];
    if (members.length === 0) throw new Error('This conversation has no members to encrypt for.');

    set({ sending: true });
    try {
      const attachments: NonNullable<MessagePayload['attachments']> = [];

      for (const file of options?.files ?? []) {
        // Encrypt on this device, then upload opaque bytes.
        const encryptedFile = await encryptFile(await file.arrayBuffer());
        const uploaded = await api.upload<{ attachment: { id: string } }>(
          `/api/files/attachments/${conversationId}?category=${categoryFor(file)}&filename=${encodeURIComponent(file.name)}`,
          encryptedFile.blob,
        );
        attachments.push({
          id: uploaded.attachment.id,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          key: encryptedFile.key,
          nonce: encryptedFile.nonce,
        });
      }

      const payload: MessagePayload = { text, ...(attachments.length ? { attachments } : {}) };
      const encrypted = await encryptForMembers(
        payload,
        members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
      );

      await api.post<{ message: ApiMessage }>(`/api/chat/${conversationId}/messages`, {
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keys: encrypted.keys,
        kind: attachments.length ? 'attachment' : 'text',
        replyToId: options?.replyToId ?? null,
        attachmentIds: attachments.map((a) => a.id),
        mentions: options?.mentions ?? [],
      });
      // The transport echo populates the thread, so there is no optimistic duplicate to
      // clean up. In polling mode, pull now instead of waiting for the next tick.
      realtime.nudge();
    } finally {
      set({ sending: false });
    }
  },

  async editMessage(message, text) {
    const members = get().members[message.conversationId] ?? [];
    const payload: MessagePayload = { ...(message.payload ?? { text: '' }), text };
    const encrypted = await encryptForMembers(
      payload,
      members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    await api.patch(`/api/chat/messages/${message.id}`, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });
  },

  async deleteMessage(message, scope) {
    await api.del(`/api/chat/messages/${message.id}?scope=${scope}`);
    if (scope === 'me') {
      set((current) => ({
        messages: {
          ...current.messages,
          [message.conversationId]: (current.messages[message.conversationId] ?? []).filter(
            (m) => m.id !== message.id,
          ),
        },
      }));
    }
  },

  async forwardMessage(message, targetConversationId) {
    let members = get().members[targetConversationId];
    if (!members) {
      const detail = await api.get<{ members: ConversationMember[] }>(
        `/api/conversations/${targetConversationId}`,
      );
      members = detail.members;
      set((current) => ({ members: { ...current.members, [targetConversationId]: detail.members } }));
    }

    const encrypted = await encryptForMembers(
      { text: message.payload?.text ?? '' },
      members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    );
    await api.post(`/api/chat/messages/${message.id}/forward`, {
      conversationId: targetConversationId,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keys: encrypted.keys,
    });
  },

  async react(messageId, emoji) {
    await api.post(`/api/chat/messages/${messageId}/reactions`, { emoji });
  },

  async togglePin(conversationId, messageId) {
    await api.post(`/api/chat/${conversationId}/pins/${messageId}`);
  },

  async markConversationRead(conversationId) {
    const messages = get().messages[conversationId] ?? [];
    const last = messages[messages.length - 1];
    if (!last) return;
    try {
      await api.post(`/api/chat/${conversationId}/read`, { messageId: last.id });
      set((current) => ({
        conversations: current.conversations.map((c) =>
          c.id === conversationId ? { ...c, unreadCount: 0, manuallyUnread: false } : c,
        ),
      }));
    } catch {
      /* a failed receipt is not worth interrupting the user */
    }
  },

  async setConversationFlag(id, flags) {
    await api.patch(`/api/conversations/${id}/state`, flags);
    await get().loadConversations({ archived: get().showArchived });
  },

  sendTyping(conversationId, typing) {
    // Typing is a live-connection signal; polling mode has no upstream channel for it.
    if (!realtime.supportsEphemeral()) return;
    realtime.emit(typing ? 'typing:start' : 'typing:stop', { conversationId });
  },

  async loadRequests() {
    const response = await api.get<{ incoming: MessageRequest[]; outgoing: MessageRequest[] }>(
      '/api/requests?direction=both',
    );
    set({ requests: { incoming: response.incoming, outgoing: response.outgoing } });
  },

  async respondToRequest(id, decision) {
    await api.post(`/api/requests/${id}/respond`, { decision });
    await Promise.all([get().loadRequests(), get().loadConversations({ archived: get().showArchived })]);
  },

  async loadNotifications() {
    const response = await api.get<{ notifications: AppNotification[]; unreadCount: number }>(
      '/api/notifications?limit=40',
    );
    set({ notifications: response.notifications, unreadNotifications: response.unreadCount });
  },

  async markNotificationsRead(ids) {
    const response = await api.post<{ unreadCount: number }>('/api/notifications/read', {
      ids: ids ?? null,
    });
    set((current) => ({
      unreadNotifications: response.unreadCount,
      notifications: current.notifications.map((n) =>
        !ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n,
      ),
    }));
  },

  setShowArchived(value) {
    set({ showArchived: value });
    void get().loadConversations({ archived: value });
  },

  async reloadMembers(conversationId) {
    const response = await api.get<{ members: ConversationMember[] }>(
      `/api/conversations/${conversationId}/members`,
    );
    set((current) => ({ members: { ...current.members, [conversationId]: response.members } }));
  },
}));

function categoryFor(file: File): string {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (/pdf|word|excel|text|document|sheet|presentation/.test(file.type)) return 'document';
  return 'file';
}

/**
 * Typed API client.
 *
 * Sessions ride on an httpOnly cookie, so no token is ever kept in JavaScript where an XSS
 * bug could read it. The CSRF token comes from a readable companion cookie and is echoed on
 * every state-changing request.
 */
export const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Array<{ field: string; message: string }>;

  constructor(status: number, code: string, message: string, details?: Array<{ field: string; message: string }>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level message for inline form errors. */
  fieldError(field: string): string | undefined {
    return this.details?.find((d) => d.field === field)?.message;
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  raw?: BodyInit;
  headers?: Record<string, string>;
  /** Return the raw Response instead of parsed JSON (used for file downloads). */
  responseType?: 'json' | 'arraybuffer';
}

let onUnauthorized: (() => void) | null = null;

/** Lets the auth store react once to a session that expired mid-use. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie('veylo_csrf');
    if (csrf) headers['x-veylo-csrf'] = csrf;
  }

  let body: BodyInit | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      credentials: 'include',
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'Could not reach Veylo. Check your connection and try again.');
  }

  if (response.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();

  if (options.responseType === 'arraybuffer') {
    if (!response.ok) throw new ApiError(response.status, 'download_failed', 'That file could not be downloaded.');
    return (await response.arrayBuffer()) as T;
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details?: unknown } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'Something went wrong. Please try again.',
      Array.isArray(error?.details)
        ? (error.details as Array<{ field: string; message: string }>)
        : undefined,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
  upload: <T>(path: string, bytes: Uint8Array, contentType = 'application/octet-stream') =>
    request<T>(path, {
      method: 'POST',
      raw: new Blob([bytes as unknown as BlobPart], { type: contentType }),
      headers: { 'Content-Type': contentType },
    }),
  download: (path: string) => request<ArrayBuffer>(path, { responseType: 'arraybuffer' }),
};

// ---------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------

export type Visibility = 'everyone' | 'contacts' | 'nobody';
export type ContactPolicy = 'everyone' | 'approved' | 'nobody';

export interface PrivacySettings {
  whoCanContact: ContactPolicy;
  onlineStatusVisible: Visibility;
  lastSeenVisible: Visibility;
  avatarVisible: Visibility;
  profileVisible: Visibility;
  discoverable: boolean;
  readReceipts: boolean;
  typingIndicators: boolean;
}

export interface SelfUser {
  id: string;
  username: string;
  customAddress: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  publicKey: string | null;
  encryptedPrivateKey: string | null;
  presence: 'online' | 'away' | 'offline';
  lastSeenAt: string | null;
  role: 'user' | 'moderator' | 'admin';
  accountStatus: string;
  createdAt: string;
  recoveryEmail: string | null;
  recoveryEmailVerified: boolean;
  privacy: PrivacySettings;
}

export interface PublicUser {
  id: string;
  username: string;
  customAddress: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  publicKey: string | null;
  presence: 'online' | 'away' | 'offline' | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  isContact: boolean;
  isBlocked: boolean;
  canMessage: boolean;
  accountStatus: string;
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  senderId: string | null;
  kind: string;
  ciphertext: string;
  nonce: string;
  wrappedKey: string | null;
  systemPayload: Record<string, unknown> | null;
  replyToId: string | null;
  forwardedFrom: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedForAll: boolean;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  attachments: Array<{ id: string; byteSize: number; mimeType: string; category: string }>;
  deliveredCount: number;
  readCount: number;
  recipientCount: number;
  readAt: string | null;
}

export interface ConversationSummary {
  id: string;
  type: 'direct' | 'group';
  title: string | null;
  description: string;
  avatarUrl: string | null;
  isE2ee: boolean;
  permissions: Record<string, string>;
  myRole: 'owner' | 'admin' | 'member';
  isActive: boolean;
  mutedUntil: string | null;
  archivedAt: string | null;
  pinnedAt: string | null;
  manuallyUnread: boolean;
  unreadCount: number;
  memberCount: number;
  createdAt: string;
  lastMessageAt: string | null;
  lastMessage: ApiMessage | null;
  otherMember: {
    id: string;
    username: string;
    customAddress: string;
    displayName: string;
    avatarUrl: string | null;
    publicKey: string | null;
    presence: string | null;
  } | null;
  pendingRequest: { id: string; direction: 'incoming' | 'outgoing'; status: string } | null;
}

export interface ConversationMember {
  userId: string;
  username: string;
  customAddress: string;
  displayName: string;
  avatarUrl: string | null;
  publicKey: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
  isActive: boolean;
  presence: string | null;
}

export interface MessageRequest {
  id: string;
  conversationId: string;
  status: string;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  counterpart: {
    id: string;
    username: string;
    customAddress: string;
    displayName: string;
    avatarUrl: string | null;
    publicKey: string | null;
  };
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export type UserRole = 'user' | 'moderator' | 'admin';
export type AccountStatus = 'active' | 'suspended' | 'banned' | 'deleted';
export type Presence = 'online' | 'away' | 'offline';
export type MemberRole = 'owner' | 'admin' | 'member';
export type ConversationType = 'direct' | 'group';
export type Visibility = 'everyone' | 'contacts' | 'nobody';
export type ContactPolicy = 'everyone' | 'approved' | 'nobody';

export interface UserRow {
  id: string;
  username: string;
  custom_address: string;
  display_name: string;
  password_hash: string;
  auth_salt: string;
  vault_salt: string;
  password_changed_at: Date;
  public_key: string | null;
  encrypted_private_key: string | null;
  avatar_key: string | null;
  bio: string;
  presence: Presence;
  last_seen_at: Date | null;
  role: UserRole;
  status: AccountStatus;
  suspended_until: Date | null;
  moderation_note: string | null;
  recovery_email_enc: string | null;
  recovery_email_index: string | null;
  recovery_email_verified: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface PrivacySettingsRow {
  user_id: string;
  who_can_contact: ContactPolicy;
  online_status_visible: Visibility;
  last_seen_visible: Visibility;
  avatar_visible: Visibility;
  profile_visible: Visibility;
  discoverable: boolean;
  read_receipts: boolean;
  typing_indicators: boolean;
  updated_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_label: string;
  user_agent: string | null;
  ip_hash: string | null;
  approx_location: string | null;
  created_at: Date;
  last_active_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/** The authenticated principal attached to a request or socket. */
export interface AuthContext {
  user: {
    id: string;
    username: string;
    customAddress: string;
    displayName: string;
    role: UserRole;
    status: AccountStatus;
    avatarKey: string | null;
  };
  sessionId: string;
}

export interface ConversationPermissions {
  who_can_send: 'everyone' | 'admins';
  who_can_add: 'everyone' | 'admins';
  who_can_edit_info: 'everyone' | 'admins';
  who_can_invite: 'everyone' | 'admins';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

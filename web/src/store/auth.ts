import { create } from 'zustand';
import { api, ApiError, setUnauthorizedHandler, type SelfUser } from '../lib/api';
import {
  createIdentity,
  deriveAuthenticator,
  deriveKey,
  deriveLoginKeys,
  fromB64,
  resealPrivateKey,
  randomSalt,
  toB64,
  unlockIdentity,
  VaultUnlockError,
} from '../lib/crypto';

/**
 * Where the unlocked key lives
 * ----------------------------
 * The decrypted private key is kept in sessionStorage so a page refresh does not force a
 * password re-entry. That is a deliberate trade-off, and the Security settings page states it
 * plainly: the key is cleared when the tab closes and when you lock or sign out, but a
 * cross-site-scripting flaw in this app could read it. The session cookie itself is httpOnly
 * and is never reachable from JavaScript.
 */
const VAULT_STORAGE_KEY = 'veylo.identity.v1';

interface StoredIdentity {
  userId: string;
  publicKey: string;
  privateKey: string;
}

function loadStoredIdentity(userId: string): { publicKey: string; privateKey: Uint8Array } | null {
  try {
    const raw = sessionStorage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredIdentity;
    if (parsed.userId !== userId) return null;
    return { publicKey: parsed.publicKey, privateKey: fromB64(parsed.privateKey) };
  } catch {
    return null;
  }
}

function storeIdentity(userId: string, publicKey: string, privateKey: Uint8Array): void {
  try {
    sessionStorage.setItem(
      VAULT_STORAGE_KEY,
      JSON.stringify({ userId, publicKey, privateKey: toB64(privateKey) } satisfies StoredIdentity),
    );
  } catch {
    // Private browsing with storage disabled: the key simply stays in memory for this page.
  }
}

function clearStoredIdentity(): void {
  try {
    sessionStorage.removeItem(VAULT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export interface Identity {
  publicKey: string;
  privateKey: Uint8Array;
}

interface AuthState {
  user: SelfUser | null;
  identity: Identity | null;
  identityDomain: string;
  status: 'loading' | 'authenticated' | 'anonymous';
  /** Signed in, but the encryption key is not unlocked on this device. */
  locked: boolean;

  bootstrap: () => Promise<void>;
  signUp: (input: {
    username: string;
    displayName: string;
    password: string;
    recoveryEmail?: string;
  }) => Promise<void>;
  signIn: (identifier: string, password: string) => Promise<{ unfamiliarDevice: boolean }>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<void>;
  changePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  setUser: (user: SelfUser) => void;
  refresh: () => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  identity: null,
  identityDomain: 'veylo.chat',
  status: 'loading',
  locked: false,

  async bootstrap() {
    try {
      // Also primes the CSRF cookie for the first state-changing request.
      await api.get('/api/auth/csrf');
      const response = await api.get<{ user: SelfUser | null; identityDomain: string }>(
        '/api/auth/session',
      );

      if (!response.user) {
        clearStoredIdentity();
        set({ user: null, identity: null, status: 'anonymous', identityDomain: response.identityDomain });
        return;
      }

      const identity = loadStoredIdentity(response.user.id);
      set({
        user: response.user,
        identity,
        identityDomain: response.identityDomain,
        status: 'authenticated',
        locked: identity === null,
      });
    } catch {
      set({ user: null, identity: null, status: 'anonymous' });
    }
  },

  async signUp({ username, displayName, password, recoveryEmail }) {
    const [authSalt, vaultSalt] = await Promise.all([randomSalt(), randomSalt()]);
    const { authenticator, vaultKey } = await deriveLoginKeys(password, authSalt, vaultSalt);
    const identity = await createIdentity(vaultKey);

    const response = await api.post<{ user: SelfUser; identityDomain: string }>('/api/auth/register', {
      username,
      displayName,
      authenticator,
      authSalt,
      vaultSalt,
      publicKey: identity.publicKey,
      encryptedPrivateKey: identity.encryptedPrivateKey,
      recoveryEmail: recoveryEmail || undefined,
    });

    storeIdentity(response.user.id, identity.publicKey, identity.privateKey);
    set({
      user: response.user,
      identity: { publicKey: identity.publicKey, privateKey: identity.privateKey },
      identityDomain: response.identityDomain,
      status: 'authenticated',
      locked: false,
    });
  },

  async signIn(identifier, password) {
    const salts = await api.post<{ authSalt: string; vaultSalt: string }>('/api/auth/salt', { identifier });
    const { authenticator, vaultKey } = await deriveLoginKeys(password, salts.authSalt, salts.vaultSalt);

    const response = await api.post<{
      user: SelfUser;
      identityDomain: string;
      unfamiliarDevice: boolean;
    }>('/api/auth/login', { identifier, authenticator });

    let identity: Identity | null = null;
    if (response.user.encryptedPrivateKey && response.user.publicKey) {
      try {
        const privateKey = await unlockIdentity(response.user.encryptedPrivateKey, vaultKey);
        identity = { publicKey: response.user.publicKey, privateKey };
        storeIdentity(response.user.id, response.user.publicKey, privateKey);
      } catch {
        // Correct password, but the sealed key predates a reset: history stays unreadable.
        identity = null;
      }
    }

    set({
      user: response.user,
      identity,
      identityDomain: response.identityDomain,
      status: 'authenticated',
      locked: identity === null,
    });
    return { unfamiliarDevice: response.unfamiliarDevice };
  },

  async unlock(password) {
    const user = get().user;
    if (!user?.encryptedPrivateKey || !user.publicKey) throw new VaultUnlockError();

    const salts = await api.post<{ vaultSalt: string }>('/api/auth/salt', { identifier: user.username });
    const vaultKey = await deriveKey(password, salts.vaultSalt);
    const privateKey = await unlockIdentity(user.encryptedPrivateKey, vaultKey);

    storeIdentity(user.id, user.publicKey, privateKey);
    set({ identity: { publicKey: user.publicKey, privateKey }, locked: false });
  },

  lock() {
    clearStoredIdentity();
    set({ identity: null, locked: true });
  },

  async signOut() {
    try {
      await api.post('/api/auth/logout');
    } finally {
      clearStoredIdentity();
      set({ user: null, identity: null, status: 'anonymous', locked: false });
    }
  },

  async signOutEverywhere() {
    try {
      await api.post('/api/auth/logout-all');
    } finally {
      clearStoredIdentity();
      set({ user: null, identity: null, status: 'anonymous', locked: false });
    }
  },

  async changePassword(currentPassword, nextPassword) {
    const { user, identity } = get();
    if (!user) throw new ApiError(401, 'unauthorized', 'You are not signed in.');
    if (!identity) {
      throw new VaultUnlockError();
    }

    const currentSalts = await api.post<{ authSalt: string }>('/api/auth/salt', {
      identifier: user.username,
    });
    const currentAuthenticator = await deriveAuthenticator(currentPassword, currentSalts.authSalt);

    // New salts for both keys, and the same identity key re-sealed under the new vault key,
    // so message history stays readable after the change.
    const [authSalt, vaultSalt] = await Promise.all([randomSalt(), randomSalt()]);
    const { authenticator, vaultKey } = await deriveLoginKeys(nextPassword, authSalt, vaultSalt);
    const encryptedPrivateKey = await resealPrivateKey(identity.privateKey, vaultKey);

    await api.post('/api/auth/password/change', {
      currentAuthenticator,
      authenticator,
      authSalt,
      vaultSalt,
      encryptedPrivateKey,
    });
    await get().refresh();
  },

  setUser(user) {
    set({ user });
  },

  async refresh() {
    const response = await api.get<{ user: SelfUser }>('/api/users/me');
    set({ user: response.user });
  },
}));

setUnauthorizedHandler(() => {
  clearStoredIdentity();
  useAuth.setState({ user: null, identity: null, status: 'anonymous', locked: false });
});

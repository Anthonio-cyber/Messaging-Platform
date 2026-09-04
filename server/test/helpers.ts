import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://veylo:veylo_dev_password@127.0.0.1:5432/veylo_test';
process.env.AUTH_SECRET = 'test-auth-secret-value-that-is-long-enough-000';
process.env.DATA_ENCRYPTION_KEY = 'test-data-encryption-key-long-enough-0000000000';
process.env.COOKIE_SECURE = 'false';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = './.test-uploads';
process.env.IDENTITY_DOMAIN = 'veylo.test';
// The suite creates dozens of accounts from one address; exempt the loopback the same way a
// deployment exempts its uptime probes.
process.env.RATE_LIMIT_TRUSTED_IPS = '127.0.0.1,::1,::ffff:127.0.0.1';

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const { runMigrations } = await import('../src/db/migrate.js');
  const { pool } = await import('../src/db/pool.js');

  await runMigrations();
  // A clean slate for every run; CASCADE follows the foreign keys.
  await pool.query(`
    TRUNCATE users, conversations, messages, sessions, login_attempts, security_events,
             notifications, reports, admin_actions, message_requests, blocks, contacts,
             auth_tokens, recovery_codes, attachments, invite_links
    RESTART IDENTITY CASCADE
  `);

  const { createApp } = await import('../src/app.js');
  const { createRealtimeServer } = await import('../src/realtime/socket.js');

  const app = createApp();
  const server: Server = createServer(app);
  createRealtimeServer(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

/** Minimal browser-ish client: keeps cookies and echoes the CSRF token like the real app. */
export class ApiClient {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  private csrfToken(): string | undefined {
    return this.cookies.get('veylo_csrf');
  }

  private storeCookies(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const entry of raw) {
      const [pair] = entry.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (!pair || index === -1) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const token = this.csrfToken();
    if (token) headers['x-veylo-csrf'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.storeCookies(response);

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed as T };
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }

  /** Raw binary upload, the way the browser posts an encrypted attachment. */
  async upload<T = unknown>(path: string, bytes: Buffer): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const token = this.csrfToken();
    if (token) headers['x-veylo-csrf'] = token;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: new Uint8Array(bytes),
      redirect: 'manual',
    });
    this.storeCookies(response);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed as T };
  }

  /** Returns the raw bytes of a download, plus its status. */
  async downloadBytes(path: string): Promise<{ status: number; bytes: Buffer }> {
    const headers: Record<string, string> = {};
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${this.baseUrl}${path}`, { headers, redirect: 'manual' });
    return {
      status: response.status,
      bytes: Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0))),
    };
  }
  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }
  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  del<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('DELETE', path, body);
  }

  /** Fetches the CSRF cookie the way the web client does at boot. */
  async bootstrap(): Promise<void> {
    await this.get('/api/auth/csrf');
  }
}

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import { formatTimestamp } from '../lib/format';
import {
  Avatar,
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  Icon,
  Modal,
  Skeleton,
  TextArea,
  useToast,
} from '../components/ui';

type Tab = 'overview' | 'users' | 'reports' | 'security';

interface Overview {
  stats: {
    total_users: number;
    active_users: number;
    suspended_users: number;
    banned_users: number;
    new_today: number;
    new_week: number;
    online_now: number;
    total_messages: number;
    messages_today: number;
    total_conversations: number;
    group_conversations: number;
    open_reports: number;
    pending_requests: number;
  };
  security: { failed_logins_24h: number; critical_events_24h: number; active_sessions: number };
  signupTrend: Array<{ day: string; count: number }>;
  server: { status: string; uptimeSeconds: number; nodeVersion: string; memoryMb: number };
}

export function AdminPage() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [tab, setTab] = useState<Tab>('overview');

  // The API enforces this too; the guard here just avoids rendering a dead screen.
  if (user && user.role === 'user') {
    return (
      <div className="flex flex-1 items-center justify-center bg-ink">
        <EmptyState
          icon="shield"
          title="Not available"
          description="This area is for Veylo moderators and administrators."
          action={<Button onClick={() => navigate('/app')}>Back to messages</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-ink">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={() => navigate('/app')}
          aria-label="Back to conversations"
          className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text"
        >
          <Icon name="back" />
        </button>
        <h1 className="flex-1 text-sm font-semibold text-text">Administration</h1>
        <span className="chip capitalize">{user?.role}</span>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-3 pb-2" aria-label="Admin sections">
        {(
          [
            ['overview', 'Overview'],
            ['users', 'Users'],
            ['reports', 'Reports'],
            ['security', 'Security'],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            aria-current={tab === value ? 'page' : undefined}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              tab === value ? 'bg-raised text-text' : 'text-muted hover:text-text'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-6">
          {tab === 'overview' && <OverviewTab />}
          {tab === 'users' && <UsersTab canModerate={user?.role === 'admin'} />}
          {tab === 'reports' && <ReportsTab />}
          {tab === 'security' && <SecurityTab />}
        </div>
      </div>
    </div>
  );
}

function OverviewTab() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Overview>('/api/admin/overview')
      .then(setData)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load stats.'));
  }, []);

  if (error) return <ErrorNotice message={error} />;
  if (!data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  const peak = Math.max(...data.signupTrend.map((point) => point.count), 1);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total users" value={data.stats.total_users} sub={`${data.stats.active_users} active`} />
        <Stat label="Online now" value={data.stats.online_now} sub="last 5 minutes" />
        <Stat label="Messages sent" value={data.stats.total_messages} sub={`${data.stats.messages_today} today`} />
        <Stat label="New sign-ups" value={data.stats.new_week} sub={`${data.stats.new_today} today`} />
        <Stat label="Conversations" value={data.stats.total_conversations} sub={`${data.stats.group_conversations} groups`} />
        <Stat
          label="Open reports"
          value={data.stats.open_reports}
          sub="awaiting review"
          tone={data.stats.open_reports > 0 ? 'warn' : undefined}
        />
        <Stat label="Suspended" value={data.stats.suspended_users} sub={`${data.stats.banned_users} banned`} />
        <Stat label="Pending requests" value={data.stats.pending_requests} sub="message requests" />
      </div>

      <section className="pane p-5">
        <h2 className="text-[15px] font-semibold text-text">New accounts, last 14 days</h2>
        <div className="mt-5 flex h-40 gap-1.5" role="img" aria-label="Daily sign-ups over the last 14 days">
          {data.signupTrend.map((point) => (
            <div
              key={point.day}
              className="flex h-full flex-1 flex-col items-center justify-end gap-1.5"
              title={`${point.day}: ${point.count} ${point.count === 1 ? 'account' : 'accounts'}`}
            >
              <span className="text-[10px] font-medium text-muted">{point.count || ''}</span>
              {/* The column is the sizing context, so the bar's percentage resolves. */}
              <div
                className="w-full rounded-t bg-accent/70 transition-all"
                style={{ height: `${Math.max((point.count / peak) * 100, 1.5)}%` }}
              />
              <span className="text-[10px] text-faint">{point.day.slice(8)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="pane p-5">
          <h2 className="text-[15px] font-semibold text-text">Security, last 24 hours</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Failed sign-ins" value={data.security.failed_logins_24h} />
            <Row label="Critical events" value={data.security.critical_events_24h} />
            <Row label="Active sessions" value={data.security.active_sessions} />
          </dl>
        </section>

        <section className="pane p-5">
          <h2 className="text-[15px] font-semibold text-text">Server</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Status" value={data.server.status === 'ok' ? 'Healthy' : 'Degraded'} />
            <Row label="Uptime" value={formatUptime(data.server.uptimeSeconds)} />
            <Row label="Memory" value={`${data.server.memoryMb} MB`} />
            <Row label="Runtime" value={data.server.nodeVersion} />
          </dl>
        </section>
      </div>

      <p className="rounded-xl border border-line bg-raised p-4 text-sm leading-relaxed text-muted">
        <Icon name="lock" className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-accent" />
        Message content is end-to-end encrypted and is not available anywhere in this dashboard. Moderators
        can act on accounts and on reports, and can read a reported excerpt only when the person who
        reported it chose to attach one.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: 'warn';
}) {
  return (
    <div className="pane p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-faint">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold ${tone === 'warn' ? 'text-warn' : 'text-text'}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-text">{typeof value === 'number' ? value.toLocaleString() : value}</dd>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

interface AdminUser {
  id: string;
  username: string;
  customAddress: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  status: string;
  suspendedUntil: string | null;
  moderationNote: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  openReports: number;
}

function UsersTab({ canModerate }: { canModerate: boolean }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [action, setAction] = useState<'suspend' | 'ban' | 'restore'>('suspend');
  const [days, setDays] = useState('7');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ users: AdminUser[]; total: number }>(
        `/api/admin/users?limit=50&status=${status}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
      );
      setUsers(response.users);
      setTotal(response.total);
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not load users.', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, status, toast]);

  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function applyAction() {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/api/admin/users/${target.id}/actions`, {
        action,
        days: action === 'suspend' ? Number(days) : undefined,
        note: note.trim() || undefined,
      });
      toast.push(`Account ${action === 'restore' ? 'restored' : `${action}ned`}.`, 'success');
      setTarget(null);
      setNote('');
      await load();
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not apply that action.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            className="field pl-9"
            placeholder="Search by username, address or name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search users"
          />
        </div>
        <select
          className="field w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="banned">Banned</option>
          <option value="deleted">Deleted</option>
        </select>
      </div>

      <p className="text-sm text-muted">{total.toLocaleString()} accounts</p>

      <div className="pane divide-y divide-line">
        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <EmptyState icon="search" title="No accounts match" />
        ) : (
          users.map((person) => (
            <div key={person.id} className="flex flex-wrap items-center gap-3 p-3.5">
              <Avatar name={person.displayName} src={person.avatarUrl} seed={person.id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {person.displayName}
                  {person.role !== 'user' && (
                    <span className="ml-2 rounded-full bg-violet/15 px-2 py-0.5 text-[11px] capitalize text-violet">
                      {person.role}
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-[11px] text-faint">{person.customAddress}</p>
              </div>
              {person.openReports > 0 && (
                <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">
                  {person.openReports} open {person.openReports === 1 ? 'report' : 'reports'}
                </span>
              )}
              <StatusPill status={person.status} />
              <span className="hidden text-xs text-faint sm:block">
                Joined {formatTimestamp(person.createdAt)}
              </span>
              {canModerate && person.status !== 'deleted' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTarget(person);
                    setAction(person.status === 'active' ? 'suspend' : 'restore');
                    setNote(person.moderationNote ?? '');
                  }}
                >
                  Manage
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      <Modal
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={`Manage ${target?.displayName ?? ''}`}
        description={target?.customAddress}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant={action === 'restore' ? 'primary' : 'danger'} loading={busy} onClick={applyAction}>
              {action === 'suspend' ? 'Suspend' : action === 'ban' ? 'Ban permanently' : 'Restore'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <fieldset>
            <legend className="label">Action</legend>
            <div className="space-y-1">
              {(
                [
                  ['suspend', 'Suspend for a period — sessions end immediately'],
                  ['ban', 'Ban permanently — the account can never sign in again'],
                  ['restore', 'Restore — return the account to normal'],
                ] as Array<[typeof action, string]>
              ).map(([value, label]) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text transition hover:bg-raised"
                >
                  <input
                    type="radio"
                    name="admin-action"
                    checked={action === value}
                    onChange={() => setAction(value)}
                    className="h-4 w-4 accent-[rgb(var(--accent))]"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {action === 'suspend' && (
            <Field
              label="Length in days"
              type="number"
              min={1}
              max={3650}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          )}

          <TextArea
            label="Moderation note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            hint="Shown to the account holder and recorded in the audit log."
            maxLength={1000}
          />
        </div>
      </Modal>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tones: Record<string, string> = {
    active: 'bg-ok/15 text-ok',
    suspended: 'bg-warn/15 text-warn',
    banned: 'bg-danger/15 text-danger',
    deleted: 'bg-raised text-faint',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] capitalize ${tones[status] ?? 'bg-raised text-muted'}`}>
      {status}
    </span>
  );
}

interface AdminReport {
  id: string;
  target_type: string;
  category: string;
  reason: string;
  evidence: { excerpt?: string | null; capturedAt?: string | null };
  status: string;
  created_at: string;
  resolution_note: string | null;
  reporter_username: string | null;
  reported_username: string | null;
  reported_id: string | null;
  reported_status: string | null;
}

function ReportsTab() {
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<AdminReport | null>(null);
  const [decision, setDecision] = useState<'resolved' | 'dismissed' | 'reviewing'>('resolved');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ reports: AdminReport[] }>(`/api/admin/reports?status=${status}`);
      setReports(response.reports);
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not load reports.', 'error');
    } finally {
      setLoading(false);
    }
  }, [status, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve() {
    if (!resolving) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/reports/${resolving.id}`, { status: decision, note: note.trim() || undefined });
      toast.push('Report updated.', 'success');
      setResolving(null);
      setNote('');
      await load();
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not update that report.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <select
        className="field w-auto"
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        aria-label="Filter reports"
      >
        <option value="open">Open</option>
        <option value="reviewing">Under review</option>
        <option value="resolved">Resolved</option>
        <option value="dismissed">Dismissed</option>
        <option value="all">All</option>
      </select>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <EmptyState icon="check" title="Nothing in the queue" description="No reports with this status." />
      ) : (
        <ul className="space-y-3">
          {reports.map((report) => (
            <li key={report.id} className="pane p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium capitalize text-text">
                    {report.category.replace(/_/g, ' ')}
                    <span className="ml-2 text-xs font-normal text-faint">on a {report.target_type}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    @{report.reporter_username ?? 'deleted account'} reported @
                    {report.reported_username ?? 'deleted account'} · {formatTimestamp(report.created_at)}
                  </p>
                </div>
                <StatusPill status={report.status} />
              </div>

              {report.reason && (
                <p className="mt-3 rounded-lg bg-raised px-3 py-2 text-sm leading-relaxed text-muted">
                  {report.reason}
                </p>
              )}

              {report.evidence?.excerpt ? (
                <div className="mt-2 rounded-lg border border-line px-3 py-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
                    Excerpt attached by the reporter
                  </p>
                  <p className="mt-1 text-sm text-text">{report.evidence.excerpt}</p>
                </div>
              ) : (
                report.target_type === 'message' && (
                  <p className="mt-2 text-xs text-faint">
                    No excerpt attached. Message content is end-to-end encrypted and cannot be retrieved.
                  </p>
                )
              )}

              {report.resolution_note && (
                <p className="mt-2 text-xs text-muted">Resolution: {report.resolution_note}</p>
              )}

              {report.status !== 'resolved' && report.status !== 'dismissed' && (
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setResolving(report);
                      setDecision('resolved');
                    }}
                  >
                    Review and close
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={Boolean(resolving)}
        onClose={() => setResolving(null)}
        title="Close this report"
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolving(null)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={resolve}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <fieldset>
            <legend className="label">Outcome</legend>
            {(
              [
                ['resolved', 'Resolved — action was taken'],
                ['dismissed', 'Dismissed — no action needed'],
                ['reviewing', 'Still under review'],
              ] as Array<[typeof decision, string]>
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text transition hover:bg-raised"
              >
                <input
                  type="radio"
                  name="report-decision"
                  checked={decision === value}
                  onChange={() => setDecision(value)}
                  className="h-4 w-4 accent-[rgb(var(--accent))]"
                />
                {label}
              </label>
            ))}
          </fieldset>
          <TextArea
            label="Moderation note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
          />
        </div>
      </Modal>
    </div>
  );
}

interface SecurityFeed {
  events: Array<{
    id: number;
    event_type: string;
    severity: string;
    created_at: string;
    username: string | null;
  }>;
  failedLogins: Array<{ hour: string; count: number }>;
  suspicious: Array<{ identifier_hash: string; attempts: number; last_attempt: string }>;
  sessions: { active: number; distinct_users: number };
}

function SecurityTab() {
  const [data, setData] = useState<SecurityFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<SecurityFeed>('/api/admin/security')
      .then(setData)
      .catch((caught) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load security data.'),
      );
  }, []);

  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Active sessions" value={data.sessions.active} sub={`${data.sessions.distinct_users} accounts`} />
        <Stat
          label="Accounts under attack"
          value={data.suspicious.length}
          sub="5+ failed sign-ins in 24h"
          tone={data.suspicious.length > 0 ? 'warn' : undefined}
        />
      </div>

      <section className="pane p-5">
        <h2 className="text-[15px] font-semibold text-text">Repeated failed sign-ins</h2>
        <p className="mt-1 text-sm text-muted">
          Identifiers are stored as keyed hashes, so this shows the pattern without exposing who was
          targeted.
        </p>
        {data.suspicious.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing unusual in the last 24 hours.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.suspicious.map((row) => (
              <li key={row.identifier_hash} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                  {row.identifier_hash.slice(0, 24)}…
                </span>
                <span className="shrink-0 font-medium text-warn">{row.attempts} attempts</span>
                <span className="shrink-0 text-xs text-faint">{formatTimestamp(row.last_attempt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pane p-5">
        <h2 className="text-[15px] font-semibold text-text">Security event log</h2>
        <ul className="mt-3 divide-y divide-line">
          {data.events.slice(0, 40).map((event) => (
            <li key={event.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  event.severity === 'critical'
                    ? 'bg-danger'
                    : event.severity === 'warning'
                      ? 'bg-warn'
                      : 'bg-faint'
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-text">{event.event_type}</span>
              <span className="shrink-0 text-xs text-muted">
                {event.username ? `@${event.username}` : 'system'}
              </span>
              <span className="shrink-0 text-xs text-faint">{formatTimestamp(event.created_at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

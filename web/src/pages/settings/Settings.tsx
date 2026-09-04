import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../store/auth';
import { Icon, type IconName } from '../../components/ui';

const SECTIONS: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: '/app/settings', label: 'Profile', icon: 'user', end: true },
  { to: '/app/settings/privacy', label: 'Privacy', icon: 'shield' },
  { to: '/app/settings/security', label: 'Security', icon: 'lock' },
  { to: '/app/settings/notifications', label: 'Notifications', icon: 'bell' },
  { to: '/app/settings/blocked', label: 'Blocked people', icon: 'block' },
  { to: '/app/settings/account', label: 'Account', icon: 'settings' },
];

export function SettingsLayout() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('veylo.theme') as 'dark' | 'light') ?? 'dark',
  );

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('veylo.theme', theme);
  }, [theme]);

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
        <h1 className="flex-1 text-sm font-semibold text-text">Settings</h1>
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <nav className="mb-6 flex gap-1 overflow-x-auto pb-1" aria-label="Settings sections">
            {SECTIONS.map((section) => (
              <NavLink
                key={section.to}
                to={section.to}
                end={section.end}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${
                    isActive ? 'bg-raised text-text' : 'text-muted hover:bg-raised/60 hover:text-text'
                  }`
                }
              >
                <Icon name={section.icon} className="h-4 w-4" />
                {section.label}
              </NavLink>
            ))}
            {user?.role !== 'user' && (
              <NavLink
                to="/app/admin"
                className="flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-violet transition hover:bg-raised"
              >
                <Icon name="chart" className="h-4 w-4" />
                Admin
              </NavLink>
            )}
          </nav>

          <Outlet />
        </div>
      </div>
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pane mb-4 p-5">
      <h2 className="text-[15px] font-semibold text-text">{title}</h2>
      {description && <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

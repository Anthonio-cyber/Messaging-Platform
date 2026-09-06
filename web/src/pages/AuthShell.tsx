import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Wordmark } from '../components/ui';

/** Shared frame for every signed-out screen, so the auth flow feels like one place. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="relative flex min-h-full flex-col bg-ink">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-20 blur-3xl"
        style={{
          background:
            'radial-gradient(ellipse at 50% 0%, rgb(47 191 155 / 0.6), transparent 70%)',
        }}
      />
      <header className="relative px-5 py-5">
        <Link to="/" aria-label="Veylo home">
          <Wordmark />
        </Link>
      </header>

      <main className="relative flex flex-1 items-start justify-center px-5 pb-16 pt-4 sm:items-center sm:pt-0">
        <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'}`}>
          <div className="mb-7">
            <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-muted">{subtitle}</p>}
          </div>
          <div className="pane p-6">{children}</div>
          {footer && <p className="mt-6 text-center text-sm text-muted">{footer}</p>}
        </div>
      </main>
    </div>
  );
}

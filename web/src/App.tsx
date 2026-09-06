import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from './store/auth';
import { installViewportSync } from './lib/viewport';
import { ToastProvider, Spinner, Logo } from './components/ui';
import { LandingPage } from './pages/Landing';
import { SignUpPage } from './pages/SignUp';
import { SignInPage } from './pages/SignIn';
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/PasswordRecovery';
import { PrivacyPolicyPage, TermsPage } from './pages/Legal';
import { InvitePage } from './pages/Invite';
import { Messenger } from './pages/messenger/Messenger';
import { NotificationsPage } from './pages/Notifications';
import { AdminPage } from './pages/Admin';
import { SettingsLayout } from './pages/settings/Settings';
import { ProfileSettings } from './pages/settings/ProfileSettings';
import { PrivacySettingsPage } from './pages/settings/PrivacySettings';
import { SecuritySettingsPage } from './pages/settings/SecuritySettings';
import {
  AccountSettingsPage,
  BlockedSettingsPage,
  NotificationSettingsPage,
} from './pages/settings/OtherSettings';

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const status = useAuth((s) => s.status);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    // Restore the saved theme before the first paint of any signed-in screen.
    const theme = localStorage.getItem('veylo.theme');
    document.documentElement.classList.toggle('light', theme === 'light');
    document.documentElement.classList.toggle('dark', theme !== 'light');
  }, []);

  // Publishes the visual viewport height so the messenger can size itself above a phone's
  // on-screen keyboard. Installed app-wide because orientation changes affect every screen.
  useEffect(() => installViewportSync(), []);

  if (status === 'loading') return <BootScreen />;

  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<PublicOnly><LandingPage /></PublicOnly>} />
          <Route path="/sign-up" element={<PublicOnly redirect><SignUpPage /></PublicOnly>} />
          <Route path="/sign-in" element={<PublicOnly redirect><SignInPage /></PublicOnly>} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/privacy" element={<PrivacyPolicyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          {/* Where the invite links the server mints actually land. Handles its own
              signed-out case rather than sitting behind RequireAuth, so an invitee
              without an account is offered sign-up instead of only sign-in. */}
          <Route path="/invite/:code" element={<InvitePage />} />

          <Route
            path="/app"
            element={
              <RequireAuth>
                <Messenger />
              </RequireAuth>
            }
          >
            <Route path="c/:conversationId" element={null} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<ProfileSettings />} />
              <Route path="privacy" element={<PrivacySettingsPage />} />
              <Route path="security" element={<SecuritySettingsPage />} />
              <Route path="notifications" element={<NotificationSettingsPage />} />
              <Route path="blocked" element={<BlockedSettingsPage />} />
              <Route path="account" element={<AccountSettingsPage />} />
            </Route>
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}

function BootScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-ink">
      <Logo className="h-10 w-10" />
      <Spinner className="h-5 w-5 text-muted" />
      <span className="sr-only">Loading Veylo</span>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();

  if (status === 'loading') return <BootScreen />;
  if (status === 'anonymous') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/sign-in?next=${next}`} replace />;
  }
  return <>{children}</>;
}

/** Sends a signed-in visitor straight to the app instead of showing an auth screen again. */
function PublicOnly({ children, redirect }: { children: React.ReactNode; redirect?: boolean }) {
  const status = useAuth((s) => s.status);
  const [params] = useSearchParams();
  // Honour ?next= here too: someone who follows an invite link while already signed in should
  // land on the invite, not be bounced to the inbox with the code thrown away.
  if (redirect && status === 'authenticated') {
    return <Navigate to={params.get('next') || '/app'} replace />;
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-ink px-5 text-center">
      <Logo className="h-10 w-10" />
      <h1 className="text-xl font-semibold text-text">That page does not exist</h1>
      <p className="max-w-sm text-sm text-muted">
        The link may be out of date, or the conversation may have been deleted.
      </p>
      <a href="/app" className="link text-sm font-medium">
        Go to your messages
      </a>
    </div>
  );
}

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../store/chat';
import { formatTimestamp } from '../lib/format';
import { Button, EmptyState, Icon, type IconName } from '../components/ui';

const ICONS: Record<string, IconName> = {
  new_message: 'chat',
  message_request: 'inbox',
  request_accepted: 'check',
  group_invite: 'users',
  mention: 'user',
  reply: 'reply',
  security_alert: 'shield',
  new_login: 'key',
  moderation: 'flag',
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const { notifications, unreadNotifications, loadNotifications, markNotificationsRead } = useChat();

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-ink">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={() => navigate('/app')}
          aria-label="Back"
          className="rounded-lg p-2 text-muted transition hover:bg-raised hover:text-text md:hidden"
        >
          <Icon name="back" />
        </button>
        <h1 className="flex-1 text-sm font-semibold text-text">Notifications</h1>
        {unreadNotifications > 0 && (
          <Button size="sm" variant="ghost" onClick={() => markNotificationsRead()}>
            Mark all read
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <EmptyState
            icon="bell"
            title="Nothing yet"
            description="New messages, requests, group invitations and security alerts show up here."
          />
        ) : (
          <ul className="mx-auto max-w-2xl divide-y divide-line p-4">
            {notifications.map((notification) => {
              const conversationId = notification.data?.conversationId as string | undefined;
              return (
                <li key={notification.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void markNotificationsRead([notification.id]);
                      if (conversationId) navigate(`/app/c/${conversationId}`);
                    }}
                    className="flex w-full items-start gap-3 px-2 py-3 text-left transition hover:bg-raised"
                  >
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        notification.type === 'security_alert'
                          ? 'bg-warn/15 text-warn'
                          : 'bg-raised text-muted'
                      }`}
                    >
                      <Icon name={ICONS[notification.type] ?? 'bell'} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate text-sm ${
                            notification.readAt ? 'text-text' : 'font-semibold text-text'
                          }`}
                        >
                          {notification.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-faint">
                          {formatTimestamp(notification.createdAt)}
                        </span>
                      </span>
                      {notification.body && (
                        <span className="mt-0.5 block text-sm text-muted">{notification.body}</span>
                      )}
                    </span>
                    {!notification.readAt && (
                      <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

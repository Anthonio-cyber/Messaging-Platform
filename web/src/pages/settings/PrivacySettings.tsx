import { useState } from 'react';
import { api, ApiError, type PrivacySettings as Privacy } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { Icon, Select, Toggle, useToast } from '../../components/ui';
import { SettingsSection } from './Settings';

const VISIBILITY = [
  { value: 'everyone' as const, label: 'Everyone' },
  { value: 'contacts' as const, label: 'People I have accepted' },
  { value: 'nobody' as const, label: 'Nobody' },
];

export function PrivacySettingsPage() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const privacy = user?.privacy;
  if (!privacy) return null;

  async function update(patch: Partial<Privacy>) {
    setSaving(true);
    try {
      const response = await api.patch<{ user: typeof user }>('/api/users/me/privacy', patch);
      if (response.user) setUser(response.user);
    } catch (caught) {
      toast.push(
        caught instanceof ApiError ? caught.message : 'Could not save that setting.',
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SettingsSection
        title="Who can reach you"
        description="Message requests are the default. Someone you have not accepted cannot land in your inbox."
      >
        <Select
          label="Who can start a conversation with me"
          value={privacy.whoCanContact}
          onChange={(value) => update({ whoCanContact: value })}
          options={[
            { value: 'everyone', label: 'Anyone — messages arrive directly' },
            { value: 'approved', label: 'Anyone, but I approve first (recommended)' },
            { value: 'nobody', label: 'Nobody new' },
          ]}
        />
        {privacy.whoCanContact === 'everyone' && (
          <p className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            Anyone who knows your address can put a message straight into your inbox.
          </p>
        )}
        {privacy.whoCanContact === 'nobody' && (
          <p className="text-sm text-muted">
            Existing conversations keep working. New people cannot start one.
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="Being found" description="Controls whether search can surface your account.">
        <Toggle
          label="Let people find me in search"
          description="When off, only someone who already knows your exact address can reach you — and search will not confirm the account exists."
          checked={privacy.discoverable}
          onChange={(value) => update({ discoverable: value })}
          disabled={saving}
        />
      </SettingsSection>

      <SettingsSection title="What others see">
        <div className="divide-y divide-line">
          <Select
            label="Online status"
            value={privacy.onlineStatusVisible}
            onChange={(value) => update({ onlineStatusVisible: value })}
            options={VISIBILITY}
          />
          <Select
            label="Last seen"
            value={privacy.lastSeenVisible}
            onChange={(value) => update({ lastSeenVisible: value })}
            options={VISIBILITY}
          />
          <Select
            label="Profile picture"
            value={privacy.avatarVisible}
            onChange={(value) => update({ avatarVisible: value })}
            options={VISIBILITY}
          />
          <Select
            label="Profile and bio"
            value={privacy.profileVisible}
            onChange={(value) => update({ profileVisible: value })}
            options={VISIBILITY}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Conversation signals"
        description="These are reciprocal by design: turning one off hides it in both directions for the conversations you are in."
      >
        <div className="divide-y divide-line">
          <Toggle
            label="Read receipts"
            description="When off, nobody is told that you read their message — and you keep seeing whether yours were read only where the other person has receipts on."
            checked={privacy.readReceipts}
            onChange={(value) => update({ readReceipts: value })}
            disabled={saving}
          />
          <Toggle
            label="Typing indicators"
            description="When off, others do not see when you are typing."
            checked={privacy.typingIndicators}
            onChange={(value) => update({ typingIndicators: value })}
            disabled={saving}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="What Veylo can still see">
        <ul className="space-y-2.5 text-sm leading-relaxed text-muted">
          {[
            'Message text and attachments are encrypted on your device. Veylo cannot read them, and these settings do not change that.',
            'Veylo can see that a message moved between two accounts, and when. Routing a message requires that.',
            'Your username, address, display name and profile picture are stored unencrypted, and are shown according to the settings above.',
            'Sign-in times and device labels are kept so you can review them on the Security page.',
          ].map((line) => (
            <li key={line} className="flex gap-2.5">
              <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
              {line}
            </li>
          ))}
        </ul>
      </SettingsSection>
    </>
  );
}

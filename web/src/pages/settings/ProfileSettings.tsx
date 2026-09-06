import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { Avatar, Button, Field, Icon, TextArea, useToast } from '../../components/ui';
import { SettingsSection } from './Settings';

export function ProfileSettings() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName ?? '');
    setBio(user?.bio ?? '');
  }, [user?.displayName, user?.bio]);

  const dirty = displayName !== (user?.displayName ?? '') || bio !== (user?.bio ?? '');

  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/users/me', { displayName: displayName.trim(), bio: bio.trim() });
      await refresh();
      toast.push('Profile saved.', 'success');
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not save your profile.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File) {
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await api.upload('/api/files/avatar', bytes, file.type || 'application/octet-stream');
      await refresh();
      toast.push('Profile picture updated.', 'success');
    } catch (caught) {
      toast.push(
        caught instanceof ApiError ? caught.message : 'Could not upload that picture.',
        'error',
      );
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    try {
      await api.del('/api/files/avatar');
      await refresh();
    } catch {
      toast.push('Could not remove your picture.', 'error');
    }
  }

  return (
    <>
      <SettingsSection
        title="Your identity"
        description="This address is how people find you. It cannot be changed after you claim it."
      >
        <div className="flex items-center gap-3 rounded-xl border border-line bg-raised px-4 py-3">
          <Icon name="user" className="h-4 w-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">
            {user?.customAddress}
          </span>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(user?.customAddress ?? '').catch(() => {});
              toast.push('Address copied.', 'success');
            }}
            className="shrink-0 rounded-lg p-1.5 text-faint transition hover:bg-surface hover:text-text"
            aria-label="Copy address"
          >
            <Icon name="copy" className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Joined {user ? new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' }) : ''}
        </p>
      </SettingsSection>

      <SettingsSection title="Profile picture" description="Visible to whoever your privacy settings allow.">
        <div className="flex items-center gap-4">
          <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} seed={user?.id} size="xl" />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
              Upload picture
            </Button>
            {user?.avatarUrl && (
              <Button variant="ghost" size="sm" onClick={removeAvatar}>
                Remove
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadAvatar(file);
                e.target.value = '';
              }}
            />
          </div>
        </div>
        <p className="mt-3 text-sm text-faint">
          JPEG, PNG, GIF or WebP, up to 2 MB. Unlike your messages, profile pictures are not end-to-end
          encrypted — they have to be readable by the people allowed to see them.
        </p>
      </SettingsSection>

      <SettingsSection title="How you appear">
        <div className="space-y-4">
          <Field
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={60}
          />
          <TextArea
            label="Bio"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={400}
            hint={`${bio.length}/400`}
          />
          <Button onClick={save} loading={saving} disabled={!dirty || !displayName.trim()}>
            Save changes
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}

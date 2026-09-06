import { useEffect, useState } from 'react';
import { api, ApiError, type ConversationMember, type ConversationSummary } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { useChat, type DecryptedMessage } from '../../store/chat';
import { keyFingerprint } from '../../lib/crypto';
import { formatBytes, formatTimestamp } from '../../lib/format';
import { Avatar, Button, Icon, Modal, Select, useToast } from '../../components/ui';
import { AddMembersDialog, ReportDialog } from './Dialogs';

export function InfoPanel({
  conversation,
  members,
  open,
  onClose,
}: {
  conversation: ConversationSummary;
  members: ConversationMember[];
  open: boolean;
  onClose: () => void;
}) {
  const user = useAuth((s) => s.user);
  const toast = useToast();
  const { messages, setConversationFlag, loadConversations, reloadMembers } = useChat();

  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [pinned, setPinned] = useState<DecryptedMessage[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const isGroup = conversation.type === 'group';
  const other = conversation.otherMember;
  const isAdmin = conversation.myRole !== 'member';
  // The group's own who_can_add setting decides this, exactly as the server does — an admins-only
  // group hides the button from members rather than letting them press it into a 403.
  const canAddMembers =
    isGroup && (isAdmin || (conversation.permissions?.who_can_add ?? 'admins') === 'everyone');

  useEffect(() => {
    if (!open || isGroup || !other?.publicKey) {
      setFingerprint(null);
      return;
    }
    keyFingerprint(other.publicKey).then(setFingerprint).catch(() => setFingerprint(null));
  }, [open, isGroup, other?.publicKey]);

  useEffect(() => {
    if (!open) return;
    // Pinned messages come back encrypted; reuse the already-decrypted copies in the thread.
    api
      .get<{ pinned: Array<{ id: string }> }>(`/api/chat/${conversation.id}/pins`)
      .then((response) => {
        const loaded = messages[conversation.id] ?? [];
        setPinned(
          response.pinned
            .map((p) => loaded.find((m) => m.id === p.id))
            .filter((m): m is DecryptedMessage => Boolean(m)),
        );
      })
      .catch(() => setPinned([]));
  }, [open, conversation.id, messages]);

  const sharedFiles = (messages[conversation.id] ?? [])
    .flatMap((message) =>
      message.attachments.map((attachment) => ({
        id: attachment.id,
        size: attachment.byteSize,
        name:
          message.payload?.attachments?.find((a) => a.id === attachment.id)?.name ??
          'Encrypted attachment',
        at: message.createdAt,
      })),
    )
    .slice(-12)
    .reverse();

  async function block() {
    if (!other) return;
    setBusy(true);
    try {
      await api.post('/api/safety/blocks', { userId: other.id });
      toast.push(`${other.displayName} is blocked. They can no longer message you.`, 'success');
      await loadConversations();
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not block that person.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function createInvite() {
    setBusy(true);
    try {
      const response = await api.post<{ invite: { url: string } }>(
        `/api/conversations/${conversation.id}/invites`,
        { expiresInHours: 168, maxUses: 25 },
      );
      setInviteUrl(response.invite.url);
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not create an invite link.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(memberId: string, role: 'admin' | 'member' | 'owner') {
    try {
      await api.patch(`/api/conversations/${conversation.id}/members/${memberId}`, { role });
      await reloadMembers(conversation.id);
      toast.push('Role updated.', 'success');
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not change that role.', 'error');
    }
  }

  async function removeMember(memberId: string) {
    try {
      await api.del(`/api/conversations/${conversation.id}/members/${memberId}`);
      await reloadMembers(conversation.id);
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not remove that person.', 'error');
    }
  }

  async function updatePermission(key: string, value: string) {
    try {
      await api.patch(`/api/conversations/${conversation.id}`, { permissions: { [key]: value } });
      await loadConversations();
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not update permissions.', 'error');
    }
  }

  async function leaveOrDelete() {
    setBusy(true);
    try {
      if (isGroup && conversation.myRole === 'owner') {
        await api.del(`/api/conversations/${conversation.id}`);
      } else if (isGroup) {
        await api.del(`/api/conversations/${conversation.id}/members/${user!.id}`);
      } else {
        await api.del(`/api/conversations/${conversation.id}`);
      }
      await loadConversations();
      setConfirmLeave(false);
      onClose();
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'Could not complete that.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const title = isGroup ? (conversation.title ?? 'Group') : (other?.displayName ?? 'Unknown');

  return (
    <>
      {/* Docked panel on wide screens, a sheet over the thread on narrow ones. */}
      <aside className="fixed inset-0 z-40 flex flex-col border-l border-line bg-surface lg:static lg:z-auto lg:w-[320px] lg:shrink-0">
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-text">
            {isGroup ? 'Group details' : 'Contact details'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="rounded-lg p-1.5 text-faint transition hover:bg-raised hover:text-text"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col items-center px-5 py-6 text-center">
            <Avatar
              name={title}
              src={isGroup ? conversation.avatarUrl : other?.avatarUrl}
              seed={isGroup ? conversation.id : other?.id}
              size="xl"
            />
            <h3 className="mt-3 text-[17px] font-semibold text-text">{title}</h3>
            {!isGroup && other && (
              <p className="mt-1 font-mono text-sm text-muted">{other.customAddress}</p>
            )}
            {isGroup && conversation.description && (
              <p className="mt-2 text-sm leading-relaxed text-muted">{conversation.description}</p>
            )}
          </div>

          <Section title="Encryption">
            <div className="flex items-start gap-2.5 rounded-xl border border-line bg-raised p-3">
              <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-text">End-to-end encrypted</p>
                <p className="mt-1 leading-relaxed text-muted">
                  Messages are encrypted on each device. Veylo stores only ciphertext and cannot read
                  this conversation.
                </p>
                {fingerprint && (
                  <>
                    <p className="mt-2.5 text-xs text-faint">
                      Their key fingerprint — compare it in person or over another channel:
                    </p>
                    <p className="mt-1 select-all break-all font-mono text-[11px] text-text">{fingerprint}</p>
                  </>
                )}
              </div>
            </div>
          </Section>

          {pinned.length > 0 && (
            <Section title={`Pinned (${pinned.length})`}>
              <ul className="space-y-1.5">
                {pinned.map((message) => (
                  <li key={message.id} className="rounded-lg border border-line bg-raised px-3 py-2">
                    <p className="line-clamp-2 text-sm text-text">{message.payload?.text}</p>
                    <p className="mt-0.5 text-[11px] text-faint">{formatTimestamp(message.createdAt)}</p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={`Shared files${sharedFiles.length ? ` (${sharedFiles.length})` : ''}`}>
            {sharedFiles.length === 0 ? (
              <p className="text-sm text-muted">Files shared in this conversation appear here.</p>
            ) : (
              <ul className="space-y-1.5">
                {sharedFiles.map((file) => (
                  <li key={file.id} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
                    <Icon name="paperclip" className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{file.name}</span>
                    <span className="shrink-0 text-[11px] text-faint">{formatBytes(file.size)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {isGroup && (
            <Section title={`Members (${members.length})`}>
              {canAddMembers && (
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="mb-1 flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition hover:bg-raised"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-faint text-faint">
                    <Icon name="plus" className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium text-accent">Add people</span>
                </button>
              )}
              <ul className="space-y-1">
                {members.map((member) => (
                  <li key={member.userId} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
                    <Avatar
                      name={member.displayName}
                      src={member.avatarUrl}
                      seed={member.userId}
                      size="sm"
                      presence={member.presence}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">
                        {member.displayName}
                        {member.userId === user?.id && <span className="text-faint"> (you)</span>}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-faint">
                        {member.customAddress}
                      </span>
                    </span>
                    {member.role !== 'member' && (
                      <span className="chip shrink-0 !px-2 !py-0.5 capitalize">{member.role}</span>
                    )}
                    {conversation.myRole === 'owner' && member.userId !== user?.id && (
                      <MemberMenu
                        member={member}
                        onPromote={() => changeRole(member.userId, member.role === 'admin' ? 'member' : 'admin')}
                        onTransfer={() => changeRole(member.userId, 'owner')}
                        onRemove={() => removeMember(member.userId)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {isGroup && isAdmin && (
            <Section title="Group permissions">
              <div className="-my-2">
                {(
                  [
                    ['who_can_send', 'Who can send messages'],
                    ['who_can_add', 'Who can add members'],
                    ['who_can_edit_info', 'Who can edit group info'],
                    ['who_can_invite', 'Who can create invite links'],
                  ] as const
                ).map(([key, label]) => (
                  <Select
                    key={key}
                    label={label}
                    value={(conversation.permissions?.[key] as 'everyone' | 'admins') ?? 'admins'}
                    onChange={(value) => updatePermission(key, value)}
                    options={[
                      { value: 'everyone', label: 'Everyone' },
                      { value: 'admins', label: 'Admins only' },
                    ]}
                  />
                ))}
              </div>

              <div className="mt-3">
                <Button size="sm" variant="secondary" onClick={createInvite} loading={busy}>
                  <Icon name="link" className="h-3.5 w-3.5" />
                  Create invite link
                </Button>
                {inviteUrl && (
                  <div className="mt-2 rounded-lg border border-line bg-raised p-2.5">
                    <p className="break-all font-mono text-[11px] text-text">{inviteUrl}</p>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(inviteUrl).catch(() => {});
                        toast.push('Invite link copied.', 'success');
                      }}
                      className="mt-1.5 text-xs font-medium text-accent hover:underline"
                    >
                      Copy link
                    </button>
                  </div>
                )}
              </div>
            </Section>
          )}

          <Section title="This conversation">
            <div className="space-y-1">
              <RowButton
                icon="archive"
                label={conversation.archivedAt ? 'Move back to inbox' : 'Archive conversation'}
                onClick={() =>
                  setConversationFlag(conversation.id, { archived: !conversation.archivedAt })
                }
              />
              <RowButton
                icon="pin"
                label={conversation.pinnedAt ? 'Unpin from top' : 'Pin to top'}
                onClick={() => setConversationFlag(conversation.id, { pinned: !conversation.pinnedAt })}
              />
              <RowButton
                icon="unread"
                label="Mark as unread"
                onClick={() => setConversationFlag(conversation.id, { unread: true })}
              />
              {!isGroup && other && (
                <>
                  <RowButton icon="flag" label="Report this person" onClick={() => setReportOpen(true)} />
                  <RowButton icon="block" label="Block this person" tone="danger" onClick={block} />
                </>
              )}
              <RowButton
                icon="logout"
                label={
                  isGroup
                    ? conversation.myRole === 'owner'
                      ? 'Delete this group'
                      : 'Leave this group'
                    : 'Leave this conversation'
                }
                tone="danger"
                onClick={() => setConfirmLeave(true)}
              />
            </div>
          </Section>
        </div>
      </aside>

      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={
          isGroup && conversation.myRole === 'owner'
            ? 'Delete this group?'
            : isGroup
              ? 'Leave this group?'
              : 'Leave this conversation?'
        }
        description={
          isGroup && conversation.myRole === 'owner'
            ? 'The group disappears for everyone in it. This cannot be undone.'
            : isGroup
              ? 'You will stop receiving messages from this group. Members will see that you left.'
              : 'It disappears from your list. The other person keeps their copy, and they are not told.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={leaveOrDelete} data-autofocus>
              {isGroup && conversation.myRole === 'owner' ? 'Delete group' : 'Leave'}
            </Button>
          </>
        }
      />

      <ReportDialog
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        target={other ? { type: 'user', userId: other.id, conversationId: conversation.id } : null}
        onSubmitted={() => toast.push('Report received. Our moderation team will review it.', 'success')}
      />

      <AddMembersDialog
        open={addOpen}
        conversationId={conversation.id}
        existingMemberIds={members.map((member) => member.userId)}
        onClose={() => setAddOpen(false)}
        onAdded={(count) => {
          void reloadMembers(conversation.id);
          void loadConversations();
          toast.push(
            count === 0
              ? 'Everyone you picked was already in the group.'
              : `Added ${count} ${count === 1 ? 'person' : 'people'} to the group.`,
            count === 0 ? 'info' : 'success',
          );
        }}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-4">
      <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-faint">{title}</h3>
      {children}
    </section>
  );
}

function RowButton({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: 'archive' | 'pin' | 'unread' | 'flag' | 'block' | 'logout';
  label: string;
  onClick: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition ${
        tone === 'danger' ? 'text-danger hover:bg-danger/10' : 'text-text hover:bg-raised'
      }`}
    >
      <Icon name={icon} className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}

function MemberMenu({
  member,
  onPromote,
  onTransfer,
  onRemove,
}: {
  member: ConversationMember;
  onPromote: () => void;
  onTransfer: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Manage ${member.displayName}`}
        className="rounded-lg p-1.5 text-faint transition hover:bg-raised hover:text-text"
      >
        <Icon name="more" className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-line bg-surface p-1 shadow-pop"
          onMouseLeave={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => {
              onPromote();
              setOpen(false);
            }}
            className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-text transition hover:bg-raised"
          >
            {member.role === 'admin' ? 'Remove admin' : 'Make admin'}
          </button>
          <button
            type="button"
            onClick={() => {
              onTransfer();
              setOpen(false);
            }}
            className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-text transition hover:bg-raised"
          >
            Transfer ownership
          </button>
          <button
            type="button"
            onClick={() => {
              onRemove();
              setOpen(false);
            }}
            className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-danger transition hover:bg-danger/10"
          >
            Remove from group
          </button>
        </div>
      )}
    </div>
  );
}

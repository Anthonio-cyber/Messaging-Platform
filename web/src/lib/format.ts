const dayMs = 86_400_000;

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Relative, then absolute — the way a person would say it. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  if (date.getTime() >= startOfToday) return formatTime(iso);
  if (date.getTime() >= startOfToday - dayMs) return 'Yesterday';
  if (now.getTime() - date.getTime() < 7 * dayMs) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDayDivider(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return 'Today';
  if (date.getTime() >= startOfToday - dayMs) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function formatLastSeen(iso: string | null): string {
  if (!iso) return 'Last seen hidden';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'Active just now';
  if (diff < 3_600_000) return `Active ${Math.floor(diff / 60_000)}m ago`;
  if (diff < dayMs) return `Active ${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * dayMs) return `Active ${Math.floor(diff / dayMs)}d ago`;
  return `Last seen ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/** Stable colour per identity, so avatars stay recognisable without a photo. */
export function avatarTone(seed: string): { background: string; color: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return { background: `hsl(${hue} 42% 26%)`, color: `hsl(${hue} 70% 78%)` };
}

export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string; hint: string } {
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^\w\s]/.test(password)) score += 1;
  if (/^(.)\1+$/.test(password) || /^(012|123|abc|password|qwerty)/i.test(password)) score = 0;

  const clamped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
  const labels = ['Too weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;
  const hints = [
    'Use at least 12 characters.',
    'Longer is better than complicated — try a short sentence.',
    'Add length or a symbol.',
    'Good. A few more characters would be even better.',
    'This is a solid passphrase.',
  ] as const;
  return { score: clamped, label: labels[clamped], hint: hints[clamped] };
}

export const MIN_PASSWORD_LENGTH = 10;

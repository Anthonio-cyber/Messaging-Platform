import { useCallback, useEffect, useState } from 'react';
import { useCall } from '../../store/call';
import { formatCallDuration } from '../../lib/webrtc';
import { Avatar, Icon } from '../../components/ui';

/**
 * The call surface: an incoming-call sheet, and a full-screen in-call view.
 *
 * Rendered above everything else so a call is never lost behind a conversation. Nothing here
 * touches media directly — the store owns the streams and this attaches them to elements.
 */
export function CallOverlay() {
  const {
    phase,
    kind,
    peer,
    outgoing,
    localStream,
    remoteStream,
    micEnabled,
    cameraEnabled,
    startedAt,
    error,
    endedReason,
    relayWarning,
    accept,
    decline,
    hangUp,
    toggleMic,
    toggleCamera,
    dismissError,
  } = useCall();

  if (error) return <CallError message={error} onDismiss={dismissError} />;
  if (phase === 'idle') return null;
  if (phase === 'incoming') {
    return <IncomingCall peer={peer} kind={kind} onAccept={accept} onDecline={decline} />;
  }

  return (
    <ActiveCall
      phase={phase}
      kind={kind}
      peer={peer}
      outgoing={outgoing}
      localStream={localStream}
      remoteStream={remoteStream}
      micEnabled={micEnabled}
      cameraEnabled={cameraEnabled}
      startedAt={startedAt}
      endedReason={endedReason}
      relayWarning={relayWarning}
      onHangUp={() => hangUp()}
      onToggleMic={toggleMic}
      onToggleCamera={toggleCamera}
    />
  );
}

function CallError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="fixed inset-x-0 top-16 z-[70] flex justify-center px-4">
      <div
        role="alert"
        className="flex max-w-md items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/15 px-4 py-3 text-sm text-danger shadow-pop"
      >
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="flex-1">{message}</span>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0">
          <Icon name="close" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function IncomingCall({
  peer,
  kind,
  onAccept,
  onDecline,
}: {
  peer: { displayName: string; customAddress: string | null; avatarUrl: string | null; id: string } | null;
  kind: 'audio' | 'video';
  onAccept: () => void;
  onDecline: () => void;
}) {
  useRingtone();

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Incoming ${kind} call from ${peer?.displayName ?? 'someone'}`}
        className="w-full max-w-sm animate-scale-in rounded-t-3xl border border-line bg-surface p-6 text-center shadow-pop sm:rounded-2xl"
      >
        <Avatar
          name={peer?.displayName ?? '?'}
          src={peer?.avatarUrl}
          seed={peer?.id}
          size="xl"
          className="mx-auto"
        />
        <p className="mt-4 text-lg font-semibold text-text">{peer?.displayName}</p>
        {peer?.customAddress && (
          <p className="mt-0.5 font-mono text-xs text-faint">{peer.customAddress}</p>
        )}
        <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-muted">
          <span className="flex gap-1" aria-hidden="true">
            <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-accent" />
            <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-accent [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-accent [animation-delay:300ms]" />
          </span>
          Incoming {kind === 'video' ? 'video call' : 'call'}
        </p>

        <div className="mt-7 flex items-center justify-center gap-6">
          <button
            type="button"
            onClick={onDecline}
            aria-label="Decline call"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-danger text-white transition hover:brightness-110"
          >
            <Icon name="callEnd" className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={onAccept}
            aria-label="Answer call"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-ok text-white transition hover:brightness-110"
          >
            <Icon name={kind === 'video' ? 'video' : 'phone'} className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ActiveCall({
  phase,
  kind,
  peer,
  outgoing,
  localStream,
  remoteStream,
  micEnabled,
  cameraEnabled,
  startedAt,
  endedReason,
  relayWarning,
  onHangUp,
  onToggleMic,
  onToggleCamera,
}: {
  phase: string;
  kind: 'audio' | 'video';
  peer: { displayName: string; customAddress: string | null; avatarUrl: string | null; id: string } | null;
  outgoing: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  startedAt: number | null;
  endedReason: string | null;
  relayWarning: boolean;
  onHangUp: () => void;
  onToggleMic: () => void;
  onToggleCamera: () => void;
}) {
  const duration = useCallDuration(startedAt);

  /*
   * Streams are attached in a callback ref rather than an effect, and that is the whole fix
   * for "I can see myself but not them".
   *
   * CallSession reuses one MediaStream object for the remote side and only adds tracks to it,
   * so the value never changes identity. An effect keyed on the stream therefore fires exactly
   * once — when the first track arrives, while the phase is still `connecting` and the remote
   * <video> has not been rendered yet. By the time the phase reaches `active` and the element
   * mounts, the effect has no reason to run again, so srcObject is never set and the far side
   * stays black. The audio element escaped this only because it is always mounted, which is
   * why voice calls sounded fine.
   *
   * A callback ref runs when the element mounts, which is exactly when the assignment has to
   * happen. The local preview has the same problem for the same reason: toggling the camera
   * off and on remounts it.
   */
  const attachRemote = useCallback(
    (element: HTMLVideoElement | HTMLAudioElement | null) => {
      if (element && remoteStream && element.srcObject !== remoteStream) {
        element.srcObject = remoteStream;
      }
    },
    [remoteStream],
  );

  const attachLocal = useCallback(
    (element: HTMLVideoElement | null) => {
      if (element && localStream && element.srcObject !== localStream) {
        element.srcObject = localStream;
      }
    },
    [localStream],
  );

  const isVideo = kind === 'video';
  const connected = phase === 'active';

  const status =
    endedReason ??
    (phase === 'dialing'
      ? 'Calling…'
      : phase === 'ringing'
        ? 'Ringing…'
        : phase === 'connecting'
          ? outgoing
            ? 'Connecting…'
            : 'Answering…'
          : duration);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-ink">
      {/* Remote audio always renders; on a voice call it is the only media element. */}
      <audio ref={attachRemote} autoPlay playsInline className="hidden" />

      <div className="relative flex-1 overflow-hidden">
        {isVideo && connected ? (
          <video
            ref={attachRemote}
            autoPlay
            playsInline
            className="h-full w-full bg-black object-cover"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Avatar
              name={peer?.displayName ?? '?'}
              src={peer?.avatarUrl}
              seed={peer?.id}
              size="xl"
              className="mb-5"
            />
            <p className="text-xl font-semibold text-text">{peer?.displayName}</p>
            {peer?.customAddress && (
              <p className="mt-1 font-mono text-xs text-faint">{peer.customAddress}</p>
            )}
          </div>
        )}

        {/* Own camera preview, mirrored the way people expect to see themselves. */}
        {isVideo && localStream && cameraEnabled && (
          <video
            ref={attachLocal}
            autoPlay
            playsInline
            muted
            className="absolute bottom-4 right-4 h-40 w-28 scale-x-[-1] rounded-xl border border-line object-cover shadow-pop sm:h-48 sm:w-36"
          />
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 p-5">
          <p className="rounded-full bg-black/50 px-3 py-1 text-sm text-white backdrop-blur">
            {status}
          </p>
          <p className="flex items-center gap-1.5 rounded-full bg-black/40 px-2.5 py-0.5 text-[11px] text-white/80 backdrop-blur">
            <Icon name="lock" className="h-3 w-3" />
            Encrypted directly between your devices
          </p>
          {relayWarning && !connected && (
            <p className="max-w-xs rounded-lg bg-warn/20 px-2.5 py-1 text-center text-[11px] text-warn backdrop-blur">
              No TURN relay is configured on this deployment — calls between some networks will
              not connect.
            </p>
          )}
        </div>
      </div>

      <div className="safe-bottom flex items-center justify-center gap-4 border-t border-line bg-surface px-6 py-5">
        <ControlButton
          label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
          icon={micEnabled ? 'mic' : 'micOff'}
          active={!micEnabled}
          onClick={onToggleMic}
        />
        {isVideo && (
          <ControlButton
            label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
            icon={cameraEnabled ? 'video' : 'videoOff'}
            active={!cameraEnabled}
            onClick={onToggleCamera}
          />
        )}
        <button
          type="button"
          onClick={onHangUp}
          aria-label="End call"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-danger text-white transition hover:brightness-110"
        >
          <Icon name="callEnd" className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: 'mic' | 'micOff' | 'video' | 'videoOff';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${
        active
          ? 'border-transparent bg-text text-ink'
          : 'border-line bg-raised text-text hover:border-faint'
      }`}
    >
      <Icon name={icon} className="h-5 w-5" />
    </button>
  );
}

function useCallDuration(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return '';
  return formatCallDuration(Math.max(0, Math.floor((now - startedAt) / 1000)));
}

/**
 * A ringtone synthesised with the Web Audio API rather than shipped as a file — it keeps the
 * bundle small and needs no asset hosting. Browsers block audio until the page has been
 * interacted with, so this fails quietly when it cannot play.
 */
function useRingtone(): void {
  useEffect(() => {
    let context: AudioContext | null = null;
    let stopped = false;

    try {
      context = new AudioContext();
    } catch {
      return;
    }

    const ring = () => {
      if (stopped || !context || context.state === 'closed') return;
      const now = context.currentTime;
      const gain = context.createGain();
      gain.connect(context.destination);

      // Two short tones, the shape people read as "ringing".
      for (const offset of [0, 0.45]) {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = 480;
        oscillator.connect(gain);
        gain.gain.setValueAtTime(0, now + offset);
        gain.gain.linearRampToValueAtTime(0.08, now + offset + 0.04);
        gain.gain.linearRampToValueAtTime(0, now + offset + 0.35);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.36);
      }
    };

    ring();
    const timer = window.setInterval(ring, 2600);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      void context?.close().catch(() => {});
    };
  }, []);
}

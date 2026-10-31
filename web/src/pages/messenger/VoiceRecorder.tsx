import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/ui';

/**
 * Voice messages ride the ordinary attachment path: the recording becomes a File, which the
 * composer encrypts on this device before upload, exactly like any other attachment.
 *
 * MediaRecorder needs a secure context, so this is unavailable over plain HTTP (except on
 * localhost) and in browsers without it. The button hides itself rather than failing on click.
 */
export function isVoiceRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    window.isSecureContext
  );
}

const MAX_SECONDS = 300;

function pickMimeType(): string {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function VoiceRecorder({
  onRecorded,
  disabled,
}: {
  onRecorded: (file: File) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const keepRef = useRef(true);

  // Releasing the microphone matters: the browser shows a recording indicator until we do.
  useEffect(() => () => teardown(), []);

  function teardown() {
    window.clearInterval(timerRef.current);
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close().catch(() => {});
    streamRef.current = null;
    audioContextRef.current = null;
    recorderRef.current = null;
  }

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      keepRef.current = true;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        teardown();
        setRecording(false);
        setSeconds(0);
        setLevel(0);
        if (keepRef.current && blob.size > 0) {
          const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          onRecorded(
            new File([blob], `voice-message-${new Date().toISOString().slice(0, 19)}.${extension}`, { type }),
          );
        }
      };

      recorder.start(250);
      setRecording(true);

      timerRef.current = window.setInterval(() => {
        setSeconds((current) => {
          // Hard cap so a forgotten recording cannot grow without bound.
          if (current + 1 >= MAX_SECONDS) stop();
          return current + 1;
        });
      }, 1000);

      // A cheap level meter, so the control shows the microphone is actually live.
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128));
        setLevel(Math.min(peak / 40, 1));
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (caught) {
      teardown();
      setRecording(false);
      setError(
        (caught as Error)?.name === 'NotAllowedError'
          ? 'Microphone access was denied.'
          : 'Could not start recording.',
      );
    }
  }

  function stop() {
    keepRef.current = true;
    recorderRef.current?.stop();
  }

  function cancel() {
    keepRef.current = false;
    recorderRef.current?.stop();
  }

  if (!recording) {
    return (
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        aria-label="Record a voice message"
        title={error ?? 'Record a voice message'}
        className={`rounded-lg p-2.5 transition hover:bg-raised disabled:opacity-50 ${
          error ? 'text-danger' : 'text-muted hover:text-text'
        }`}
      >
        <Icon name="mic" />
      </button>
    );
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');

  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-2.5 py-1.5"
      role="status"
      aria-live="polite"
    >
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden="true" />
      <span className="font-mono text-sm tabular-nums text-text">
        {minutes}:{remainder}
      </span>
      <span className="flex h-4 items-center gap-0.5" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className="w-0.5 rounded-full bg-danger transition-all"
            style={{ height: `${Math.max(3, level * 16 * (1 - Math.abs(bar - 2) * 0.2))}px` }}
          />
        ))}
      </span>
      <button
        type="button"
        onClick={cancel}
        aria-label="Discard recording"
        className="rounded-lg p-1 text-faint transition hover:text-danger"
      >
        <Icon name="trash" className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={stop}
        aria-label="Finish recording and attach it"
        className="rounded-lg p-1 text-accent transition hover:brightness-125"
      >
        <Icon name="check" className="h-4 w-4" />
      </button>
    </div>
  );
}

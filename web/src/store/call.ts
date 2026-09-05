import { create } from 'zustand';
import { api } from '../lib/api';
import { realtime } from '../lib/realtime';
import { CallSession, isCallingSupported, type IceConfig } from '../lib/webrtc';

/**
 * Call state machine.
 *
 *   idle → dialing → ringing → connecting → active → idle      (outgoing)
 *   idle → incoming →           connecting → active → idle      (incoming)
 *
 * Any state can drop straight to `ended` and then `idle`. The caller creates the offer only
 * once the callee has accepted, so no camera is opened on the callee's device until they
 * choose to answer.
 */

export type CallPhase =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'incoming'
  | 'connecting'
  | 'active'
  | 'ended';

export interface CallPeer {
  id: string;
  displayName: string;
  customAddress: string | null;
  avatarUrl: string | null;
}

interface CallState {
  phase: CallPhase;
  callId: string | null;
  conversationId: string | null;
  kind: 'audio' | 'video';
  peer: CallPeer | null;
  /** True when we placed the call. */
  outgoing: boolean;

  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;

  startedAt: number | null;
  error: string | null;
  endedReason: string | null;
  /** No TURN relay configured — some networks will not connect. */
  relayWarning: boolean;

  init: () => void;
  startCall: (conversationId: string, kind: 'audio' | 'video', peer: CallPeer) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  hangUp: (reason?: string) => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  dismissError: () => void;
}

let session: CallSession | null = null;
let iceConfig: IceConfig | null = null;
let ringTimeout: number | undefined;

async function loadIceConfig(): Promise<IceConfig> {
  if (iceConfig) return iceConfig;
  const response = await api.get<IceConfig>('/api/calls/ice');
  iceConfig = response;
  return response;
}

function teardown(): void {
  window.clearTimeout(ringTimeout);
  session?.close();
  session = null;
}

export const useCall = create<CallState>((set, get) => ({
  phase: 'idle',
  callId: null,
  conversationId: null,
  kind: 'audio',
  peer: null,
  outgoing: false,
  localStream: null,
  remoteStream: null,
  micEnabled: true,
  cameraEnabled: true,
  startedAt: null,
  error: null,
  endedReason: null,
  relayWarning: false,

  /**
   * Registers the signalling handlers. Safe to call repeatedly: realtime.on() replaces any
   * previous handler for the same event.
   *
   * There is deliberately no "already bound" guard. The transport is torn down and rebuilt
   * whenever the messenger remounts — which React does on every mount in StrictMode — and a
   * one-shot guard would skip re-registration against the new socket, leaving incoming calls
   * arriving at a handler that is no longer attached to anything.
   */
  init() {
    realtime.on('call:incoming', (payload: {
      callId: string;
      conversationId: string;
      kind: 'audio' | 'video';
      from: CallPeer;
    }) => {
      // Already busy: refuse politely rather than dropping the existing call.
      //
      // "ended" does not count. It is only the couple of seconds where the outcome of the
      // previous call is still on screen, and someone calling straight back must ring, not
      // be told you are busy.
      const phase = get().phase;
      if (phase !== 'idle' && phase !== 'ended') {
        realtime.emit('call:hangup', { callId: payload.callId, reason: 'busy' });
        return;
      }

      set({
        phase: 'incoming',
        callId: payload.callId,
        conversationId: payload.conversationId,
        kind: payload.kind,
        peer: payload.from,
        outgoing: false,
        error: null,
        endedReason: null,
      });
      realtime.emit('call:ringing', { callId: payload.callId });
    });

    realtime.on('call:ringing', ({ callId }: { callId: string }) => {
      if (get().callId === callId && get().phase === 'dialing') set({ phase: 'ringing' });
    });

    // The callee accepted: now build the offer.
    realtime.on('call:accepted', async ({ callId }: { callId: string }) => {
      const state = get();
      if (state.callId !== callId || !session) return;
      set({ phase: 'connecting' });
      try {
        const offer = await session.createOffer();
        realtime.emit('call:offer', { callId, sdp: offer });
      } catch {
        get().hangUp('failed');
      }
    });

    realtime.on('call:offer', async ({ callId, sdp }: { callId: string; sdp: RTCSessionDescriptionInit }) => {
      const state = get();
      if (state.callId !== callId || !session) return;
      try {
        const answer = await session.acceptOffer(sdp);
        realtime.emit('call:answer', { callId, sdp: answer });
      } catch {
        get().hangUp('failed');
      }
    });

    realtime.on('call:answer', async ({ callId, sdp }: { callId: string; sdp: RTCSessionDescriptionInit }) => {
      if (get().callId !== callId || !session) return;
      await session.acceptAnswer(sdp).catch(() => get().hangUp('failed'));
    });

    realtime.on('call:ice', async ({ callId, candidate }: { callId: string; candidate: RTCIceCandidateInit }) => {
      if (get().callId !== callId || !session) return;
      await session.addIceCandidate(candidate);
    });

    realtime.on('call:ended', ({ callId, reason }: { callId: string; reason: string }) => {
      if (get().callId !== callId) return;
      teardown();
      set({
        phase: 'ended',
        endedReason:
          reason === 'declined' ? 'Call declined' : reason === 'busy' ? 'They are on another call' : 'Call ended',
        localStream: null,
        remoteStream: null,
      });
      window.setTimeout(() => {
        if (get().phase === 'ended') set({ phase: 'idle', callId: null, peer: null, endedReason: null });
      }, 2500);
    });

    // Another of this user's devices picked up or dismissed it.
    realtime.on('call:handled', ({ callId }: { callId: string }) => {
      if (get().callId === callId && get().phase === 'incoming') {
        teardown();
        set({ phase: 'idle', callId: null, peer: null });
      }
    });
  },

  async startCall(conversationId, kind, peer) {
    if (!isCallingSupported()) {
      set({ error: 'This browser cannot make calls. Calls need a secure (https) page.' });
      return;
    }
    // Signalling rides the WebSocket; polling has no upstream channel fast enough for it.
    if (!realtime.supportsEphemeral()) {
      set({
        error:
          'Calls need a live connection, which this deployment cannot hold. Messaging still works.',
      });
      return;
    }
    if (get().phase !== 'idle') return;

    set({
      phase: 'dialing',
      conversationId,
      kind,
      peer,
      outgoing: true,
      error: null,
      endedReason: null,
      micEnabled: true,
      cameraEnabled: kind === 'video',
    });

    try {
      const config = await loadIceConfig();
      if (!config.callsEnabled) throw new Error('Calling is turned off on this deployment.');

      session = new CallSession(config, {
        onLocalStream: (stream) => set({ localStream: stream }),
        onRemoteStream: (stream) => set({ remoteStream: stream }),
        onIceCandidate: (candidate) => {
          const id = get().callId;
          if (id) realtime.emit('call:ice', { callId: id, candidate });
        },
        onConnectionStateChange: (state) => {
          if (state === 'connected' && get().phase !== 'active') {
            set({ phase: 'active', startedAt: Date.now() });
          }
        },
        onFailure: (message) => set({ error: message }),
      });

      await session.open(kind === 'video');
      set({ relayWarning: !config.hasRelay });

      const ack = await realtime.request<{ ok: boolean; callId?: string; error?: string }>(
        'call:start',
        { conversationId, kind },
      );
      if (!ack?.ok || !ack.callId) throw new Error(ack?.error ?? 'Could not start the call.');

      set({ callId: ack.callId });

      // Give up if they never pick up, so the call does not ring forever.
      ringTimeout = window.setTimeout(() => {
        if (get().phase === 'dialing' || get().phase === 'ringing') get().hangUp('timeout');
      }, 45_000);
    } catch (error) {
      teardown();
      set({
        phase: 'idle',
        callId: null,
        localStream: null,
        error: error instanceof Error ? error.message : 'Could not start the call.',
      });
    }
  },

  async accept() {
    const { callId, kind } = get();
    if (!callId) return;

    set({ phase: 'connecting', micEnabled: true, cameraEnabled: kind === 'video' });
    try {
      const config = await loadIceConfig();
      session = new CallSession(config, {
        onLocalStream: (stream) => set({ localStream: stream }),
        onRemoteStream: (stream) => set({ remoteStream: stream }),
        onIceCandidate: (candidate) => realtime.emit('call:ice', { callId, candidate }),
        onConnectionStateChange: (state) => {
          if (state === 'connected' && get().phase !== 'active') {
            set({ phase: 'active', startedAt: Date.now() });
          }
        },
        onFailure: (message) => set({ error: message }),
      });

      // The camera only opens now — answering is what grants it, not ringing.
      await session.open(kind === 'video');
      set({ relayWarning: !config.hasRelay });
      realtime.emit('call:accept', { callId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not answer the call.';
      realtime.emit('call:hangup', { callId, reason: 'failed' });
      teardown();
      set({ phase: 'idle', callId: null, localStream: null, error: message });
    }
  },

  decline() {
    const { callId } = get();
    if (callId) realtime.emit('call:hangup', { callId, reason: 'declined' });
    teardown();
    set({ phase: 'idle', callId: null, peer: null, localStream: null, remoteStream: null });
  },

  hangUp(reason = 'hangup') {
    const { callId } = get();
    if (callId) realtime.emit('call:hangup', { callId, reason });
    teardown();
    set({
      phase: 'idle',
      callId: null,
      peer: null,
      localStream: null,
      remoteStream: null,
      startedAt: null,
    });
  },

  toggleMic() {
    const next = !get().micEnabled;
    session?.setMicrophoneEnabled(next);
    set({ micEnabled: next });
  },

  toggleCamera() {
    const next = !get().cameraEnabled;
    session?.setCameraEnabled(next);
    set({ cameraEnabled: next });
  },

  dismissError() {
    set({ error: null });
  },
}));

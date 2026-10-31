/**
 * WebRTC peer connection for one-to-one calls.
 *
 * Audio and video travel directly between the two devices, encrypted with DTLS-SRTP — a
 * mandatory part of WebRTC, not something bolted on here. The server only relays the session
 * descriptions and ICE candidates needed to find a path. Where a TURN relay is required to
 * traverse a restrictive NAT, it forwards packets it cannot decrypt.
 *
 * Unlike message encryption, this needs no key management: the DTLS handshake happens between
 * the browsers themselves.
 */

export interface IceConfig {
  iceServers: RTCIceServer[];
  hasRelay: boolean;
  callsEnabled: boolean;
}

export interface PeerCallbacks {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  onFailure: (message: string) => void;
}

export class CallSession {
  private connection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private readonly remoteStream = new MediaStream();
  /** Candidates that arrive before the remote description is set have to wait. */
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(
    private readonly config: IceConfig,
    private readonly callbacks: PeerCallbacks,
  ) {}

  /**
   * Asks for the microphone (and camera, for a video call) and opens the peer connection.
   * Throws a message worth showing the user — permission refusal and missing hardware are
   * the two common cases and read very differently.
   */
  async open(video: boolean): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot access the microphone. Calls need a secure (https) page.');
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
      });
    } catch (error) {
      const name = (error as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error(
          video
            ? 'Camera and microphone access was blocked. Allow it in your browser settings to make video calls.'
            : 'Microphone access was blocked. Allow it in your browser settings to make calls.',
        );
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new Error(video ? 'No camera or microphone was found.' : 'No microphone was found.');
      }
      throw new Error('Could not start your microphone.');
    }

    this.callbacks.onLocalStream(this.localStream);

    const connection = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      // Trickling gets media flowing sooner than waiting for the full candidate set.
      iceCandidatePoolSize: 4,
    });
    this.connection = connection;

    for (const track of this.localStream.getTracks()) {
      connection.addTrack(track, this.localStream);
    }

    connection.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        // Replace rather than accumulate, so a renegotiated track does not duplicate.
        const existing = this.remoteStream.getTracks().find((t) => t.kind === track.kind);
        if (existing) this.remoteStream.removeTrack(existing);
        this.remoteStream.addTrack(track);
      }
      this.callbacks.onRemoteStream(this.remoteStream);
    };

    connection.onicecandidate = (event) => {
      if (event.candidate) this.callbacks.onIceCandidate(event.candidate.toJSON());
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      this.callbacks.onConnectionStateChange(state);
      if (state === 'failed') {
        this.callbacks.onFailure(
          this.config.hasRelay
            ? 'The call could not connect.'
            : 'The call could not connect. This deployment has no TURN relay configured, which some networks require.',
        );
      }
    };
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const connection = this.require();
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    return offer;
  }

  async acceptOffer(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const connection = this.require();
    await connection.setRemoteDescription(new RTCSessionDescription(sdp));
    await this.drainCandidates();

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    return answer;
  }

  async acceptAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    const connection = this.require();
    // A late answer after teardown is normal; ignore rather than throw.
    if (connection.signalingState === 'closed') return;
    await connection.setRemoteDescription(new RTCSessionDescription(sdp));
    await this.drainCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const connection = this.connection;
    if (!connection || this.closed) return;

    // Candidates routinely arrive before the remote description; queue until it lands.
    if (!connection.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // A candidate for a bundle that was never negotiated is safe to drop.
    }
  }

  private async drainCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) await this.addIceCandidate(candidate);
  }

  setMicrophoneEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  setCameraEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getVideoTracks() ?? []) track.enabled = enabled;
  }

  hasVideo(): boolean {
    return (this.localStream?.getVideoTracks().length ?? 0) > 0;
  }

  /** Releases the camera and microphone. The browser keeps its recording indicator lit until this runs. */
  close(): void {
    this.closed = true;
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    for (const track of this.remoteStream.getTracks()) this.remoteStream.removeTrack(track);
    this.localStream = null;

    if (this.connection) {
      this.connection.ontrack = null;
      this.connection.onicecandidate = null;
      this.connection.onconnectionstatechange = null;
      this.connection.close();
      this.connection = null;
    }
  }

  private require(): RTCPeerConnection {
    if (!this.connection) throw new Error('The call is not open.');
    return this.connection;
  }
}

export function isCallingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof RTCPeerConnection !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    window.isSecureContext
  );
}

export function formatCallDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

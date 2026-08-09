import { Platform, Vibration } from 'react-native';
import functions from '@react-native-firebase/functions';
import type { MediaStream } from 'react-native-webrtc';
import { Limits } from '@/src/config/env';
import type { CallRecord, CallState, CallType, UserProfile } from '@/src/config/types';
import {
  Paths,
  fanOut,
  onChildAdded,
  onValue,
  pushKey,
  readOnce,
  remove,
  serverTimestamp,
  update,
  write,
  type Unsubscribe,
} from './FirebaseService';
import { WebRTCManager } from './WebRTCManager';
import type { AudioRoute } from './AudioRoute';
import * as CallKeep from './CallKeepService';
import { appState } from './StateManager';
import { ensureCallPermissions } from './PermissionManager';

/**
 * CallManager — the call state machine and RTDB signalling.
 *
 * One call at a time; a second incoming call while busy is auto-rejected with
 * `busy`. State lives at `calls/{callId}/state` and both peers drive off it,
 * so there is exactly one source of truth for "is this call still alive".
 *
 * Signalling layout:
 *   calls/{id}/offer                 — caller's SDP
 *   calls/{id}/answer                — callee's SDP
 *   calls/{id}/candidates/{uid}/*    — trickled ICE, per-sender
 *   incoming/{calleeUid}/{callId}    — ring pointer the callee listens on
 */

type Teardown = Unsubscribe | (() => void);

class CallManagerImpl {
  private rtc: WebRTCManager | null = null;
  private callId: string | null = null;
  private myUid: string | null = null;
  private peerUid: string | null = null;
  private isCaller = false;
  private subs: Teardown[] = [];
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private callkeepUnsub: (() => void) | null = null;
  /** Set when we answered from the native UI before the RTC layer was ready. */
  private pendingNativeAnswer = false;

  private onLocalStreamCb: ((s: MediaStream | null) => void) | null = null;
  private onRemoteStreamCb: ((s: MediaStream | null) => void) | null = null;

  // --- wiring ------------------------------------------------------------

  /** Called once from the root layout after auth resolves. */
  attach(uid: string) {
    this.myUid = uid;

    this.callkeepUnsub?.();
    this.callkeepUnsub = CallKeep.subscribe((event) => {
      switch (event.type) {
        case 'answer':
          void this.acceptFromNative(event.callId);
          break;
        case 'end':
          // Only the active call may be hung up. The OS also emits `end` for
          // UUIDs we are no longer tracking — a ghost UI left behind by a
          // previous process, or the native side of an invite the busy path
          // already rejected over RTDB. Routing those into hangUp() would drop
          // whatever call is live now, since hangUp always ends `this.callId`.
          if (this.callId !== event.callId) {
            CallKeep.endCall(event.callId, 'remote');
            break;
          }
          void this.hangUp('hangup');
          break;
        case 'mute':
          this.setMicMuted(event.muted);
          break;
      }
    });

    // Ring pointer: this is what fires when the app is already running.
    const off = onChildAdded(Paths.incoming(uid), (snap) => {
      const invite = snap.val() as {
        callId: string;
        callerId: string;
        callerName: string;
        callerPhoto: string | null;
        type: CallType;
        createdAt: number;
      } | null;
      if (!invite) return;
      void this.handleIncoming(invite);
    });
    this.subs.push(off);
  }

  setStreamHandlers(
    onLocal: (s: MediaStream | null) => void,
    onRemote: (s: MediaStream | null) => void
  ) {
    this.onLocalStreamCb = onLocal;
    this.onRemoteStreamCb = onRemote;
    // Late subscribers (the call screen mounting after the call started) need
    // the streams that already exist.
    if (this.rtc) {
      onLocal(this.rtc.getLocalStream());
      onRemote(this.rtc.getRemoteStream());
    }
  }

  // --- outgoing ----------------------------------------------------------

  async startCall(peer: UserProfile, type: CallType): Promise<boolean> {
    const myUid = this.myUid;
    if (!myUid) return false;

    if (this.callId) {
      console.warn('[Flyer/call] already in a call');
      return false;
    }

    const perms = await ensureCallPermissions(type === 'video');
    if (!perms.ok) return false;

    const callId = CallKeep.newCallId();
    this.callId = callId;
    this.peerUid = peer.uid;
    this.isCaller = true;

    appState.get().startCall({
      callId,
      peerId: peer.uid,
      peer,
      type,
      direction: 'outgoing',
      state: 'calling',
      connectedAt: null,
      micMuted: false,
      videoEnabled: type === 'video',
      speakerOn: type === 'video',
      frontCamera: true,
      reconnecting: false,
      endedReason: null,
    });

    try {
      const me = appState.get().currentUser;

      await write(Paths.call(callId), {
        callerId: myUid,
        calleeId: peer.uid,
        type,
        state: 'calling',
        createdAt: serverTimestamp(),
        answeredAt: null,
        endedAt: null,
        endedReason: null,
      });

      await this.buildPeerConnection(type === 'video', /* polite */ false);

      const offer = await this.rtc!.createOffer();
      await write(Paths.callOffer(callId), {
        type: offer.type,
        sdp: offer.sdp,
      });

      // Ring pointer + push, so the callee hears it whether or not the app runs.
      await write(`${Paths.incoming(peer.uid)}/${callId}`, {
        callId,
        callerId: myUid,
        callerName: me?.name ?? 'Flyer user',
        callerPhoto: me?.photoURL ?? null,
        type,
        createdAt: serverTimestamp(),
      });

      await update(Paths.call(callId), { state: 'ringing' });
      appState.get().setCallState('ringing');

      this.listenForAnswer();
      this.listenForRemoteCandidates();
      this.listenForCallState();
      this.armRingTimeout();

      await CallKeep.startOutgoing({
        callId,
        calleeName: peer.name,
        calleeHandle: peer.email || peer.uid,
        hasVideo: type === 'video',
      });
      CallKeep.reportOutgoingRinging(callId);

      // Fire-and-forget: the ring pointer already works for a live app, the
      // push is what covers a killed one. A failure here must not fail the call.
      functions()
        .httpsCallable('sendCallInvite')({ calleeId: peer.uid, callId, type })
        .catch((e) => console.warn('[Flyer/call] invite push failed', e));

      return true;
    } catch (e) {
      console.warn('[Flyer/call] startCall failed', e);
      await this.hangUp('failed');
      return false;
    }
  }

  // --- incoming ----------------------------------------------------------

  private async handleIncoming(invite: {
    callId: string;
    callerId: string;
    callerName: string;
    callerPhoto: string | null;
    type: CallType;
  }) {
    const myUid = this.myUid;
    if (!myUid) return;

    // Busy: reject without disturbing the call in progress.
    if (this.callId && this.callId !== invite.callId) {
      await update(Paths.call(invite.callId), {
        state: 'rejected',
        endedReason: 'busy',
        endedAt: serverTimestamp(),
      }).catch(() => {});
      await remove(`${Paths.incoming(myUid)}/${invite.callId}`).catch(() => {});
      return;
    }

    if (this.callId === invite.callId) return;

    // A stale pointer (server reaped the call, or we already answered elsewhere).
    const record = await readOnce<CallRecord>(Paths.call(invite.callId));
    if (!record || record.state === 'ended' || record.state === 'rejected') {
      await remove(`${Paths.incoming(myUid)}/${invite.callId}`).catch(() => {});
      return;
    }

    this.callId = invite.callId;
    this.peerUid = invite.callerId;
    this.isCaller = false;

    const cached = appState.get().users[invite.callerId] ?? null;

    appState.get().startCall({
      callId: invite.callId,
      peerId: invite.callerId,
      peer: cached ?? {
        uid: invite.callerId,
        name: invite.callerName,
        photoURL: invite.callerPhoto,
      } as UserProfile,
      type: invite.type,
      direction: 'incoming',
      state: 'ringing',
      connectedAt: null,
      micMuted: false,
      videoEnabled: invite.type === 'video',
      speakerOn: invite.type === 'video',
      frontCamera: true,
      reconnecting: false,
      endedReason: null,
    });

    this.listenForCallState();
    this.armRingTimeout();

    await CallKeep.displayIncoming({
      callId: invite.callId,
      callerName: invite.callerName,
      callerHandle: invite.callerId,
      hasVideo: invite.type === 'video',
    });

    if (Platform.OS === 'android') {
      Vibration.vibrate([0, 500, 1000], true);
    }

    // The native UI may have been answered before this ran (cold start).
    if (this.pendingNativeAnswer) {
      this.pendingNativeAnswer = false;
      await this.accept();
    }
  }

  /** Answer triggered by the OS call UI rather than our own screen. */
  private async acceptFromNative(callId: string) {
    if (!this.callId) {
      // Woken by the push but the invite listener has not resolved yet.
      this.pendingNativeAnswer = true;
      return;
    }
    if (this.callId !== callId) return;
    await this.accept();
  }

  async accept(): Promise<boolean> {
    const callId = this.callId;
    const myUid = this.myUid;
    const active = appState.get().activeCall;
    if (!callId || !myUid || !active) return false;

    Vibration.cancel();
    this.clearRingTimeout();

    const perms = await ensureCallPermissions(active.type === 'video');
    if (!perms.ok) {
      await this.reject();
      return false;
    }

    try {
      // The callee is the "polite" peer for glare resolution.
      await this.buildPeerConnection(active.type === 'video', /* polite */ true);

      const offer = await readOnce<{ type: string; sdp: string }>(Paths.callOffer(callId));
      if (!offer) throw new Error('No offer present for this call');

      await this.rtc!.setRemoteDescription(offer);

      const answer = await this.rtc!.createAnswer();
      await write(Paths.callAnswer(callId), { type: answer.type, sdp: answer.sdp });

      await update(Paths.call(callId), {
        state: 'accepted',
        answeredAt: serverTimestamp(),
      });

      this.listenForRemoteCandidates();
      appState.get().setCallState('accepted');
      CallKeep.reportConnected(callId);

      await remove(`${Paths.incoming(myUid)}/${callId}`).catch(() => {});
      return true;
    } catch (e) {
      console.warn('[Flyer/call] accept failed', e);
      await this.hangUp('failed');
      return false;
    }
  }

  async reject(): Promise<void> {
    const callId = this.callId;
    if (!callId) return;

    Vibration.cancel();
    await update(Paths.call(callId), {
      state: 'rejected',
      endedAt: serverTimestamp(),
      endedReason: 'rejected',
    }).catch(() => {});

    CallKeep.endCall(callId, 'declined');
    await this.cleanup('rejected');
  }

  // --- signalling --------------------------------------------------------

  private async buildPeerConnection(video: boolean, polite: boolean) {
    const callId = this.callId!;
    const myUid = this.myUid!;

    this.rtc = new WebRTCManager({
      video,
      polite,
      callbacks: {
        onLocalStream: (stream) => this.onLocalStreamCb?.(stream),
        onRemoteStream: (stream) => this.onRemoteStreamCb?.(stream),

        onIceCandidate: (candidate) => {
          const key = pushKey(Paths.callCandidates(callId, myUid));
          write(`${Paths.callCandidates(callId, myUid)}/${key}`, {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          }).catch(() => {});
        },

        onPhaseChange: (phase) => {
          if (phase === 'connected') {
            const call = appState.get().activeCall;
            if (call && !call.connectedAt) {
              appState.get().patchCall({ connectedAt: Date.now(), reconnecting: false });
              this.startDurationTimer();
              CallKeep.reportConnected(callId);
            } else {
              appState.get().patchCall({ reconnecting: false });
            }
          }
          if (phase === 'reconnecting') {
            appState.get().patchCall({ reconnecting: true });
          }
        },

        onFatal: (reason) => {
          console.warn('[Flyer/call] fatal:', reason);
          void this.hangUp('failed');
        },
      },
    });

    // Republish the SDP after an ICE restart so the peer renegotiates.
    this.rtc.setRestartHandler(async (offer) => {
      await write(Paths.callOffer(callId), { type: offer.type, sdp: offer.sdp });
    });

    await this.rtc.initialize();
  }

  private listenForAnswer() {
    const callId = this.callId!;
    const off = onValue(Paths.callAnswer(callId), async (snap) => {
      const answer = snap.val() as { type: string; sdp: string } | null;
      if (!answer || !this.rtc) return;
      try {
        await this.rtc.setRemoteDescription(answer);
        this.clearRingTimeout();
      } catch (e) {
        console.warn('[Flyer/call] failed to apply answer', e);
      }
    });
    this.subs.push(off);
  }

  private listenForRemoteCandidates() {
    const callId = this.callId!;
    const peerUid = this.peerUid;
    if (!peerUid) return;

    const off = onChildAdded(Paths.callCandidates(callId, peerUid), (snap) => {
      const value = snap.val() as RTCIceCandidateInit | null;
      if (value && this.rtc) void this.rtc.addIceCandidate(value);
    });
    this.subs.push(off);
  }

  /**
   * The authoritative end signal. Whoever hangs up writes `ended` here and the
   * other side tears down from this listener — that way a hangup during a
   * network blip still lands as soon as the socket recovers.
   */
  private listenForCallState() {
    const callId = this.callId!;
    const off = onValue(Paths.callState(callId), (snap) => {
      const state = snap.val() as CallState | null;
      if (!state) return;

      if (state === 'accepted' && this.isCaller) {
        this.clearRingTimeout();
        appState.get().setCallState('accepted');
      }

      if (state === 'ended' || state === 'rejected') {
        CallKeep.endCall(callId, state === 'rejected' ? 'declined' : 'remote');
        void this.cleanup(state);
      }
    });
    this.subs.push(off);
  }

  private armRingTimeout() {
    this.clearRingTimeout();
    this.ringTimer = setTimeout(() => {
      const state = appState.get().callState;
      if (state === 'calling' || state === 'ringing') {
        void this.hangUp('missed');
      }
    }, Limits.callRingTimeoutMs);
  }

  private clearRingTimeout() {
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
  }

  private startDurationTimer() {
    if (this.durationTimer) return;
    // Drives the on-screen timer; the store update forces a re-render each tick.
    this.durationTimer = setInterval(() => {
      const call = appState.get().activeCall;
      if (!call?.connectedAt) return;
      appState.get().patchCall({});
    }, 1000);
  }

  // --- controls ----------------------------------------------------------

  setMicMuted(muted: boolean) {
    this.rtc?.setMicMuted(muted);
    appState.get().patchCall({ micMuted: muted });
    if (this.callId) CallKeep.setMuted(this.callId, muted);
  }

  toggleMic() {
    const current = appState.get().activeCall?.micMuted ?? false;
    this.setMicMuted(!current);
  }

  toggleVideo() {
    const call = appState.get().activeCall;
    if (!call) return;
    const next = !call.videoEnabled;
    this.rtc?.setVideoEnabled(next);
    appState.get().patchCall({ videoEnabled: next });
  }

  toggleSpeaker() {
    const call = appState.get().activeCall;
    if (!call) return;
    const next = !call.speakerOn;
    this.rtc?.setSpeaker(next);
    appState.get().patchCall({ speakerOn: next });
  }

  /**
   * Pick an explicit output. `speakerOn` is kept in sync so the speaker button
   * reflects a route chosen from the picker instead of contradicting it.
   */
  setAudioRoute(route: AudioRoute) {
    if (!appState.get().activeCall) return;
    this.rtc?.setAudioRoute(route);
    appState.get().patchCall({ speakerOn: route === 'SPEAKER_PHONE' });
  }

  async switchCamera() {
    await this.rtc?.switchCamera();
    const call = appState.get().activeCall;
    if (call) appState.get().patchCall({ frontCamera: !call.frontCamera });
  }

  // --- teardown ----------------------------------------------------------

  async hangUp(reason: CallRecord['endedReason'] = 'hangup'): Promise<void> {
    const callId = this.callId;
    if (!callId) return;

    const wasRinging = appState.get().callState === 'ringing' && !this.isCaller;

    try {
      await update(Paths.call(callId), {
        state: reason === 'rejected' || wasRinging ? 'rejected' : 'ended',
        endedAt: serverTimestamp(),
        endedReason: reason,
      });
    } catch (e) {
      console.warn('[Flyer/call] failed to publish end state', e);
    }

    // Tell the callee's device to drop the ringing UI if they never picked up.
    if (this.isCaller && this.peerUid) {
      remove(`${Paths.incoming(this.peerUid)}/${callId}`).catch(() => {});
      functions()
        .httpsCallable('cancelCallInvite')({ calleeId: this.peerUid, callId })
        .catch(() => {});
    }

    CallKeep.endCall(callId, 'local');
    await this.cleanup(reason === 'rejected' ? 'rejected' : 'ended');
  }

  private async cleanup(finalState: CallState) {
    Vibration.cancel();
    this.clearRingTimeout();

    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    for (const off of this.subs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    // Keep the incoming-invite listener alive — it is attached for the session,
    // not per call. attach() re-adds it if the user signs out and back in.
    this.subs = [];
    if (this.myUid) {
      const off = onChildAdded(Paths.incoming(this.myUid), (snap) => {
        const invite = snap.val();
        if (invite) void this.handleIncoming(invite);
      });
      this.subs.push(off);
    }

    this.rtc?.close();
    this.rtc = null;

    this.onLocalStreamCb?.(null);
    this.onRemoteStreamCb?.(null);

    const callId = this.callId;
    const myUid = this.myUid;

    this.callId = null;
    this.peerUid = null;
    this.isCaller = false;
    this.pendingNativeAnswer = false;

    appState.get().setCallState(finalState);
    // Let the UI show "call ended" briefly before dismissing.
    setTimeout(() => {
      if (appState.get().callState !== 'idle' && !this.callId) {
        appState.get().clearCall();
      }
    }, 1200);

    // Signalling data is dead weight once the call is over; the call record
    // itself is kept for history (Cloud Functions writes callHistory from it).
    if (callId && myUid) {
      fanOut({
        [Paths.callOffer(callId)]: null,
        [Paths.callAnswer(callId)]: null,
        [`${Paths.call(callId)}/candidates`]: null,
        [`${Paths.incoming(myUid)}/${callId}`]: null,
      }).catch(() => {});
    }
  }

  detach() {
    for (const off of this.subs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.subs = [];
    this.callkeepUnsub?.();
    this.callkeepUnsub = null;
    this.rtc?.close();
    this.rtc = null;
    this.callId = null;
    this.myUid = null;
    CallKeep.endAll();
  }

  get currentCallId(): string | null {
    return this.callId;
  }
}

export const CallManager = new CallManagerImpl();

export function formatCallDuration(connectedAt: number | null): string {
  if (!connectedAt) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

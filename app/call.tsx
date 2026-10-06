import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { RTCView, type MediaStream } from 'react-native-webrtc';
import { darkTheme } from '@/src/theme/theme';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Avatar } from '@/src/components/Avatar';
import { AudioRouteSheet, ROUTE_ICON } from '@/src/components/AudioRouteSheet';
import { DraggablePiP } from '@/src/components/DraggablePiP';
import { Icon, type IconName } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { useAppStore } from '@/src/services/StateManager';
import { CallManager, formatCallDuration } from '@/src/services/CallManager';
import { useAudioRoutes } from '@/src/hooks/useAudioRoutes';
import { routeLabel } from '@/src/services/AudioRoute';
import { enterPipMode, isPipSupported, onPipModeChanged } from '@/src/services/PipService';
import type { CallRecord } from '@/src/config/types';

/**
 * The call surface is always dark: a light UI over a live video feed reads
 * badly, so this screen pulls its background and text from the dark palette
 * regardless of the app theme. Semantic colours still come from the theme.
 */
const surface = darkTheme.colors;

/** These sit on top of video, so they have to be translucent rather than flat. */
const CONTROL_IDLE_BG = 'rgba(255,255,255,0.14)';
const CONTROL_ACTIVE_BG = 'rgba(255,255,255,0.92)';
const BAR_BG = 'rgba(0,0,0,0.35)';
const PIP_BORDER = 'rgba(255,255,255,0.25)';

/** Self-view tile. Portrait, because the camera feed is, and 9:16 of 108px. */
const TILE_W = 108;
const TILE_H = 168;

const END_REASON_COPY: Record<NonNullable<CallRecord['endedReason']>, string> = {
  hangup: '',
  rejected: 'Declined',
  missed: 'No answer',
  failed: 'Connection failed',
  busy: 'Busy',
};

interface ControlProps {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
}

function ControlButton({ icon, label, onPress, active = false }: ControlProps) {
  return (
    <Pressable
      onPress={onPress}
      haptic
      round={56}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={{ backgroundColor: active ? CONTROL_ACTIVE_BG : CONTROL_IDLE_BG }}
    >
      <Icon name={icon} size={24} color={active ? surface.bg : surface.text} />
    </Pressable>
  );
}

export default function CallScreen() {
  useKeepAwake();

  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const call = useAppStore((s) => s.activeCall);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [routeSheet, setRouteSheet] = useState(false);
  const [inPip, setInPip] = useState(false);
  /** Which feed is fullscreen. Tapping the tile swaps them, as WhatsApp does. */
  const [selfFullscreen, setSelfFullscreen] = useState(false);

  const { available: audioRoutes, selected: audioRoute } = useAudioRoutes();

  useEffect(() => onPipModeChanged(setInPip), []);

  useEffect(() => {
    CallManager.setStreamHandlers(setLocalStream, setRemoteStream);
    // The handlers are held by the singleton for the whole call; detach on
    // unmount so a backgrounded screen is not kept alive by stream callbacks.
    return () => {
      CallManager.setStreamHandlers(
        () => {},
        () => {}
      );
    };
  }, []);

  // CallManager clears the store ~1.2s after a call ends; that is what dismisses
  // this screen. The mount must not count: on a cold start (notification tap)
  // the store hydrates after this screen, and popping on the first empty frame
  // would dismiss a call that never appeared.
  const hadCall = useRef(Boolean(call));
  useEffect(() => {
    if (call) {
      hadCall.current = true;
      return;
    }
    if (hadCall.current) router.back();
  }, [call]);

  const state = call?.state;
  const live = state === 'calling' || state === 'ringing' || state === 'accepted';

  // Swiping/backing out of a live call would orphan it — the peer connection
  // outlives this screen. Only let back through once the call is over.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => live);
    return () => sub.remove();
  }, [live]);

  // The timer re-renders from the store: CallManager patches activeCall every
  // second while connected, so reading Date.now() here is always fresh.
  const duration = call?.connectedAt ? formatCallDuration(call.connectedAt) : '';

  const videoLive = call?.type === 'video' && call?.state === 'accepted';

  /**
   * Leaving a video call by going home should shrink it, not abandon it — the
   * peer keeps sending video either way, so without this the user pays for a
   * stream they cannot see. Requested on the transition to `background` rather
   * than `inactive`: iOS fires `inactive` for a notification pull-down too, and
   * on Android the window is between the home press and the activity stopping.
   */
  useEffect(() => {
    if (!videoLive || !isPipSupported()) return;

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') enterPipMode({ width: 9, height: 16 });
    });
    return () => sub.remove();
  }, [videoLive]);

  const onEnterPip = useCallback(() => {
    enterPipMode({ width: 9, height: 16 });
  }, []);

  if (!call) return null;

  const isVideo = call.type === 'video';
  const isIncomingRing = state === 'ringing' && call.direction === 'incoming';
  const showVideoStage = isVideo && state === 'accepted';
  const peerName = call.peer?.name ?? 'Unknown';

  const subtitle = (() => {
    switch (state) {
      case 'calling':
        return 'Ringing…';
      case 'ringing':
        return call.direction === 'incoming'
          ? `Incoming ${isVideo ? 'video' : 'voice'} call`
          : 'Ringing…';
      case 'accepted':
        return call.connectedAt ? duration : 'Connecting…';
      case 'rejected':
        return 'Call declined';
      case 'ended':
        return 'Call ended';
      default:
        return '';
    }
  })();

  const endedNote = call.endedReason ? END_REASON_COPY[call.endedReason] : '';
  const isOver = state === 'ended' || state === 'rejected';

  // Which stream fills the screen, and which sits in the tile. The tile is only
  // worth showing when there are genuinely two feeds to choose between.
  const selfVisible = Boolean(localStream) && call.videoEnabled;
  const fullscreenStream = selfFullscreen && selfVisible ? localStream : remoteStream;
  const tileStream = selfFullscreen && selfVisible ? remoteStream : localStream;
  const tileIsSelf = !selfFullscreen;
  const showTile = showVideoStage && Boolean(tileStream) && (tileIsSelf ? selfVisible : true);

  // A picker is only worth a tap when there is more than one thing to pick, and
  // "earpiece + speaker" is the degenerate case the plain toggle already covers.
  const hasRouteChoice = audioRoutes.length > 2;
  const pipAvailable = isPipSupported();

  // In PiP the window is a few hundred pixels wide: controls, names and timers
  // are illegible and steal room from the only thing worth showing. Android
  // expects an app to strip itself back to the content on entering PiP.
  if (inPip) {
    return (
      <View style={[styles.root, { backgroundColor: surface.bg }]}>
        <Stack.Screen options={{ headerShown: false }} />
        {fullscreenStream ? (
          <RTCView
            streamURL={fullscreenStream.toURL()}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={selfFullscreen && call.frontCamera}
            zOrder={0}
          />
        ) : (
          <View style={styles.pipFallback}>
            <Avatar
              uri={call.peer?.photoURL ?? null}
              name={peerName}
              uid={call.peerId}
              size={72}
              showPhoto={call.peer?.privacy?.showPhoto ?? true}
            />
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: surface.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {showVideoStage && fullscreenStream ? (
        <RTCView
          streamURL={fullscreenStream.toURL()}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          mirror={selfFullscreen && call.frontCamera}
          zOrder={0}
        />
      ) : null}

      {showTile && tileStream ? (
        <DraggablePiP
          width={TILE_W}
          height={TILE_H}
          onPress={() => setSelfFullscreen((v) => !v)}
          topInset={theme.spacing(8)}
          bottomInset={theme.spacing(24)}
          style={{
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: PIP_BORDER,
          }}
        >
          <RTCView
            streamURL={tileStream.toURL()}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={tileIsSelf && call.frontCamera}
            zOrder={1}
          />
        </DraggablePiP>
      ) : null}

      {call.reconnecting ? (
        <View
          style={[
            styles.reconnecting,
            {
              top: insets.top + theme.spacing(2),
              backgroundColor: theme.colors.warning,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.spacing(4),
              paddingVertical: theme.spacing(2),
            },
          ]}
        >
          <Text style={[styles.reconnectingText, { color: surface.bg }]}>Reconnecting…</Text>
        </View>
      ) : null}

      {/* The identity block is hidden behind the remote feed on a live video
          call, where the video itself is the subject. */}
      {!showVideoStage ? (
        <View style={[styles.identity, { paddingTop: insets.top + theme.spacing(16) }]}>
          <Avatar
            uri={call.peer?.photoURL ?? null}
            name={peerName}
            uid={call.peerId}
            size={120}
            showPhoto={call.peer?.privacy?.showPhoto ?? true}
          />

          <Text style={[styles.name, { color: surface.text, marginTop: theme.spacing(6) }]}>
            {peerName}
          </Text>

          <Text
            style={[styles.subtitle, { color: surface.textMuted, marginTop: theme.spacing(2) }]}
          >
            {subtitle}
          </Text>

          {isOver && endedNote ? (
            <Text
              style={[styles.reason, { color: surface.textFaint, marginTop: theme.spacing(1) }]}
            >
              {endedNote}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={[styles.videoHeader, { top: insets.top + theme.spacing(12) }]}>
          <Text style={[styles.videoName, { color: surface.text }]} numberOfLines={1}>
            {peerName}
          </Text>
          <Text style={[styles.subtitle, { color: surface.textMuted }]}>{subtitle}</Text>
        </View>
      )}

      <View style={[styles.dock, { paddingBottom: insets.bottom + theme.spacing(8) }]}>
        {isIncomingRing ? (
          <View style={styles.answerRow}>
            <View style={styles.answerSlot}>
              <Pressable
                onPress={() => void CallManager.reject()}
                haptic
                round={72}
                accessibilityRole="button"
                accessibilityLabel="Decline call"
                style={{ backgroundColor: theme.colors.danger }}
              >
                <Icon name="endCall" size={30} color={surface.text} />
              </Pressable>
              <Text style={[styles.answerLabel, { color: surface.textMuted }]}>Decline</Text>
            </View>

            <View style={styles.answerSlot}>
              <Pressable
                onPress={() => void CallManager.accept()}
                haptic
                round={72}
                accessibilityRole="button"
                accessibilityLabel="Accept call"
                style={{ backgroundColor: theme.colors.success }}
              >
                <Icon name={isVideo ? 'video' : 'phone'} size={30} color={surface.text} />
              </Pressable>
              <Text style={[styles.answerLabel, { color: surface.textMuted }]}>Accept</Text>
            </View>
          </View>
        ) : isOver ? (
          // The auto-clear usually pops this screen, but if it races the
          // detach the user would sit on a dead "Call ended" view with
          // swipe-back disabled and no way out. An explicit Close covers it.
          <View style={[styles.controlBar, { paddingVertical: theme.spacing(3) }]}>
            <Pressable
              onPress={() => router.back()}
              haptic
              round={64}
              accessibilityRole="button"
              accessibilityLabel="Close call screen"
              style={{ backgroundColor: BAR_BG }}
            >
              <Icon name="close" size={26} color={surface.text} />
            </Pressable>
          </View>
        ) : (
          <View
            style={[
              styles.controlBar,
              {
                backgroundColor: BAR_BG,
                borderRadius: theme.radius.xl,
                paddingVertical: theme.spacing(3),
                paddingHorizontal: theme.spacing(4),
              },
            ]}
          >
            <ControlButton
              icon={call.micMuted ? 'micOff' : 'mic'}
              label={call.micMuted ? 'Unmute microphone' : 'Mute microphone'}
              active={call.micMuted}
              onPress={() => CallManager.toggleMic()}
            />

            {/* With no headset connected the speaker toggle expresses every
                available route, so the picker stays hidden and this behaves
                exactly as it did before. */}
            {hasRouteChoice ? (
              <ControlButton
                icon={ROUTE_ICON[audioRoute ?? 'EARPIECE']}
                label={`Audio output: ${routeLabel(audioRoute ?? 'EARPIECE')}. Tap to change.`}
                active={audioRoute === 'BLUETOOTH' || audioRoute === 'SPEAKER_PHONE'}
                onPress={() => setRouteSheet(true)}
              />
            ) : (
              <ControlButton
                icon="speaker"
                label={call.speakerOn ? 'Turn off speaker' : 'Turn on speaker'}
                active={call.speakerOn}
                onPress={() => CallManager.toggleSpeaker()}
              />
            )}

            {isVideo ? (
              <ControlButton
                icon={call.videoEnabled ? 'video' : 'videoOff'}
                label={call.videoEnabled ? 'Turn off camera' : 'Turn on camera'}
                active={!call.videoEnabled}
                onPress={() => CallManager.toggleVideo()}
              />
            ) : null}

            {isVideo && call.videoEnabled ? (
              <ControlButton
                icon="switchCamera"
                label="Switch camera"
                onPress={() => void CallManager.switchCamera()}
              />
            ) : null}

            {showVideoStage && pipAvailable ? (
              <ControlButton icon="pip" label="Minimise call" onPress={onEnterPip} />
            ) : null}

            <Pressable
              onPress={() => void CallManager.hangUp('hangup')}
              haptic
              round={56}
              accessibilityRole="button"
              accessibilityLabel="End call"
              style={{ backgroundColor: theme.colors.danger }}
            >
              <Icon name="endCall" size={24} color={surface.text} />
            </Pressable>
          </View>
        )}
      </View>

      <AudioRouteSheet
        visible={routeSheet}
        routes={audioRoutes}
        selected={audioRoute}
        onSelect={(route) => CallManager.setAudioRoute(route)}
        onClose={() => setRouteSheet(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pipFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  reconnecting: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 3,
  },
  reconnectingText: { fontSize: darkTheme.font.small, fontWeight: '600' },
  identity: { alignItems: 'center', paddingHorizontal: 24 },
  name: { fontSize: darkTheme.font.large, fontWeight: '600', textAlign: 'center' },
  subtitle: { fontSize: darkTheme.font.body },
  reason: { fontSize: darkTheme.font.small },
  videoHeader: {
    position: 'absolute',
    left: 24,
    right: 24,
    alignItems: 'center',
    zIndex: 2,
  },
  videoName: { fontSize: darkTheme.font.title, fontWeight: '600' },
  dock: { marginTop: 'auto', paddingHorizontal: 20, zIndex: 3 },
  controlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    gap: 12,
  },
  answerRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
  },
  answerSlot: { alignItems: 'center', gap: 10 },
  answerLabel: { fontSize: darkTheme.font.small },
});

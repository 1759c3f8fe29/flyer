import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import { useTheme } from '@/src/theme/ThemeProvider';
import { formatDuration } from '@/src/services/MediaManager';
import { Icon } from './Icon';
import { Pressable } from './Pressable';

/**
 * Voice-note player.
 *
 * expo-av allows several sounds to play at once, which sounds like chaos when a
 * user taps through a run of voice notes. This module-level handle enforces one
 * at a time.
 */
let activeSound: { id: string; stop: () => Promise<void> } | null = null;

/**
 * Playback speeds, cycled by tapping the pill.
 *
 * Module-level so a speed chosen on one note carries to the next — someone
 * skimming a run of voice notes sets 2× once, not once per note. Deliberately
 * session-only: a listening speed is a mood, not a preference worth a storage
 * key, and it resetting to 1× on next launch is the behaviour people expect.
 */
const RATES = [1, 1.5, 2] as const;
let preferredRate: number = RATES[0];

interface Props {
  uri: string;
  durationMs: number | null;
  messageId: string;
  tint: string;
  trackColor: string;
  /** Deterministic bar heights so the same note always looks the same. */
  seed: string;
}

const BAR_COUNT = 28;

function barsFor(seed: string): number[] {
  const bars: number[] = [];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 1000003;
  }
  for (let i = 0; i < BAR_COUNT; i += 1) {
    hash = (hash * 1103515245 + 12345) % 2147483648;
    bars.push(0.25 + ((hash % 100) / 100) * 0.75);
  }
  return bars;
}

export function AudioPlayer({ uri, durationMs, messageId, tint, trackColor, seed }: Props) {
  const theme = useTheme();
  const soundRef = useRef<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [totalMs, setTotalMs] = useState(durationMs ?? 0);

  const bars = useRef(barsFor(seed)).current;
  const [rate, setRate] = useState(preferredRate);

  // False from the moment cleanup runs. expo-av keeps calling the status callback
  // from native until `unloadAsync` actually completes, and `createAsync` can
  // resolve long after the row has scrolled away, so every async continuation
  // below has to re-check this before touching state or storing a handle.
  const mountedRef = useRef(true);
  // Latched synchronously, before the first await in the load path. Two fast taps
  // otherwise both see `soundRef.current === null`, both call `createAsync`, and
  // the second overwrites the first — leaving an unreachable Sound playing
  // forever alongside the new one.
  const loadingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
      // Clear the global whenever it points at this note, even if the handle was
      // never stored (unmounted mid-load): leaving a stop() closure that targets
      // a dead component behind would make the next player await a no-op.
      if (activeSound?.id === messageId) activeSound = null;
    };
    // `uri` belongs here: a re-signed media URL under a stable messageId would
    // otherwise leave the previous Sound loaded and playing the old bytes.
  }, [messageId, uri]);

  const onStatus = (status: AVPlaybackStatus) => {
    // Ticks queued before unload completes would otherwise set state on a dead
    // component.
    if (!mountedRef.current || !status.isLoaded) return;
    setPositionMs(status.positionMillis ?? 0);
    if (status.durationMillis) setTotalMs(status.durationMillis);

    if (status.didJustFinish) {
      setPlaying(false);
      setPositionMs(0);
      soundRef.current?.setPositionAsync(0).catch(() => {});
    }
  };

  const toggle = async () => {
    // A tap that lands while a load is in flight is a no-op rather than a second
    // load. Pausing is handled below once there is a Sound to pause.
    if (loadingRef.current) return;

    try {
      if (playing) {
        await soundRef.current?.pauseAsync();
        if (mountedRef.current) setPlaying(false);
        return;
      }

      // Stop whatever else is playing first.
      if (activeSound && activeSound.id !== messageId) {
        await activeSound.stop().catch(() => {});
      }

      if (!soundRef.current) {
        loadingRef.current = true;
        setLoading(true);
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
        });

        const { sound } = await Audio.Sound.createAsync(
          { uri },
          {
            shouldPlay: true,
            progressUpdateIntervalMillis: 100,
            // Set at creation rather than after: applying it post-play makes the
            // first half-second audibly shift speed.
            rate,
            shouldCorrectPitch: true,
          },
          onStatus
        );

        // The row is gone — tapping play then navigating straight back is the
        // common path here. Nothing will ever unload this handle if we store it,
        // so drop it now; that is the voice note that plays until app restart.
        if (!mountedRef.current) {
          loadingRef.current = false;
          await sound.unloadAsync().catch(() => {});
          return;
        }

        soundRef.current = sound;
        loadingRef.current = false;
        setLoading(false);
      } else {
        await soundRef.current.playAsync();
      }

      if (!mountedRef.current) return;

      setPlaying(true);
      activeSound = {
        id: messageId,
        // Guarded because another player can call this after *this* row has
        // unmounted — the owner is only cleared on its own cleanup.
        stop: async () => {
          await soundRef.current?.pauseAsync().catch(() => {});
          if (mountedRef.current) setPlaying(false);
        },
      };
    } catch (e) {
      console.warn('[Flyer/audio] playback failed', e);
      loadingRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setPlaying(false);
      }
    }
  };

  /**
   * Cycles 1× → 1.5× → 2× → 1×.
   *
   * `shouldCorrectPitch` matters more than the speed itself: without it a voice
   * at 2× is a chipmunk, which is unusable for the thing people actually speed
   * up — someone talking.
   */
  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length];
    setRate(next);
    preferredRate = next;
    soundRef.current?.setRateAsync(next, true).catch((e) => {
      console.warn('[Flyer/audio] rate change failed', e);
    });
  };

  const progress = totalMs > 0 ? Math.min(1, positionMs / totalMs) : 0;
  const playedBars = Math.round(progress * BAR_COUNT);
  const remaining = totalMs > 0 ? totalMs - positionMs : (durationMs ?? 0);

  return (
    <View style={styles.row}>
      <Pressable
        onPress={toggle}
        round={38}
        style={styles.playButton}
        accessibilityLabel={playing ? 'Pause voice note' : 'Play voice note'}
        accessibilityState={{ busy: loading, disabled: loading }}
      >
        <Icon
          name={loading ? 'clock' : playing ? 'pause' : 'play'}
          size={loading ? 16 : 18}
          color={tint}
        />
      </Pressable>

      <View style={styles.waveform}>
        {bars.map((height, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                height: Math.max(3, height * 22),
                backgroundColor: i < playedBars ? tint : trackColor,
              },
            ]}
          />
        ))}
      </View>

      <Text style={[styles.time, { color: theme.colors.textMuted }]}>
        {formatDuration(playing || positionMs > 0 ? remaining : (durationMs ?? 0))}
      </Text>

      {/* Only once the note has been started: an untouched bubble showing a
          speed control is clutter, and there is nothing to apply it to yet. */}
      {playing || positionMs > 0 ? (
        <Pressable
          onPress={cycleRate}
          haptic
          accessibilityLabel={`Playback speed ${rate}×, tap to change`}
          style={[styles.ratePill, { backgroundColor: trackColor }]}
        >
          <Text style={[styles.rateLabel, { color: tint }]}>{rate}×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minWidth: 210, gap: 4 },
  playButton: { backgroundColor: 'transparent' },
  waveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 26,
  },
  bar: { flex: 1, borderRadius: 2, minWidth: 2 },
  time: { fontSize: 11, minWidth: 34, textAlign: 'right' },
  ratePill: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    marginLeft: 2,
  },
  rateLabel: { fontSize: 11, fontWeight: '700' },
});

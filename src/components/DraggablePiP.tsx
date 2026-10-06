import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The small self-view on a video call.
 *
 * Two behaviours make this feel native rather than like a positioned div:
 * the tile follows the finger and then *snaps to the nearest corner* instead of
 * staying wherever it was dropped, and a tap swaps which stream is fullscreen.
 * Free positioning looks like a bug on a phone — every native calling app
 * corner-snaps, because a tile half off the edge is never what was intended.
 *
 * Uses RN's `Animated` with `runOnJS(true)`, matching SwipeableRow: the drag is
 * short and cheap, and mixing a second animation runtime into this screen for
 * one tile is not a trade worth making.
 */

const MARGIN = 12;

interface Props {
  children: React.ReactNode;
  width: number;
  height: number;
  /** Tap handler — used to swap the local and remote feeds. */
  onPress?: () => void;
  /** Extra top clearance so the tile never lands under the call header. */
  topInset?: number;
  /** Extra bottom clearance so it never lands under the control bar. */
  bottomInset?: number;
  style?: React.ComponentProps<typeof View>['style'];
}

export function DraggablePiP({
  children,
  width,
  height,
  onPress,
  topInset = 0,
  bottomInset = 0,
  style,
}: Props) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // The four resting positions, in absolute layout coordinates.
  const corners = useMemo(() => {
    const left = MARGIN;
    const right = Math.max(MARGIN, screenW - width - MARGIN);
    const top = insets.top + MARGIN + topInset;
    const bottom = Math.max(top, screenH - insets.bottom - height - MARGIN - bottomInset);

    return [
      { x: right, y: top },
      { x: left, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
  }, [screenW, screenH, width, height, insets.top, insets.bottom, topInset, bottomInset]);

  // Top-right is the default, the same corner WhatsApp opens on.
  const home = corners[0];

  const position = useRef(new Animated.ValueXY({ x: home.x, y: home.y })).current;
  // The committed corner. `position` is mid-flight during a drag, so the
  // gesture needs its own record of where it started from.
  const settled = useRef({ x: home.x, y: home.y });
  const dragged = useRef(false);

  // Corners move with rotation and insets; without this a rotated tile keeps
  // its portrait coordinates and can end up half off-screen. Skipped mid-drag
  // so a rotation does not yank the tile out from under the finger.
  useEffect(() => {
    if (dragged.current) return;
    position.setValue(corners[0]);
    settled.current = corners[0];
  }, [corners, position]);

  const snap = useCallback(
    (x: number, y: number) => {
      // Nearest by squared distance — no need for the square root.
      let best = corners[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of corners) {
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }

      settled.current = best;
      Animated.spring(position, {
        toValue: best,
        useNativeDriver: true,
        speed: 18,
        bounciness: 6,
      }).start();
    },
    [corners, position]
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(4)
        .onStart(() => {
          dragged.current = false;
        })
        .onUpdate((event) => {
          if (!dragged.current && Math.hypot(event.translationX, event.translationY) > 6) {
            dragged.current = true;
          }

          // Clamped to the screen so the tile cannot be flung out of reach.
          const x = settled.current.x + event.translationX;
          const y = settled.current.y + event.translationY;
          position.setValue({
            x: Math.max(MARGIN, Math.min(x, screenW - width - MARGIN)),
            y: Math.max(insets.top, Math.min(y, screenH - insets.bottom - height)),
          });
        })
        .onEnd((event) => {
          // Project the throw a little so a flick carries to the corner the
          // user was heading for, not the one they happened to release over.
          const x = settled.current.x + event.translationX + event.velocityX * 0.06;
          const y = settled.current.y + event.translationY + event.velocityY * 0.06;

          if (dragged.current) Haptics.selectionAsync().catch(() => {});
          snap(x, y);
        })
        .runOnJS(true),
    [position, snap, screenW, screenH, width, height, insets.top, insets.bottom]
  );

  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(260)
        .onEnd((_e, success) => {
          // `dragged` guards the case where a drag ends inside the tap's time
          // window, which would otherwise swap the feeds on every short flick.
          if (success && !dragged.current) onPress?.();
        })
        .runOnJS(true),
    [onPress]
  );

  // Simultaneous rather than exclusive: the tap only fires when the pan did not
  // move, and this way a slow press-and-drag is not swallowed by the tap.
  const gesture = useMemo(() => Gesture.Simultaneous(pan, tap), [pan, tap]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[
          styles.tile,
          { width, height },
          style,
          { transform: position.getTranslateTransform() },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Your camera. Drag to move, tap to swap views."
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  tile: {
    position: 'absolute',
    top: 0,
    left: 0,
    overflow: 'hidden',
    zIndex: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
});

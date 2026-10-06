import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTheme } from '@/src/theme/ThemeProvider';

const DOT_COUNT = 3;
const STEP_MS = 180;
const CYCLE_MS = 900;

/**
 * "Peer is typing" bubble.
 *
 * One Animated.Value per dot driven by a looped sequence with a per-dot delay,
 * which keeps the whole animation on the native driver — a JS-driven loop stutters
 * badly while the message list is settling after a new message arrives.
 */
export function TypingIndicator() {
  const theme = useTheme();
  const dots = useRef(
    Array.from({ length: DOT_COUNT }, () => new Animated.Value(0))
  ).current;

  useEffect(() => {
    const animations = dots.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * STEP_MS),
          Animated.timing(value, {
            toValue: 1,
            duration: 300,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: 300,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.delay(CYCLE_MS - 600 - index * STEP_MS),
        ])
      )
    );

    for (const animation of animations) animation.start();

    return () => {
      for (const animation of animations) animation.stop();
      for (const value of dots) value.setValue(0);
    };
  }, [dots]);

  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel="Typing"
    >
      <View style={[styles.bubble, { backgroundColor: theme.colors.bubbleIn }]}>
        {dots.map((value, index) => (
          <Animated.View
            key={index}
            style={[
              styles.dot,
              {
                backgroundColor: theme.colors.textMuted,
                opacity: value.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.35, 1],
                }),
                transform: [
                  {
                    translateY: value.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -4],
                    }),
                  },
                ],
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'flex-start', paddingHorizontal: 8, marginVertical: 3 },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 12,
    borderBottomLeftRadius: 3,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
});

import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useTheme } from '@/src/theme/ThemeProvider';
import { useAppStore } from '@/src/services/StateManager';
import { onListenerError } from '@/src/services/FirebaseService';

const STRIP_HEIGHT = 26;
/** White reads on the danger fill; the warning fill takes dark `onWarning`. */
const ON_FILL = 'rgba(255,255,255,0.95)';

/**
 * Thin connectivity strip. Sits above the content, collapses to zero height
 * when there is nothing to report.
 */
export function NetworkBanner() {
  const theme = useTheme();
  const status = useAppStore((s) => s.networkStatus);
  const pendingCount = useAppStore((s) => s.pendingCount);

  /**
   * A cancelled RTDB listener is the one failure mode with no other symptom.
   * The database fires the error callback once and drops the subscription for
   * good — no retry, no reconnect — so the screen keeps rendering whatever it
   * last had and simply never updates again. That is indistinguishable from a
   * quiet chat, which is why this was previously invisible: `onListenerError`
   * had no subscribers at all. Surfacing it here at least tells the user the
   * data is stale, and restarting the app rebuilds the listeners.
   */
  const [listenerFailed, setListenerFailed] = useState(false);

  useEffect(() => onListenerError(() => setListenerFailed(true)), []);

  // A reconnect rebuilds every listener, so the stale state clears with it.
  useEffect(() => {
    if (status === 'online') setListenerFailed(false);
  }, [status]);

  const visible = status !== 'online' || pendingCount > 0 || listenerFailed;

  const height = useRef(new Animated.Value(visible ? STRIP_HEIGHT : 0)).current;
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    Animated.parallel([
      // Height cannot use the native driver; opacity can, but they must run on
      // the same driver to stay in step, so both are on the JS driver here.
      Animated.timing(height, {
        toValue: visible ? STRIP_HEIGHT : 0,
        duration: 200,
        useNativeDriver: false,
      }),
      Animated.timing(opacity, {
        toValue: visible ? 1 : 0,
        duration: 200,
        useNativeDriver: false,
      }),
    ]).start();
  }, [visible, height, opacity]);

  const { background, color, message } = (() => {
    if (status === 'offline') {
      return {
        background: theme.colors.danger,
        color: ON_FILL,
        message: 'No internet connection',
      };
    }
    if (status === 'reconnecting') {
      return {
        background: theme.colors.warning,
        color: theme.colors.onWarning,
        message: 'Connecting…',
      };
    }
    // Ranked below the connectivity states: those explain the staleness on their
    // own, and this message would only add noise while offline.
    if (listenerFailed) {
      return {
        background: theme.colors.warning,
        color: theme.colors.onWarning,
        message: 'Not up to date — restart Flyer to refresh',
      };
    }
    return {
      background: theme.colors.surfaceAlt,
      color: theme.colors.textMuted,
      message: `${pendingCount} message${pendingCount === 1 ? '' : 's'} waiting to send`,
    };
  })();

  return (
    <Animated.View
      style={[styles.strip, { height, opacity, backgroundColor: background }]}
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.text, { color }]} numberOfLines={1}>
        {message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  strip: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  text: { fontSize: 12, fontWeight: '600' },
});

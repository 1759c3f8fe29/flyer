import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Pressable } from './Pressable';
import { Icon } from './Icon';

export interface BannerPayload {
  chatId: string;
  senderId: string;
  title: string;
  body: string;
  /** Distinguishes two identical texts from the same sender (see `key`). */
  messageId?: string;
}

interface Props {
  banner: BannerPayload | null;
  onPress: () => void;
  onDismiss: () => void;
}

const HIDDEN_OFFSET = -160;
const AUTO_DISMISS_MS = 4000;

/** In-app heads-up notification for messages that arrive while Flyer is open. */
export function Banner({ banner, onPress, onDismiss }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(HIDDEN_OFFSET)).current;

  // Keyed on identity, not content: two "ok" texts from the same sender used
  // to share a key, so the second inherited the first toast's remaining timer
  // and never re-animated.
  const key = banner
    ? `${banner.chatId}:${banner.senderId}:${banner.messageId ?? banner.title}:${banner.body}`
    : null;

  /**
   * Always call the newest `onDismiss`, without letting its identity re-arm the
   * timer. The parent re-creates this callback on most renders, so listing it as
   * a dependency would restart the 4s countdown each time and a chatty app would
   * keep the banner up indefinitely. Omitting it instead captures the callback
   * from the render that set the key, which goes stale. A ref sidesteps both:
   * the effect stays keyed on the message alone, and the timer fires whatever
   * handler is current when it actually elapses.
   */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!key) {
      Animated.timing(translateY, {
        toValue: HIDDEN_OFFSET,
        duration: 180,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start();
      return;
    }

    translateY.setValue(HIDDEN_OFFSET);
    Animated.timing(translateY, {
      toValue: 0,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    const timer = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [key, translateY]);

  if (!banner) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          top: 0,
          left: theme.spacing(3),
          right: theme.spacing(3),
          marginTop: insets.top + theme.spacing(2),
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.lg,
          paddingLeft: theme.spacing(4),
          paddingRight: theme.spacing(2),
          transform: [{ translateY }],
        },
      ]}
    >
      <Pressable
        onPress={onPress}
        style={[styles.tap, { paddingVertical: theme.spacing(3) }]}
        accessibilityRole="button"
        accessibilityLabel={`${banner.title}: ${banner.body}`}
      >
        <View style={styles.copy}>
          <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
            {banner.title}
          </Text>
          <Text
            style={[
              styles.body,
              { color: theme.colors.textMuted, marginTop: theme.spacing(0.5) },
            ]}
            numberOfLines={2}
          >
            {banner.body}
          </Text>
        </View>
      </Pressable>

      <Pressable
        onPress={onDismiss}
        round={36}
        accessibilityRole="button"
        accessibilityLabel="Dismiss notification"
      >
        <Icon name="close" size={16} color={theme.colors.textMuted} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    zIndex: 950,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  tap: { flex: 1 },
  copy: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 19 },
});

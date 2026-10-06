import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Message } from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';
import {
  fetchSuggestions,
  isSmartReplyEnabledForChat,
  subscribeSmartReplyForChat,
} from '@/src/services/SmartReplyService';
import { Pressable } from './Pressable';

interface Props {
  chatId: string;
  messages: Message[];
  myUid: string;
  onPick: (text: string) => void;
}

const MAX_SUGGESTIONS = 3;

/**
 * AI-generated quick replies.
 *
 * Every failure path here renders nothing rather than surfacing an error: the
 * suggestions are a convenience, and a model hiccup must never interrupt the
 * conversation. Fetches are keyed on the newest message id so re-renders from
 * typing state or presence updates do not re-hit the service.
 */
export function SmartReplyBar({ chatId, messages, myUid, onPick }: Props) {
  const theme = useTheme();
  const [enabled, setEnabled] = useState(() => isSmartReplyEnabledForChat(chatId));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => subscribeSmartReplyForChat(chatId, setEnabled), [chatId]);

  const newest = messages.length > 0 ? messages[messages.length - 1] : null;
  // Only offer replies to something the peer actually said.
  const shouldSuggest =
    enabled && Boolean(newest) && newest!.senderId !== myUid && !newest!.deleted;
  const triggerId = shouldSuggest ? newest!.id : null;

  const requestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!triggerId) {
      requestedFor.current = null;
      setSuggestions([]);
      setLoading(false);
      return;
    }
    if (requestedFor.current === triggerId) return;

    requestedFor.current = triggerId;
    let cancelled = false;
    setSuggestions([]);
    setLoading(true);

    fetchSuggestions(chatId, messages, myUid)
      .then((result) => {
        if (cancelled) return;
        setSuggestions(
          result
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            // De-duplicated: duplicate strings would share a React key and the
            // reconciler would drop or mis-wire a chip.
            .filter((s, i, all) => all.indexOf(s) === i)
            .slice(0, MAX_SUGGESTIONS)
        );
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `messages` is intentionally excluded: the fetch is keyed on the newest
    // message id, and depending on the array would refire on every seen-receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerId, chatId, myUid]);

  if (!shouldSuggest) return null;
  if (!loading && suggestions.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={[styles.aiChip, { backgroundColor: theme.colors.accentDim }]}>
        <Text style={[styles.aiLabel, { color: theme.colors.accent }]}>AI</Text>
      </View>

      {loading ? (
        <ShimmerRow />
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.chips}
        >
          {suggestions.map((suggestion, index) => (
            <Pressable
              key={`${index}:${suggestion}`}
              onPress={() => onPick(suggestion)}
              haptic
              accessibilityRole="button"
              accessibilityLabel={`Send suggested reply: ${suggestion}`}
              style={[styles.chip, { backgroundColor: theme.colors.accentDim }]}
            >
              {/* Full width, no truncation: the row scrolls horizontally, so a
                  capped chip shows "Sounds gre…" while tapping it sends the
                  whole sentence — the preview must be the payload. */}
              <Text style={[styles.chipText, { color: theme.colors.accent }]}>
                {suggestion}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const PLACEHOLDER_WIDTHS = [96, 128, 72];

/** Pulsing placeholders so the bar does not pop in without warning. */
function ShimmerRow() {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 620,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 620,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.8] });

  return (
    <View style={styles.chips}>
      {PLACEHOLDER_WIDTHS.map((width) => (
        <Animated.View
          key={width}
          style={[
            styles.chip,
            styles.placeholder,
            { width, backgroundColor: theme.colors.surfaceAlt, opacity },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  aiChip: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  aiLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: { fontSize: 14, fontWeight: '500' },
  placeholder: { height: 33 },
});

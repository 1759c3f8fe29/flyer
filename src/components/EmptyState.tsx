import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Icon, type IconName } from './Icon';
import { Pressable } from './Pressable';

interface Props {
  icon: IconName;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** Centred placeholder for empty lists and no-result states. */
export function EmptyState({ icon, title, body, actionLabel, onAction }: Props) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <View style={[styles.iconCircle, { backgroundColor: theme.colors.surfaceAlt }]}>
        <Icon name={icon} size={32} color={theme.colors.textMuted} />
      </View>

      <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>

      {body ? (
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>{body}</Text>
      ) : null}

      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          haptic
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={[styles.action, { backgroundColor: theme.colors.accent }]}
        >
          <Text style={[styles.actionLabel, { color: theme.colors.accentText }]}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    paddingVertical: 48,
  },
  iconCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  action: {
    marginTop: 22,
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  actionLabel: { fontSize: 15, fontWeight: '600' },
});

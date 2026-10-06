import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Pressable } from './Pressable';
import { Icon, type IconName } from './Icon';

interface Props {
  icon?: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  destructive?: boolean;
  showChevron?: boolean;
}

/**
 * Reusable row for settings and profile screens. Single style, no forks for
 * variant—every row looks the same except for its content and colour.
 */
export function ListRow({
  icon,
  title,
  subtitle,
  value,
  onPress,
  right,
  destructive,
  showChevron,
}: Props) {
  const theme = useTheme();
  const interactive = Boolean(onPress);

  const content = (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.colors.bg, borderBottomColor: theme.colors.border },
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={20}
          color={destructive ? theme.colors.danger : theme.colors.textMuted}
          style={styles.icon}
        />
      ) : null}

      <View style={styles.middle}>
        <Text
          style={[
            styles.title,
            { color: destructive ? theme.colors.danger : theme.colors.text },
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {value ? (
        <Text style={[styles.value, { color: theme.colors.textMuted }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}

      {right ? <View style={styles.rightSlot}>{right}</View> : null}

      {showChevron && !right ? (
        <Icon name="chevron" size={18} color={theme.colors.textMuted} style={styles.chevron} />
      ) : null}
    </View>
  );

  if (!interactive) return content;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, value ?? subtitle].filter(Boolean).join(', ')}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icon: { marginRight: 14 },
  middle: { flex: 1 },
  title: { fontSize: 16, fontWeight: '400', marginBottom: 2 },
  subtitle: { fontSize: 13, marginTop: 2 },
  value: { fontSize: 15, marginLeft: 8 },
  rightSlot: { marginLeft: 12 },
  chevron: { marginLeft: 8 },
});

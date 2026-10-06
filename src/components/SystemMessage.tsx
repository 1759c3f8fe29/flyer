import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SystemEvent } from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';

interface Props {
  event: SystemEvent | null;
  /** Resolves a uid to a display name. Falls back to "Someone" when unknown. */
  nameOf: (uid: string) => string;
  myUid: string;
}

/**
 * Builds the label from the stored event rather than reading frozen text.
 *
 * This is the reason `event` is structured data on the message: names change,
 * and the reader is not necessarily the person who triggered it. "You added Ben"
 * and "Ana added you" are the same row seen from two sides.
 */
export function systemLabel(
  event: SystemEvent | null,
  nameOf: (uid: string) => string,
  myUid: string
): string {
  if (!event) return '';
  const who = (uid: string) => (uid === myUid ? 'You' : nameOf(uid));
  const whom = (uid: string) => (uid === myUid ? 'you' : nameOf(uid));

  switch (event.kind) {
    case 'group_created':
      return `${who(event.by)} created this group`;
    case 'members_added': {
      const names = event.uids.map(whom);
      const list =
        names.length <= 1
          ? (names[0] ?? 'someone')
          : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return `${who(event.by)} added ${list}`;
    }
    case 'member_removed':
      return `${who(event.by)} removed ${whom(event.uid)}`;
    case 'member_left':
      return `${who(event.uid)} left`;
    case 'group_renamed':
      return `${who(event.by)} changed the group name to "${event.name}"`;
    case 'group_photo_changed':
      return `${who(event.by)} changed the group photo`;
    case 'admin_granted':
      // Subject position takes `who` ("You are…"), not `whom` ("you are…").
      return `${who(event.uid)} ${event.uid === myUid ? 'are' : 'is'} now an admin`;
    case 'admin_revoked':
      return `${who(event.uid)} ${event.uid === myUid ? 'are' : 'is'} no longer an admin`;
    default:
      return '';
  }
}

/** Centred pill, not a bubble: nobody said this, so it has no side. */
export function SystemMessage({ event, nameOf, myUid }: Props) {
  const theme = useTheme();
  const label = systemLabel(event, nameOf, myUid);
  if (!label) return null;

  return (
    <View style={styles.row}>
      <View style={[styles.pill, { backgroundColor: theme.colors.surfaceAlt }]}>
        <Text style={[styles.text, { color: theme.colors.textMuted }]}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', paddingHorizontal: 32, paddingVertical: 5 },
  pill: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  text: { fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
});

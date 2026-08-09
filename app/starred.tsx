import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageType, StarredRef, UserProfile } from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Icon } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { alertError, confirm } from '@/src/components/Confirm';
import { Paths, readOnce } from '@/src/services/FirebaseService';
import {
  dayLabel,
  formatClock,
  listenToStarred,
  previewFor,
  toggleStar,
} from '@/src/services/ChatEngine';
import { appState, useAppStore } from '@/src/services/StateManager';

interface StarredItem {
  key: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  type: MessageType;
  text: string | null;
  mediaUrl: string | null;
  timestamp: number;
  starredAt: number;
}

/** Resolves a display name, caching the profile so later rows are free. */
async function resolveSenderName(senderId: string, myUid: string | null): Promise<string> {
  if (senderId === myUid) return 'You';

  const cached = appState.get().users[senderId];
  if (cached?.name) return cached.name;

  const profile = await readOnce<UserProfile>(Paths.user(senderId)).catch(() => null);
  if (!profile) return 'Unknown';

  appState.get().cacheUser({ ...profile, uid: senderId });
  return profile.name ?? 'Unknown';
}

export default function StarredScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const myUid = useAppStore((s) => s.currentUser?.uid) ?? null;

  const [items, setItems] = useState<StarredItem[]>([]);
  const [loading, setLoading] = useState(true);

  const hydrate = useCallback(
    async (refs: StarredRef[]): Promise<StarredItem[]> => {
      const resolved = await Promise.all(
        refs.map(async (starRef) => {
          const raw = await readOnce<Record<string, unknown>>(
            Paths.message(starRef.chatId, starRef.messageId)
          ).catch(() => null);

          // Deleted or unreadable (chat left) — drop it rather than showing a stub.
          if (!raw || raw.deleted === true) return null;

          const senderId = String(raw.senderId ?? '');
          const item: StarredItem = {
            key: starRef.key,
            chatId: starRef.chatId,
            messageId: starRef.messageId,
            senderId,
            senderName: await resolveSenderName(senderId, myUid),
            type: (raw.type as MessageType) ?? 'text',
            text: (raw.text as string | null) ?? null,
            mediaUrl: (raw.mediaUrl as string | null) ?? null,
            timestamp: (raw.timestamp as number) ?? starRef.starredAt,
            starredAt: starRef.starredAt,
          };
          return item;
        })
      );

      return resolved.filter((item): item is StarredItem => item !== null);
    },
    [myUid]
  );

  useEffect(() => {
    if (!myUid) return;
    let alive = true;

    // Late callbacks from a superseded snapshot would clobber newer data.
    let generation = 0;

    const off = listenToStarred(myUid, (refs) => {
      const mine = ++generation;
      hydrate(refs)
        .then((list) => {
          if (!alive || mine !== generation) return;
          setItems(list);
        })
        .catch((e) => console.warn('[Flyer/starred] hydrate failed', e))
        .finally(() => {
          if (alive && mine === generation) setLoading(false);
        });
    });

    return () => {
      alive = false;
      off();
    };
  }, [myUid, hydrate]);

  const unstar = useCallback(
    async (item: StarredItem) => {
      if (!myUid) return;
      const ok = await confirm({
        title: 'Remove star?',
        message: 'This message will no longer appear in your starred list.',
        confirmLabel: 'Unstar',
      });
      if (!ok) return;

      try {
        await toggleStar(myUid, item.chatId, item.messageId);
      } catch (e) {
        console.warn('[Flyer/starred] unstar failed', e);
        alertError('Could not remove star', 'Please try again.');
      }
    },
    [myUid]
  );

  const renderItem = useCallback(
    ({ item }: { item: StarredItem }) => (
      <Pressable
        // The message id was already here; until the chat screen accepted a
        // target it had nowhere to go, so tapping a starred message dropped you
        // at the bottom of the thread to find it yourself.
        onPress={() => router.push(`/chat/${item.chatId}?jumpTo=${item.messageId}`)}
        onLongPress={() => void unstar(item)}
        accessibilityRole="button"
        accessibilityLabel={`Message from ${item.senderName}. Long press to unstar.`}
        style={[styles.row, { borderBottomColor: theme.colors.border }]}
      >
        <View style={styles.rowTop}>
          <Icon name="star" size={14} color={theme.colors.warning} />
          <Text style={[styles.sender, { color: theme.colors.text }]} numberOfLines={1}>
            {item.senderName}
          </Text>
          <Text style={[styles.date, { color: theme.colors.textFaint }]}>
            {dayLabel(item.timestamp)}, {formatClock(item.timestamp)}
          </Text>
        </View>

        <Text style={[styles.preview, { color: theme.colors.textMuted }]} numberOfLines={2}>
          {previewFor(item.type, item.text)}
        </Text>
      </Pressable>
    ),
    [router, unstar, theme]
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <View
        style={[
          styles.header,
          { backgroundColor: theme.colors.header, paddingTop: insets.top + 8 },
        ]}
      >
        <Pressable
          round={40}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={30} color="#FFFFFF" />
        </Pressable>
        <Text style={styles.headerTitle}>Starred messages</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Icon name="star" size={52} color={theme.colors.textFaint} />
          <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
            No starred messages
          </Text>
          <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
            Long-press any message in a chat and tap the star to keep it here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 6,
    paddingBottom: 10,
  },
  headerTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '600', marginLeft: 4 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 44,
  },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 72,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sender: { flex: 1, fontSize: 15, fontWeight: '600' },
  date: { fontSize: 12 },
  preview: { fontSize: 14, marginTop: 6, lineHeight: 20 },
});

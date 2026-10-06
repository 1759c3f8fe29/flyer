import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, BackHandler, FlatList, StyleSheet, Text, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Avatar } from '@/src/components/Avatar';
import { Icon, type IconName } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { useAppStore } from '@/src/services/StateManager';
import { CallManager } from '@/src/services/CallManager';
import { listenToUser } from '@/src/services/ChatEngine';
import {
  clearCallHistory,
  deleteCallHistoryEntry,
  listenToCallHistory,
} from '@/src/services/CallHistoryService';
import type { CallHistoryEntry, CallType, UserProfile } from '@/src/config/types';

/** mm:ss (or h:mm:ss) from a completed call's duration. */
function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function relativeDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;

  const withinWeek = now.getTime() - ts < 7 * 24 * 60 * 60 * 1000;
  if (withinWeek) {
    return `${d.toLocaleDateString(undefined, { weekday: 'long' })}, ${time}`;
  }

  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function directionIcon(entry: CallHistoryEntry): IconName {
  if (entry.missed) return 'missedCall';
  return entry.direction === 'incoming' ? 'incomingCall' : 'outgoingCall';
}

function detailLine(entry: CallHistoryEntry): string {
  const when = relativeDate(entry.startedAt);
  if (entry.missed) {
    const label = entry.state === 'rejected' ? 'Declined' : 'Missed';
    return `${label} · ${when}`;
  }
  if (entry.durationMs > 0) return `${when} · ${formatDuration(entry.durationMs)}`;
  return when;
}

interface RowProps {
  entry: CallHistoryEntry;
  peer: UserProfile | undefined;
  onCall: (peer: UserProfile, type: CallType) => void;
  onDelete: (entry: CallHistoryEntry) => void;
}

function CallRow({ entry, peer, onCall, onDelete }: RowProps) {
  const theme = useTheme();
  const name = peer?.name ?? 'Unknown';
  const tint = entry.missed ? theme.colors.danger : theme.colors.text;

  // Starting a call needs a full profile (CallManager writes the callee's name
  // and handle into the invite); fall back to a minimal one if it has not
  // loaded, rather than disabling the button.
  const target: UserProfile = peer ?? ({ uid: entry.peerId, name } as UserProfile);

  return (
    <Pressable
      onLongPress={() => onDelete(entry)}
      accessibilityLabel={`Call with ${name}. ${detailLine(entry)}`}
      style={[
        styles.row,
        { paddingHorizontal: theme.spacing(4), paddingVertical: theme.spacing(3) },
      ]}
    >
      <Avatar
        uri={peer?.photoURL ?? null}
        name={name}
        uid={entry.peerId}
        size={48}
        showPhoto={peer?.privacy?.showPhoto ?? true}
      />

      <View style={[styles.rowBody, { marginLeft: theme.spacing(3) }]}>
        <Text style={[styles.rowName, { color: tint }]} numberOfLines={1}>
          {name}
        </Text>

        <View style={[styles.rowDetail, { marginTop: theme.spacing(1) }]}>
          <Icon
            name={directionIcon(entry)}
            size={14}
            color={entry.missed ? theme.colors.danger : theme.colors.textMuted}
          />
          <Text
            style={[
              styles.rowDetailText,
              { color: entry.missed ? theme.colors.danger : theme.colors.textMuted },
            ]}
            numberOfLines={1}
          >
            {detailLine(entry)}
          </Text>
        </View>
      </View>

      <Pressable
        onPress={() => onCall(target, 'voice')}
        round={40}
        accessibilityLabel={`Voice call ${name}`}
      >
        <Icon name="phone" size={20} color={theme.colors.accent} />
      </Pressable>

      <Pressable
        onPress={() => onCall(target, 'video')}
        round={40}
        accessibilityLabel={`Video call ${name}`}
      >
        <Icon name="video" size={20} color={theme.colors.accent} />
      </Pressable>
    </Pressable>
  );
}

export default function CallsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const myUid = useAppStore((s) => s.currentUser?.uid);
  const users = useAppStore((s) => s.users);

  const [entries, setEntries] = useState<CallHistoryEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  // Hardware back dismisses the overflow menu rather than the tab — the chat
  // screen's identical menu does this, and this one was missed.
  useEffect(() => {
    if (!menuOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMenuOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [menuOpen]);

  useEffect(() => {
    if (!myUid) return;
    return listenToCallHistory(myUid, setEntries);
  }, [myUid]);

  // Profiles are not denormalised into history entries, so resolve each distinct
  // peer once and let the store cache serve every row that references it.
  const peerIds = useMemo(
    () => Array.from(new Set(entries.map((e) => e.peerId))).filter(Boolean),
    [entries]
  );

  // Depend on the *contents*, not the array identity. `peerIds` is a fresh array
  // on every history snapshot, so a reference dep would tear down and re-attach
  // every profile listener each time any call row changed — including the common
  // case where the same people are involved and nothing about the set moved.
  const peerKey = peerIds.join(',');

  useEffect(() => {
    const offs = peerIds.map((uid) => listenToUser(uid));
    return () => {
      for (const off of offs) off();
    };
    // `peerKey` is the checkable stand-in for `peerIds`: same contents, same
    // string, so the listeners are rebuilt exactly when the peer set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerKey]);

  const startCall = useCallback(async (peer: UserProfile, type: CallType) => {
    const started = await CallManager.startCall(peer, type);
    if (started) router.push('/call');
  }, []);

  const confirmDelete = useCallback(
    (entry: CallHistoryEntry) => {
      if (!myUid) return;
      Alert.alert('Delete this call?', 'It will be removed from your call log.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteCallHistoryEntry(myUid, entry.callId).catch(() => {
              Alert.alert('Could not delete', 'Please try again.');
            });
          },
        },
      ]);
    },
    [myUid]
  );

  const confirmClear = useCallback(() => {
    setMenuOpen(false);
    if (!myUid) return;
    Alert.alert('Clear call log?', 'This deletes your entire call history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          clearCallHistory(myUid).catch(() => {
            Alert.alert('Could not clear the log', 'Please try again.');
          });
        },
      },
    ]);
  }, [myUid]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + theme.spacing(2),
            paddingHorizontal: theme.spacing(4),
            paddingBottom: theme.spacing(3),
            backgroundColor: theme.colors.header,
          },
        ]}
      >
        <Text style={[styles.headerTitle, { color: theme.colors.accentText }]}>Calls</Text>

        <Pressable
          onPress={() => setMenuOpen((v) => !v)}
          round={40}
          accessibilityLabel="More options"
        >
          <Icon name="more" size={22} color={theme.colors.accentText} />
        </Pressable>
      </View>

      {menuOpen ? (
        <>
          {/* Full-screen catcher so a tap anywhere dismisses the menu. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setMenuOpen(false)}
            accessibilityLabel="Close menu"
          />
          <View
            style={[
              styles.menu,
              {
                top: insets.top + theme.spacing(12),
                right: theme.spacing(4),
                backgroundColor: theme.colors.bgElevated,
                borderRadius: theme.radius.md,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Pressable
              onPress={confirmClear}
              style={{
                paddingHorizontal: theme.spacing(4),
                paddingVertical: theme.spacing(3),
              }}
              accessibilityLabel="Clear call log"
            >
              <Text style={{ color: theme.colors.text, fontSize: theme.font.body }}>
                Clear call log
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}

      <FlatList
        data={entries}
        keyExtractor={(item) => item.callId}
        renderItem={({ item }) => (
          <CallRow
            entry={item}
            peer={users[item.peerId]}
            onCall={startCall}
            onDelete={confirmDelete}
          />
        )}
        ItemSeparatorComponent={() => (
          <View
            style={[
              styles.separator,
              { backgroundColor: theme.colors.border, marginLeft: theme.spacing(18) },
            ]}
          />
        )}
        contentContainerStyle={
          entries.length === 0 ? styles.emptyContainer : { paddingBottom: insets.bottom }
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="phone" size={44} color={theme.colors.textFaint} />
            <Text
              style={[
                styles.emptyTitle,
                { color: theme.colors.text, marginTop: theme.spacing(4) },
              ]}
            >
              No calls yet
            </Text>
            <Text
              style={[
                styles.emptyBody,
                { color: theme.colors.textMuted, marginTop: theme.spacing(2) },
              ]}
            >
              Voice and video calls you make or receive will appear here.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { fontSize: 22, fontWeight: '700' },
  menu: {
    position: 'absolute',
    minWidth: 180,
    borderWidth: StyleSheet.hairlineWidth,
    zIndex: 10,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBody: { flex: 1 },
  rowName: { fontSize: 17, fontWeight: '600' },
  rowDetail: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowDetailText: { fontSize: 13, flexShrink: 1 },
  separator: { height: StyleSheet.hairlineWidth },
  emptyContainer: { flexGrow: 1 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 48,
  },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyBody: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
});

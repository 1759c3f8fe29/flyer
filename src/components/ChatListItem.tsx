import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ChatSummary, UserProfile } from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';
import { formatClock } from '@/src/services/ChatEngine';
import { selectPeerTyping, useAppStore } from '@/src/services/StateManager';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Pressable } from './Pressable';

interface Props {
  chat: ChatSummary;
  peer: UserProfile | null;
  myUid: string;
  muted: boolean;
  /**
   * Resolves a group member's uid to a name, for the "Ana: hello" preview
   * prefix. Not needed for 1:1 chats, where the sender is unambiguous.
   */
  nameOf?: (uid: string) => string;
  onPress: () => void;
  onLongPress: () => void;
  /**
   * Swipe-action equivalents for assistive tech. Pan gestures do not exist for
   * VoiceOver/TalkBack users, so the wrapping swipe row injects its commit
   * actions here, onto the element that already owns the row's label.
   */
  swipeActions?: { name: string; label: string }[];
  onSwipeAction?: (event: { nativeEvent: { actionName: string } }) => void;
}

/** Today -> clock, this week -> weekday, older -> short date. */
function formatListTime(ts: number): string {
  if (!ts) return '';
  const then = new Date(ts);
  const now = new Date();

  if (then.toDateString() === now.toDateString()) return formatClock(ts);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return 'Yesterday';

  if (now.getTime() - ts < 7 * 24 * 60 * 60 * 1000) {
    return then.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return then.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function ChatListItemImpl({
  chat,
  peer,
  myUid,
  muted,
  nameOf,
  onPress,
  onLongPress,
  swipeActions,
  onSwipeAction,
}: Props) {
  const theme = useTheme();
  const typing = useAppStore(selectPeerTyping(chat.id, myUid));

  const unread = chat.unread?.[myUid] ?? 0;
  const hasUnread = unread > 0;
  const last = chat.lastMessage;
  const outgoing = last?.senderId === myUid;

  // A peer who hides last-seen also hides the presence dot; showing it would leak
  // exactly the signal the setting exists to suppress. Groups have no single
  // presence to show at all.
  const showPresence =
    !chat.isGroup && Boolean(peer?.online) && peer?.privacy?.showLastSeen !== false;

  const name = chat.isGroup ? (chat.name ?? 'Group') : (peer?.name ?? 'Unknown');

  /*
   * Group previews carry the sender's name, because "on my way" from an unnamed
   * someone in a nine-person group is not information. System rows are the
   * exception: their text already names whoever acted.
   */
  const previewPrefix =
    chat.isGroup && last && !last.deleted && last.type !== 'system'
      // Own messages get the tick instead — a prefix on top of it would be
      // saying the same thing twice, which is what WhatsApp avoids here too.
      ? outgoing
        ? ''
        : `${nameOf?.(last.senderId) ?? 'Unknown'}: `
      : '';

  const previewColor = typing
    ? theme.colors.accent
    : hasUnread
      ? theme.colors.text
      : theme.colors.textMuted;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={`${chat.isGroup ? 'Group' : 'Chat with'} ${name}${
        hasUnread ? `, ${unread} unread` : ''
      }`}
      accessibilityActions={swipeActions}
      onAccessibilityAction={onSwipeAction}
      style={styles.row}
    >
      <Avatar
        uri={chat.isGroup ? chat.photoURL : (peer?.photoURL ?? null)}
        name={name}
        uid={chat.isGroup ? chat.id : (peer?.uid ?? chat.id)}
        size={52}
        online={showPresence}
        showPhoto={chat.isGroup || peer?.privacy?.showPhoto !== false}
        group={chat.isGroup}
      />

      <View style={[styles.center, { borderBottomColor: theme.colors.border }]}>
        <View style={styles.topLine}>
          <Text
            style={[styles.name, { color: theme.colors.text }]}
            numberOfLines={1}
          >
            {name}
          </Text>
        </View>

        <View style={styles.bottomLine}>
          {typing ? (
            <Text style={[styles.preview, { color: theme.colors.accent }]} numberOfLines={1}>
              typing…
            </Text>
          ) : last ? (
            <>
              {outgoing && !last.deleted ? (
                <Icon name="check" size={12} color={theme.colors.tick} style={styles.previewTick} />
              ) : null}
              <Text
                style={[
                  styles.preview,
                  last.deleted ? styles.previewDeleted : null,
                  { color: last.deleted ? theme.colors.textFaint : previewColor },
                  hasUnread && !last.deleted ? styles.previewUnread : null,
                ]}
                numberOfLines={1}
              >
                {last.deleted
                  ? 'This message was deleted'
                  : `${previewPrefix}${last.text}`}
              </Text>
            </>
          ) : (
            <Text style={[styles.preview, styles.previewDeleted, { color: theme.colors.textFaint }]}>
              No messages yet
            </Text>
          )}
        </View>
      </View>

      <View style={styles.right}>
        <Text
          style={[
            styles.time,
            { color: hasUnread ? theme.colors.unreadBadge : theme.colors.textFaint },
          ]}
        >
          {formatListTime(chat.lastTimestamp)}
        </Text>

        <View style={styles.rightBottom}>
          {chat.pinned ? (
            <Icon
              name="pin"
              size={14}
              color={theme.colors.textFaint}
              style={styles.pinIcon}
            />
          ) : null}

          {muted ? (
            <Icon
              name="mute"
              size={13}
              color={theme.colors.textFaint}
              style={styles.muteIcon}
            />
          ) : null}

          {hasUnread ? (
            <View style={[styles.badge, { backgroundColor: theme.colors.unreadBadge }]}>
              <Text style={[styles.badgeText, { color: theme.colors.accentText }]}>
                {unread > 99 ? '99+' : unread}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export const ChatListItem = memo(ChatListItemImpl, (prev, next) => {
  // The group preview prefix ("Ana: hello") resolves through `nameOf`, whose
  // identity churns whenever the user cache loads. Comparing the function
  // would re-render every row on each profile fetch; comparing the resolved
  // string re-renders only the rows whose sender actually got a name.
  const prevPrefix = prev.chat.isGroup
    ? (prev.nameOf?.(prev.chat.lastMessage?.senderId ?? '') ?? 'Unknown')
    : '';
  const nextPrefix = next.chat.isGroup
    ? (next.nameOf?.(next.chat.lastMessage?.senderId ?? '') ?? 'Unknown')
    : '';
  return (
    prevPrefix === nextPrefix &&
    prev.chat.id === next.chat.id &&
    prev.chat.lastTimestamp === next.chat.lastTimestamp &&
    prev.chat.lastMessage?.text === next.chat.lastMessage?.text &&
    prev.chat.lastMessage?.type === next.chat.lastMessage?.type &&
    prev.chat.lastMessage?.deleted === next.chat.lastMessage?.deleted &&
    prev.chat.lastMessage?.senderId === next.chat.lastMessage?.senderId &&
    prev.chat.unread?.[prev.myUid] === next.chat.unread?.[next.myUid] &&
    prev.chat.pinned === next.chat.pinned &&
    prev.chat.archived === next.chat.archived &&
    prev.muted === next.muted &&
    prev.myUid === next.myUid &&
    prev.peer?.name === next.peer?.name &&
    prev.peer?.photoURL === next.peer?.photoURL &&
    prev.peer?.online === next.peer?.online &&
    prev.peer?.privacy?.showLastSeen === next.peer?.privacy?.showLastSeen &&
    prev.peer?.privacy?.showPhoto === next.peer?.privacy?.showPhoto &&
    prev.chat.isGroup === next.chat.isGroup &&
    prev.chat.name === next.chat.name &&
    prev.chat.photoURL === next.chat.photoURL
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, minHeight: 74 },
  center: {
    flex: 1,
    marginLeft: 13,
    paddingRight: 8,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  topLine: { flexDirection: 'row', alignItems: 'center' },
  name: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  bottomLine: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  preview: { fontSize: 14, flexShrink: 1 },
  previewUnread: { fontWeight: '500' },
  previewDeleted: { fontStyle: 'italic' },
  previewTick: { marginRight: 4 },
  right: { alignItems: 'flex-end', paddingRight: 14, paddingLeft: 2, minWidth: 58 },
  time: { fontSize: 12 },
  rightBottom: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, minHeight: 20 },
  muteIcon: { opacity: 0.9 },
  pinIcon: { opacity: 0.9 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
});

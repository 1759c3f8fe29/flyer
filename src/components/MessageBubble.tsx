import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import type { Message, UserProfile } from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';
import { formatClock } from '@/src/services/ChatEngine';
import { formatDuration, thumbUrl, videoPoster } from '@/src/services/MediaManager';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { Ticks } from './Ticks';
import { AudioPlayer } from './AudioPlayer';
import { SwipeableRow } from './SwipeableRow';

/**
 * Per-sender name colours for group chats, in the order WhatsApp assigns them.
 * Picked by hashing the uid so a sender keeps the same colour across sessions
 * and devices, without storing anything.
 */
const SENDER_COLORS = [
  '#E8618C',
  '#2E9BE6',
  '#8E7CE0',
  '#E5A33C',
  '#39B6A8',
  '#DE6B4E',
  '#6BAF3F',
  '#C0699E',
];

function senderColor(uid: string): string {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
}

interface Props {
  message: Message;
  mine: boolean;
  peerUid: string | null;
  /**
   * The signed-in uid. Used to label a reply quote "You" vs the author's name.
   * Comparing against `peerUid` instead looks right in a 1:1 chat and is wrong in
   * every group, where `peerUid` is null and so every quote read as "You".
   */
  myUid: string | null;
  /** Every uid that must have read a message before its ticks tint. Groups only. */
  recipients?: string[] | null;
  sender: UserProfile | null;
  /** Author of the quoted message, resolved by the parent from the users map. */
  replyToSender?: UserProfile | null;
  /** True in a group chat: incoming bubbles get the sender's name on top. */
  showSenderName?: boolean;
  showTail: boolean;
  starred: boolean;
  onLongPress: (message: Message) => void;
  /**
   * Overrides the default tap behaviour. Passed while the chat is in selection
   * mode, where a tap must toggle the tick rather than open a photo viewer.
   */
  onPress?: (message: Message) => void;
  onPressMedia: (message: Message) => void;
  onReply: (message: Message) => void;
  onRetry: (message: Message) => void;
  /** Scrolls to the quoted message when the reply header is tapped. */
  onPressReply: (messageId: string) => void;
}

/**
 * One chat bubble.
 *
 * Memoised on the fields that actually affect output — a chat with 40 visible
 * bubbles re-renders on every keystroke otherwise, because the parent's typing
 * state changes.
 */
function MessageBubbleImpl({
  message,
  mine,
  peerUid,
  myUid,
  recipients,
  sender,
  replyToSender,
  showSenderName = false,
  showTail,
  starred,
  onLongPress,
  onPress,
  onPressMedia,
  onReply,
  onRetry,
  onPressReply,
}: Props) {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();

  const bg = mine ? theme.colors.bubbleOut : theme.colors.bubbleIn;
  const fg = mine ? theme.colors.bubbleOutText : theme.colors.bubbleInText;
  const maxWidth = Math.min(screenWidth * 0.78, 420);

  const reactions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const emoji of Object.values(message.reactions ?? {})) {
      counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [message.reactions]);

  // --- deleted ------------------------------------------------------------
  if (message.deleted) {
    return (
      <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
        <View
          style={[
            styles.bubble,
            styles.deletedBubble,
            { backgroundColor: bg, maxWidth, borderColor: theme.colors.border },
          ]}
        >
          <Icon name="block" size={13} color={theme.colors.textFaint} />
          <Text style={[styles.deletedText, { color: theme.colors.textFaint }]}>
            This message was deleted
          </Text>
          <Text style={[styles.time, { color: theme.colors.textFaint }]}>
            {formatClock(message.timestamp)}
          </Text>
        </View>
      </View>
    );
  }

  const mediaWidth = Math.min(maxWidth, 300);
  const aspect =
    message.width && message.height ? message.width / message.height : 4 / 3;
  const mediaHeight = Math.max(120, Math.min(360, mediaWidth / aspect));

  const meta = (
    <View style={styles.metaRow}>
      {message.edited ? (
        <Text style={[styles.edited, { color: theme.colors.textFaint }]}>edited</Text>
      ) : null}
      {starred ? <Icon name="star" size={10} color={theme.colors.textFaint} /> : null}
      <Text style={[styles.time, { color: mine ? theme.colors.textMuted : theme.colors.textFaint }]}>
        {formatClock(message.timestamp)}
      </Text>
      {mine ? (
        <Ticks
          message={message}
          peerUid={peerUid}
          recipients={recipients}
          color={theme.colors.tick}
          seenColor={theme.colors.tickSeen}
        />
      ) : null}
    </View>
  );

  const body = (
    <Pressable
      onLongPress={() => onLongPress(message)}
      onPress={() => {
        if (onPress) {
          onPress(message);
          return;
        }
        if (message.failed) onRetry(message);
        else if (message.type !== 'text' && message.type !== 'audio') onPressMedia(message);
      }}
      delayLongPress={280}
      style={[
        styles.bubble,
        { backgroundColor: bg, maxWidth },
        mine ? styles.bubbleMine : styles.bubbleTheirs,
        showTail ? (mine ? styles.tailMine : styles.tailTheirs) : null,
      ]}
    >
      {/* group sender name — incoming bubbles only, where "who" is ambiguous */}
      {showSenderName && !mine ? (
        <Text
          style={[styles.senderName, { color: senderColor(message.senderId) }]}
          numberOfLines={1}
        >
          {sender?.name ?? 'Unknown'}
        </Text>
      ) : null}

      {/* forwarded marker */}
      {message.forwardedFrom ? (
        <View style={styles.forwarded}>
          <Icon name="forward" size={11} color={theme.colors.textFaint} />
          <Text style={[styles.forwardedText, { color: theme.colors.textFaint }]}>
            Forwarded
          </Text>
        </View>
      ) : null}

      {/* quoted reply */}
      {message.replyTo ? (
        <Pressable
          onPress={() => onPressReply(message.replyTo!.messageId)}
          accessibilityRole="button"
          accessibilityLabel="Go to quoted message"
          style={[
            styles.replyBox,
            {
              backgroundColor: theme.dark ? 'rgba(0,0,0,0.24)' : 'rgba(0,0,0,0.06)',
              borderLeftColor: theme.colors.accent,
            },
          ]}
        >
          <Text style={[styles.replyName, { color: theme.colors.accent }]} numberOfLines={1}>
            {message.replyTo.senderId === myUid
              ? 'You'
              : (replyToSender?.name ??
                (message.replyTo.senderId === message.senderId ? sender?.name : null) ??
                'Them')}
          </Text>
          <Text style={[styles.replyPreview, { color: theme.colors.textMuted }]} numberOfLines={2}>
            {message.replyTo.preview}
          </Text>
        </Pressable>
      ) : null}

      {/* image */}
      {message.type === 'image' && message.mediaUrl ? (
        <View style={[styles.mediaWrap, { width: mediaWidth, height: mediaHeight }]}>
          <Image
            source={{
              uri: message.mediaUrl.startsWith('http')
                ? thumbUrl(message.mediaUrl, 800)
                : message.mediaUrl,
            }}
            style={styles.media}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
          />
          {message.pending ? <UploadOverlay /> : null}
        </View>
      ) : null}

      {/* video */}
      {message.type === 'video' && message.mediaUrl ? (
        <View style={[styles.mediaWrap, { width: mediaWidth, height: mediaHeight }]}>
          <Image
            source={{
              uri:
                message.thumbUrl ??
                (message.mediaUrl.startsWith('http')
                  ? videoPoster(message.mediaUrl, 800)
                  : message.mediaUrl),
            }}
            style={styles.media}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
          />
          <View style={styles.playBadge}>
            <Icon name="play" size={20} color="#FFFFFF" />
          </View>
          {message.durationMs ? (
            <View style={styles.durationChip}>
              <Text style={styles.durationChipText}>{formatDuration(message.durationMs)}</Text>
            </View>
          ) : null}
          {message.pending ? <UploadOverlay /> : null}
        </View>
      ) : null}

      {/* voice note */}
      {message.type === 'audio' && message.mediaUrl ? (
        <AudioPlayer
          uri={message.mediaUrl}
          durationMs={message.durationMs}
          messageId={message.id}
          seed={message.id}
          tint={mine ? theme.colors.accent : theme.colors.textMuted}
          trackColor={theme.dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)'}
        />
      ) : null}

      {/* text */}
      {message.text ? (
        <Text style={[styles.text, { color: fg }]} selectable>
          {message.text}
        </Text>
      ) : null}

      {meta}
    </Pressable>
  );

  return (
    <View>
      <SwipeableRow
        mine={mine}
        onReply={() => onReply(message)}
        enabled={!message.pending && !message.failed}
      >
        <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>{body}</View>
      </SwipeableRow>

      {reactions.length > 0 ? (
        <View
          style={[
            styles.reactions,
            mine ? styles.reactionsMine : styles.reactionsTheirs,
            { backgroundColor: theme.colors.bgElevated, borderColor: theme.colors.border },
          ]}
          accessible
          accessibilityLabel={`Reactions: ${reactions.map(([emoji, count]) => `${emoji} ${count}`).join(', ')}`}
        >
          {reactions.map(([emoji, count]) => (
            <Text key={emoji} style={styles.reactionText}>
              {emoji}
              {count > 1 ? <Text style={{ color: theme.colors.textMuted }}> {count}</Text> : null}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function UploadOverlay() {
  return (
    <View style={styles.uploadOverlay}>
      <View style={styles.uploadSpinner}>
        <Icon name="clock" size={18} color="#FFFFFF" />
      </View>
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  const a = prev.message;
  const b = next.message;
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.type === b.type &&
    a.mediaUrl === b.mediaUrl &&
    a.thumbUrl === b.thumbUrl &&
    // Late-arriving metadata resizes the bubble and fills the meta row: without
    // these the upload placeholder keeps its guessed aspect forever.
    a.width === b.width &&
    a.height === b.height &&
    a.durationMs === b.durationMs &&
    a.forwardedFrom === b.forwardedFrom &&
    a.replyTo?.messageId === b.replyTo?.messageId &&
    a.deleted === b.deleted &&
    a.edited === b.edited &&
    a.pending === b.pending &&
    a.failed === b.failed &&
    a.timestamp === b.timestamp &&
    JSON.stringify(a.seenBy) === JSON.stringify(b.seenBy) &&
    JSON.stringify(a.deliveredTo ?? {}) === JSON.stringify(b.deliveredTo ?? {}) &&
    JSON.stringify(a.reactions) === JSON.stringify(b.reactions) &&
    prev.showTail === next.showTail &&
    prev.starred === next.starred &&
    prev.mine === next.mine &&
    prev.peerUid === next.peerUid &&
    // Identity is enough: the parent memoises the recipient list per membership.
    prev.recipients === next.recipients &&
    prev.sender?.name === next.sender?.name &&
    prev.replyToSender?.name === next.replyToSender?.name &&
    prev.showSenderName === next.showSenderName &&
    // Not a rendered value, but entering and leaving selection mode changes what
    // a tap does. Comparing presence rather than identity keeps the memo useful:
    // the handler is a fresh closure on every parent render.
    Boolean(prev.onPress) === Boolean(next.onPress)
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 8, marginVertical: 1 },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },

  bubble: { borderRadius: 12, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 5, minWidth: 90 },
  bubbleMine: { borderTopRightRadius: 12 },
  bubbleTheirs: { borderTopLeftRadius: 12 },
  tailMine: { borderBottomRightRadius: 3 },
  tailTheirs: { borderBottomLeftRadius: 3 },

  deletedBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
  },
  deletedText: { fontSize: 14, fontStyle: 'italic', flexShrink: 1 },

  text: { fontSize: 15, lineHeight: 21 },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 2,
  },
  time: { fontSize: 11 },
  edited: { fontSize: 10, fontStyle: 'italic' },

  forwarded: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3 },
  forwardedText: { fontSize: 11, fontStyle: 'italic' },

  replyBox: {
    borderLeftWidth: 3,
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 4,
    marginBottom: 4,
  },
  senderName: { fontSize: 13, fontWeight: '600', marginBottom: 2 },
  replyName: { fontSize: 12, fontWeight: '600' },
  replyPreview: { fontSize: 12, marginTop: 1 },

  mediaWrap: { borderRadius: 8, overflow: 'hidden', marginBottom: 3 },
  media: { width: '100%', height: '100%', backgroundColor: 'rgba(127,127,127,0.18)' },
  playBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  durationChip: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  durationChipText: { color: '#FFFFFF', fontSize: 11 },

  uploadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadSpinner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  reactions: {
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: -6,
    marginBottom: 4,
    alignSelf: 'flex-start',
  },
  reactionsMine: { alignSelf: 'flex-end', marginRight: 14 },
  reactionsTheirs: { alignSelf: 'flex-start', marginLeft: 14 },
  reactionText: { fontSize: 13 },
});

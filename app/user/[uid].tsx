import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatIdFor } from '@/src/config/env';
import { DEFAULT_PRIVACY, type UserProfile } from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Avatar } from '@/src/components/Avatar';
import { Icon } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { ListRow } from '@/src/components/ListRow';
import { Switch } from '@/src/components/Switch';
import { alertError, confirm } from '@/src/components/Confirm';
import { Paths, readOnce } from '@/src/services/FirebaseService';
import {
  blockUser,
  ensureChat,
  listenToUser,
  reportUser,
  unblockUser,
} from '@/src/services/ChatEngine';
import { CallManager } from '@/src/services/CallManager';
import { formatLastSeen } from '@/src/services/PresenceManager';
import {
  isSmartReplyEnabled,
  isSmartReplyEnabledForChat,
  setChatOverride,
  subscribeSmartReply,
} from '@/src/services/SmartReplyService';
import { useAppStore } from '@/src/services/StateManager';

const REPORT_REASONS = [
  'Spam',
  'Harassment',
  'Inappropriate content',
  'Other',
] as const;

export default function UserProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { uid } = useLocalSearchParams<{ uid: string }>();

  const myUid = useAppStore((s) => s.currentUser?.uid) ?? null;
  const blocked = useAppStore((s) => s.blocked);
  const cached = useAppStore((s) => (uid ? s.users[uid] : undefined));

  const [fetched, setFetched] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // The live listener writes into the store; the one-shot read fills the screen
  // immediately when the peer is not already cached.
  useEffect(() => {
    if (!uid) return;
    let alive = true;

    readOnce<UserProfile>(Paths.user(uid))
      .then((profile) => {
        if (!alive) return;
        setFetched(profile ? { ...profile, uid } : null);
      })
      .catch((e) => console.warn('[Flyer/user] profile read failed', e))
      .finally(() => {
        if (alive) setLoading(false);
      });

    const off = listenToUser(uid);
    return () => {
      alive = false;
      off();
    };
  }, [uid]);

  const peer = cached ?? fetched;
  const isBlocked = uid ? blocked[uid] === true : false;
  const privacy = peer?.privacy ?? DEFAULT_PRIVACY;

  /**
   * Smart replies for this one conversation.
   *
   * The chat id is derived rather than looked up: `chatIdFor` is deterministic
   * from the two uids, so the toggle works before the chat exists and does not
   * need `ensureChat`'s round-trip — a preference set here is waiting for the
   * first message rather than creating an empty chat to hold it.
   */
  const directChatId = myUid && uid ? chatIdFor(myUid, uid) : null;
  const [smartReplyGlobal, setSmartReplyGlobal] = useState(() => isSmartReplyEnabled());
  const [smartReplyHere, setSmartReplyHere] = useState(() =>
    directChatId ? isSmartReplyEnabledForChat(directChatId) : false
  );

  useEffect(() => {
    if (!directChatId) return;
    // One subscription for both values: the service notifies on any change, and
    // the global switch moving in Settings has to move this row with it.
    return subscribeSmartReply(() => {
      setSmartReplyGlobal(isSmartReplyEnabled());
      setSmartReplyHere(isSmartReplyEnabledForChat(directChatId));
    });
  }, [directChatId]);

  const onToggleSmartReply = useCallback(
    (value: boolean) => {
      if (!directChatId) return;
      setSmartReplyHere(value);
      // `true` clears the override instead of storing it: with the global switch
      // on, "follow the default" and "explicitly on" behave identically, and not
      // writing the entry keeps this chat tracking Settings if it is turned off
      // and on again later.
      void setChatOverride(directChatId, value ? null : false);
    },
    [directChatId]
  );

  const presence = useMemo(() => {
    if (!peer) return '';
    return formatLastSeen(peer.online === true, peer.lastSeen ?? 0, privacy.showLastSeen !== false);
  }, [peer, privacy.showLastSeen]);

  const openChat = useCallback(async () => {
    if (!myUid || !uid || busy) return;
    setBusy(true);
    try {
      const chatId = await ensureChat(myUid, uid);
      router.push(`/chat/${chatId}`);
    } catch (e) {
      console.warn('[Flyer/user] could not open chat', e);
      alertError('Could not open chat', 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [myUid, uid, busy, router]);

  const placeCall = useCallback(
    async (type: 'voice' | 'video') => {
      if (!peer || busy) return;
      if (isBlocked) {
        alertError('Unblock first', `Unblock ${peer.name} before calling them.`);
        return;
      }
      setBusy(true);
      try {
        const started = await CallManager.startCall(peer, type);
        if (started) router.push('/call');
      } catch (e) {
        console.warn('[Flyer/user] call failed', e);
        alertError('Could not start the call', 'Please try again.');
      } finally {
        setBusy(false);
      }
    },
    [peer, busy, isBlocked, router]
  );

  const toggleBlock = useCallback(async () => {
    if (!myUid || !uid || !peer) return;

    const ok = await confirm({
      title: isBlocked ? `Unblock ${peer.name}?` : `Block ${peer.name}?`,
      message: isBlocked
        ? 'They will be able to message and call you again.'
        : 'Blocked people cannot message you, call you, or send you a contact request.',
      confirmLabel: isBlocked ? 'Unblock' : 'Block',
      destructive: !isBlocked,
    });
    if (!ok) return;

    try {
      if (isBlocked) await unblockUser(myUid, uid);
      else await blockUser(myUid, uid);
    } catch (e) {
      console.warn('[Flyer/user] block toggle failed', e);
      alertError('Could not update block list', 'Please try again.');
    }
  }, [myUid, uid, peer, isBlocked]);

  const submitReport = useCallback(
    async (reason: string) => {
      if (!myUid || !uid) return;
      setReportOpen(false);
      try {
        await reportUser(myUid, uid, reason, null);
        alertError(
          'Thanks for letting us know',
          'Our team reviews every report. You can also block this person from their profile.'
        );
      } catch (e) {
        console.warn('[Flyer/user] report failed', e);
        alertError('Could not send report', 'Please try again.');
      }
    },
    [myUid, uid]
  );

  if (loading && !peer) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: theme.colors.bg }]}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (!peer) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
        <Header onBack={() => router.back()} insetTop={insets.top} title="Contact info" />
        <View style={[styles.center, styles.grow]}>
          <Icon name="warning" size={44} color={theme.colors.textFaint} />
          <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
            Profile unavailable
          </Text>
          <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
            This account may have been deleted.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <Header onBack={() => router.back()} insetTop={insets.top} title="Contact info" />

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <View style={styles.hero}>
          <Avatar
            uri={peer.photoURL}
            name={peer.name ?? ''}
            uid={peer.uid}
            size={148}
            showPhoto={privacy.showPhoto !== false}
          />
          <Text style={[styles.name, { color: theme.colors.text }]}>
            {peer.name ?? 'Flyer user'}
          </Text>
          {peer.username ? (
            <Text style={[styles.handle, { color: theme.colors.textMuted }]}>
              @{peer.username}
            </Text>
          ) : null}
          {presence ? (
            <Text style={[styles.presence, { color: theme.colors.textMuted }]}>{presence}</Text>
          ) : null}
          {isBlocked ? (
            <View style={[styles.blockedPill, { backgroundColor: theme.colors.surfaceAlt }]}>
              <Icon name="block" size={13} color={theme.colors.danger} />
              <Text style={[styles.blockedPillText, { color: theme.colors.danger }]}>Blocked</Text>
            </View>
          ) : null}
        </View>

        {privacy.showAbout !== false && peer.about ? (
          <View style={[styles.block, { borderBottomColor: theme.colors.border }]}>
            <Text style={[styles.blockLabel, { color: theme.colors.accent }]}>About</Text>
            <Text style={[styles.blockValue, { color: theme.colors.text }]}>{peer.about}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <ListRow
            icon="send"
            title="Message"
            onPress={() => void openChat()}
            showChevron
            right={busy ? <ActivityIndicator size="small" color={theme.colors.accent} /> : undefined}
          />
          <ListRow icon="phone" title="Voice call" onPress={() => void placeCall('voice')} showChevron />
          <ListRow icon="video" title="Video call" onPress={() => void placeCall('video')} showChevron />
        </View>

        {directChatId ? (
          <View style={styles.section}>
            <ListRow
              icon="reply"
              title="Smart replies"
              subtitle={
                smartReplyGlobal
                  ? `Suggest replies in this chat. Recent messages with ${peer.name} are sent to AI.`
                  : 'Turn on Smart replies in Settings to use this.'
              }
              right={
                <Switch
                  value={smartReplyHere}
                  onValueChange={onToggleSmartReply}
                  disabled={!smartReplyGlobal}
                  accessibilityLabel={`Smart replies with ${peer.name}`}
                />
              }
            />
          </View>
        ) : null}

        <View style={styles.section}>
          <ListRow
            icon="block"
            title={isBlocked ? `Unblock ${peer.name}` : `Block ${peer.name}`}
            destructive={!isBlocked}
            onPress={() => void toggleBlock()}
          />
          <ListRow
            icon="report"
            title={`Report ${peer.name}`}
            destructive
            onPress={() => setReportOpen(true)}
          />
        </View>
      </ScrollView>

      <Modal
        visible={reportOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setReportOpen(false)}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
          onPress={() => setReportOpen(false)}
          accessibilityLabel="Dismiss report options"
        >
          <Pressable
            style={[styles.sheet, { backgroundColor: theme.colors.bgElevated }]}
            onPress={() => {}}
          >
            <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />
            <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>
              Why are you reporting {peer.name}?
            </Text>
            <Text style={[styles.sheetBody, { color: theme.colors.textMuted }]}>
              Reports are reviewed by our team. This person is not told who reported them.
            </Text>

            {REPORT_REASONS.map((reason) => (
              <Pressable
                key={reason}
                onPress={() => void submitReport(reason)}
                accessibilityRole="button"
                accessibilityLabel={`Report for ${reason}`}
                style={[styles.reason, { borderTopColor: theme.colors.border }]}
              >
                <Text style={[styles.reasonLabel, { color: theme.colors.text }]}>{reason}</Text>
                <Icon name="chevron" size={18} color={theme.colors.textFaint} />
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Header({
  onBack,
  insetTop,
  title,
}: {
  onBack: () => void;
  insetTop: number;
  title: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.header,
        { backgroundColor: theme.colors.header, paddingTop: insetTop + 8 },
      ]}
    >
      <Pressable
        round={40}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Icon name="back" size={30} color="#FFFFFF" />
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  grow: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 6,
    paddingBottom: 10,
  },
  headerTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '600', marginLeft: 4 },
  hero: { alignItems: 'center', paddingTop: 28, paddingBottom: 24, gap: 6 },
  name: { fontSize: 24, fontWeight: '600', marginTop: 18, textAlign: 'center' },
  handle: { fontSize: 14.5, marginTop: 4, textAlign: 'center' },
  presence: { fontSize: 14 },
  blockedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginTop: 6,
  },
  blockedPillText: { fontSize: 12, fontWeight: '600' },
  block: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  blockLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  blockValue: { fontSize: 16, lineHeight: 22, marginTop: 8 },
  section: { marginTop: 20 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyBody: { fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingBottom: 34,
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  sheetTitle: { fontSize: 17, fontWeight: '600', paddingHorizontal: 20 },
  sheetBody: { fontSize: 13, lineHeight: 19, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  reasonLabel: { fontSize: 16 },
});

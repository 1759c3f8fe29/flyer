import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Message } from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Avatar } from '@/src/components/Avatar';
import { Icon } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { alertError } from '@/src/components/Confirm';
import { forwardMessage, previewFor, readMessage } from '@/src/services/ChatEngine';
import { useAppStore } from '@/src/services/StateManager';

/** How many contacts one tap can forward to, matching WhatsApp's own cap. */
const MAX_TARGETS = 5;

/**
 * Forward a message to one or more contacts.
 *
 * Targets are contacts rather than existing chats: forwarding to someone you
 * have never messaged is the common case, and `forwardMessage` creates the chat
 * on demand anyway.
 */
export default function ForwardScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { chatId, messageId, messageIds } = useLocalSearchParams<{
    chatId: string;
    messageId?: string;
    /** Comma-separated, from the chat screen's selection mode. */
    messageIds?: string;
  }>();

  const myUid = useAppStore((s) => s.currentUser?.uid) ?? null;
  const contacts = useAppStore((s) => s.contacts);
  const users = useAppStore((s) => s.users);
  const messages = useAppStore((s) => s.messages);

  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  // The messages are read from the cache the chat screen already populated, so
  // forwarding works offline for anything currently on screen.
  //
  // Two entry points land here: the single-message action sheet sends
  // `messageId`, and selection mode sends a comma-separated `messageIds`. Both
  // resolve to a list so the send path below has one shape to handle.
  //
  // Anything older than the loaded window is fetched directly: the chat screen
  // pages into local `older` state, never the store, so a scrolled-up message
  // used to resolve to an empty preview and a silent no-op send.
  const ids = useMemo(
    () =>
      messageIds
        ? messageIds.split(',').filter(Boolean)
        : messageId
          ? [messageId]
          : [],
    [messageIds, messageId]
  );
  const [fetched, setFetched] = useState<Message[]>([]);
  useEffect(() => {
    if (!chatId || ids.length === 0) return;
    const pool = messages[chatId] ?? [];
    const have = new Set(pool.map((m) => m.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const rows: Message[] = [];
      for (const id of missing) {
        try {
          const row = await readMessage(chatId, id);
          if (row) rows.push(row);
        } catch {
          /* offline or denied — the row stays missing */
        }
      }
      if (!cancelled) setFetched(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, ids, messages]);

  const forwardList: Message[] = useMemo(() => {
    if (!chatId) return [];
    const pool = messages[chatId] ?? [];
    // Preserve transcript order rather than selection order, so a forwarded
    // thread reads the same way it did in the original chat.
    const wanted = new Set(ids);
    return [...pool.filter((m) => wanted.has(m.id)), ...fetched.filter((m) => wanted.has(m.id))]
      .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, fetched, chatId, ids]);

  /** The single message, when there is exactly one — drives the preview card. */
  const message: Message | null = forwardList.length === 1 ? forwardList[0] : null;

  const rows = useMemo(() => {
    const q = term.trim().toLowerCase();
    const handle = q.replace(/^@/, '');
    const list = contacts
      .map((c) => ({ uid: c.uid, profile: users[c.uid] ?? null }))
      .sort((a, b) => (a.profile?.name ?? '~').localeCompare(b.profile?.name ?? '~'));

    if (!q) return list;
    return list.filter(
      (r) =>
        (r.profile?.name ?? '').toLowerCase().includes(q) ||
        (r.profile?.username ?? '').toLowerCase().includes(handle)
    );
  }, [contacts, users, term]);

  const toggle = useCallback((uid: string) => {
    setSelected((prev) => {
      if (prev.includes(uid)) return prev.filter((u) => u !== uid);
      if (prev.length >= MAX_TARGETS) return prev;
      return [...prev, uid];
    });
  }, []);

  const send = useCallback(async () => {
    if (!myUid || forwardList.length === 0 || selected.length === 0 || sending) return;

    setSending(true);
    // Sequential rather than parallel: each forward may have to create a chat,
    // and two concurrent creations for the same pair would race. The inner loop
    // is ordered too, so a multi-message forward arrives in transcript order
    // instead of whichever write happened to land first.
    const failed: string[] = [];
    for (const uid of selected) {
      try {
        for (const m of forwardList) {
          await forwardMessage(m, myUid, uid);
        }
      } catch (e) {
        console.warn('[Flyer/forward] failed', uid, e);
        failed.push(users[uid]?.name ?? 'a contact');
      }
    }
    setSending(false);

    if (failed.length === 0) {
      router.back();
      return;
    }

    alertError(
      'Some messages were not sent',
      `Could not forward to ${failed.join(', ')}. Please try again.`
    );
  }, [myUid, forwardList, selected, sending, users, router]);

  /**
   * What is being forwarded, as one line. A single message shows its own
   * preview; a selection shows a count, because the individual previews would
   * not fit and a bare count is what WhatsApp shows too.
   */
  const preview = message
    ? previewFor(message.type, message.text)
    : forwardList.length > 1
      ? `${forwardList.length} messages`
      : '';

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
          accessibilityLabel="Cancel forwarding"
        >
          <Icon name="close" size={24} color="#FFFFFF" />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Forward to…
          </Text>
          {selected.length > 0 ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              {selected.length} of {MAX_TARGETS} selected
            </Text>
          ) : null}
        </View>
      </View>

      {preview ? (
        <View style={[styles.preview, { backgroundColor: theme.colors.surfaceAlt }]}>
          <Icon name="forward" size={16} color={theme.colors.textMuted} />
          <Text
            style={[styles.previewText, { color: theme.colors.textMuted }]}
            numberOfLines={1}
          >
            {preview}
          </Text>
        </View>
      ) : null}

      <View style={[styles.searchWrap, { borderBottomColor: theme.colors.border }]}>
        <View style={[styles.field, { backgroundColor: theme.colors.surfaceAlt }]}>
          <Icon name="search" size={18} color={theme.colors.textMuted} />
          <TextInput
            value={term}
            onChangeText={setTerm}
            placeholder="Search contacts"
            placeholderTextColor={theme.colors.textFaint}
            style={[styles.input, { color: theme.colors.text }]}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search contacts"
          />
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.uid}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        renderItem={({ item }) => {
          const p = item.profile;
          const name = p?.name ?? 'Flyer user';
          const isOn = selected.includes(item.uid);
          const atCap = !isOn && selected.length >= MAX_TARGETS;

          return (
            <Pressable
              onPress={() => toggle(item.uid)}
              disabled={atCap}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isOn, disabled: atCap }}
              accessibilityLabel={name}
              style={[styles.row, { opacity: atCap ? 0.4 : 1 }]}
            >
              <Avatar
                uri={p?.photoURL}
                name={name}
                uid={item.uid}
                size={46}
                showPhoto={p?.privacy?.showPhoto !== false}
              />
              <View style={styles.rowText}>
                <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                  {name}
                </Text>
                {p?.username ? (
                  <Text style={[styles.handle, { color: theme.colors.textMuted }]} numberOfLines={1}>
                    @{p.username}
                  </Text>
                ) : null}
              </View>

              <View
                style={[
                  styles.check,
                  {
                    borderColor: isOn ? theme.colors.accent : theme.colors.border,
                    backgroundColor: isOn ? theme.colors.accent : 'transparent',
                  },
                ]}
              >
                {isOn ? <Icon name="accept" size={15} color={theme.colors.accentText} /> : null}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="peopleOutline" size={40} color={theme.colors.textFaint} />
            <Text style={[styles.emptyText, { color: theme.colors.textMuted }]}>
              {term.trim() ? 'No matching contacts.' : 'You have no contacts yet.'}
            </Text>
          </View>
        }
      />

      {selected.length > 0 ? (
        <View style={[styles.sendWrap, { bottom: insets.bottom + 20 }]}>
          <Pressable
            onPress={() => void send()}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel={`Send to ${selected.length} contacts`}
            accessibilityState={{ disabled: sending }}
            style={[styles.send, { backgroundColor: theme.colors.accent }]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={theme.colors.accentText} />
            ) : (
              <Icon name="send" size={24} color={theme.colors.accentText} />
            )}
          </Pressable>
        </View>
      ) : null}
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
  headerText: { flex: 1, marginLeft: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '600' },
  headerSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12.5, marginTop: 1 },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  previewText: { flex: 1, fontSize: 13.5 },
  searchWrap: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
  },
  input: { flex: 1, fontSize: 15.5, padding: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, height: 68 },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: '500' },
  handle: { fontSize: 13 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { alignItems: 'center', gap: 12, paddingTop: 64, paddingHorizontal: 40 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  sendWrap: { position: 'absolute', right: 20 },
  send: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 3 },
  },
});

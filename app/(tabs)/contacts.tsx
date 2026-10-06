import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Avatar } from '@/src/components/Avatar';
import { Icon } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { ActionSheet, type SheetAction } from '@/src/components/ActionSheet';
import { alertError, confirm } from '@/src/components/Confirm';
import { ensureChat } from '@/src/services/ChatEngine';
import { removeContact } from '@/src/services/ContactService';
import { selectIncomingRequestCount, useAppStore } from '@/src/services/StateManager';

/**
 * Contacts — only people you have a mutual, accepted connection with.
 *
 * No longer a directory of every registered user: now that requests exist,
 * listing strangers would defeat the point of the handshake. New people are
 * found by email on the Add screen.
 */
export default function ContactsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const myUid = useAppStore((s) => s.currentUser?.uid) ?? null;
  const contacts = useAppStore((s) => s.contacts);
  const users = useAppStore((s) => s.users);
  const requestCount = useAppStore(selectIncomingRequestCount);

  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = term.trim().toLowerCase();
    const list = contacts
      .map((c) => ({ uid: c.uid, profile: users[c.uid] ?? null }))
      .sort((a, b) => (a.profile?.name ?? '~').localeCompare(b.profile?.name ?? '~'));

    if (!q) return list;
    // Leading "@" is how people write handles, but it is not part of the value.
    const handle = q.replace(/^@/, '');
    return list.filter(
      (r) =>
        (r.profile?.name ?? '').toLowerCase().includes(q) ||
        (r.profile?.username ?? '').toLowerCase().includes(handle) ||
        (r.profile?.email ?? '').toLowerCase().includes(q)
    );
  }, [contacts, users, term]);

  const openChat = useCallback(
    async (peerUid: string) => {
      if (!myUid || opening) return;
      setOpening(peerUid);
      try {
        const chatId = await ensureChat(myUid, peerUid);
        router.push(`/chat/${chatId}`);
      } catch (e) {
        console.warn('[Flyer/contacts] could not open chat', e);
        alertError('Could not open chat', 'Please try again.');
      } finally {
        setOpening(null);
      }
    },
    [myUid, opening, router]
  );

  const sheetActions = useMemo<SheetAction[]>(() => {
    if (!sheetFor || !myUid) return [];
    const name = users[sheetFor]?.name ?? 'this contact';
    return [
      { key: 'message', label: 'Message', icon: 'chats', onPress: () => void openChat(sheetFor) },
      {
        key: 'remove',
        label: 'Remove contact',
        icon: 'personRemove',
        destructive: true,
        onPress: async () => {
          const ok = await confirm({
            title: `Remove ${name}?`,
            message:
              'They come off your contact list. Your chat history stays, and you keep theirs.',
            confirmLabel: 'Remove',
            destructive: true,
          });
          if (!ok) return;
          try {
            await removeContact(myUid, sheetFor);
          } catch (e) {
            console.warn('[Flyer/contacts] remove failed', e);
            alertError('Could not remove contact', 'Please try again.');
          }
        },
      },
    ];
  }, [sheetFor, myUid, users, openChat]);

  const closeSearch = useCallback(() => {
    setSearching(false);
    setTerm('');
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <View
        style={[
          styles.header,
          { backgroundColor: theme.colors.header, paddingTop: insets.top + 8 },
        ]}
      >
        {searching ? (
          <TextInput
            value={term}
            onChangeText={setTerm}
            autoFocus
            placeholder="Search name or @username"
            placeholderTextColor="rgba(255,255,255,0.6)"
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            accessibilityLabel="Search contacts"
          />
        ) : (
          <Text style={styles.headerTitle} numberOfLines={1}>
            Contacts
          </Text>
        )}

        <Pressable
          round={40}
          onPress={() => (searching ? closeSearch() : setSearching(true))}
          accessibilityRole="button"
          accessibilityLabel={searching ? 'Close search' : 'Search contacts'}
        >
          <Icon name={searching ? 'close' : 'search'} size={searching ? 22 : 24} color="#FFFFFF" />
        </Pressable>

        {searching ? null : (
          <Pressable
            round={40}
            onPress={() => router.push('/add-contact')}
            accessibilityRole="button"
            accessibilityLabel="Add contact"
          >
            <Icon name="personAdd" size={24} color="#FFFFFF" />
          </Pressable>
        )}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.uid}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        ListHeaderComponent={
          term.trim() ? null : (
            <View>
              <Pressable
                onPress={() => router.push('/new-group')}
                accessibilityRole="button"
                accessibilityLabel="New group"
                style={[styles.actionRow, { borderBottomColor: theme.colors.border }]}
              >
                <View style={[styles.actionIcon, { backgroundColor: theme.colors.accent }]}>
                  <Icon name="people" size={20} color={theme.colors.accentText} />
                </View>
                <Text style={[styles.actionLabel, { color: theme.colors.text }]}>New group</Text>
                <Icon name="chevron" size={20} color={theme.colors.textMuted} />
              </Pressable>

              <Pressable
                onPress={() => router.push('/requests')}
                accessibilityRole="button"
                accessibilityLabel={
                  requestCount > 0
                    ? `Contact requests, ${requestCount} pending`
                    : 'Contact requests'
                }
                style={[styles.actionRow, { borderBottomColor: theme.colors.border }]}
              >
                <View style={[styles.actionIcon, { backgroundColor: theme.colors.accent }]}>
                  <Icon name="personAdd" size={20} color={theme.colors.accentText} />
                </View>
                <Text style={[styles.actionLabel, { color: theme.colors.text }]}>
                  Contact requests
                </Text>
                {requestCount > 0 ? (
                  <View style={[styles.badge, { backgroundColor: theme.colors.unreadBadge }]}>
                    <Text style={[styles.badgeText, { color: theme.colors.accentText }]}>
                      {requestCount > 99 ? '99+' : requestCount}
                    </Text>
                  </View>
                ) : null}
                <Icon name="chevron" size={20} color={theme.colors.textMuted} />
              </Pressable>

              <Pressable
                onPress={() => router.push('/add-contact')}
                accessibilityRole="button"
                accessibilityLabel="Add a contact by username or email"
                style={[styles.actionRow, { borderBottomColor: theme.colors.border }]}
              >
                <View style={[styles.actionIcon, { backgroundColor: theme.colors.accent }]}>
                  <Icon name="personSearch" size={20} color={theme.colors.accentText} />
                </View>
                <Text style={[styles.actionLabel, { color: theme.colors.text }]}>
                  Add contact
                </Text>
                <Icon name="chevron" size={20} color={theme.colors.textMuted} />
              </Pressable>

              {rows.length > 0 ? (
                <Text style={[styles.sectionHeader, { color: theme.colors.textMuted }]}>
                  {rows.length === 1 ? '1 contact' : `${rows.length} contacts`}
                </Text>
              ) : null}
            </View>
          )
        }
        renderItem={({ item }) => {
          const p = item.profile;
          const name = p?.name ?? 'Flyer user';
          const showPresence = p?.privacy?.showLastSeen !== false;

          return (
            <Pressable
              onPress={() => void openChat(item.uid)}
              onLongPress={() => setSheetFor(item.uid)}
              accessibilityRole="button"
              accessibilityLabel={`Message ${name}`}
              style={[styles.row, { borderBottomColor: theme.colors.border }]}
            >
              <Avatar
                uri={p?.photoURL}
                name={name}
                uid={item.uid}
                size={48}
                online={showPresence && p?.online === true}
                showPhoto={p?.privacy?.showPhoto !== false}
              />

              <View style={styles.rowText}>
                <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={[styles.about, { color: theme.colors.textMuted }]} numberOfLines={1}>
                  {p?.privacy?.showAbout === false || !p?.about
                    ? p?.username
                      ? `@${p.username}`
                      : ''
                    : p.about}
                </Text>
              </View>

              {opening === item.uid ? (
                <ActivityIndicator size="small" color={theme.colors.accent} />
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="peopleOutline" size={44} color={theme.colors.textFaint} />
            <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
              {term.trim() ? 'No matches' : 'No contacts yet'}
            </Text>
            <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
              {term.trim()
                ? 'Try a different name or username.'
                : 'Add someone by their username or email, then start chatting once they accept.'}
            </Text>
          </View>
        }
      />

      <ActionSheet
        visible={sheetFor !== null}
        onClose={() => setSheetFor(null)}
        title={sheetFor ? (users[sheetFor]?.name ?? 'Contact') : undefined}
        actions={sheetActions}
      />
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
  headerTitle: { flex: 1, color: '#FFFFFF', fontSize: 19, fontWeight: '600', marginLeft: 4 },
  searchInput: { flex: 1, color: '#FFFFFF', fontSize: 17, paddingVertical: 6, marginLeft: 4 },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 68,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { flex: 1, fontSize: 16 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 68,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  name: { fontSize: 16, fontWeight: '500' },
  about: { fontSize: 13, marginTop: 3 },
  empty: { alignItems: 'center', paddingTop: 70, paddingHorizontal: 40, gap: 10 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
});

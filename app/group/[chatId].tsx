import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  type GroupMember,
} from '@/src/config/types';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Avatar } from '@/src/components/Avatar';
import { Icon } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { ListRow } from '@/src/components/ListRow';
import { ActionSheet, type SheetAction } from '@/src/components/ActionSheet';
import { alertError, confirm } from '@/src/components/Confirm';
import {
  addMembers,
  grantAdmin,
  leaveGroup,
  listenToGroupMembers,
  removeMember,
  renameGroup,
  revokeAdmin,
  setGroupDescription,
  setGroupPhoto,
} from '@/src/services/GroupService';
import { captureWithCamera, pickFromLibrary, uploadToCloudinary } from '@/src/services/MediaManager';
import { isChatMuted, setChatMuted } from '@/src/services/ChatEngine';
import { useAppStore } from '@/src/services/StateManager';

/** Mute duration offered here, matching the chat list's long-press menu. */
const MUTE_MS = 8 * 60 * 60 * 1000;

/**
 * Group info.
 *
 * Everything an admin can change lives behind an explicit tap: the header shows
 * the group as it is, and edit affordances only appear for people who can
 * actually use them. A non-admin sees the same screen with the same information
 * and no controls that would fail server-side — the rules reject those writes, so
 * offering them would only produce errors.
 */
export default function GroupInfoScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();

  const myUid = useAppStore((s) => s.currentUser?.uid) ?? null;
  const chat = useAppStore((s) => (chatId ? s.chats[chatId] : undefined));
  const contacts = useAppStore((s) => s.contacts);
  const users = useAppStore((s) => s.users);

  const [members, setMembers] = useState<GroupMember[]>([]);
  const [memberFor, setMemberFor] = useState<GroupMember | null>(null);
  const [photoSheet, setPhotoSheet] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<'name' | 'description' | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addSelected, setAddSelected] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!chatId) return;
    return listenToGroupMembers(chatId, setMembers);
  }, [chatId]);

  const isAdmin = myUid ? chat?.admins?.[myUid] === true : false;
  const muted = chat && myUid ? isChatMuted(chat, myUid) : false;

  // --- photo ---------------------------------------------------------------

  const pickPhoto = useCallback(
    async (source: 'camera' | 'library' | 'remove') => {
      if (!chatId || !myUid || uploading) return;
      try {
        if (source === 'remove') {
          setUploading(true);
          await setGroupPhoto(chatId, myUid, null);
          return;
        }
        const picked =
          source === 'camera'
            ? await captureWithCamera('image')
            : (await pickFromLibrary('image'))[0];
        if (!picked) return;
        setUploading(true);
        const uploaded = await uploadToCloudinary(picked.uri, 'image');
        await setGroupPhoto(chatId, myUid, uploaded.url);
      } catch (e) {
        console.warn('[Flyer/group] photo failed', e);
        alertError('Could not update the photo', e instanceof Error ? e.message : undefined);
      } finally {
        setUploading(false);
      }
    },
    [chatId, myUid, uploading]
  );

  const photoActions = useMemo<SheetAction[]>(() => {
    const list: SheetAction[] = [
      { key: 'camera', label: 'Take photo', icon: 'camera', onPress: () => void pickPhoto('camera') },
      {
        key: 'library',
        label: 'Choose from gallery',
        icon: 'attach',
        onPress: () => void pickPhoto('library'),
      },
    ];
    if (chat?.photoURL) {
      list.push({
        key: 'remove',
        label: 'Remove photo',
        icon: 'trash',
        destructive: true,
        onPress: () => void pickPhoto('remove'),
      });
    }
    return list;
  }, [chat?.photoURL, pickPhoto]);

  // --- name / description --------------------------------------------------

  const openEditor = useCallback(
    (field: 'name' | 'description') => {
      setDraft(field === 'name' ? (chat?.name ?? '') : (chat?.description ?? ''));
      setEditing(field);
    },
    [chat?.name, chat?.description]
  );

  const saveEditor = useCallback(async () => {
    if (!chatId || !myUid || !editing || saving) return;
    setSaving(true);
    try {
      if (editing === 'name') await renameGroup(chatId, myUid, draft);
      else await setGroupDescription(chatId, myUid, draft);
      setEditing(null);
    } catch (e) {
      console.warn('[Flyer/group] save failed', e);
      alertError('Could not save', e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }, [chatId, myUid, editing, draft, saving]);

  // --- membership ----------------------------------------------------------

  const memberActions = useMemo<SheetAction[]>(() => {
    if (!memberFor || !chatId || !myUid) return [];
    const target = memberFor;
    const name = target.profile?.name ?? 'this person';

    // `memberFor` is never yourself — your own row is not pressable — so every
    // action here is unconditionally about someone else.
    const list: SheetAction[] = [
      {
        key: 'view',
        label: `View ${name}`,
        icon: 'people',
        onPress: () => router.push(`/user/${target.uid}`),
      },
    ];

    if (isAdmin) {
      list.push(
        target.isAdmin
          ? {
              key: 'revoke',
              label: 'Dismiss as admin',
              icon: 'personRemove',
              onPress: async () => {
                try {
                  await revokeAdmin(chatId, myUid, target.uid);
                } catch (e) {
                  alertError('Could not change admins', e instanceof Error ? e.message : undefined);
                }
              },
            }
          : {
              key: 'grant',
              label: 'Make group admin',
              icon: 'personAdd',
              onPress: async () => {
                try {
                  await grantAdmin(chatId, myUid, target.uid);
                } catch (e) {
                  alertError('Could not change admins', e instanceof Error ? e.message : undefined);
                }
              },
            },
        {
          key: 'remove',
          label: `Remove ${name}`,
          icon: 'personRemove',
          destructive: true,
          onPress: async () => {
            const ok = await confirm({
              title: `Remove ${name}?`,
              message: 'They lose access to this group and its future messages.',
              confirmLabel: 'Remove',
              destructive: true,
            });
            if (!ok) return;
            try {
              await removeMember(chatId, myUid, target.uid);
            } catch (e) {
              alertError('Could not remove them', e instanceof Error ? e.message : undefined);
            }
          },
        }
      );
    }

    return list;
  }, [memberFor, chatId, myUid, isAdmin, router]);

  const addable = useMemo(
    () =>
      contacts
        .filter((c) => chat?.participants?.[c.uid] !== true)
        .map((c) => ({ uid: c.uid, profile: users[c.uid] ?? null }))
        .sort((a, b) => (a.profile?.name ?? '~').localeCompare(b.profile?.name ?? '~')),
    [contacts, chat?.participants, users]
  );

  const submitAdd = useCallback(async () => {
    if (!chatId || !myUid || adding || addSelected.size === 0) return;
    setAdding(true);
    try {
      await addMembers(chatId, myUid, [...addSelected]);
      setAddOpen(false);
      setAddSelected(new Set());
    } catch (e) {
      console.warn('[Flyer/group] add failed', e);
      alertError('Could not add members', e instanceof Error ? e.message : undefined);
    } finally {
      setAdding(false);
    }
  }, [chatId, myUid, adding, addSelected]);

  const doLeave = useCallback(async () => {
    if (!chatId || !myUid) return;
    const ok = await confirm({
      title: 'Leave this group?',
      message: 'You stop receiving its messages. Someone will have to add you back.',
      confirmLabel: 'Leave',
      destructive: true,
    });
    if (!ok) return;
    try {
      await leaveGroup(chatId, myUid);
      // Straight to the list: the chat this screen describes no longer exists
      // for us, so going back one step would land on a dead transcript.
      router.replace('/(tabs)');
    } catch (e) {
      console.warn('[Flyer/group] leave failed', e);
      alertError('Could not leave the group', e instanceof Error ? e.message : undefined);
    }
  }, [chatId, myUid, router]);

  const toggleMute = useCallback(async () => {
    if (!chatId || !myUid) return;
    try {
      await setChatMuted(chatId, myUid, muted ? null : Date.now() + MUTE_MS);
    } catch (e) {
      alertError('Could not update notifications', e instanceof Error ? e.message : undefined);
    }
  }, [chatId, myUid, muted]);

  if (!chat || !myUid) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: theme.colors.bg }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Icon name="warning" size={44} color={theme.colors.textFaint} />
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>Group unavailable</Text>
        <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
          You may have left this group, or it was deleted.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View
        style={[
          styles.header,
          { backgroundColor: theme.colors.header, paddingTop: insets.top + 8 },
        ]}
      >
        <Pressable
          round={40}
          onPress={() => {
            // Deep links and notification taps can land here with an empty
            // stack, where back() is a no-op that strands the user.
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }}
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={30} color={theme.colors.headerText} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.colors.headerText }]}>Group info</Text>
      </View>

      <FlatList
        data={members}
        keyExtractor={(m) => m.uid}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        ListHeaderComponent={
          <>
            <View style={styles.hero}>
              <Pressable
                onPress={isAdmin ? () => setPhotoSheet(true) : undefined}
                disabled={!isAdmin}
                accessibilityLabel={isAdmin ? 'Change group photo' : 'Group photo'}
                style={styles.photoWrap}
              >
                <Avatar
                  uri={chat.photoURL}
                  name={chat.name ?? 'Group'}
                  uid={chat.id}
                  size={148}
                  group
                />
                {isAdmin ? (
                  <View style={[styles.photoBadge, { backgroundColor: theme.colors.accent }]}>
                    {uploading ? (
                      <ActivityIndicator size="small" color={theme.colors.accentText} />
                    ) : (
                      <Icon name="camera" size={18} color={theme.colors.accentText} />
                    )}
                  </View>
                ) : null}
              </Pressable>

              <Pressable
                onPress={isAdmin ? () => openEditor('name') : undefined}
                disabled={!isAdmin}
                accessibilityLabel={isAdmin ? 'Rename group' : (chat.name ?? 'Group')}
                style={styles.nameRow}
              >
                <Text style={[styles.name, { color: theme.colors.text }]}>
                  {chat.name ?? 'Group'}
                </Text>
                {isAdmin ? <Icon name="edit" size={17} color={theme.colors.accent} /> : null}
              </Pressable>

              <Text style={[styles.count, { color: theme.colors.textMuted }]}>
                Group · {members.length} participants
              </Text>
            </View>

            <Pressable
              onPress={isAdmin ? () => openEditor('description') : undefined}
              disabled={!isAdmin}
              accessibilityLabel={isAdmin ? 'Edit group description' : 'Group description'}
              style={[styles.block, { borderBottomColor: theme.colors.border }]}
            >
              <View style={styles.blockHead}>
                <Text style={[styles.blockLabel, { color: theme.colors.accent }]}>Description</Text>
                {isAdmin ? <Icon name="edit" size={15} color={theme.colors.accent} /> : null}
              </View>
              <Text
                style={[
                  styles.blockValue,
                  { color: chat.description ? theme.colors.text : theme.colors.textFaint },
                ]}
              >
                {chat.description ??
                  (isAdmin ? 'Add a description so people know what this group is for.' : 'No description')}
              </Text>
            </Pressable>

            <View style={styles.section}>
              <ListRow
                icon={muted ? 'unmute' : 'mute'}
                title={muted ? 'Unmute notifications' : 'Mute for 8 hours'}
                onPress={() => void toggleMute()}
              />
            </View>

            <Text style={[styles.sectionHeader, { color: theme.colors.accent }]}>
              {members.length} participants
            </Text>

            {isAdmin ? (
              <Pressable
                onPress={() => setAddOpen(true)}
                accessibilityLabel="Add participants"
                style={styles.row}
              >
                <View style={[styles.addIcon, { backgroundColor: theme.colors.accent }]}>
                  <Icon name="personAdd" size={22} color={theme.colors.accentText} />
                </View>
                <View style={[styles.rowText, { borderBottomColor: theme.colors.border }]}>
                  <Text style={[styles.rowName, { color: theme.colors.accent }]}>
                    Add participants
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </>
        }
        renderItem={({ item }) => {
          const isMe = item.uid === myUid;
          const label = isMe ? 'You' : (item.profile?.name ?? 'Unknown');
          return (
            <Pressable
              // Your own row has no menu: everything the sheet offers is about
              // someone else, and "leave group" already sits in the footer.
              onPress={isMe ? undefined : () => setMemberFor(item)}
              disabled={isMe}
              accessibilityLabel={label}
              style={styles.row}
            >
              <Avatar
                uri={item.profile?.photoURL ?? null}
                name={item.profile?.name ?? '?'}
                uid={item.uid}
                size={48}
                showPhoto={item.profile?.privacy?.showPhoto !== false}
              />
              <View style={[styles.rowText, { borderBottomColor: theme.colors.border }]}>
                <View style={styles.rowTop}>
                  <Text style={[styles.rowName, { color: theme.colors.text }]} numberOfLines={1}>
                    {label}
                  </Text>
                  {item.isAdmin ? (
                    <View style={[styles.adminPill, { backgroundColor: theme.colors.surfaceAlt }]}>
                      <Text style={[styles.adminPillText, { color: theme.colors.accent }]}>
                        Admin
                      </Text>
                    </View>
                  ) : null}
                </View>
                {item.profile?.about ? (
                  <Text
                    style={[styles.rowAbout, { color: theme.colors.textMuted }]}
                    numberOfLines={1}
                  >
                    {item.profile.about}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        }}
        ListFooterComponent={
          <View style={styles.section}>
            <ListRow icon="logout" title="Leave group" destructive onPress={() => void doLeave()} />
          </View>
        }
      />

      <ActionSheet
        visible={photoSheet}
        title="Group photo"
        actions={photoActions}
        onClose={() => setPhotoSheet(false)}
      />

      <ActionSheet
        visible={memberFor !== null && memberActions.length > 0}
        title={memberFor?.profile?.name ?? ''}
        actions={memberActions}
        onClose={() => setMemberFor(null)}
      />

      {/* Name / description editor */}
      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
          onPress={() => setEditing(null)}
          accessibilityLabel="Dismiss"
        >
          <Pressable style={[styles.dialog, { backgroundColor: theme.colors.bgElevated }]} onPress={() => {}}>
            <Text style={[styles.dialogTitle, { color: theme.colors.text }]}>
              {editing === 'name' ? 'Group name' : 'Group description'}
            </Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoFocus
              multiline={editing === 'description'}
              maxLength={editing === 'name' ? GROUP_NAME_MAX : GROUP_DESCRIPTION_MAX}
              placeholder={editing === 'name' ? 'Group name' : 'What is this group about?'}
              placeholderTextColor={theme.colors.textFaint}
              style={[
                styles.dialogInput,
                editing === 'description' && styles.dialogInputTall,
                { color: theme.colors.text, borderBottomColor: theme.colors.accent },
              ]}
              accessibilityLabel={editing === 'name' ? 'Group name' : 'Group description'}
            />
            <Text style={[styles.counter, { color: theme.colors.textFaint }]}>
              {(editing === 'name' ? GROUP_NAME_MAX : GROUP_DESCRIPTION_MAX) - draft.length}
            </Text>
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setEditing(null)} accessibilityLabel="Cancel">
                <Text style={[styles.dialogAction, { color: theme.colors.textMuted }]}>CANCEL</Text>
              </Pressable>
              <Pressable onPress={() => void saveEditor()} accessibilityLabel="Save">
                {saving ? (
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                ) : (
                  <Text style={[styles.dialogAction, { color: theme.colors.accent }]}>SAVE</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Add participants */}
      <Modal
        visible={addOpen}
        animationType="slide"
        onRequestClose={() => setAddOpen(false)}
        presentationStyle="fullScreen"
      >
        <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
          <View
            style={[
              styles.header,
              { backgroundColor: theme.colors.header, paddingTop: insets.top + 8 },
            ]}
          >
            <Pressable round={40} onPress={() => setAddOpen(false)} accessibilityLabel="Close">
              <Icon name="close" size={26} color={theme.colors.headerText} />
            </Pressable>
            <View style={styles.headerText}>
              <Text style={[styles.headerTitle, { color: theme.colors.headerText }]}>Add participants</Text>
              <Text style={[styles.headerSubtitle, { color: theme.colors.headerSubtext }]}>
                {addSelected.size === 0 ? 'Choose contacts' : `${addSelected.size} selected`}
              </Text>
            </View>
          </View>

          <FlatList
            data={addable}
            keyExtractor={(item) => item.uid}
            contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
            renderItem={({ item }) => {
              const checked = addSelected.has(item.uid);
              const label = item.profile?.name ?? 'Unknown';
              return (
                <Pressable
                  onPress={() =>
                    setAddSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.uid)) next.delete(item.uid);
                      else next.add(item.uid);
                      return next;
                    })
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={label}
                  style={styles.row}
                >
                  <Avatar
                    uri={item.profile?.photoURL ?? null}
                    name={label}
                    uid={item.uid}
                    size={48}
                    showPhoto={item.profile?.privacy?.showPhoto !== false}
                  />
                  <View style={[styles.rowText, { borderBottomColor: theme.colors.border }]}>
                    <Text style={[styles.rowName, { color: theme.colors.text }]} numberOfLines={1}>
                      {label}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: checked ? theme.colors.accent : theme.colors.border,
                        backgroundColor: checked ? theme.colors.accent : 'transparent',
                      },
                    ]}
                  >
                    {checked ? (
                      <Icon name="accept" size={14} color={theme.colors.accentText} />
                    ) : null}
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <View style={[styles.center, styles.addEmpty]}>
                <Icon name="people" size={40} color={theme.colors.textFaint} />
                <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
                  Everyone is here
                </Text>
                <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
                  All of your contacts are already in this group.
                </Text>
              </View>
            }
          />

          {addSelected.size > 0 ? (
            <Pressable
              style={[
                styles.fab,
                { backgroundColor: theme.colors.accent, bottom: insets.bottom + 24 },
              ]}
              haptic
              onPress={() => void submitAdd()}
              accessibilityLabel="Add selected participants"
            >
              {adding ? (
                <ActivityIndicator color={theme.colors.accentText} />
              ) : (
                <Icon name="accept" size={26} color={theme.colors.accentText} />
              )}
            </Pressable>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 6,
    paddingBottom: 10,
  },
  headerText: { flex: 1, marginLeft: 4 },
  headerTitle: { fontSize: 19, fontWeight: '600', marginLeft: 4 },
  headerSubtitle: { fontSize: 12.5, marginLeft: 4, marginTop: 1 },

  hero: { alignItems: 'center', paddingTop: 28, paddingBottom: 20 },
  photoWrap: { width: 148, height: 148 },
  photoBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 },
  name: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  count: { fontSize: 14, marginTop: 6 },

  block: { paddingHorizontal: 18, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  blockLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  blockValue: { fontSize: 15.5, lineHeight: 22, marginTop: 8 },

  section: { marginTop: 20 },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, minHeight: 66 },
  rowText: {
    flex: 1,
    marginLeft: 13,
    paddingRight: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
  rowAbout: { fontSize: 13, marginTop: 2 },
  adminPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 },
  adminPillText: { fontSize: 11, fontWeight: '600' },
  addIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },

  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyBody: { fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  addEmpty: { paddingTop: 80 },

  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  dialog: { width: '100%', borderRadius: 14, padding: 22 },
  dialogTitle: { fontSize: 17, fontWeight: '600' },
  dialogInput: { fontSize: 16, paddingVertical: 8, borderBottomWidth: 2, marginTop: 14 },
  dialogInputTall: { minHeight: 88, textAlignVertical: 'top' },
  counter: { fontSize: 12, alignSelf: 'flex-end', marginTop: 6 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 28, marginTop: 20 },
  dialogAction: { fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },

  fab: {
    position: 'absolute',
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 3 },
  },
});

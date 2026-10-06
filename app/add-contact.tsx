import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Avatar } from '@/src/components/Avatar';
import { Icon } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { alertError } from '@/src/components/Confirm';
import {
  ContactError,
  relationshipWith,
  sendRequest,
  type RelationshipState,
} from '@/src/services/ContactService';
import { findUserByEmail, hitToPartial, type SearchHit } from '@/src/services/DirectoryService';
import { useAppStore } from '@/src/services/StateManager';
import { findUserByUsername, validateUsername } from '@/src/services/UsernameService';

type Mode = 'username' | 'email';

/**
 * Add a contact by exact username or by exact email address.
 *
 * Both modes resolve an identifier you already know; neither searches. Username
 * used to be a prefix search over `usernames`, but a prefix range and full
 * enumeration share one RTDB permission, so that had to move to the
 * `searchUsers` callable. This screen resolves a full `@username` instead via
 * `findUserByUsername`, which reads `usernames/{handle}` per-row and is still
 * permitted. Email is exact-match only: a prefix search over addresses would let
 * anyone enumerate every account one letter at a time, and you are expected to
 * already know the address — the same bar as knowing someone's phone number.
 */
export default function AddContactScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const myUid = useAppStore((s) => s.currentUser?.uid) ?? null;
  // Merge, not replace: a search hit is a projection, and someone you already
  // have a chat with must not lose their cached profile by turning up in one.
  const mergeUser = useAppStore((s) => s.mergeUser);
  // Subscribing to these keeps the button label correct the instant the
  // listener sees the request land, with no local mirror to fall out of sync.
  useAppStore((s) => s.requests);
  useAppStore((s) => s.contacts);

  const [mode, setMode] = useState<Mode>('username');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [notFound, setNotFound] = useState(false);
  // Guards against an older, slower search overwriting a newer one's results.
  const seq = useRef(0);

  const runEmailSearch = useCallback(async () => {
    const needle = query.trim().toLowerCase();
    if (!needle || !myUid || searching) return;

    const ticket = ++seq.current;
    setSearching(true);
    setNotFound(false);
    setResults([]);
    try {
      const found = await findUserByEmail(needle);
      if (ticket !== seq.current) return;
      // The callable filters you out of your own results, so a hit is always
      // somebody else.
      if (found) {
        setResults([found]);
        mergeUser(hitToPartial(found));
      } else {
        setNotFound(true);
      }
    } catch (e) {
      console.warn('[Flyer/add-contact] email search failed', e);
      alertError('Search failed', 'Check your connection and try again.');
    } finally {
      if (ticket === seq.current) setSearching(false);
    }
  }, [query, myUid, searching, mergeUser]);

  // Usernames resolve by exact handle; email waits for submit because an exact
  // match on a half-typed address is never going to hit.
  useEffect(() => {
    if (mode !== 'username') return;

    const needle = query.trim().replace(/^@/, '').toLowerCase();
    // Only fire once the query is a well-formed handle. Anything shorter or
    // malformed can never resolve, so reading it would just return null.
    if (!needle || !myUid || validateUsername(needle)) {
      // Invalidate any in-flight lookup: without the bump, clearing the query
      // does not retire its ticket, and the stale promise repopulates results
      // after the clear. (The pending timer is cleared by the effect cleanup.)
      seq.current += 1;
      setResults([]);
      setNotFound(false);
      setSearching(false);
      return;
    }

    const ticket = ++seq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const profile = await findUserByUsername(needle, myUid);
        if (ticket !== seq.current) return;
        if (profile) {
          const hit: SearchHit = {
            uid: profile.uid,
            name: profile.name,
            username: profile.username,
            // The callable's searchProjection withheld the photo when a profile
            // set showPhoto:false; a direct users/{uid} read returns it verbatim,
            // so honour that choice here instead of leaking the hidden URL.
            photoURL: profile.privacy?.showPhoto === false ? null : profile.photoURL,
            // A handle result never carries an email for the same reason the old
            // callable withheld it: lookup must not become a harvester.
            email: null,
          };
          setResults([hit]);
          setNotFound(false);
          mergeUser(hitToPartial(hit));
        } else {
          setResults([]);
          setNotFound(true);
        }
      } catch (e) {
        if (ticket !== seq.current) return;
        console.warn('[Flyer/add-contact] username lookup failed', e);
        setResults([]);
      } finally {
        if (ticket === seq.current) setSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query, mode, myUid, mergeUser]);

  const onSend = useCallback(
    async (target: SearchHit) => {
      if (!myUid || sending) return;
      setSending(target.uid);
      try {
        const outcome = await sendRequest(myUid, target.uid);
        if (outcome === 'accepted') router.replace('/(tabs)/contacts');
      } catch (e) {
        if (e instanceof ContactError) alertError('Could not add contact', e.message);
        else {
          console.warn('[Flyer/add-contact] send failed', e);
          alertError('Could not send request', 'Please try again.');
        }
      } finally {
        setSending(null);
      }
    },
    [myUid, sending, router]
  );

  const switchMode = useCallback((next: Mode) => {
    seq.current++;
    setMode(next);
    setQuery('');
    setResults([]);
    setNotFound(false);
    setSearching(false);
  }, []);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
          <Icon name="back" size={26} color="#FFFFFF" />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Add contact
        </Text>
      </View>

      <View style={styles.body}>
        <View style={[styles.segment, { backgroundColor: theme.colors.surfaceAlt }]}>
          {(['username', 'email'] as const).map((m) => {
            const active = mode === m;
            return (
              <Pressable
                key={m}
                onPress={() => switchMode(m)}
                accessibilityRole="button"
                accessibilityLabel={m === 'username' ? 'Search by username' : 'Search by email'}
                accessibilityState={{ selected: active }}
                style={[
                  styles.segmentItem,
                  active && { backgroundColor: theme.colors.surface },
                ]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: active ? theme.colors.text : theme.colors.textMuted },
                  ]}
                >
                  {m === 'username' ? 'Username' : 'Email'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.label, { color: theme.colors.textMuted }]}>
          {mode === 'username'
            ? 'Search for someone by their full @username.'
            : 'Enter the exact email address of the person you want to add.'}
        </Text>

        <View style={[styles.field, { borderColor: theme.colors.border }]}>
          <Icon
            name={mode === 'username' ? 'personSearch' : 'search'}
            size={20}
            color={theme.colors.textMuted}
          />
          <TextInput
            value={query}
            onChangeText={(v) => {
              setQuery(v);
              if (mode === 'email') {
                setResults([]);
                setNotFound(false);
              }
            }}
            onSubmitEditing={() => {
              if (mode === 'email') void runEmailSearch();
            }}
            placeholder={mode === 'username' ? '@username' : 'name@example.com'}
            placeholderTextColor={theme.colors.textFaint}
            style={[styles.input, { color: theme.colors.text }]}
            keyboardType={mode === 'email' ? 'email-address' : 'default'}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="search"
            accessibilityLabel={mode === 'username' ? 'Username' : 'Email address'}
          />
          {searching ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : null}
        </View>

        {mode === 'email' ? (
          <Pressable
            onPress={() => void runEmailSearch()}
            disabled={searching || query.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Search"
            accessibilityState={{ disabled: searching || query.trim().length === 0 }}
            style={[
              styles.primary,
              {
                backgroundColor:
                  query.trim().length === 0 ? theme.colors.surfaceAlt : theme.colors.accent,
              },
            ]}
          >
            {searching ? (
              <ActivityIndicator size="small" color={theme.colors.accentText} />
            ) : (
              <Text style={[styles.primaryText, { color: theme.colors.accentText }]}>
                Search
              </Text>
            )}
          </Pressable>
        ) : null}

        {notFound && !searching ? (
          <View style={styles.note}>
            <Icon name="info" size={18} color={theme.colors.textMuted} />
            <Text style={[styles.noteText, { color: theme.colors.textMuted }]}>
              {mode === 'username'
                ? 'No Flyer account uses that username.'
                : 'No Flyer account uses that email address.'}
            </Text>
          </View>
        ) : null}

        <FlatList
          data={results}
          keyExtractor={(item) => item.uid}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={[styles.card, { borderColor: theme.colors.border }]}>
              <Avatar
                uri={item.photoURL}
                name={item.name ?? ''}
                uid={item.uid}
                size={56}
                // The callable withholds the photo of anyone whose privacy hides
                // it, so a URL that arrived here is one we are allowed to show.
                showPhoto
              />
              <View style={styles.cardText}>
                <Text style={[styles.cardName, { color: theme.colors.text }]} numberOfLines={1}>
                  {item.name ?? 'Flyer user'}
                </Text>
                <Text
                  style={[styles.cardEmail, { color: theme.colors.textMuted }]}
                  numberOfLines={1}
                >
                  {item.username ? `@${item.username}` : (item.email ?? '')}
                </Text>
              </View>

              <ResultAction
                state={myUid ? relationshipWith(myUid, item.uid) : null}
                sending={sending === item.uid}
                onSend={() => void onSend(item)}
                onOpenRequests={() => router.push('/requests')}
              />
            </View>
          )}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

/** The one button whose label depends entirely on the existing relationship. */
function ResultAction({
  state,
  sending,
  onSend,
  onOpenRequests,
}: {
  state: RelationshipState | null;
  sending: boolean;
  onSend: () => void;
  onOpenRequests: () => void;
}) {
  const theme = useTheme();

  if (state === 'contact') {
    return (
      <View style={styles.pill}>
        <Icon name="accept" size={18} color={theme.colors.success} />
        <Text style={[styles.pillText, { color: theme.colors.success }]}>Added</Text>
      </View>
    );
  }

  if (state === 'outgoing') {
    return (
      <View style={styles.pill}>
        <Icon name="clock" size={18} color={theme.colors.textMuted} />
        <Text style={[styles.pillText, { color: theme.colors.textMuted }]}>Requested</Text>
      </View>
    );
  }

  if (state === 'incoming') {
    return (
      <Pressable
        onPress={onOpenRequests}
        accessibilityRole="button"
        accessibilityLabel="Answer their request"
        style={[styles.action, { backgroundColor: theme.colors.accent }]}
      >
        <Text style={[styles.actionText, { color: theme.colors.accentText }]}>Respond</Text>
      </Pressable>
    );
  }

  if (state === 'blocked') {
    return (
      <View style={styles.pill}>
        <Icon name="block" size={18} color={theme.colors.danger} />
        <Text style={[styles.pillText, { color: theme.colors.danger }]}>Blocked</Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onSend}
      disabled={sending}
      accessibilityRole="button"
      accessibilityLabel="Send contact request"
      accessibilityState={{ disabled: sending }}
      style={[styles.action, { backgroundColor: theme.colors.accent }]}
    >
      {sending ? (
        <ActivityIndicator size="small" color={theme.colors.accentText} />
      ) : (
        <Text style={[styles.actionText, { color: theme.colors.accentText }]}>Add</Text>
      )}
    </Pressable>
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
  body: { flex: 1, padding: 20, gap: 16 },
  segment: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  segmentItem: {
    flex: 1,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { fontSize: 14, fontWeight: '600' },
  list: { gap: 10, paddingBottom: 24 },
  label: { fontSize: 14, lineHeight: 20 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 52,
  },
  input: { flex: 1, fontSize: 16, padding: 0 },
  primary: {
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 16, fontWeight: '600' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  noteText: { fontSize: 14, flex: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 14,
  },
  cardText: { flex: 1, gap: 3 },
  cardName: { fontSize: 16, fontWeight: '600' },
  cardEmail: { fontSize: 13 },
  action: {
    minWidth: 78,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  actionText: { fontSize: 14, fontWeight: '700' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pillText: { fontSize: 13, fontWeight: '600' },
});

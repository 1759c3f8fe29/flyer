import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Application from 'expo-application';
import { DEFAULT_PRIVACY, type PrivacySettings } from '@/src/config/types';
import { persistThemeMode, useTheme } from '@/src/theme/ThemeProvider';
import { Icon } from '@/src/components/Icon';
import { Pressable } from '@/src/components/Pressable';
import { ListRow } from '@/src/components/ListRow';
import { Switch } from '@/src/components/Switch';
import { alertError } from '@/src/components/Confirm';
import { Paths, update } from '@/src/services/FirebaseService';
import { useAppStore } from '@/src/services/StateManager';
import {
  check,
  openSettings,
  request,
  type PermissionResult,
} from '@/src/services/PermissionManager';
import {
  isSmartReplyEnabled,
  setSmartReplyEnabled,
  subscribeSmartReply,
} from '@/src/services/SmartReplyService';

type ThemeMode = 'system' | 'light' | 'dark';

const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System default' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

const PRIVACY_ROWS: {
  key: keyof PrivacySettings;
  title: string;
  subtitle: string;
}[] = [
  {
    key: 'showLastSeen',
    title: 'Last seen & online',
    subtitle: 'Let others see when you were last active',
  },
  { key: 'showPhoto', title: 'Profile photo', subtitle: 'Show your photo to other people' },
  { key: 'showAbout', title: 'About', subtitle: 'Show your about text on your profile' },
  { key: 'readReceipts', title: 'Read receipts', subtitle: 'Send blue ticks when you read a message' },
  { key: 'hidePreview', title: 'Hide message previews', subtitle: 'Lock-screen notifications show “New message” instead' },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const me = useAppStore((s) => s.currentUser);
  const themeMode = useAppStore((s) => s.themeMode);
  const patchCurrentUser = useAppStore((s) => s.patchCurrentUser);

  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [smartReply, setSmartReply] = useState(() => isSmartReplyEnabled());
  const [notifications, setNotifications] = useState<PermissionResult | null>(null);

  useEffect(() => subscribeSmartReply(setSmartReply), []);

  const refreshNotifications = useCallback(() => {
    check('notifications')
      .then(setNotifications)
      .catch(() => setNotifications('denied'));
  }, []);

  useEffect(refreshNotifications, [refreshNotifications]);

  const uid = me?.uid ?? null;
  const privacy = me?.privacy ?? DEFAULT_PRIVACY;

  const setPrivacy = useCallback(
    async (key: keyof PrivacySettings, value: boolean) => {
      if (!uid || savingPrivacy) return;
      const next: PrivacySettings = { ...privacy, [key]: value };

      // Optimistic: the switch must move on the same frame as the tap.
      patchCurrentUser({ privacy: next });
      setSavingPrivacy(true);
      try {
        await update(Paths.user(uid), { privacy: next });
      } catch (e) {
        console.warn('[Flyer/settings] privacy write failed', e);
        patchCurrentUser({ privacy });
        alertError('Could not save', 'Your privacy setting was not changed.');
      } finally {
        setSavingPrivacy(false);
      }
    },
    [uid, privacy, savingPrivacy, patchCurrentUser]
  );

  const onSmartReply = useCallback(async (value: boolean) => {
    setSmartReply(value);
    try {
      await setSmartReplyEnabled(value);
    } catch (e) {
      console.warn('[Flyer/settings] smart reply toggle failed', e);
      setSmartReply(!value);
      alertError('Could not save', 'Smart replies were not changed.');
    }
  }, []);

  const onNotificationAction = useCallback(async () => {
    if (notifications === 'granted') return;
    if (notifications === 'blocked') {
      openSettings();
      return;
    }
    const result = await request('notifications');
    setNotifications(result);
    if (result === 'blocked') openSettings();
  }, [notifications]);

  const notificationCopy =
    notifications === 'granted'
      ? { value: 'Enabled', subtitle: 'Messages and calls can reach you when Flyer is closed.' }
      : notifications === 'blocked'
        ? { value: 'Open settings', subtitle: 'Notifications are turned off in system settings.' }
        : notifications === 'denied'
          ? { value: 'Enable', subtitle: 'You will not be told about new messages or calls.' }
          : { value: '', subtitle: 'Checking…' };

  const version = Application.nativeApplicationVersion ?? '1.0.0';
  const build = Application.nativeBuildVersion;

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
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <SectionHeader label="Appearance" />
        {THEME_MODES.map(({ mode, label }) => (
          <ListRow
            key={mode}
            icon={mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'settings'}
            title={label}
            onPress={() => void persistThemeMode(mode)}
            right={
              themeMode === mode ? (
                <Icon name="check" size={20} color={theme.colors.accent} />
              ) : undefined
            }
          />
        ))}

        <SectionHeader label="Privacy" />
        {PRIVACY_ROWS.map((row) => (
          <React.Fragment key={row.key}>
            <ListRow
              title={row.title}
              subtitle={row.subtitle}
              right={
                <Switch
                  value={privacy[row.key]}
                  onValueChange={(v) => void setPrivacy(row.key, v)}
                  // A second tap mid-save used to be silently swallowed by the
                  // savingPrivacy guard with no visual feedback; disabling
                  // shows the control is busy instead of ignoring the user.
                  disabled={!uid || savingPrivacy}
                  accessibilityLabel={row.title}
                />
              }
            />
            {row.key === 'readReceipts' ? (
              <Caption text="If you turn off read receipts, you won't be able to see them from other people either." />
            ) : null}
          </React.Fragment>
        ))}

        <SectionHeader label="AI" />
        <ListRow
          title="Smart replies"
          right={
            <Switch
              value={smartReply}
              onValueChange={(v) => void onSmartReply(v)}
              accessibilityLabel="Smart replies"
            />
          }
        />
        <Caption text="When on, your recent messages in a chat are sent to AI to generate reply suggestions. Off by default." />

        <SectionHeader label="Notifications" />
        <ListRow
          icon="unmute"
          title="Push notifications"
          subtitle={notificationCopy.subtitle}
          value={notificationCopy.value}
          onPress={notifications === 'granted' ? undefined : () => void onNotificationAction()}
          showChevron={notifications !== 'granted' && notifications !== null}
        />

        <SectionHeader label="Chats" />
        <ListRow
          icon="star"
          title="Starred messages"
          onPress={() => router.push('/starred')}
          showChevron
        />

        <SectionHeader label="About" />
        <ListRow icon="info" title="Version" value={build ? `${version} (${build})` : version} />
        <ListRow
          icon="privacy"
          title="Media storage"
          subtitle="Photos, videos and voice notes you send are stored on Cloud."
        />
      </ScrollView>
    </View>
  );
}

function SectionHeader({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <Text style={[styles.sectionHeader, { color: theme.colors.accent }]}>{label}</Text>
  );
}

function Caption({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text style={[styles.caption, { color: theme.colors.textMuted }]}>{text}</Text>
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
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  caption: {
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 2,
  },
});

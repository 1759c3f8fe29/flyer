import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { Stack, router, useRootNavigationState, useSegments } from 'expo-router';
import { ThemeProvider, useTheme } from '@/src/theme/ThemeProvider';
import { Banner, type BannerPayload } from '@/src/components/Banner';
import { NetworkBanner } from '@/src/components/NetworkBanner';
import { CallOverlay } from '@/src/components/CallOverlay';
import { useAppStore, appState } from '@/src/services/StateManager';
import * as Auth from '@/src/services/AuthManager';
import * as Notifications from '@/src/services/NotificationManager';
import { startPresence, stopPresence } from '@/src/services/PresenceManager';
import { requestStartupPermissions } from '@/src/services/PermissionManager';
import { CallManager } from '@/src/services/CallManager';
import {
  listenToChats,
  listenToBlocks,
  listenToUser,
  stopTypingTimers,
} from '@/src/services/ChatEngine';
import { listenToContacts, listenToRequests } from '@/src/services/ContactService';
import { startOutbox, stopOutbox } from '@/src/services/OfflineQueue';
import { hydrateSmartReply } from '@/src/services/SmartReplyService';
import { Paths, onValue } from '@/src/services/FirebaseService';
import type { UserProfile } from '@/src/config/types';

/**
 * Root layout.
 *
 * Owns every session-scoped subscription in the app: presence, the chat-list
 * listener, the block list, push registration, the offline outbox, and the call
 * manager's incoming-invite listener. All of them are keyed on the signed-in uid
 * and torn down on sign-out — a listener that outlives its session keeps writing
 * with stale credentials and, in the case of presence, leaves the user pinned
 * "online" forever.
 *
 * The FCM *background* handler is not here. It is registered in index.js before
 * this module is even imported, because Android delivers the data message that
 * woke the process before React mounts.
 */

// Keep the native splash up until auth has resolved, so the app never flashes
// the login screen at someone who is already signed in.
void SplashScreen.preventAutoHideAsync().catch(() => {});

function useAuthGate() {
  const currentUser = useAppStore((s) => s.currentUser);
  const authReady = useAppStore((s) => s.authReady);
  const segments = useSegments();
  const navState = useRootNavigationState();

  const inAuthFlow = segments[0] === 'login';
  // The redirect below lands an effect late — one painted frame after the router
  // has already drawn the wrong screen. On a cold start the URL is `/`, so a
  // signed-out user watches the empty chat list appear and vanish on the way to
  // the login screen. This flag lets the caller cover that frame.
  const redirecting = authReady && (currentUser ? inAuthFlow : !inAuthFlow);

  useEffect(() => {
    // Navigating before the router has mounted throws; wait for it.
    if (!navState?.key || !authReady) return;

    if (!currentUser && !inAuthFlow) {
      router.replace('/login');
    } else if (currentUser && inAuthFlow) {
      router.replace('/(tabs)');
    }
  }, [currentUser, authReady, inAuthFlow, navState?.key]);

  return redirecting;
}

function RootNavigator() {
  const theme = useTheme();
  const authReady = useAppStore((s) => s.authReady);
  const [banner, setBanner] = useState<BannerPayload | null>(null);

  const redirecting = useAuthGate();

  /**
   * Drop the splash the moment the app can actually paint, and not before.
   *
   * `authReady` is the real signal: for a signed-in user it flips when the first
   * profile snapshot lands, and for a signed-out one `reset()` sets it, so both
   * paths converge here. Hiding from inside the auth callback instead — which is
   * what this used to do — dismissed the splash while `authReady` was still
   * false, and the boot spinner below got a frame of screen time on every cold
   * start.
   */
  useEffect(() => {
    if (authReady) void SplashScreen.hideAsync().catch(() => {});
  }, [authReady]);

  // --- auth session ------------------------------------------------------
  useEffect(() => {
    // Env validation and the outbox sender registration both happen at module
    // scope — env.ts logs missing config on import, and ChatEngine calls
    // registerSender when it is first imported (which the import above does).
    void hydrateSmartReply();

    let sessionTeardown: (() => void)[] = [];
    let activeUid: string | null = null;

    const teardownSession = () => {
      for (const off of sessionTeardown) {
        try {
          off();
        } catch {
          /* a failed unsubscribe must not block the rest */
        }
      }
      sessionTeardown = [];

      if (activeUid) {
        stopPresence();
        stopOutbox();
        // Module-level timers in ChatEngine; without this a pending typing timer
        // fires under whoever signs in next.
        stopTypingTimers();
        Notifications.stop();
        CallManager.detach();
      }
      activeUid = null;
    };

    const offAuth = Auth.onAuthChanged(async (user) => {
      if (!user) {
        teardownSession();
        appState.get().reset();
        return;
      }

      // Re-firing for the same uid (a token refresh) must not double-subscribe.
      if (activeUid === user.uid) return;
      teardownSession();
      activeUid = user.uid;

      try {
        await Auth.upsertProfile(user);
      } catch (e) {
        console.warn('[Flyer/boot] profile upsert failed', e);
      }

      // Own profile: drives the header, and privacy settings the whole UI reads.
      const offMe = onValue(Paths.user(user.uid), (snap) => {
        const profile = snap.val() as UserProfile | null;
        if (profile) {
          appState.get().setCurrentUser({ ...profile, uid: user.uid });
        }
        appState.get().setAuthReady(true);
      });

      const offChats = listenToChats(user.uid);
      const offBlocks = listenToBlocks(user.uid);
      const offSelf = listenToUser(user.uid);
      const offContacts = listenToContacts(user.uid);
      const offRequests = listenToRequests(user.uid);

      startPresence(user.uid);
      startOutbox(user.uid);
      CallManager.attach(user.uid);

      /**
       * Ask for POST_NOTIFICATIONS *before* registering for push.
       *
       * On Android 13+ (targetSdk is 35) the permission is deny-by-default and
       * has to be requested at runtime. Nothing was requesting it: `start()`
       * fetches an FCM token and attaches the message listeners, which all
       * succeed regardless, so the token landed in RTDB, Cloud Functions sent to
       * it, and Android dropped every notification on the floor. No message
       * alerts, and no ringing for calls that arrive while Flyer is closed —
       * with no error anywhere to explain it.
       *
       * Sequenced ahead of `start()` rather than in parallel so the token is
       * only published once the OS will actually surface what we send to it.
       * Deliberately not blocking: a denial is a valid choice, and the rest of
       * the session (chats, presence, calls in the foreground) works fine
       * without it, so the failure is logged and the app carries on.
       */
      void requestStartupPermissions()
        .catch((e) => {
          console.warn('[Flyer/boot] notification permission request failed', e);
        })
        .finally(() => {
          void Notifications.start(user.uid);
        });

      sessionTeardown = [offMe, offChats, offBlocks, offSelf, offContacts, offRequests];
    });

    return () => {
      offAuth();
      teardownSession();
    };
  }, []);

  // --- foreground notification plumbing ----------------------------------
  useEffect(() => {
    Notifications.setNavigator((path) => {
      // The notification can land before the router is ready on a cold start;
      // NotificationManager already defers the initial one, and replace() here
      // is safe for the rest.
      try {
        router.push(path as never);
      } catch (e) {
        console.warn('[Flyer/nav] deferred navigation failed', e);
      }
    });
    Notifications.setBannerHandler((payload) => setBanner(payload));
  }, []);

  const openBanner = useCallback(() => {
    const chatId = banner?.chatId;
    setBanner(null);
    if (chatId) router.push(`/chat/${chatId}`);
  }, [banner?.chatId]);

  if (!authReady) {
    return (
      <View style={[styles.boot, { backgroundColor: theme.colors.bg }]}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />

      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" options={{ animation: 'fade' }} />
        <Stack.Screen name="chat/[chatId]" />
        <Stack.Screen name="user/[uid]" />
        <Stack.Screen name="group/[chatId]" />
        <Stack.Screen name="new-group" />
        <Stack.Screen name="add-contact" options={{ presentation: 'modal' }} />
        <Stack.Screen name="requests" />
        <Stack.Screen name="forward" options={{ presentation: 'modal' }} />
        <Stack.Screen name="profile" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="starred" />
        <Stack.Screen name="archived" />
        {/* Full-screen and gesture-free: a swipe-back mid-call would leave the
            peer connection alive behind the chat list. */}
        <Stack.Screen
          name="call"
          options={{ animation: 'fade', gestureEnabled: false, presentation: 'fullScreenModal' }}
        />
      </Stack>

      {/* Covers the frame between "wrong screen mounted" and the gate's
          replace() landing. An overlay rather than an early return on purpose:
          unmounting the Stack takes the navigator with it, so
          useRootNavigationState().key goes undefined, the gate's own
          `if (!navState?.key) return` never clears, and the app sits here
          forever. Background only — the window is a frame or two, and a spinner
          that brief is the flicker it is meant to hide. */}
      {redirecting ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.bg }]}
        />
      ) : null}

      <NetworkBanner />
      <CallOverlay />
      <Banner banner={banner} onPress={openBanner} onDismiss={() => setBanner(null)} />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <RootNavigator />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

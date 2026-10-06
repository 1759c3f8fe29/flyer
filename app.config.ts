import fs from 'fs';
import path from 'path';
import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Flyer — app config.
 *
 * Values that differ per-environment come from `.env` (see `.env.example`).
 * `EXPO_PUBLIC_*` vars are inlined into the JS bundle by Metro; everything the
 * client needs is public by definition (Cloudinary unsigned preset, OAuth client
 * IDs, Firebase web config). Nothing secret lives here — the FCM service account
 * stays in Cloud Functions.
 */

const PACKAGE = 'com.flyer.chat';

/**
 * Resolve a native Firebase config file, or undefined if it is not on disk.
 *
 * Expo validates `googleServicesFile` strictly: naming a path that does not
 * exist fails the whole config with "Could not parse Expo config", which breaks
 * `expo config`, `expo export` and every EAS build — including Android builds
 * that have nothing to do with the missing iOS plist. Returning undefined omits
 * the key instead, so the platform is simply unconfigured until someone adds
 * the file, which is the honest state of an Android-first project.
 */
function firebaseConfigFile(envVar: string | undefined, fallback: string): string | undefined {
  const candidate = envVar ?? fallback;
  return fs.existsSync(path.resolve(__dirname, candidate)) ? candidate : undefined;
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Flyer',
  // Must match the slug of the EAS project in extra.eas.projectId, which is not
  // "flyer" — that project lives on a different account. The user-visible name
  // above is what shows on the device; this is only the EAS project handle.
  slug: 'a007light',
  // The EAS account that owns the project referenced by extra.eas.projectId.
  // Required because the signed-in account is a member of several orgs: without
  // it, EAS cannot tell which one this slug belongs to and refuses to build.
  owner: 'a007firsts-team',
  scheme: 'flyer',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // Off deliberately. react-native-callkeep, react-native-incall-manager and
  // react-native-webrtc are all old-architecture modules — none has a Fabric or
  // TurboModule spec. All three register during native init, before JS runs, so
  // under the New Architecture the process dies at launch with no JS error to
  // catch: splash, then straight back to the launcher. Calls are core to this
  // app, so the interop layer is not worth betting startup on.
  newArchEnabled: false,
  assetBundlePatterns: ['**/*'],
  // Regenerate with `python3 tools/gen-assets.py` if the mark ever changes.
  icon: './assets/icon.png',

  ios: {
    bundleIdentifier: PACKAGE,
    supportsTablet: false,
    googleServicesFile: firebaseConfigFile(
      process.env.GOOGLE_SERVICES_PLIST,
      './GoogleService-Info.plist'
    ),
    infoPlist: {
      UIBackgroundModes: ['audio', 'voip', 'remote-notification', 'fetch'],
      NSCameraUsageDescription:
        'Flyer uses the camera for video calls and to capture photos and videos you send in chats.',
      NSMicrophoneUsageDescription:
        'Flyer uses the microphone for voice and video calls and to record voice notes.',
      NSPhotoLibraryUsageDescription:
        'Flyer needs access to your photos so you can send images and videos in chats.',
      NSPhotoLibraryAddUsageDescription: 'Flyer saves media you download from chats.',
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      // Production only: dev/preview builds use the APNs sandbox, and a
      // hardcoded `production` here breaks pushes on every non-store build.
      // Omitted elsewhere so Expo resolves it from the provisioning profile.
      ...(process.env.EAS_BUILD_PROFILE === 'production'
        ? { 'aps-environment': 'production' }
        : {}),
    },
  },

  android: {
    package: PACKAGE,
    googleServicesFile: firebaseConfigFile(
      process.env.GOOGLE_SERVICES_JSON,
      './google-services.json'
    ),
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0B141A',
    },
    // The remaining permissions (telecom, full-screen intent, foreground service
    // types) are injected by ./plugins/withFlyerCallKeep so they stay next to the
    // ConnectionService declaration that requires them.
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.VIBRATE',
      'android.permission.WAKE_LOCK',
    ],
  },

  plugins: [
    'expo-router',
    '@react-native-firebase/app',
    '@react-native-firebase/auth',
    './plugins/withFlyerNotificationIcon',
    '@config-plugins/react-native-webrtc',
    './plugins/withFlyerCallKeep',
    [
      '@react-native-google-signin/google-signin',
      {
        // Reversed iOS OAuth client ID, e.g. com.googleusercontent.apps.1234-abcd.
        // No placeholder default: a bogus scheme baked into the build fails
        // iOS Google Sign-In opaquely. Supply the real value via EAS secrets;
        // when absent the plugin is configured without a scheme.
        ...(process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME
          ? { iosUrlScheme: process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME }
          : {}),
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          // react-native-webrtc requires 24+; callkeep's ConnectionService requires 23+.
          minSdkVersion: 24,
          compileSdkVersion: 35,
          targetSdkVersion: 35,
        },
        ios: {
          // Required by @react-native-firebase when not using Swift Package Manager.
          useFrameworks: 'static',
          deploymentTarget: '15.1',
        },
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 180,
        resizeMode: 'contain',
        backgroundColor: '#0B141A',
        dark: { backgroundColor: '#0B141A' },
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Flyer needs access to your photos so you can send images and videos in chats.',
        cameraPermission: 'Flyer uses the camera to capture photos and videos you send in chats.',
      },
    ],
    [
      'expo-av',
      { microphonePermission: 'Flyer uses the microphone to record voice notes.' },
    ],
  ],

  experiments: {
    typedRoutes: true,
  },
 
  extra: {
    router: {},
    // No fallback id.  A placeholder here is worse than nothing: `eas init` reads
    // this field to decide whether the project is already linked, so a fake uuid
    // makes it skip linking and then fail looking the fake up.  Left undefined,
    // `eas init` creates the project and prints the real id, which goes in `.env`.
    eas: {
      projectId: '5725af5d-1a29-47d3-af21-bde2e6cece80',
    },
  },
});

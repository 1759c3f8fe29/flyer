import auth from '@react-native-firebase/auth';
import type { FirebaseAuthTypes } from '@react-native-firebase/auth';
import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { Env } from '@/src/config/env';
import { DEFAULT_PRIVACY, type UserProfile } from '@/src/config/types';
import { Paths, fanOut, readOnce, serverTimestamp, update } from './FirebaseService';
import { claimInitialUsername, releaseUsername } from './UsernameService';
import { clearAllDrafts } from './DraftService';

/**
 * AuthManager — Google Sign-In + Email/Password.
 *
 * Note on the deviation from "Expo AuthSession": we use the native Google
 * Sign-In module rather than AuthSession because the rest of the app depends on
 * @react-native-firebase (required for the FCM background handler that rings
 * incoming calls on a killed app). Mixing the Firebase JS SDK's auth state with
 * RNFirebase's native auth state produces two independent sessions, and the
 * native listeners would not see the JS SDK's user. AuthSession would still work
 * for obtaining an idToken, but the native module additionally gives us silent
 * re-auth on cold start, which is what makes "auto login persistence" reliable.
 */

let configured = false;

export function configureGoogleSignIn() {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: Env.googleWebClientId,
    iosClientId: Env.googleIosClientId || undefined,
    offlineAccess: false,
    scopes: ['profile', 'email'],
  });
  configured = true;
}

export class GoogleSignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'GoogleSignInCancelled';
  }
}

/**
 * Sign up with email and password. Creates a new Firebase Auth account and
 * upserts the profile. Throws if the email is already in use or the password
 * is too weak (Firebase enforces >=6 characters).
 */
export async function signUpWithEmail(
  email: string,
  password: string
): Promise<FirebaseAuthTypes.User> {
  const { user } = await auth().createUserWithEmailAndPassword(email, password);
  await upsertProfile(user);
  return user;
}

/**
 * Sign in with email and password. Throws if the credentials are wrong or the
 * account does not exist.
 */
export async function signInWithEmail(
  email: string,
  password: string
): Promise<FirebaseAuthTypes.User> {
  const { user } = await auth().signInWithEmailAndPassword(email, password);
  await upsertProfile(user);
  return user;
}

/** Interactive Google sign-in. Throws GoogleSignInCancelled if the user backs out. */
export async function signInWithGoogle(): Promise<FirebaseAuthTypes.User> {
  configureGoogleSignIn();

  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

  let idToken: string | null = null;
  try {
    const result = await GoogleSignin.signIn();
    // v13 returns { type, data }, older returns the user object directly.
    // Handle both so a minor bump doesn't silently break login.
    const anyResult = result as unknown as {
      type?: string;
      data?: { idToken?: string | null };
      idToken?: string | null;
    };
    if (anyResult.type === 'cancelled') throw new GoogleSignInCancelled();
    idToken = anyResult.data?.idToken ?? anyResult.idToken ?? null;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === statusCodes.SIGN_IN_CANCELLED) throw new GoogleSignInCancelled();
    throw e;
  }

  if (!idToken) {
    // Almost always a webClientId/SHA-1 mismatch rather than a transient error.
    throw new Error(
      'Google returned no idToken. Check EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID and that ' +
        'your release/debug SHA-1 fingerprints are registered in the Firebase console.'
    );
  }

  const credential = auth.GoogleAuthProvider.credential(idToken);
  const { user } = await auth().signInWithCredential(credential);
  await upsertProfile(user);
  return user;
}

/**
 * Create the profile on first login; on subsequent logins refresh only the
 * fields Google owns. Name/photo/about are deliberately NOT overwritten if the
 * user has edited them locally — otherwise every login would revert their edits.
 */
export async function upsertProfile(user: FirebaseAuthTypes.User): Promise<void> {
  const existing = await readOnce<UserProfile>(Paths.user(user.uid));

  if (!existing) {
    const name = user.displayName ?? user.email?.split('@')[0] ?? 'Flyer user';
    await update(Paths.user(user.uid), {
      uid: user.uid,
      name,
      username: null,
      email: user.email ?? '',
      photoURL: user.photoURL ?? null,
      about: 'Available',
      online: true,
      lastSeen: serverTimestamp(),
      createdAt: serverTimestamp(),
      privacy: DEFAULT_PRIVACY,
    });
    // After the profile exists, not before: the username field's rule checks the
    // claim, and the claim is meaningless without a profile to point at.
    // Best-effort — a null handle is valid and the profile screen can set one.
    try {
      await claimInitialUsername(user.uid, name, user.email ?? '');
    } catch (e) {
      console.warn('[Flyer/auth] could not auto-assign a username', e);
    }
    return;
  }

  await update(Paths.user(user.uid), {
    email: user.email ?? existing.email,
    online: true,
    lastSeen: serverTimestamp(),
    // Backfill for profiles created before these fields existed.
    privacy: existing.privacy ?? DEFAULT_PRIVACY,
    about: existing.about ?? 'Available',
  });

  // Accounts that predate usernames get one on their next login.
  if (!existing.username) {
    try {
      await claimInitialUsername(user.uid, existing.name ?? '', user.email ?? '');
    } catch (e) {
      console.warn('[Flyer/auth] could not backfill a username', e);
    }
  }
}

/** Sends a reset link. Resolves even when the address has no account, so the
 * screen cannot be used to enumerate which emails are registered. */
export async function sendPasswordReset(email: string): Promise<void> {
  try {
    await auth().sendPasswordResetEmail(email);
  } catch (e) {
    if ((e as { code?: string }).code === 'auth/user-not-found') return;
    throw e;
  }
}

/**
 * Firebase auth codes are not user-facing strings ("auth/invalid-credential").
 * Map the ones an email flow can actually produce; anything unmapped falls back
 * to the raw message rather than a generic lie about what went wrong.
 */
export function authErrorMessage(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address is not valid.';
    case 'auth/email-already-in-use':
      return 'An account already exists with that email. Sign in instead.';
    case 'auth/weak-password':
      return 'Use at least 6 characters for your password.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      // Deliberately one message for all three: saying "no such user" tells an
      // attacker which addresses are registered.
      return 'Wrong email or password.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Try again in a few minutes.';
    case 'auth/network-request-failed':
      return 'No connection. Check your internet and try again.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in is not enabled for this project yet.';
    default:
      return (e as Error)?.message ?? 'Something went wrong. Try again.';
  }
}

/** Restores a session silently on cold start. Returns null when signed out. */
export function currentUser(): FirebaseAuthTypes.User | null {
  return auth().currentUser;
}

export function onAuthChanged(
  cb: (user: FirebaseAuthTypes.User | null) => void
): () => void {
  return auth().onAuthStateChanged(cb);
}

/**
 * Full sign-out. Order matters: clear presence and the push token while we
 * still have write permission, then drop the Firebase session.
 */
export async function signOut(uid: string, token: string | null): Promise<void> {
  const updates: Record<string, unknown> = {
    [`${Paths.userPresence(uid)}`]: false,
    [`${Paths.userLastSeen(uid)}`]: serverTimestamp(),
  };
  // Stripping the token stops this device receiving pushes for an account it is
  // no longer signed into.
  if (token) updates[Paths.userToken(uid, token)] = null;

  try {
    await fanOut(updates);
  } catch (e) {
    console.warn('[Flyer/auth] failed to clear presence on sign-out', e);
  }

  try {
    configureGoogleSignIn();
    await GoogleSignin.signOut();
  } catch {
    // Non-fatal: the Firebase sign-out below is what actually ends the session.
  }

  await auth().signOut();
}

export async function deleteAccount(uid: string): Promise<void> {
  // Release the handle first and on its own: the rules only permit the owner to
  // delete their claim, and once `users/{uid}` is gone there is no owner left to
  // do it — the handle would be locked out of circulation forever.
  const profile = await readOnce<UserProfile>(Paths.user(uid));
  if (profile?.username) {
    try {
      await releaseUsername(profile.username);
    } catch (e) {
      console.warn('[Flyer/auth] could not release username on delete', e);
    }
  }

  await fanOut({
    [Paths.user(uid)]: null,
    [Paths.userTokens(uid)]: null,
    [Paths.starred(uid)]: null,
    [Paths.blocks(uid)]: null,
    [Paths.callHistory(uid)]: null,
    [Paths.contacts(uid)]: null,
    [Paths.requests(uid)]: null,
    [Paths.sentRequests(uid)]: null,
  });

  // Local unsent text outlives the server data otherwise: drafts are keyed by
  // uid and nothing else ever removes them, so a deleted account would leave
  // its half-written messages readable by the next person to use the device.
  await clearAllDrafts(uid);

  await auth().currentUser?.delete();
}

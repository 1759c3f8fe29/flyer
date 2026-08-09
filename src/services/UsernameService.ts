import { Paths, fanOut, readOnce } from './FirebaseService';
import { appState } from './StateManager';
import type { UserProfile } from '../config/types';

/**
 * Usernames.
 *
 * RTDB has no unique constraint, so uniqueness is a protocol rather than a
 * schema property: `usernames/{handle}` may only be created when it does not
 * already exist (enforced in the rules), and `users/{uid}/username` is only
 * valid while the matching claim points back at that uid. Both are written in
 * one fan-out, so a handle can never be claimed without the profile agreeing.
 */

export const USERNAME_PATTERN = /^[a-z0-9_.]{3,24}$/;

/** Names that would be confusing or that we want to keep for routes. */
const RESERVED = new Set([
  'admin',
  'support',
  'help',
  'flyer',
  'system',
  'root',
  'me',
  'you',
  'settings',
  'about',
  'null',
  'undefined',
]);

export class UsernameError extends Error {}

/** Returns null when valid, or a human-readable reason when not. */
export function validateUsername(raw: string): string | null {
  const handle = raw.trim().toLowerCase();

  if (handle.length === 0) return 'Enter a username.';
  if (handle.length < 3) return 'Usernames are at least 3 characters.';
  if (handle.length > 24) return 'Usernames are at most 24 characters.';
  if (!USERNAME_PATTERN.test(handle)) {
    return 'Use only lowercase letters, numbers, dots and underscores.';
  }
  if (handle.startsWith('.') || handle.endsWith('.')) {
    return 'Usernames cannot start or end with a dot.';
  }
  if (handle.includes('..')) return 'Usernames cannot contain two dots in a row.';
  if (RESERVED.has(handle)) return 'That username is reserved.';

  return null;
}

export function normaliseUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Availability check. Advisory only — two people can pass this at the same
 * instant, which is why the actual claim still relies on the create-only rule.
 */
export async function isUsernameAvailable(raw: string, myUid: string): Promise<boolean> {
  const handle = normaliseUsername(raw);
  if (validateUsername(handle)) return false;

  const owner = await readOnce<string>(Paths.username(handle));
  return owner === null || owner === myUid;
}

/**
 * Claim a handle, releasing the previous one in the same write.
 *
 * The release has to be part of the fan-out: doing it first would strand the
 * user with no handle if the claim then failed, and doing it after would leak
 * the old one forever on a crash.
 */
export async function setUsername(myUid: string, raw: string): Promise<void> {
  const handle = normaliseUsername(raw);
  const invalid = validateUsername(handle);
  if (invalid) throw new UsernameError(invalid);

  const current = appState.get().currentUser?.username ?? null;
  if (current === handle) return;

  const owner = await readOnce<string>(Paths.username(handle));
  if (owner !== null && owner !== myUid) {
    throw new UsernameError('That username is taken.');
  }

  const updates: Record<string, unknown> = {
    [Paths.username(handle)]: myUid,
    [Paths.userUsername(myUid)]: handle,
  };
  if (current && current !== handle) updates[Paths.username(current)] = null;

  try {
    await fanOut(updates);
  } catch {
    // The only rule that can reject a well-formed claim is the create-only
    // guard, which means somebody took it between the check and the write.
    throw new UsernameError('That username was just taken. Try another.');
  }

  appState.get().patchCurrentUser({ username: handle });
}

/**
 * Claim a handle at signup, without prompting.
 *
 * Best-effort by design: it tries the suggestion, then a few numeric variants,
 * and gives up silently. A new account with no handle is a valid state (the
 * field is nullable), so failing here must not block login — the profile screen
 * lets the user pick one later.
 */
export async function claimInitialUsername(
  myUid: string,
  name: string,
  email: string
): Promise<string | null> {
  const base = suggestUsername(name, email);
  if (!base) return null;

  // The suffix has to fit inside the 24-character limit, so trim the stem
  // rather than the digits.
  const candidates = [base, ...[1, 2, 3, 4, 5].map((n) => `${base.slice(0, 22)}${n}`)];

  for (const handle of candidates) {
    if (validateUsername(handle)) continue;

    const owner = await readOnce<string>(Paths.username(handle));
    if (owner !== null && owner !== myUid) continue;

    try {
      await fanOut({
        [Paths.username(handle)]: myUid,
        [Paths.userUsername(myUid)]: handle,
      });
      // The profile listener may not have attached yet at signup, so patch the
      // store directly rather than waiting for a round trip.
      appState.get().patchCurrentUser({ username: handle });
      return handle;
    } catch {
      // Taken in the gap between the check and the write. Try the next one.
    }
  }

  return null;
}

/**
 * Release a handle. The rules only allow the owner to delete their own claim,
 * so this is a no-op for anyone else's.
 */
export async function releaseUsername(handle: string): Promise<void> {
  await fanOut({ [Paths.username(normaliseUsername(handle))]: null });
}

/** Resolve a handle to a profile. Exact match; handles are case-insensitive. */
export async function findUserByUsername(
  raw: string,
  myUid: string
): Promise<UserProfile | null> {
  const handle = normaliseUsername(raw).replace(/^@/, '');
  if (validateUsername(handle)) return null;

  const uid = await readOnce<string>(Paths.username(handle));
  if (!uid || uid === myUid) return null;

  const profile = await readOnce<UserProfile>(Paths.user(uid));
  return profile ? { ...profile, uid } : null;
}

/**
 * Prefix search over handles lived here, as an `orderByKey()` range over the
 * `usernames` node. That range is a read of the parent, and the same permission
 * enumerates every handle in the app \u2014 so the rules withdrew it and the search
 * moved to `searchDirectory` in DirectoryService.ts.
 *
 * `findUserByUsername` above is unaffected: resolving one handle you were given
 * reads `usernames/{handle}` directly, which is still permitted.
 */

/** Suggest a starting handle from a display name, e.g. "Ana Ruiz" -> "anaruiz". */
export function suggestUsername(name: string, email: string): string {
  const fromName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (fromName.length >= 3) return fromName.slice(0, 24);

  const fromEmail = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9_.]/g, '') ?? '';
  return fromEmail.length >= 3 ? fromEmail.slice(0, 24) : '';
}

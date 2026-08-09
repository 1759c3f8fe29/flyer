import functions from '@react-native-firebase/functions';
import type { UserProfile } from '../config/types';

/**
 * DirectoryService — finding people you are not already connected to.
 *
 * Search used to happen on the client: `users` granted read on the parent node
 * plus an email index, so the query ran straight from the app. That is also what
 * let any signed-in account download the entire user table in one request,
 * because in RTDB enumeration and search are the same permission. The rules now
 * grant read per row, so discovery moved to the `searchUsers` callable and this
 * module is the only way in.
 *
 * Resolving somebody you were *given* — a chat participant, a group member, an
 * incoming request — still reads `users/{uid}` directly and does not come
 * through here. That was never the hole.
 */

/**
 * Shortest query the server will answer. Kept in step with SEARCH_MIN_PREFIX in
 * functions/index.js: below it the callable returns nothing, so a client that
 * asked anyway would render "no results" for a query that was never run.
 */
export const SEARCH_MIN_PREFIX = 3;

/**
 * What a search tells you about a stranger — deliberately less than a profile.
 *
 * Not a `UserProfile`, and not padded out into one. Presence, about text and
 * creation date are absent because the callable does not return them, and
 * inventing defaults would put values into the user cache that were never
 * fetched. Callers that need a full profile read `users/{uid}` once they have a
 * uid, which the rules still allow.
 */
export interface SearchHit {
  uid: string;
  name: string;
  username: string | null;
  photoURL: string | null;
  /**
   * Only populated for an email lookup, where the caller supplied the address
   * and the match merely confirmed it. Handle results carry no email: returning
   * one would turn the directory into an address harvester.
   */
  email: string | null;
}

/** Enough of a profile to warm the cache with, and nothing that was guessed. */
export function hitToPartial(hit: SearchHit): Partial<UserProfile> & { uid: string } {
  return {
    uid: hit.uid,
    name: hit.name,
    username: hit.username,
    photoURL: hit.photoURL,
  };
}

function parseHits(raw: unknown, email: string | null): SearchHit[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((hit): hit is SearchHit => {
      const h = hit as SearchHit | null;
      return !!h && typeof h.uid === 'string' && typeof h.name === 'string';
    })
    .map((hit) => ({
      uid: hit.uid,
      name: hit.name,
      username: typeof hit.username === 'string' ? hit.username : null,
      photoURL: typeof hit.photoURL === 'string' && hit.photoURL ? hit.photoURL : null,
      email,
    }));
}

/**
 * Search the directory by handle prefix or exact email address.
 *
 * One entry point for both, because the server decides which it is from the
 * presence of an `@`. Splitting that decision across client and server would
 * give the two a way to disagree.
 */
export async function searchDirectory(query: string): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase().replace(/^@/, '');
  if (q.length < SEARCH_MIN_PREFIX) return [];

  const call = functions().httpsCallable('searchUsers');
  const response = await call({ query: q });

  const raw = (response?.data as { results?: unknown })?.results;
  return parseHits(raw, q.includes('@') ? q : null);
}

/**
 * Exact-email lookup, returning the single hit or null.
 *
 * A shape adapter over `searchDirectory` rather than a second callable: the
 * email branch already returns at most one row, and the add-contact screen wants
 * "found / not found" rather than a list it has to unwrap.
 */
export async function findUserByEmail(email: string): Promise<SearchHit | null> {
  const needle = email.trim().toLowerCase();
  if (!needle.includes('@')) return null;

  const results = await searchDirectory(needle);
  return results[0] ?? null;
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import functions from '@react-native-firebase/functions';
import type { Message } from '@/src/config/types';

/**
 * SmartReplyService — AI reply suggestions, off by default.
 *
 * Privacy: turning this on means the last few messages of a conversation leave
 * the user's Firebase project and go to Mistral. That is a real disclosure, so
 * the toggle defaults to OFF and the settings screen says so in plain words.
 *
 * Key handling: the Mistral API key never touches this file or the bundle.
 * Anything shipped to the device is extractable — `EXPO_PUBLIC_*` values are
 * inlined into the JS bundle at build time and `apktool` recovers them in
 * seconds. The key lives as a Firebase secret and is only read inside the
 * `smartReply` Cloud Function, which also re-checks that the caller is signed
 * in and is actually a participant of the chat before any text is forwarded.
 *
 * Failure policy: suggestions are a nicety. Every error path here returns an
 * empty array. A Mistral outage, a quota exhaustion, or a cold-start timeout
 * must never surface as an error in the chat.
 */

const STORAGE_KEY = '@flyer/smartReply/enabled';

/**
 * Per-chat overrides, as one JSON map of `chatId -> boolean`.
 *
 * A single key rather than one per chat because every consumer needs the whole
 * map synchronously during render — `SmartReplyBar` decides whether to exist at
 * all, and a per-chat `getItem` would mean a frame of the bar appearing in a
 * conversation the user opted out of. Only chats the user has explicitly touched
 * appear here; an absent entry means "follow the global setting", which keeps the
 * map small and lets the master switch stay meaningful.
 */
const OVERRIDES_KEY = '@flyer/smartReply/perChat/v1';

/** How much history the model gets. Enough for context, small enough to stay cheap. */
const CONTEXT_MESSAGES = 10;
const MAX_SUGGESTIONS = 3;

/** A suggestion longer than this is a paragraph, not a tap-to-send reply. */
const MAX_SUGGESTION_CHARS = 120;

/** Mistral behind a cold-started function; past this the moment has passed. */
const REQUEST_TIMEOUT_MS = 12_000;

let enabled = false;
let hydrated = false;
let overrides: Record<string, boolean> = {};

/**
 * Parameterless on purpose. Listeners re-read whichever value they care about,
 * because the two are not interchangeable: flipping one chat's override leaves
 * the global boolean untouched, so a subscriber handed `enabled` would be called
 * with a value it already has and `useState` would drop the update as a no-op.
 */
const listeners = new Set<() => void>();

/**
 * Reads the persisted toggle into memory. Called once at app start so that the
 * synchronous `isSmartReplyEnabled()` used during render is accurate; before
 * this resolves it reports `false`, which is the safe direction to be wrong in.
 */
export async function hydrateSmartReply(): Promise<boolean> {
  if (hydrated) return enabled;
  try {
    const [raw, rawOverrides] = await AsyncStorage.multiGet([STORAGE_KEY, OVERRIDES_KEY]);
    enabled = raw[1] === '1';
    overrides = parseOverrides(rawOverrides[1]);
  } catch (e) {
    console.warn('[Flyer/smartreply] could not read setting, staying off', e);
    enabled = false;
    overrides = {};
  }
  hydrated = true;
  emit();
  return enabled;
}

/**
 * Tolerates anything that is not the shape we wrote. A corrupt or half-written
 * value costs the per-chat choices, which the user can set again; throwing here
 * would instead take the global toggle down with it, since both are read in the
 * same `multiGet`.
 */
function parseOverrides(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out: Record<string, boolean> = {};
    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[chatId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function isSmartReplyEnabled(): boolean {
  return enabled;
}

export async function setSmartReplyEnabled(value: boolean): Promise<void> {
  enabled = value;
  hydrated = true;
  emit();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch (e) {
    // The switch already moved; losing the write only costs the preference on
    // next launch, and the default it falls back to is the private one.
    console.warn('[Flyer/smartreply] could not persist setting', e);
  }
}

export function subscribeSmartReply(cb: (value: boolean) => void): () => void {
  const listener = () => cb(enabled);
  listeners.add(listener);
  cb(enabled);
  return () => {
    listeners.delete(listener);
  };
}

/** Fires for a change to the global setting *or* to any chat's override. */
export function subscribeSmartReplyForChat(
  chatId: string,
  cb: (value: boolean) => void
): () => void {
  const listener = () => cb(isSmartReplyEnabledForChat(chatId));
  listeners.add(listener);
  cb(isSmartReplyEnabledForChat(chatId));
  return () => {
    listeners.delete(listener);
  };
}

// --- per-chat overrides ----------------------------------------------------

/**
 * What the toggle in a chat's profile screen should show.
 *
 * `null` means "no explicit choice for this chat" — the UI renders the global
 * setting's value, so the switch always reflects what will actually happen.
 */
export function getChatOverride(chatId: string): boolean | null {
  return chatId in overrides ? overrides[chatId] : null;
}

/**
 * The question every caller actually wants answered: will suggestions appear in
 * this conversation?
 *
 * The global switch is the master — off means off everywhere, and no per-chat
 * override can turn it back on. That direction is deliberate: the global toggle
 * is the one the settings screen describes as the privacy disclosure ("your
 * recent messages are sent to AI"), so it has to be the thing that stops all
 * outbound text, not a default that a forgotten per-chat opt-in quietly
 * overrides. With it on, a per-chat `false` excludes that conversation.
 */
export function isSmartReplyEnabledForChat(chatId: string): boolean {
  if (!enabled) return false;
  return overrides[chatId] !== false;
}

/**
 * Set or clear one chat's preference. `null` removes the override so the chat
 * follows the global setting again.
 */
export async function setChatOverride(chatId: string, value: boolean | null): Promise<void> {
  if (value === null) {
    if (!(chatId in overrides)) return;
    const { [chatId]: _removed, ...rest } = overrides;
    overrides = rest;
  } else {
    if (overrides[chatId] === value) return;
    overrides = { ...overrides, [chatId]: value };
  }

  emit();

  try {
    await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch (e) {
    // Same reasoning as the global setting: the switch has already moved, and
    // losing the write only costs the preference on next launch.
    console.warn('[Flyer/smartreply] could not persist chat override', e);
  }
}

function emit() {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.warn('[Flyer/smartreply] listener threw', e);
    }
  }
}

/**
 * Turns the tail of a conversation into the compact transcript the function
 * forwards to Mistral.
 *
 * Deliberately text-only: media URLs are Cloudinary links that would leak the
 * user's asset paths to a third party and mean nothing to the model anyway, so
 * they go across as a bare `[photo]` / `[video]` / `[voice note]` label.
 */
function buildTranscript(messages: Message[], myUid: string) {
  const recent = messages
    .filter((m) => !m.deleted && !m.pending && !m.failed)
    .slice(-CONTEXT_MESSAGES);

  return recent
    .map((m) => {
      let content = m.text?.trim() ?? '';
      if (!content) {
        if (m.type === 'image') content = '[photo]';
        else if (m.type === 'video') content = '[video]';
        else if (m.type === 'audio') content = '[voice note]';
      }
      return {
        role: m.senderId === myUid ? ('me' as const) : ('them' as const),
        content: content.slice(0, 500),
      };
    })
    .filter((m) => m.content.length > 0);
}

/**
 * Asks for up to three short replies to the current conversation.
 *
 * Returns `[]` — never throws — when the toggle is off, when there is nothing
 * worth replying to, or when anything at all goes wrong upstream.
 */
export async function fetchSuggestions(
  chatId: string,
  messages: Message[],
  myUid: string
): Promise<string[]> {
  // Checked here and not only in the UI: this is the function that puts message
  // text on the wire, so it is the right place for the last word on consent.
  if (!isSmartReplyEnabledForChat(chatId)) return [];

  const transcript = buildTranscript(messages, myUid);
  if (transcript.length === 0) return [];

  // Nothing to suggest when the last word was ours — that is a conversation
  // waiting on them, and offering "reply" options to your own message is noise.
  if (transcript[transcript.length - 1].role === 'me') return [];

  try {
    const call = functions().httpsCallable('smartReply', {
      timeout: REQUEST_TIMEOUT_MS,
    });
    const response = await call({ chatId, messages: transcript });

    const raw = (response?.data as { suggestions?: unknown })?.suggestions;
    if (!Array.isArray(raw)) return [];

    const seen = new Set<string>();
    const out: string[] = [];

    for (const item of raw) {
      if (typeof item !== 'string') continue;
      // Models like to wrap suggestions in quotes or number them; strip both.
      const cleaned = item
        .trim()
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^["'`]|["'`]$/g, '')
        .trim();

      if (!cleaned || cleaned.length > MAX_SUGGESTION_CHARS) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      out.push(cleaned);
      if (out.length >= MAX_SUGGESTIONS) break;
    }

    return out;
  } catch (e) {
    console.warn('[Flyer/smartreply] suggestion request failed', e);
    return [];
  }
}

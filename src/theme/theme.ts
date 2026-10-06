/**
 * Design tokens. Two palettes, one shape — every component reads from the
 * resolved `Theme` object so dark mode needs no per-component branching.
 */

export interface Theme {
  dark: boolean;
  colors: {
    bg: string;
    bgElevated: string;
    surface: string;
    surfaceAlt: string;
    header: string;
    /** Text and icons on `header`. The light header is white, so these are dark. */
    headerText: string;
    headerSubtext: string;
    border: string;
    text: string;
    textMuted: string;
    textFaint: string;
    accent: string;
    accentDim: string;
    accentText: string;
    bubbleOut: string;
    bubbleIn: string;
    bubbleOutText: string;
    bubbleInText: string;
    tick: string;
    tickSeen: string;
    danger: string;
    warning: string;
    /** Text on `warning`. Dark in both themes: white-on-amber fails contrast. */
    onWarning: string;
    success: string;
    overlay: string;
    chatWallpaper: string;
    chatSelection: string;
    ripple: string;
    unreadBadge: string;
  };
  spacing: (n: number) => number;
  radius: { sm: number; md: number; lg: number; xl: number; pill: number };
  font: {
    tiny: number;
    small: number;
    body: number;
    title: number;
    large: number;
    huge: number;
  };
}

const spacing = (n: number) => n * 4;

const radius = { sm: 6, md: 10, lg: 16, xl: 24, pill: 999 };

const font = { tiny: 11, small: 13, body: 15, title: 17, large: 22, huge: 30 };

export const lightTheme: Theme = {
  dark: false,
  colors: {
    bg: '#FFFFFF',
    bgElevated: '#FFFFFF',
    surface: '#F7F8FA',
    surfaceAlt: '#EDEFF2',
    // White, not green: the light palette is white / light gray / green *accent*,
    // and `text` is near-black — on a green header that pairing fails contrast.
    header: '#FFFFFF',
    headerText: '#0B141A',
    headerSubtext: '#5E6B73',
    border: '#E4E6EA',
    text: '#0B141A',
    textMuted: '#5E6B73',
    textFaint: '#8D9AA3',
    accent: '#008069',
    accentDim: '#D9F2EB',
    accentText: '#FFFFFF',
    bubbleOut: '#D9FDD3',
    bubbleIn: '#FFFFFF',
    bubbleOutText: '#0B141A',
    bubbleInText: '#0B141A',
    tick: '#8D9AA3',
    tickSeen: '#34B7F1',
    danger: '#E23D3D',
    warning: '#E8A33D',
    onWarning: '#0B141A',
    success: '#25D366',
    overlay: 'rgba(0,0,0,0.55)',
    chatWallpaper: '#EFE7DE',
    /** Background of a selected bubble during multi-select, ~15% accent. */
    chatSelection: 'rgba(0,128,105,0.12)',
    ripple: 'rgba(0,0,0,0.08)',
    // Accent-darkened, not the brand green: white badge text on #25D366 is
    // ~2.3:1, and the unread timestamp wears this on a white background too.
    unreadBadge: '#008069',
  },
  spacing,
  radius,
  font,
};

export const darkTheme: Theme = {
  dark: true,
  colors: {
    bg: '#0B141A',
    bgElevated: '#1F2C33',
    surface: '#111B21',
    surfaceAlt: '#202C33',
    header: '#1F2C33',
    headerText: '#E9EDEF',
    headerSubtext: '#8696A0',
    border: '#2A3942',
    text: '#E9EDEF',
    textMuted: '#8696A0',
    textFaint: '#667781',
    accent: '#00A884',
    accentDim: '#103A31',
    accentText: '#0B141A',
    bubbleOut: '#005C4B',
    bubbleIn: '#202C33',
    bubbleOutText: '#E9EDEF',
    bubbleInText: '#E9EDEF',
    tick: '#8696A0',
    tickSeen: '#53BDEB',
    danger: '#F15C6D',
    warning: '#F0B232',
    onWarning: '#0B141A',
    success: '#00A884',
    overlay: 'rgba(0,0,0,0.7)',
    chatWallpaper: '#0B141A',
    chatSelection: 'rgba(0,168,132,0.18)',
    ripple: 'rgba(255,255,255,0.08)',
    unreadBadge: '#00A884',
  },
  spacing,
  radius,
  font,
};

/** Deterministic avatar colour so a user's placeholder never changes. */
const AVATAR_COLORS = [
  '#E8788A',
  '#7C9CF0',
  '#63C2A0',
  '#E0A458',
  '#B58BD8',
  '#4FB0C6',
  '#D97C7C',
  '#7FBF6A',
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * Legible text on an avatar swatch. White initials on the light greens and
 * ambers in AVATAR_COLORS fall below contrast, so pick per-swatch instead of
 * hardcoding white at every call site.
 */
export function avatarTextFor(background: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(background);
  if (!match) return '#FFFFFF';
  const n = parseInt(match[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? '#0B141A' : '#FFFFFF';
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

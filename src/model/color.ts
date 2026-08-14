import type { Color } from './types';

export interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(hex: Color): RGB {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 6) h += 'ff';
  if (h.length !== 8) return { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: parseInt(h.slice(6, 8), 16) / 255,
  };
}

export function toHex({ r, g, b }: RGB): Color {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `rgba(...)` string for canvas, honouring a separate opacity multiplier. */
export function toCss(hex: Color, opacity = 1): string {
  const { r, g, b, a } = parseColor(hex);
  const alpha = a * opacity;
  return alpha >= 1 ? toHex({ r, g, b, a: 1 }) : `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

// --- HSL round-trip, used by the palette generator (§22) and colour inheritance (§7) ---

export interface HSL {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hn < 60) [rp, gp, bp] = [c, x, 0];
  else if (hn < 120) [rp, gp, bp] = [x, c, 0];
  else if (hn < 180) [rp, gp, bp] = [0, c, x];
  else if (hn < 240) [rp, gp, bp] = [0, x, c];
  else if (hn < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255, a: 1 };
}

/** Move a colour towards white (`amount > 0`) or black (`amount < 0`), -1..1. */
export function shade(hex: Color, amount: number): Color {
  const hsl = rgbToHsl(parseColor(hex));
  const l = amount >= 0 ? hsl.l + (1 - hsl.l) * amount : hsl.l * (1 + amount);
  // Desaturate slightly as we lighten, which is what makes child territories read
  // as "the same family, one rank down" rather than as a different colour.
  const s = amount > 0 ? hsl.s * (1 - amount * 0.35) : hsl.s;
  return toHex(hslToRgb({ h: hsl.h, s, l: Math.max(0, Math.min(1, l)) }));
}

/**
 * CIE76-ish perceptual distance, good enough to answer "do these two neighbouring
 * states look confusingly similar?" for the palette generator (§22).
 */
export function colorDistance(a: Color, b: Color): number {
  const ca = parseColor(a);
  const cb = parseColor(b);
  // Weighted euclidean in RGB — cheap and adequate for palette separation.
  const rm = (ca.r + cb.r) / 2;
  const dr = ca.r - cb.r;
  const dg = ca.g - cb.g;
  const db = ca.b - cb.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** Pick black or white text for legibility on a given fill. */
export function contrastingText(hex: Color): Color {
  const { r, g, b } = parseColor(hex);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? '#1a1712' : '#f7f3ea';
}

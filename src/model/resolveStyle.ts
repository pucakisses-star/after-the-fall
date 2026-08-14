/**
 * Style resolution (spec §40, §60).
 *
 * A feature never stores a full appearance. It stores
 *   styleClassId  — a named, shared style
 *   styleOverrides — a sparse patch on top of it
 * and the renderer asks for the composed result here. That is what makes
 * "change the Country Label style and every country label updates" work, while
 * still allowing per-object exceptions.
 */

import { hslToRgb, parseColor, rgbToHsl, shade, toHex } from './color';
import {
  cohesionFactor,
  defaultLineStyle,
  defaultSymbolStyle,
  defaultTerritoryStyle,
  defaultTextStyle,
  relationshipInfo,
} from './defaults';
import { ancestorsOf } from './hierarchy';
import type {
  LineStyle,
  MapLabel,
  MapProject,
  Settlement,
  SymbolStyle,
  Territory,
  TerritoryStyle,
  TextStyle,
  LinearFeature,
  UUID,
} from './types';

/** Lightening applied per level of hierarchy depth when `inheritParentColor` is on. */
export const SHADE_STEP = 0.16;

export function resolveTerritoryStyle(project: MapProject, t: Territory): TerritoryStyle {
  const base = project.styles.territory[t.styleClassId]?.style ?? defaultTerritoryStyle();
  const merged: TerritoryStyle = {
    ...base,
    ...t.styleOverrides,
    outline: { ...base.outline, ...(t.styleOverrides.outline ?? {}) },
    pattern:
      t.styleOverrides.pattern !== undefined
        ? t.styleOverrides.pattern
        : base.pattern
          ? { ...base.pattern }
          : null,
  };

  const inherited = inheritedFill(project, t);
  if (inherited) merged.fillColor = inherited;

  return merged;
}

/**
 * The fill a territory takes from the realm it belongs to, or null if it keeps
 * its own (spec §3, §4, §6, §17, §18).
 *
 * The rule the reference atlases follow: a realm has a colour, and everything
 * inside it is a variation on that colour rather than a fresh one from a
 * rainbow. How far a member drifts is not a fixed step per level but a property
 * of *how it is held* — an ordinary canton barely moves, a vassal moves enough
 * that you can see it is a different kind of thing without leaving the family —
 * scaled by the project's cohesion setting.
 *
 * The small per-sibling offset matters more than it looks. Without it every
 * canton of a realm is the identical colour and the internal borders are the
 * only thing separating them; with it they are the near-identical but distinct
 * shades an atlas actually prints, and it is derived from the territory's own id
 * so it is stable across reloads rather than shuffling on every render.
 */
export function inheritedFill(project: MapProject, t: Territory): string | null {
  if (!t.inheritParentColor || !t.parentId) return null;
  const factor = cohesionFactor(project.politicalCohesion);
  if (factor === 0) return null;

  const rel = relationshipInfo(t.relationship);
  // A free city is a hole in its realm's colour, not a shade of it.
  if (rel.ownColor) return null;

  // Walk up to the nearest ancestor that sets its own colour, accumulating how
  // far each step down is allowed to drift.
  const chain = ancestorsOf(project, t.id);
  let drift = rel.variation;
  let source: Territory | undefined;
  for (const a of chain) {
    if (!a.inheritParentColor || !a.parentId) {
      source = a;
      break;
    }
    drift += relationshipInfo(a.relationship).variation;
  }
  if (!source) return null;

  const sourceStyle = project.styles.territory[source.styleClassId]?.style ?? defaultTerritoryStyle();
  const base = source.styleOverrides.fillColor ?? sourceStyle.fillColor;

  const amount = Math.min(0.8, drift * factor);
  const lightened = shade(base, amount);

  // Nudge each sibling around the family colour, on three axes independently.
  //
  // Deliberately *not* scaled by `amount`: how far a vassal sits from its realm
  // and how far two cantons sit from each other are different questions, and
  // tying them together made the second one vanish. At strong cohesion an
  // ordinary canton drifts about 5% from the realm, so a spread proportional to
  // that came to well under one part in 255 — every canton rounded to the
  // identical hex and the fills were distinguishable only by the hairline
  // between them.
  //
  // Three axes rather than one because a single axis collides: four siblings
  // spread over the ~7 rounding steps this is worth would share a colour about
  // half the time. Hue, saturation and lightness are driven from different mixes
  // of the id, so two siblings have to match on all three to come out the same.
  const { h, s, l } = rgbToHsl(parseColor(lightened));
  const spread = SIBLING_SPREAD * factor;
  const jitter = (salt: number) => (hashUnit(t.id, salt) * 2 - 1) * spread;
  return toHex(
    hslToRgb({
      h: (h + jitter(1) * 30 + 360) % 360,
      s: Math.max(0, Math.min(1, s + jitter(2) * 0.35)),
      l: Math.max(0, Math.min(1, l + jitter(3) * 0.35)),
    }),
  );
}

/**
 * How far siblings of one realm sit from each other, before cohesion scales it.
 *
 * Tuned against the reference plate, whose neighbouring cantons differ by a few
 * parts in 255 — enough to see two shapes, nowhere near enough to read as two
 * countries.
 */
export const SIBLING_SPREAD = 0.06;

/** Stable 0..1 from an id, so a territory's colour never moves between reloads. */
function hashUnit(id: string, salt = 0): number {
  let h = 2166136261 ^ Math.imul(salt + 1, 0x9e3779b9);
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

export function resolveLineStyle(project: MapProject, styleClassId: UUID, overrides: Partial<LineStyle> = {}): LineStyle {
  const base = project.styles.line[styleClassId]?.style ?? defaultLineStyle();
  return { ...base, ...overrides };
}

export function resolveLinearStyle(project: MapProject, f: LinearFeature): LineStyle {
  return resolveLineStyle(project, f.styleClassId, f.styleOverrides);
}

export function resolveTextStyle(project: MapProject, l: MapLabel): TextStyle {
  const base = project.styles.text[l.styleClassId]?.style ?? defaultTextStyle();
  return { ...base, ...l.styleOverrides };
}

export function resolveSymbolStyle(project: MapProject, s: Settlement): SymbolStyle {
  return resolveSymbolClass(project, s.styleClassId, s.styleOverrides);
}

/**
 * Style classes resolved by id alone, with no feature to hang them on.
 *
 * The legend needs these: a key row stands for the *class* — "this is what a
 * fortress looks like" — and inventing a throwaway settlement to ask what a
 * fortress looks like would be answering the question with a lie.
 */
export function resolveSymbolClass(
  project: MapProject,
  styleClassId: UUID,
  overrides: Partial<SymbolStyle> = {},
): SymbolStyle {
  const base = project.styles.symbol[styleClassId]?.style ?? defaultSymbolStyle();
  return { ...base, ...overrides };
}

export function resolveTerritoryClass(
  project: MapProject,
  styleClassId: UUID,
  overrides: Partial<TerritoryStyle> = {},
): TerritoryStyle {
  const base = project.styles.territory[styleClassId]?.style ?? defaultTerritoryStyle();
  return {
    ...base,
    ...overrides,
    outline: { ...base.outline, ...(overrides.outline ?? {}) },
    pattern: overrides.pattern !== undefined ? overrides.pattern : base.pattern ? { ...base.pattern } : null,
  };
}

/** Apply a text style's case transform. Tracking is applied at draw time, not here. */
export function applyTextTransform(text: string, transform: TextStyle['transform']): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default:
      return text;
  }
}

/**
 * CSS font shorthand for a resolved text style. Used by both the canvas renderer
 * and the SVG exporter so screen and export stay in step.
 */
export function fontShorthand(s: TextStyle, scale = 1): string {
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${(s.fontSize * scale).toFixed(2)}px ${s.fontFamily}`;
}

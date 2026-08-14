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

import { shade } from './color';
import {
  defaultLineStyle,
  defaultSymbolStyle,
  defaultTerritoryStyle,
  defaultTextStyle,
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

  if (t.inheritParentColor && t.parentId) {
    // Walk up until we hit an ancestor that defines its own colour, then lighten
    // by one step per level down. Grandchildren therefore read as a tint family.
    const chain = ancestorsOf(project, t.id);
    let levels = 0;
    let source: Territory | undefined;
    for (const a of chain) {
      levels++;
      if (!a.inheritParentColor || !a.parentId) {
        source = a;
        break;
      }
    }
    if (source) {
      const sourceStyle = project.styles.territory[source.styleClassId]?.style ?? defaultTerritoryStyle();
      const sourceColor = source.styleOverrides.fillColor ?? sourceStyle.fillColor;
      merged.fillColor = shade(sourceColor, Math.min(0.8, levels * SHADE_STEP));
    }
  }

  return merged;
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

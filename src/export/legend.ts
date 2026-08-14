/**
 * Legend and compass rose (spec §26, §28).
 *
 * The rows are derived from what the map actually contains, not from a fixed
 * list: a map with no fortresses should not have a fortress in its key, and a
 * map that gains a disputed border should gain the hatching row without anyone
 * remembering to add it. Each row names a *style class* rather than carrying its
 * own appearance, so every swatch is drawn by the same code that draws the map —
 * restyle the Sovereign Border and the legend's rule changes with it.
 *
 * The user can still take over: editing, hiding or reordering a row turns the
 * automatic derivation off and keeps their arrangement (§26).
 */

import { findBasemapSource } from '@/geo/basemap';
import { BORDER_HIERARCHY, STYLE_IDS } from '@/model/defaults';
import { fixedId } from '@/model/ids';
import {
  resolveLineStyle,
  resolveSymbolClass,
  resolveTerritoryClass,
  resolveTerritoryStyle,
} from '@/model/resolveStyle';
import { dashArray, svgPatternDef, svgPatternId } from '@/render/patterns';
import { symbolToSvg } from '@/render/symbols';
import { toCss } from '@/model/color';
import type {
  CompassSettings,
  FurniturePosition,
  HatchPattern,
  LegendEntry,
  LegendSettings,
  MapProject,
  Settlement,
} from '@/model/types';

/** Settlement type → the style class and wording a key would use. */
const SETTLEMENT_ROWS: { type: Settlement['type']; styleId: string; text: string }[] = [
  { type: 'imperial-capital', styleId: STYLE_IDS.symbolCapitalImperial, text: 'Imperial capital' },
  { type: 'national-capital', styleId: STYLE_IDS.symbolCapitalNational, text: 'National capital' },
  { type: 'regional-capital', styleId: STYLE_IDS.symbolCapitalRegional, text: 'Regional capital' },
  { type: 'city', styleId: STYLE_IDS.symbolCity, text: 'City' },
  { type: 'town', styleId: STYLE_IDS.symbolTown, text: 'Town' },
  { type: 'village', styleId: STYLE_IDS.symbolVillage, text: 'Village' },
  { type: 'fortress', styleId: STYLE_IDS.symbolFortress, text: 'Fortress' },
  { type: 'port', styleId: STYLE_IDS.symbolPort, text: 'Port' },
  { type: 'monastery', styleId: STYLE_IDS.symbolMonastery, text: 'Monastery' },
  { type: 'ruins', styleId: STYLE_IDS.symbolRuins, text: 'Ruins' },
];

/** A stable id per row, so toggling one does not renumber the rest. */
const rowId = (kind: string, styleId: string) => fixedId(`legend-${kind}-${styleId}`);

/**
 * Rows for the map as it stands: the settlement types it uses, the border tiers
 * its territories actually carry, the watercourses it draws, and any patterned
 * fill — which is what a reader most needs explained.
 */
export function deriveLegendEntries(project: MapProject): LegendEntry[] {
  const entries: LegendEntry[] = [];
  const add = (kind: LegendEntry['kind'], styleId: string, text: string) => {
    if (entries.some((e) => e.styleId === styleId && e.kind === kind)) return;
    entries.push({ id: rowId(kind, styleId), kind, styleId, text, hidden: false });
  };

  const settlementTypes = new Set(Object.values(project.settlements).map((s) => s.type));
  for (const row of SETTLEMENT_ROWS) {
    if (settlementTypes.has(row.type)) add('symbol', row.styleId, row.text);
  }

  const borderKinds = new Set(Object.values(project.territories).map((t) => t.borderKind));
  for (const tier of BORDER_HIERARCHY) {
    if (borderKinds.has(tier.kind)) add('line', tier.styleClassId, tier.label);
  }

  const lineKinds = new Set(Object.values(project.linearFeatures).map((f) => f.kind));
  if (lineKinds.has('river') || lineKinds.has('river-major')) {
    add('line', lineKinds.has('river-major') ? STYLE_IDS.lineRiverMajor : STYLE_IDS.lineRiver, 'River');
  }
  if (lineKinds.has('road-major') || lineKinds.has('road-minor')) {
    add('line', lineKinds.has('road-major') ? STYLE_IDS.lineRoadMajor : STYLE_IDS.lineRoadMinor, 'Road');
  }
  if (lineKinds.has('trade-route')) add('line', STYLE_IDS.lineTradeRoute, 'Trade route');

  // Reference geography is drawn too, and a key that explains only the drawn
  // features while the map is covered in blue watercourses is not a key. These
  // come last because they are backdrop rather than subject.
  const visibleRoles = new Set(
    project.basemap
      .filter((b) => b.visible)
      .map((b) => findBasemapSource(b.sourceId)?.role)
      .filter(Boolean) as string[],
  );
  if (visibleRoles.has('rivers') && !lineKinds.has('river') && !lineKinds.has('river-major')) {
    add('line', STYLE_IDS.lineRiver, 'River');
  }
  if (visibleRoles.has('lakes')) add('fill', STYLE_IDS.territoryWater, 'Lake');

  // A hatched fill is the one thing on a political map a reader cannot guess.
  for (const territory of Object.values(project.territories)) {
    const style = resolveTerritoryStyle(project, territory);
    if (!style.pattern || style.pattern.kind === 'none') continue;
    const classId = territory.styleClassId;
    const named = project.styles.territory[classId]?.name;
    add('fill', classId, named ?? 'Disputed territory');
  }

  return entries;
}

/** The rows to draw: the user's arrangement, or a fresh derivation. */
export function legendEntries(project: MapProject): LegendEntry[] {
  const settings = project.legend;
  const rows = settings.auto || settings.entries.length === 0
    ? deriveLegendEntries(project)
    : settings.entries;
  return rows.filter((e) => !e.hidden);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Place a piece of furniture in one corner of the frame, with a margin. */
function corner(position: FurniturePosition, frame: Box, w: number, h: number, pad: number): [number, number] {
  const left = position.endsWith('left');
  const top = position.startsWith('top');
  return [
    left ? frame.x + pad : frame.x + frame.w - w - pad,
    top ? frame.y + pad : frame.y + frame.h - h - pad,
  ];
}

export interface FurnitureResult {
  markup: string[];
  /** Pattern defs the swatches referenced, to be emitted with the rest. */
  patterns: Map<string, HatchPattern>;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => (Math.abs(n) < 1e-4 ? '0' : n.toFixed(2));

/**
 * Draw the legend into the frame.
 *
 * `scale` is the export's style multiplier, so a legend on a 12,000 px sheet is
 * as legible as one on a 1,200 px sheet rather than a speck in the corner.
 */
export function legendToSvg(project: MapProject, frame: Box, scale: number): FurnitureResult {
  const settings: LegendSettings = project.legend;
  const patterns = new Map<string, HatchPattern>();
  if (!settings.enabled) return { markup: [], patterns };

  const rows = legendEntries(project);
  if (rows.length === 0) return { markup: [], patterns };

  const pad = 10 * scale;
  const rowH = 15 * scale;
  const swatchW = 26 * scale;
  const fontSize = 10 * scale;
  const titleSize = 11 * scale;
  const hasTitle = settings.title.trim().length > 0;

  // Wide enough for the longest row, measured the only way a serialiser can:
  // by character count against the font's rough average advance.
  const longest = rows.reduce((n, r) => Math.max(n, r.text.length), settings.title.length);
  const w = Math.max(120 * scale, pad * 2 + swatchW + 8 * scale + longest * fontSize * 0.52);
  const h = pad * 2 + (hasTitle ? titleSize + 6 * scale : 0) + rows.length * rowH;
  const [x, y] = corner(settings.position, frame, w, h, 14 * scale);

  const out: string[] = [
    `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ` +
      `fill="#fdfaf2" fill-opacity="0.92" stroke="#2b2318" stroke-width="${num(0.9 * scale)}"/>`,
  ];

  let cursor = y + pad;
  if (hasTitle) {
    out.push(
      `<text x="${num(x + pad)}" y="${num(cursor + titleSize * 0.8)}" font-family="Georgia,serif" ` +
        `font-size="${num(titleSize)}" font-weight="600" fill="#2b2318">${esc(settings.title)}</text>`,
    );
    cursor += titleSize + 6 * scale;
  }

  for (const row of rows) {
    const midY = cursor + rowH / 2;
    const sx = x + pad;
    out.push(swatchFor(project, row, sx, midY, swatchW, scale, patterns));
    out.push(
      `<text x="${num(sx + swatchW + 8 * scale)}" y="${num(midY)}" font-family="Georgia,serif" ` +
        `font-size="${num(fontSize)}" fill="#2b2318" dominant-baseline="central">${esc(row.text)}</text>`,
    );
    cursor += rowH;
  }

  return { markup: [`<g id="legend-box">${out.join('')}</g>`], patterns };
}

/** One swatch, drawn by the same code that draws the thing it stands for. */
function swatchFor(
  project: MapProject,
  row: LegendEntry,
  x: number,
  midY: number,
  w: number,
  scale: number,
  patterns: Map<string, HatchPattern>,
): string {
  if (row.kind === 'symbol') {
    const style = resolveSymbolClass(project, row.styleId);
    return `<g>${symbolToSvg(style, x + w / 2, midY, scale)}</g>`;
  }

  if (row.kind === 'line') {
    const style = resolveLineStyle(project, row.styleId);
    const dash = dashArray(style.dash, style.width * scale);
    const width = Math.max(0.4, style.width * scale);
    const casing =
      style.casingColor && style.casingWidth > 0
        ? `<line x1="${num(x)}" y1="${num(midY)}" x2="${num(x + w)}" y2="${num(midY)}" ` +
          `stroke="${toCss(style.casingColor, style.opacity)}" ` +
          `stroke-width="${num(width + style.casingWidth * 2 * scale)}"/>`
        : '';
    return (
      `${casing}<line x1="${num(x)}" y1="${num(midY)}" x2="${num(x + w)}" y2="${num(midY)}" ` +
      `stroke="${toCss(style.color, style.opacity)}" stroke-width="${num(width)}"` +
      (dash ? ` stroke-dasharray="${dash.map(num).join(' ')}"` : '') +
      `/>`
    );
  }

  const style = resolveTerritoryClass(project, row.styleId);
  const h = 10 * scale;
  const box =
    `<rect x="${num(x)}" y="${num(midY - h / 2)}" width="${num(w)}" height="${num(h)}" ` +
    `fill="${toCss(style.fillColor, style.fillOpacity)}" stroke="${toCss(style.outline.color, style.outline.opacity)}" ` +
    `stroke-width="${num(Math.max(0.3, style.outline.width * scale))}"/>`;
  if (!style.pattern || style.pattern.kind === 'none') return box;
  const id = svgPatternId(style.pattern);
  patterns.set(id, style.pattern);
  return (
    box +
    `<rect x="${num(x)}" y="${num(midY - h / 2)}" width="${num(w)}" height="${num(h)}" fill="url(#${id})"/>`
  );
}

/** Re-export so the caller can emit a swatch's pattern with the map's own. */
export { svgPatternDef };

/**
 * A compass rose (§28).
 *
 * Drawn rather than imported so it scales with the export and inherits the
 * map's ink colour. North is up because the projections here are all
 * north-oriented; a rotated view would need the rose rotated to match, which is
 * why the angle is taken from the caller rather than assumed.
 */
export function compassToSvg(
  compass: CompassSettings,
  frame: Box,
  scale: number,
  rotationDeg = 0,
): string[] {
  if (!compass.enabled) return [];
  const size = compass.size * scale;
  const [x, y] = corner(compass.position, frame, size, size, 16 * scale);
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size / 2;
  const ink = '#2b2318';
  const parts: string[] = [];

  if (compass.style === 'arrow') {
    parts.push(
      `<path d="M${num(cx)} ${num(cy - r)}L${num(cx + r * 0.28)} ${num(cy + r * 0.55)}L${num(cx)} ${num(cy + r * 0.25)}` +
        `L${num(cx - r * 0.28)} ${num(cy + r * 0.55)}Z" fill="${ink}"/>`,
    );
  } else {
    // A four-pointed star: two kites per axis, the eastern half inked and the
    // western half left open, which is how an engraved rose reads.
    const point = (angle: number, long: number, short: number) => {
      const a = (angle * Math.PI) / 180;
      const b = a + Math.PI / 4;
      const c = a - Math.PI / 4;
      const tip = [cx + Math.sin(a) * r * long, cy - Math.cos(a) * r * long];
      const right = [cx + Math.sin(b) * r * short, cy - Math.cos(b) * r * short];
      const left = [cx + Math.sin(c) * r * short, cy - Math.cos(c) * r * short];
      return { tip, right, left };
    };
    for (const angle of [0, 90, 180, 270]) {
      const { tip, right, left } = point(angle, 1, 0.22);
      parts.push(
        `<path d="M${num(tip[0])} ${num(tip[1])}L${num(right[0])} ${num(right[1])}L${num(cx)} ${num(cy)}Z" fill="${ink}"/>`,
        `<path d="M${num(tip[0])} ${num(tip[1])}L${num(left[0])} ${num(left[1])}L${num(cx)} ${num(cy)}Z" ` +
          `fill="#fdfaf2" stroke="${ink}" stroke-width="${num(0.6 * scale)}"/>`,
      );
    }
    if (compass.style === 'rose') {
      for (const angle of [45, 135, 225, 315]) {
        const { tip, right, left } = point(angle, 0.62, 0.12);
        parts.push(
          `<path d="M${num(tip[0])} ${num(tip[1])}L${num(right[0])} ${num(right[1])}L${num(cx)} ${num(cy)}` +
            `L${num(left[0])} ${num(left[1])}Z" fill="none" stroke="${ink}" stroke-width="${num(0.6 * scale)}"/>`,
        );
      }
      parts.push(
        `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r * 1.04)}" fill="none" stroke="${ink}" stroke-width="${num(0.7 * scale)}"/>`,
      );
    }
  }

  parts.push(
    `<text x="${num(cx)}" y="${num(cy - r - 4 * scale)}" text-anchor="middle" font-family="Georgia,serif" ` +
      `font-size="${num(10 * scale)}" fill="${ink}">N</text>`,
  );

  const transform = rotationDeg ? ` transform="rotate(${num(rotationDeg)} ${num(cx)} ${num(cy)})"` : '';
  return [`<g id="compass"${transform}>${parts.join('')}</g>`];
}

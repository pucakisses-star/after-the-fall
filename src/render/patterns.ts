/**
 * Hatch patterns (spec §9, §45).
 *
 * A `HatchPattern` is turned into a small repeating tile. The same tile
 * description drives both a `CanvasPattern` for the live map and an SVG
 * `<pattern>` for export, so "patterns should export correctly to SVG" (§9) is
 * true because there is only one definition of what the pattern is.
 */

import { toCss } from '@/model/color';
import type { DashKind, HatchPattern, LineStyle } from '@/model/types';

/** Strokes making up one tile, in tile-local coordinates. */
interface TileSpec {
  size: number;
  lines: [number, number, number, number][];
  dots: [number, number, number][];
  /** Extra rotation applied to the whole tile, in degrees. */
  rotation: number;
}

function tileSpec(p: HatchPattern): TileSpec {
  const s = Math.max(2, p.spacing);
  const spec: TileSpec = { size: s, lines: [], dots: [], rotation: p.angle };

  switch (p.kind) {
    case 'diagonal':
      // Two strokes per tile so the pattern is continuous across tile seams.
      spec.lines = [
        [-s, 0, 0, -s],
        [0, s, s, 0],
        [-0.001, -0.001, s, s * -1 + 0.001],
      ];
      spec.lines = [
        [0, s, s, 0],
        [-s * 0.5, s * 0.5, s * 0.5, -s * 0.5],
        [s * 0.5, s * 1.5, s * 1.5, s * 0.5],
      ];
      break;
    case 'reverse-diagonal':
      spec.lines = [
        [0, 0, s, s],
        [-s * 0.5, -s * 0.5, s * 0.5, s * 0.5],
        [s * 0.5, s * 0.5, s * 1.5, s * 1.5],
      ];
      break;
    case 'crosshatch':
      spec.lines = [
        [0, s, s, 0],
        [-s * 0.5, s * 0.5, s * 0.5, -s * 0.5],
        [s * 0.5, s * 1.5, s * 1.5, s * 0.5],
        [0, 0, s, s],
        [-s * 0.5, -s * 0.5, s * 0.5, s * 0.5],
        [s * 0.5, s * 0.5, s * 1.5, s * 1.5],
      ];
      break;
    case 'vertical':
      spec.lines = [[s / 2, -0.5, s / 2, s + 0.5]];
      break;
    case 'horizontal':
      spec.lines = [[-0.5, s / 2, s + 0.5, s / 2]];
      break;
    case 'dots':
      spec.dots = [
        [s * 0.25, s * 0.25, Math.max(0.5, p.thickness)],
        [s * 0.75, s * 0.75, Math.max(0.5, p.thickness)],
      ];
      break;
    default:
      break;
  }
  return spec;
}

const canvasCache = new Map<string, CanvasPattern | null>();

function patternKey(p: HatchPattern, scale: number): string {
  return `${p.kind}|${p.angle}|${p.spacing}|${p.thickness}|${p.color}|${p.opacity}|${scale.toFixed(2)}`;
}

/**
 * Build (or fetch from cache) a CanvasPattern for the live map.
 * Returns null when the pattern is `none` or the browser refuses a context.
 */
export function canvasPattern(p: HatchPattern | null, scale = 1): CanvasPattern | null {
  if (!p || p.kind === 'none') return null;
  const key = patternKey(p, scale);
  const cached = canvasCache.get(key);
  if (cached !== undefined) return cached;

  const spec = tileSpec(p);
  const size = Math.max(2, Math.round(spec.size * scale));
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) {
    canvasCache.set(key, null);
    return null;
  }

  ctx.scale(scale, scale);
  ctx.strokeStyle = toCss(p.color, p.opacity);
  ctx.fillStyle = toCss(p.color, p.opacity);
  ctx.lineWidth = p.thickness;
  ctx.lineCap = 'butt';

  if (spec.rotation) {
    ctx.translate(spec.size / 2, spec.size / 2);
    ctx.rotate((spec.rotation * Math.PI) / 180);
    ctx.translate(-spec.size / 2, -spec.size / 2);
  }

  for (const [x1, y1, x2, y2] of spec.lines) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  for (const [cx, cy, r] of spec.dots) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const measureCtx = document.createElement('canvas').getContext('2d');
  const pattern = measureCtx ? measureCtx.createPattern(c, 'repeat') : null;
  canvasCache.set(key, pattern);
  return pattern;
}

/** Stable id for an SVG `<pattern>` def. */
export function svgPatternId(p: HatchPattern): string {
  const raw = `${p.kind}-${p.angle}-${p.spacing}-${p.thickness}-${p.color}-${p.opacity}`;
  return `hatch-${raw.replace(/[^a-z0-9-]/gi, '')}`;
}

/** `<pattern>` markup for the SVG `<defs>` block. */
export function svgPatternDef(p: HatchPattern): string {
  const spec = tileSpec(p);
  const s = spec.size;
  const stroke = toCss(p.color, p.opacity);
  const body: string[] = [];
  for (const [x1, y1, x2, y2] of spec.lines) {
    body.push(
      `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${stroke}" stroke-width="${p.thickness}"/>`,
    );
  }
  for (const [cx, cy, r] of spec.dots) {
    body.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="${stroke}"/>`);
  }
  const transform = spec.rotation ? ` patternTransform="rotate(${spec.rotation})"` : '';
  return (
    `<pattern id="${svgPatternId(p)}" patternUnits="userSpaceOnUse" ` +
    `width="${round(s)}" height="${round(s)}"${transform}>${body.join('')}</pattern>`
  );
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Dash patterns (spec §8)
// ---------------------------------------------------------------------------

/** Dash array in px for a given dash kind at a given stroke width. */
export function dashArray(dash: DashKind, width: number): number[] | undefined {
  const w = Math.max(0.4, width);
  switch (dash) {
    case 'dashed':
      return [w * 4, w * 2.5];
    case 'dotted':
      return [w * 0.1, w * 2.2];
    case 'dash-dot':
      return [w * 5, w * 2, w * 0.1, w * 2];
    case 'alternating':
      return [w * 6, w * 6];
    case 'solid':
    case 'double':
    default:
      return undefined;
  }
}

/**
 * A double line is drawn as two strokes: a wide one in the casing colour
 * underneath, and a narrow one in the background colour on top, which leaves the
 * classic two-rule border of an engraved atlas.
 */
export function isDoubleLine(style: LineStyle): boolean {
  return style.dash === 'double';
}

export function doubleLineWidths(style: LineStyle): { outer: number; inner: number } {
  const outer = Math.max(style.width, 1.2) * 2.4;
  return { outer, inner: outer - Math.max(0.6, style.width) * 2 };
}

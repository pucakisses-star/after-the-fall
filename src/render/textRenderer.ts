/**
 * Text rendering (spec §10, §11, §12, §42, §43).
 *
 * The canvas API has no letter-spacing that works reliably across browsers, and
 * no text-on-path at all. Both are non-negotiable for this kind of map — the
 * country and ocean labels in a historical atlas live or die on tracking — so
 * text is drawn glyph by glyph here.
 *
 * Drawing per glyph also gives us, for free:
 *   • exact bounding boxes, used for label hit-testing and collision checks (§13)
 *   • text on an arbitrary path, by advancing along the polyline (§12)
 *   • halo and outline as separate passes (§42)
 */

import { toCss } from '@/model/color';
import { applyTextTransform, fontShorthand } from '@/model/resolveStyle';
import type { TextStyle } from '@/model/types';

export interface TextBox {
  /** Centre of the laid-out text, in pixels. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
}

/** Total advance width of `text` including tracking, in px. */
export function measureTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  style: TextStyle,
  scale = 1,
): number {
  ctx.font = fontShorthand(style, scale);
  const tracking = style.tracking * scale;
  let w = 0;
  for (const ch of Array.from(text)) w += ctx.measureText(ch).width + tracking;
  // The trailing tracking after the final glyph is not part of the visible run.
  return Math.max(0, w - tracking);
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Draw a straight (optionally rotated) text block centred on (x, y).
 * Returns the bounding box so callers can cache it for hit-testing.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  x: number,
  y: number,
  style: TextStyle,
  scale = 1,
  rotationDeg = 0,
): TextBox {
  const text = applyTextTransform(rawText, style.transform);
  const lines = splitLines(text);
  const fontPx = style.fontSize * scale;
  const lineHeight = fontPx * style.lineHeight;
  const widths = lines.map((l) => measureTracked(ctx, l, style, scale));
  const blockWidth = Math.max(...widths, 0);
  const blockHeight = lineHeight * lines.length;

  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.translate(x, y);
  if (rotationDeg) ctx.rotate((rotationDeg * Math.PI) / 180);
  ctx.font = fontShorthand(style, scale);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const tracking = style.tracking * scale;

  lines.forEach((line, i) => {
    const w = widths[i];
    // Horizontal alignment is relative to the widest line of the block.
    let startX: number;
    if (style.align === 'left') startX = -blockWidth / 2;
    else if (style.align === 'right') startX = blockWidth / 2 - w;
    else startX = -w / 2;

    const lineY = -blockHeight / 2 + lineHeight * (i + 0.5);

    // Pass 1: halo, drawn behind everything so adjacent glyphs do not clip it.
    if (style.haloColor && style.haloWidth > 0) {
      ctx.strokeStyle = toCss(style.haloColor, 1);
      ctx.lineWidth = style.haloWidth * 2 * scale;
      let cx = startX;
      for (const ch of Array.from(line)) {
        ctx.strokeText(ch, cx, lineY);
        cx += ctx.measureText(ch).width + tracking;
      }
    }

    // Pass 2: glyph outline.
    if (style.outlineColor && style.outlineWidth > 0) {
      ctx.strokeStyle = toCss(style.outlineColor, 1);
      ctx.lineWidth = style.outlineWidth * scale;
      let cx = startX;
      for (const ch of Array.from(line)) {
        ctx.strokeText(ch, cx, lineY);
        cx += ctx.measureText(ch).width + tracking;
      }
    }

    // Pass 3: fill.
    ctx.fillStyle = toCss(style.color, 1);
    let cx = startX;
    for (const ch of Array.from(line)) {
      ctx.fillText(ch, cx, lineY);
      cx += ctx.measureText(ch).width + tracking;
    }
  });

  ctx.restore();

  return { cx: x, cy: y, width: blockWidth, height: blockHeight, rotation: rotationDeg };
}

// ---------------------------------------------------------------------------
// Text on a path (spec §12, §43, §44)
// ---------------------------------------------------------------------------

export interface PathPoint {
  x: number;
  y: number;
}

interface PathSample {
  x: number;
  y: number;
  angle: number;
}

/** Cumulative lengths along a pixel polyline. */
function pathLengths(points: PathPoint[]): number[] {
  const lens = [0];
  for (let i = 1; i < points.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return lens;
}

/** Position and tangent angle at distance `d` along the polyline. */
function sampleAt(points: PathPoint[], lens: number[], d: number): PathSample | null {
  if (points.length < 2) return null;
  const total = lens[lens.length - 1];
  if (total <= 0) return null;
  const t = Math.max(0, Math.min(total, d));
  let i = 1;
  while (i < lens.length - 1 && lens[i] < t) i++;
  const seg = lens[i] - lens[i - 1];
  const f = seg > 0 ? (t - lens[i - 1]) / seg : 0;
  const a = points[i - 1];
  const b = points[i];
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

export function pathLength(points: PathPoint[]): number {
  const lens = pathLengths(points);
  return lens[lens.length - 1] ?? 0;
}

/**
 * Lay text along a polyline. Each glyph is placed at its own point on the curve
 * and rotated to the local tangent — the standard way river, ocean and mountain
 * range names are set in an atlas.
 *
 * `offsetAlong` positions the run: 0.5 centres it on the path.
 * If the text is longer than the path, it is still drawn, running off the end,
 * rather than silently dropped.
 */
export function drawTextOnPath(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  points: PathPoint[],
  style: TextStyle,
  scale = 1,
  offsetAlong = 0.5,
  /** Perpendicular offset in px; positive is to the left of travel. */
  sideOffset = 0,
): TextBox | null {
  if (points.length < 2) return null;
  const text = applyTextTransform(rawText, style.transform).replace(/\r?\n/g, ' ');
  const lens = pathLengths(points);
  const total = lens[lens.length - 1];
  if (total <= 0) return null;

  ctx.save();
  ctx.font = fontShorthand(style, scale);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.globalAlpha = style.opacity;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const tracking = style.tracking * scale;
  const chars = Array.from(text);
  const advances = chars.map((c) => ctx.measureText(c).width + tracking);
  const runWidth = Math.max(0, advances.reduce((a, b) => a + b, 0) - tracking);

  let cursor = (total - runWidth) * offsetAlong;

  // Flip the whole run when the path predominantly runs right-to-left, so the
  // text never reads upside down.
  const startSample = sampleAt(points, lens, cursor);
  const endSample = sampleAt(points, lens, cursor + runWidth);
  const flip =
    !!startSample && !!endSample && endSample.x < startSample.x && Math.abs(endSample.x - startSample.x) > 4;
  const seq = flip ? [...chars].reverse() : chars;
  const adv = flip ? [...advances].reverse() : advances;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < seq.length; i++) {
    const ch = seq[i];
    const w = adv[i] - tracking;
    const at = sampleAt(points, lens, cursor + w / 2);
    cursor += adv[i];
    if (!at) continue;

    const angle = flip ? at.angle + Math.PI : at.angle;
    const nx = Math.sin(angle) * -sideOffset;
    const ny = Math.cos(angle) * sideOffset;

    ctx.save();
    ctx.translate(at.x + nx, at.y + ny);
    ctx.rotate(angle);
    if (style.haloColor && style.haloWidth > 0) {
      ctx.strokeStyle = toCss(style.haloColor, 1);
      ctx.lineWidth = style.haloWidth * 2 * scale;
      ctx.strokeText(ch, 0, 0);
    }
    if (style.outlineColor && style.outlineWidth > 0) {
      ctx.strokeStyle = toCss(style.outlineColor, 1);
      ctx.lineWidth = style.outlineWidth * scale;
      ctx.strokeText(ch, 0, 0);
    }
    ctx.fillStyle = toCss(style.color, 1);
    ctx.fillText(ch, 0, 0);
    ctx.restore();

    minX = Math.min(minX, at.x + nx);
    maxX = Math.max(maxX, at.x + nx);
    minY = Math.min(minY, at.y + ny);
    maxY = Math.max(maxY, at.y + ny);
  }

  ctx.restore();
  if (!Number.isFinite(minX)) return null;
  const pad = style.fontSize * scale * 0.6;
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: maxX - minX + pad,
    height: maxY - minY + pad,
    rotation: 0,
  };
}

// ---------------------------------------------------------------------------
// Collision detection (spec §13)
// ---------------------------------------------------------------------------

export interface CollisionBox extends TextBox {
  id: string;
}

/** Axis-aligned overlap test. Rotated boxes use their circumscribed AABB. */
export function boxesOverlap(a: TextBox, b: TextBox, padding = 0): boolean {
  const ea = aabb(a, padding);
  const eb = aabb(b, padding);
  return !(ea.x2 < eb.x1 || eb.x2 < ea.x1 || ea.y2 < eb.y1 || eb.y2 < ea.y1);
}

function aabb(b: TextBox, padding: number) {
  const rad = (b.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const w = (b.width * c + b.height * s) / 2 + padding;
  const h = (b.width * s + b.height * c) / 2 + padding;
  return { x1: b.cx - w, x2: b.cx + w, y1: b.cy - h, y2: b.cy + h };
}

/** Which labels currently overlap. Returns pairs of ids. */
export function findCollisions(boxes: CollisionBox[], padding = 1): [string, string][] {
  const out: [string, string][] = [];
  // Sort by x so we can stop scanning once boxes are clear of each other.
  const sorted = [...boxes].sort((a, b) => a.cx - a.width / 2 - (b.cx - b.width / 2));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].cx - sorted[j].width / 2 > sorted[i].cx + sorted[i].width / 2 + padding) break;
      if (boxesOverlap(sorted[i], sorted[j], padding)) out.push([sorted[i].id, sorted[j].id]);
    }
  }
  return out;
}

/** Hit-test a point against a label box, honouring rotation. */
export function boxContains(box: TextBox, px: number, py: number, padding = 3): boolean {
  const rad = (-box.rotation * Math.PI) / 180;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= box.width / 2 + padding && Math.abs(ly) <= box.height / 2 + padding;
}

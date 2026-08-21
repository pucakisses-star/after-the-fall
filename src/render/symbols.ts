/**
 * Settlement symbol geometry (spec §14, §41).
 *
 * Each symbol is described once, as primitives in a normalised -1..1 box, and
 * rendered from that description to both the canvas (live map) and SVG (export).
 * One definition means the exported map is the map you were looking at.
 */

import type { SymbolShape, SymbolStyle } from '@/model/types';

export type Primitive =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: boolean; stroke: boolean }
  | { kind: 'polygon'; points: [number, number][]; fill: boolean; stroke: boolean }
  | { kind: 'polyline'; points: [number, number][] };

function star(points: number, inner: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 1 : inner;
    const a = (Math.PI / points) * i - Math.PI / 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

/**
 * Rays around a point, as separate strokes.
 *
 * `skipDown` leaves out the one that would point at the ground, so a radiance
 * sits *above* whatever it is shining out of rather than through it.
 */
function rays(
  n: number,
  cx: number,
  cy: number,
  from: number,
  to: number,
  skipDown = true,
): Primitive[] {
  const out: Primitive[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((Math.PI * 2) / n) * i - Math.PI / 2;
    if (skipDown && Math.sin(a) > 0.9) continue;
    out.push({
      kind: 'polyline',
      points: [
        [cx + Math.cos(a) * from, cy + Math.sin(a) * from],
        [cx + Math.cos(a) * to, cy + Math.sin(a) * to],
      ],
    });
  }
  return out;
}

function regular(n: number, rotation = -Math.PI / 2): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((Math.PI * 2) / n) * i + rotation;
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return pts;
}

/** Primitives for a shape, drawn back-to-front. */
export function symbolPrimitives(shape: SymbolShape): Primitive[] {
  switch (shape) {
    case 'circle':
      return [{ kind: 'circle', cx: 0, cy: 0, r: 1, fill: true, stroke: true }];
    case 'filled-circle':
      // Filled with the *stroke* colour: the classic solid town dot.
      return [{ kind: 'circle', cx: 0, cy: 0, r: 1, fill: true, stroke: true }];
    case 'double-circle':
      return [
        { kind: 'circle', cx: 0, cy: 0, r: 1, fill: true, stroke: true },
        { kind: 'circle', cx: 0, cy: 0, r: 0.45, fill: true, stroke: true },
      ];
    case 'star':
      return [{ kind: 'polygon', points: star(5, 0.42), fill: true, stroke: true }];
    case 'square':
      return [
        {
          kind: 'polygon',
          points: [
            [-0.8, -0.8],
            [0.8, -0.8],
            [0.8, 0.8],
            [-0.8, 0.8],
          ],
          fill: true,
          stroke: true,
        },
      ];
    case 'filled-square':
      return [
        {
          kind: 'polygon',
          points: [
            [-0.8, -0.8],
            [0.8, -0.8],
            [0.8, 0.8],
            [-0.8, 0.8],
          ],
          fill: true,
          stroke: true,
        },
      ];
    case 'diamond':
      return [{ kind: 'polygon', points: regular(4), fill: true, stroke: true }];
    case 'triangle':
      return [{ kind: 'polygon', points: regular(3), fill: true, stroke: true }];
    case 'cross':
      return [
        { kind: 'polyline', points: [[0, -1], [0, 1]] },
        { kind: 'polyline', points: [[-0.62, -0.35], [0.62, -0.35]] },
      ];
    case 'castle':
      // Crenellated block — reads as a fortress at 9 px.
      return [
        {
          kind: 'polygon',
          points: [
            [-0.9, 0.85],
            [-0.9, -0.35],
            [-0.6, -0.35],
            [-0.6, -0.75],
            [-0.3, -0.75],
            [-0.3, -0.35],
            [0.3, -0.35],
            [0.3, -0.75],
            [0.6, -0.75],
            [0.6, -0.35],
            [0.9, -0.35],
            [0.9, 0.85],
          ],
          fill: true,
          stroke: true,
        },
      ];
    case 'keep':
      // A castle the way an atlas draws one: two crenellated towers with a
      // lower curtain wall between them. `castle` is a single crenellated
      // block, which at 9 px reads as a stretch of wall or, next to it on the
      // sheet, as the factory shed; the two-tower profile is what says castle
      // at a glance, because the silhouette carries it even when the merlons
      // themselves have blurred to nothing.
      return [
        {
          kind: 'polygon',
          points: [
            [-0.95, 0.92],
            [-0.95, -0.82],
            [-0.76, -0.82],
            [-0.76, -0.5],
            [-0.61, -0.5],
            [-0.61, -0.82],
            [-0.42, -0.82],
            [-0.42, -0.2],
            [0.42, -0.2],
            [0.42, -0.82],
            [0.61, -0.82],
            [0.61, -0.5],
            [0.76, -0.5],
            [0.76, -0.82],
            [0.95, -0.82],
            [0.95, 0.92],
          ],
          fill: true,
          stroke: true,
        },
        // The gate, as an opening in the wall between the towers.
        { kind: 'polyline', points: [[-0.22, 0.92], [-0.22, 0.28], [0, 0.06], [0.22, 0.28], [0.22, 0.92]] },
      ];
    case 'holy-site':
      // A radiance over an altar. Deliberately of no particular faith: the only
      // religious mark on the sheet before this was a Latin cross, with the
      // temple's classical pediment as the nearest thing to a general one, and
      // neither will do for a place that is holy to somebody else. A disc with
      // rays above a stepped plinth reads as consecrated ground without saying
      // whose.
      return [
        ...rays(6, 0, -0.3, 0.42, 0.68),
        { kind: 'circle', cx: 0, cy: -0.3, r: 0.3, fill: true, stroke: true },
        {
          kind: 'polygon',
          points: [
            [-0.85, 0.92],
            [-0.46, 0.36],
            [0.46, 0.36],
            [0.85, 0.92],
          ],
          fill: true,
          stroke: true,
        },
      ];
    case 'anchor':
      return [
        { kind: 'polyline', points: [[0, -0.9], [0, 0.6]] },
        { kind: 'polyline', points: [[-0.5, -0.45], [0.5, -0.45]] },
        {
          kind: 'polyline',
          points: [
            [-0.8, 0.1],
            [-0.7, 0.65],
            [0, 0.95],
            [0.7, 0.65],
            [0.8, 0.1],
          ],
        },
      ];
    case 'battle':
      // Crossed swords: the one mark every historical atlas has and this had no
      // way to draw. The short guards near the hilts are what stop it reading as
      // a plain X at 9 px.
      return [
        { kind: 'polyline', points: [[-0.8, 0.85], [0.75, -0.8]] },
        { kind: 'polyline', points: [[0.8, 0.85], [-0.75, -0.8]] },
        { kind: 'polyline', points: [[-0.58, 0.24], [-0.2, 0.59]] },
        { kind: 'polyline', points: [[0.58, 0.24], [0.2, 0.59]] },
      ];
    case 'ruins':
      // Broken columns on a baseline. The Ruins settlement type used to borrow a
      // hollow triangle, which reads as "some category" and not as a ruin; three
      // stumps of unequal height read as one immediately.
      return [
        { kind: 'polyline', points: [[-0.95, 0.85], [0.95, 0.85]] },
        { kind: 'polyline', points: [[-0.6, 0.85], [-0.6, -0.3]] },
        { kind: 'polyline', points: [[-0.05, 0.85], [-0.05, -0.85]] },
        { kind: 'polyline', points: [[0.55, 0.85], [0.55, 0.1]] },
      ];
    case 'temple':
      // A classical pediment. The only religious mark here was a Latin cross,
      // which is the wrong symbol for most of the world and most of history.
      return [
        { kind: 'polygon', points: [[-0.95, -0.2], [0, -0.9], [0.95, -0.2]], fill: true, stroke: true },
        { kind: 'polyline', points: [[-0.95, 0.85], [0.95, 0.85]] },
        { kind: 'polyline', points: [[-0.6, -0.2], [-0.6, 0.85]] },
        { kind: 'polyline', points: [[0, -0.2], [0, 0.85]] },
        { kind: 'polyline', points: [[0.6, -0.2], [0.6, 0.85]] },
      ];
    case 'mountain':
      // Twin peaks, filled. `triangle` is a category marker; this is a landform.
      return [
        {
          kind: 'polygon',
          points: [
            [-1, 0.75],
            [-0.35, -0.55],
            [-0.02, 0.05],
            [0.42, -0.85],
            [1, 0.75],
          ],
          fill: true,
          stroke: true,
        },
      ];
    case 'factory':
      // Shed and chimney. This map's world runs on the Factory of Detroit and
      // the Foundry of Pittsburgh; industry deserved a mark of its own.
      return [
        { kind: 'polygon', points: [[-0.72, -0.9], [-0.42, -0.9], [-0.42, 0.2], [-0.72, 0.2]], fill: true, stroke: true },
        { kind: 'polygon', points: [[-0.95, 0.85], [-0.95, -0.15], [0.95, -0.15], [0.95, 0.85]], fill: true, stroke: true },
      ];
    case 'airfield':
      // An aircraft silhouette rather than the crossed runways the symbol is
      // often drawn as: this sheet already has crossed swords and a cross, and a
      // third pair of crossed lines would be indistinguishable from both.
      return [
        {
          kind: 'polygon',
          points: [
            [0, -0.95],
            [0.12, -0.5],
            [0.95, 0.15],
            [0.95, 0.35],
            [0.12, 0.05],
            [0.12, 0.6],
            [0.4, 0.85],
            [0.4, 0.95],
            [0, 0.75],
            [-0.4, 0.95],
            [-0.4, 0.85],
            [-0.12, 0.6],
            [-0.12, 0.05],
            [-0.95, 0.35],
            [-0.95, 0.15],
            [-0.12, -0.5],
          ],
          fill: true,
          stroke: true,
        },
      ];
    default:
      return [{ kind: 'circle', cx: 0, cy: 0, r: 1, fill: true, stroke: true }];
  }
}

/**
 * Every shape a symbol can take, with the name the picker shows.
 *
 * Ordered as the list reads rather than alphabetically: the plain geometry
 * first, because that is what most settlements use, then the pictorial marks.
 * `custom-svg` is deliberately absent — it needs a path to draw and is set by
 * supplying one, not by being chosen from a menu.
 */
export const SYMBOL_SHAPES: { value: SymbolShape; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'filled-circle', label: 'Filled circle' },
  { value: 'double-circle', label: 'Double circle' },
  { value: 'square', label: 'Square' },
  { value: 'filled-square', label: 'Filled square' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'star', label: 'Star' },
  { value: 'cross', label: 'Cross' },
  { value: 'castle', label: 'Battlement' },
  { value: 'keep', label: 'Castle' },
  { value: 'anchor', label: 'Anchor' },
  { value: 'battle', label: 'Battle' },
  { value: 'ruins', label: 'Ruins' },
  { value: 'temple', label: 'Temple' },
  { value: 'holy-site', label: 'Holy site' },
  { value: 'mountain', label: 'Mountain' },
  { value: 'factory', label: 'Factory' },
  { value: 'airfield', label: 'Airfield' },
];

/** Solid-fill shapes take their fill from the stroke colour instead. */
export function effectiveFill(style: SymbolStyle): string {
  if (style.shape === 'filled-circle' || style.shape === 'filled-square') return style.strokeColor;
  return style.fillColor;
}

/** Draw a symbol to a canvas context, centred on (0,0) in the current transform. */
export function drawSymbol(
  ctx: CanvasRenderingContext2D,
  style: SymbolStyle,
  cx: number,
  cy: number,
  scale = 1,
): void {
  const r = (style.size / 2) * scale;
  const fill = effectiveFill(style);
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.lineWidth = Math.max(0.2, style.strokeWidth * scale);
  ctx.strokeStyle = style.strokeColor;
  ctx.fillStyle = fill;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const prim of symbolPrimitives(style.shape)) {
    ctx.beginPath();
    if (prim.kind === 'circle') {
      ctx.arc(cx + prim.cx * r, cy + prim.cy * r, Math.max(0.4, prim.r * r), 0, Math.PI * 2);
      if (prim.fill) ctx.fill();
      if (prim.stroke && style.strokeWidth > 0) ctx.stroke();
    } else if (prim.kind === 'polygon') {
      prim.points.forEach(([x, y], i) => {
        const px = cx + x * r;
        const py = cy + y * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      if (prim.fill) ctx.fill();
      if (prim.stroke && style.strokeWidth > 0) ctx.stroke();
    } else {
      prim.points.forEach(([x, y], i) => {
        const px = cx + x * r;
        const py = cy + y * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (style.strokeWidth > 0) ctx.stroke();
    }
  }
  ctx.restore();
}

/** SVG markup for a symbol, positioned at (cx, cy) in output units. */
export function symbolToSvg(style: SymbolStyle, cx: number, cy: number, scale = 1): string {
  const r = (style.size / 2) * scale;
  const fill = effectiveFill(style);
  const sw = Math.max(0.2, style.strokeWidth * scale);
  const parts: string[] = [];

  for (const prim of symbolPrimitives(style.shape)) {
    if (prim.kind === 'circle') {
      parts.push(
        `<circle cx="${fmt(cx + prim.cx * r)}" cy="${fmt(cy + prim.cy * r)}" r="${fmt(Math.max(0.4, prim.r * r))}" ` +
          `fill="${prim.fill ? fill : 'none'}" stroke="${prim.stroke ? style.strokeColor : 'none'}" stroke-width="${fmt(sw)}"/>`,
      );
    } else if (prim.kind === 'polygon') {
      const pts = prim.points.map(([x, y]) => `${fmt(cx + x * r)},${fmt(cy + y * r)}`).join(' ');
      parts.push(
        `<polygon points="${pts}" fill="${prim.fill ? fill : 'none'}" ` +
          `stroke="${prim.stroke ? style.strokeColor : 'none'}" stroke-width="${fmt(sw)}" stroke-linejoin="round"/>`,
      );
    } else {
      const pts = prim.points.map(([x, y]) => `${fmt(cx + x * r)},${fmt(cy + y * r)}`).join(' ');
      parts.push(
        `<polyline points="${pts}" fill="none" stroke="${style.strokeColor}" ` +
          `stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
  }

  const opacity = style.opacity < 1 ? ` opacity="${style.opacity}"` : '';
  return `<g${opacity}>${parts.join('')}</g>`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

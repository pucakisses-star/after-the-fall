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
    default:
      return [{ kind: 'circle', cx: 0, cy: 0, r: 1, fill: true, stroke: true }];
  }
}

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

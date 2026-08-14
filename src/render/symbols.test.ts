/**
 * Settlement symbol geometry (spec §14, §41, §64).
 *
 * One definition drives the live map, the SVG export and the style-class list,
 * so what is checked here is what all three depend on: every shape draws
 * something, and the solid/hollow distinction survives being re-coloured.
 */

import { describe, expect, it } from 'vitest';
import { effectiveFill, symbolPrimitives, symbolToSvg } from './symbols';
import { createDefaultStyleSheet } from '@/model/defaults';
import type { SymbolShape, SymbolStyle } from '@/model/types';

const SHAPES: SymbolShape[] = [
  'circle', 'filled-circle', 'double-circle', 'star', 'square', 'filled-square',
  'diamond', 'triangle', 'cross', 'castle', 'anchor', 'custom-svg',
];

function style(over: Partial<SymbolStyle> = {}): SymbolStyle {
  return {
    shape: 'circle',
    size: 8,
    fillColor: '#fdfaf2',
    strokeColor: '#2b2318',
    strokeWidth: 1.1,
    opacity: 1,
    customPath: null,
    ...over,
  };
}

describe('symbolPrimitives', () => {
  it('draws something for every shape, including one it does not know', () => {
    for (const shape of SHAPES) {
      const prims = symbolPrimitives(shape);
      expect(prims.length, `${shape} draws nothing`).toBeGreaterThan(0);
      for (const p of prims) {
        const points = p.kind === 'circle' ? [[p.cx, p.cy]] : p.points;
        for (const [x, y] of points) {
          // Everything lives in the normalised box the callers scale from; a
          // primitive outside it would overflow the style list's gutter and be
          // clipped on the map.
          expect(Math.abs(x), `${shape} reaches outside the unit box`).toBeLessThanOrEqual(1);
          expect(Math.abs(y), `${shape} reaches outside the unit box`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('gives every built-in symbol class a mark', () => {
    // The style list draws each of these; a shape that resolved to nothing
    // would leave a row with an empty gutter and no way to tell what it is.
    for (const cls of Object.values(createDefaultStyleSheet().symbol)) {
      const s = cls.style as SymbolStyle;
      expect(symbolPrimitives(s.shape).length, `${cls.name} draws nothing`).toBeGreaterThan(0);
      expect(s.size, `${cls.name} has no size`).toBeGreaterThan(0);
    }
  });
});

describe('effectiveFill', () => {
  it('fills the solid shapes from the stroke colour and the rest from the fill', () => {
    expect(effectiveFill(style({ shape: 'filled-circle' }))).toBe('#2b2318');
    expect(effectiveFill(style({ shape: 'filled-square' }))).toBe('#2b2318');
    expect(effectiveFill(style({ shape: 'circle' }))).toBe('#fdfaf2');
    expect(effectiveFill(style({ shape: 'star' }))).toBe('#fdfaf2');
  });

  it('keeps solid solid and hollow hollow when the palette is swapped out', () => {
    // What the style-class list relies on. A symbol's colours are set for cream
    // paper, so on a dark panel it is re-drawn in the panel's own foreground
    // with a transparent fill. That substitution has to preserve the one
    // distinction the list exists to show — City is a hollow circle, Regional
    // capital a solid one — which it does only because a solid shape takes its
    // fill from the stroke.
    const swap = (s: SymbolStyle) => ({ ...s, strokeColor: 'currentColor', fillColor: 'transparent' });
    expect(effectiveFill(swap(style({ shape: 'filled-circle' })))).toBe('currentColor');
    expect(effectiveFill(swap(style({ shape: 'circle' })))).toBe('transparent');
  });
});

describe('symbolToSvg', () => {
  it('emits real geometry positioned where it was asked for', () => {
    const svg = symbolToSvg(style({ shape: 'circle', size: 10 }), 100, 50);
    expect(svg).toContain('<circle');
    expect(svg).toContain('cx="100"');
    expect(svg).toContain('cy="50"');
    // Radius is half the size, so a 10 px symbol is a 5 px radius.
    expect(svg).toContain('r="5"');
  });

  it('scales about the centre rather than moving it', () => {
    const big = symbolToSvg(style({ shape: 'circle', size: 10 }), 100, 50, 2);
    expect(big).toContain('cx="100"');
    expect(big).toContain('r="10"');
  });

  it('never leaves a stroke-less shape invisible', () => {
    // strokeWidth 0 is legal — a solid dot with no outline — but then the fill
    // has to carry it.
    const svg = symbolToSvg(style({ shape: 'filled-circle', strokeWidth: 0 }), 0, 0);
    expect(svg).toContain('fill="#2b2318"');
  });
});

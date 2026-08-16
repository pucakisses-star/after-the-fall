/**
 * A name and its symbol as one object (spec §11, §47).
 *
 * The bug this pins: the label offset positioned the *centre* of the text
 * block, so a name of any length lay across its own dot — measured on the
 * demonstration map, "Austin" beside a ten-pixel capital ring overlapped it by
 * ten pixels, which is the whole ring. Promoting a town to a capital made it
 * worse, because the symbol grew and the name did not move.
 */

import { describe, expect, it } from 'vitest';
import { placeNameBySymbol, symbolReach } from './namePlacement';
import type { SymbolStyle, TextStyle } from '@/model/types';

const symbol = (size: number, strokeWidth = 1): SymbolStyle =>
  ({ shape: 'circle', size, strokeWidth, strokeColor: '#000', fillColor: '#fff', opacity: 1 }) as SymbolStyle;

const text = (fontSize = 11): TextStyle =>
  ({ fontSize, lineHeight: 1.2, tracking: 0, align: 'center' }) as TextStyle;

describe('placing a name beside its symbol', () => {
  it('anchors the near edge, not the middle', () => {
    // The whole fix in one assertion. Anchoring the start means the block runs
    // away from the symbol, so its width cannot carry it back over the dot.
    const p = placeNameBySymbol([8, 0], symbol(10), text());
    expect(p.anchorX).toBe('start');
    expect(p.dy).toBe(0);
  });

  it('never comes closer than the symbol reaches', () => {
    // The offset the demonstration map ships for an ordinary town, against the
    // ring a capital gets: the name is pushed out rather than left underneath.
    const tight = placeNameBySymbol([8, 0], symbol(30), text());
    expect(tight.dx).toBeGreaterThan(symbolReach(symbol(30)));
  });

  it('keeps an offset the author pushed further out', () => {
    expect(placeNameBySymbol([40, 0], symbol(10), text()).dx).toBe(40);
  });

  it('grows the clearance with the symbol, which is what makes them one object', () => {
    const small = placeNameBySymbol([0, 0], symbol(6), text()).dx;
    const large = placeNameBySymbol([0, 0], symbol(20), text()).dx;
    expect(large - small).toBeCloseTo(7, 5);
  });

  it('puts a name on the side its offset points to', () => {
    const left = placeNameBySymbol([-8, 0], symbol(10), text());
    expect(left.anchorX).toBe('end');
    expect(left.dx).toBeLessThan(0);
  });

  it('centres a name set above or below, clear of the symbol by its own height', () => {
    const above = placeNameBySymbol([0, -9], symbol(10), text(11));
    expect(above.anchorX).toBe('middle');
    expect(above.dx).toBe(0);
    // Clear of the ring, plus half a line so the block's edge clears it too.
    expect(-above.dy).toBeGreaterThan(symbolReach(symbol(10)) + (11 * 1.2) / 2);
  });

  it('counts every line of a stacked name', () => {
    const one = placeNameBySymbol([0, 9], symbol(10), text(), 1).dy;
    const three = placeNameBySymbol([0, 9], symbol(10), text(), 3).dy;
    expect(three).toBeGreaterThan(one);
  });
});

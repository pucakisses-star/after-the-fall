/**
 * Where a settlement's name sits beside its symbol (spec §11, §47).
 *
 * A name and the dot it belongs to are one object on a map, and the whole job of
 * this module is to make them behave like one. They used to be two: the symbol
 * was drawn at whatever size its rank called for, and the name was drawn at a
 * stored pixel offset that knew nothing about it. Since that offset positioned
 * the *centre* of the text block rather than its near edge, a name of any length
 * covered its own dot — measured on the demonstration map, "Austin" beside a
 * ten-pixel capital ring overlapped it by ten pixels, which is all of it. Making
 * a town a capital made this worse in the obvious way: the symbol grew and the
 * name did not move.
 *
 * So the offset now says how far the name's near *edge* is from the anchor, and
 * it is never allowed closer than the symbol's own radius. Grow the symbol, or
 * promote the town, and the name steps out of the way; shrink it and the name
 * closes back up. It cannot overlap, because the minimum is the thing it must
 * not overlap.
 *
 * The rule lives here rather than in either renderer because both have to agree:
 * the exported SVG is meant to be the map you were looking at, down to the
 * pixel. Canvas gets `anchorX` as a shift it applies after measuring the block;
 * SVG gets it as `text-anchor`, and lets the viewer do the measuring.
 */

import type { SymbolStyle, TextStyle } from '@/model/types';

/** Clear air between the symbol's edge and the first glyph, in CSS pixels. */
const NAME_GAP = 3;

export interface NamePlacement {
  /** Symbol centre to the text's anchor point, in CSS pixels. */
  dx: number;
  dy: number;
  /** Which end of the text block sits on that point. */
  anchorX: 'start' | 'middle' | 'end';
}

/** How far from the centre the symbol actually reaches. Primitives are drawn within ±1 of it. */
export function symbolReach(symbol: SymbolStyle): number {
  return symbol.size / 2 + Math.max(0, symbol.strokeWidth) / 2;
}

/**
 * Place a name against its symbol, given the offset the label carries.
 *
 * The offset supplies two things and neither is the final position: which side
 * of the symbol the name goes, and how far out the author pushed it. A name
 * offset further than the symbol needs stays where it was put; one offset closer
 * — or one whose symbol has since grown under it — is moved out to the edge.
 *
 * Sideways placement is the ordinary case and needs no measuring: the text runs
 * away from the symbol from its near edge. Above or below, the block is centred
 * over the symbol instead, and its height is arithmetic rather than measurement,
 * so this stays a pure function of the two styles.
 */
export function placeNameBySymbol(
  offset: [number, number],
  symbol: SymbolStyle,
  text: TextStyle,
  lines = 1,
): NamePlacement {
  const clear = symbolReach(symbol) + NAME_GAP;
  const [ox, oy] = offset;

  if (Math.abs(ox) >= Math.abs(oy)) {
    const side = ox < 0 ? -1 : 1;
    return { dx: side * Math.max(Math.abs(ox), clear), dy: 0, anchorX: side < 0 ? 'end' : 'start' };
  }

  const side = oy < 0 ? -1 : 1;
  const half = (text.fontSize * text.lineHeight * Math.max(1, lines)) / 2;
  return { dx: 0, dy: side * (Math.max(Math.abs(oy), clear) + half), anchorX: 'middle' };
}

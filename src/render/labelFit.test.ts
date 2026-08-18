/**
 * Label layout derived from the shape being labelled (spec §10, §11, §42).
 *
 * The thing under test is that a name takes the *country's* direction and size
 * rather than the renderer's defaults, so the cases are shapes with obvious
 * right answers: a shape running north-east gets a north-east inscription, a
 * long thin one gets one line, a stubby one gets two.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_LABEL_SCALE,
  MIN_LABEL_SCALE,
  PLATE_METERS_PER_PIXEL,
  breakTitle,
  dominantAxis,
  fitLabel,
  fitToPlate,
  inscriptionScale,
  labelZoomScale,
  nameFitsItsLand,
  pinnedText,
  nameIsLegible,
  MIN_READABLE_FONT_SIZE,
  scaledText,
} from './labelFit';
import type { Polygon } from 'geojson';

/** A rectangle rotated `deg` clockwise about its centre, at the equator. */
function bar(length: number, width: number, deg: number, at: [number, number] = [0, 0]): Polygon {
  const t = (-deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const corners: [number, number][] = [
    [-length / 2, -width / 2],
    [length / 2, -width / 2],
    [length / 2, width / 2],
    [-length / 2, width / 2],
  ];
  const ring = corners.map(([x, y]) => [
    at[0] + x * cos - y * sin,
    at[1] + x * sin + y * cos,
  ]);
  // Sample the edges too, so the covariance sees the shape and not four points.
  const dense: number[][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (let s = 0; s < 12; s++) {
      dense.push([a[0] + ((b[0] - a[0]) * s) / 12, a[1] + ((b[1] - a[1]) * s) / 12]);
    }
  }
  dense.push(dense[0]);
  return { type: 'Polygon', coordinates: [dense] };
}

describe('dominantAxis', () => {
  it('finds the direction a territory runs', () => {
    expect(dominantAxis(bar(10, 2, 0)).angle).toBeCloseTo(0, 0);
    // Screen y grows downward, so a shape rising to the north-east is a
    // negative rotation on the canvas.
    expect(dominantAxis(bar(10, 2, -30)).angle).toBeCloseTo(-30, 0);
    expect(dominantAxis(bar(10, 2, 30)).angle).toBeCloseTo(30, 0);
  });

  it('lays a north-south territory on its side', () => {
    const a = dominantAxis(bar(2, 10, 0)).angle;
    expect(Math.abs(a)).toBeGreaterThan(80);
  });

  it('reports more room along the territory than across it', () => {
    const a = dominantAxis(bar(10, 2, 20));
    expect(a.along).toBeGreaterThan(a.across * 3);
  });

  it('keeps the answer in a range a reader can hold their head at', () => {
    // Nobody reads a label upside down; every angle folds into (-90, 90].
    for (const deg of [-170, -100, -45, 0, 45, 100, 170]) {
      const a = dominantAxis(bar(10, 2, deg)).angle;
      expect(a).toBeGreaterThan(-90);
      expect(a).toBeLessThanOrEqual(90);
    }
  });

  it('measures ground rather than degrees at high latitude', () => {
    // A degree of longitude in the Arctic is a fraction of a degree of latitude.
    // Untreated, every northern shape comes out running east-west.
    const arctic = bar(6, 6, 0, [0, 75]);
    const axis = dominantAxis(arctic);
    // 6° of longitude at 75°N is ~1.55° of latitude on the ground, so this is
    // really a tall shape and should be labelled as one.
    expect(Math.abs(axis.angle)).toBeGreaterThan(45);
  });
});

describe('breakTitle', () => {
  it('breaks where a reader would', () => {
    expect(breakTitle('Canton of Normal and Bloomington', 2)).toEqual([
      'Canton of Normal and',
      'Bloomington',
    ]);
  });

  it('never strands a word that leans on the next one', () => {
    // "Kingdom of / Hudsonia", never "Kingdom / of Hudsonia".
    const [first] = breakTitle('Kingdom of Hudsonia', 2);
    expect(first).toBe('Kingdom of');
  });

  it('leaves a single word alone', () => {
    expect(breakTitle('Illinois', 2)).toEqual(['Illinois']);
    expect(breakTitle('Canton of Iowa', 1)).toEqual(['Canton of Iowa']);
  });
});

describe('fitLabel', () => {
  const PPD = 40; // px per degree, i.e. a regional plate

  it('sets a realm several times larger than what is inside it', () => {
    // The single biggest difference from a GIS label: hierarchy in the type.
    const shape = bar(8, 5, 0);
    const realm = fitLabel('Kingdom of Hudsonia', shape, PPD, { depth: 0 });
    const member = fitLabel('Duchy of Albany', shape, PPD, { depth: 1 });
    const county = fitLabel('County of Mohawk', shape, PPD, { depth: 2 });
    expect(realm.fontSize).toBeGreaterThan(member.fontSize * 1.8);
    expect(member.fontSize).toBeGreaterThan(county.fontSize);
  });

  it('lays the name along the territory, not across it', () => {
    const layout = fitLabel('Canton of Missouri', bar(10, 2, 35), PPD, { depth: 1 });
    expect(layout.rotation).toBeCloseTo(35, 0);
  });

  it('gives a long thin territory one line and a stubby one two', () => {
    expect(fitLabel('Kingdom of Hudsonia', bar(14, 2, 0), PPD).lines).toHaveLength(1);
    expect(fitLabel('Kingdom of Hudsonia', bar(5, 4, 0), PPD).lines).toHaveLength(2);
  });

  it('opens the tracking on a realm with room to spare', () => {
    // What makes MIDWEST CONFEDERATION span its confederation instead of
    // sitting in a huddle at the middle of it.
    const roomy = fitLabel('HUDSONIA', bar(30, 6, 0), PPD, { depth: 0 });
    const tight = fitLabel('HUDSONIA', bar(4, 3, 0), PPD, { depth: 0 });
    expect(roomy.tracking).toBeGreaterThan(tight.tracking);
    expect(roomy.tracking).toBeGreaterThan(0);
  });

  it('tracks a realm more freely than a county', () => {
    const realm = fitLabel('HUDSONIA', bar(30, 6, 0), PPD, { depth: 0 });
    const county = fitLabel('HUDSONIA', bar(30, 6, 0), PPD, { depth: 2 });
    expect(realm.tracking).toBeGreaterThan(county.tracking);
  });

  it('never shrinks a name past legibility', () => {
    const tiny = fitLabel('County of Somewhere Very Long Indeed', bar(0.2, 0.15, 0), PPD, { depth: 2 });
    expect(tiny.fontSize).toBeGreaterThanOrEqual(5);
    expect(Number.isFinite(tiny.fontSize)).toBe(true);
  });

  it('survives a degenerate shape without producing nonsense', () => {
    const degenerate: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] };
    const layout = fitLabel('Nowhere', degenerate, PPD);
    expect(Number.isFinite(layout.fontSize)).toBe(true);
    expect(Number.isFinite(layout.rotation)).toBe(true);
    expect(layout.lines).toEqual(['Nowhere']);
  });

  it('grows the type as the plate scale grows', () => {
    const small = fitLabel('Hudsonia', bar(8, 5, 0), 10, { depth: 1 });
    const large = fitLabel('Hudsonia', bar(8, 5, 0), 80, { depth: 1 });
    expect(large.fontSize).toBeGreaterThan(small.fontSize);
  });
});

/**
 * Pinning a name (spec §42).
 *
 * The switch is called "do not scale with zoom", and the complaint that drove
 * these cases was that clicking it appeared to do nothing — because at ordinary
 * working zooms the scale is already pegged at its ceiling, so the only visible
 * effect was the name snapping to 40% of its drawn size. So what is asserted
 * here is the pair of properties that make the switch legible: the size on
 * screen does not change at the click, and it does not change afterwards either.
 */
describe('label zoom scale', () => {
  const style = { fontSize: 40, tracking: 8, haloWidth: 2 };
  /** What the renderer puts on screen for a style at a given ground scale. */
  const drawn = (s: typeof style, mpp: number) => scaledText(s, labelZoomScale(mpp)).fontSize;

  it('draws a name at its composed size on the plate it was composed for', () => {
    expect(labelZoomScale(PLATE_METERS_PER_PIXEL)).toBeCloseTo(1, 6);
  });

  it('grows the name as the map is zoomed in and shrinks it on the way out', () => {
    expect(labelZoomScale(PLATE_METERS_PER_PIXEL / 2)).toBeCloseTo(2, 6);
    expect(labelZoomScale(PLATE_METERS_PER_PIXEL * 2)).toBeCloseTo(0.5, 6);
  });

  it('keeps scaling well past the plate, so a name stays with its land', () => {
    // The ceiling used to be 2.5, i.e. reached one and a half zoom levels in,
    // which froze every name for the whole of the working range.
    expect(labelZoomScale(PLATE_METERS_PER_PIXEL / 4)).toBe(4);
    expect(labelZoomScale(PLATE_METERS_PER_PIXEL / 8)).toBe(8);
    expect(MAX_LABEL_SCALE).toBeGreaterThanOrEqual(8);
  });

  it('holds between a floor and a ceiling at the extremes', () => {
    expect(labelZoomScale(PLATE_METERS_PER_PIXEL * 1000)).toBe(MIN_LABEL_SCALE);
    expect(labelZoomScale(PLATE_METERS_PER_PIXEL / 1000)).toBe(MAX_LABEL_SCALE);
    expect(labelZoomScale(0)).toBe(1);
  });

  it('thins a halo with the map but never thickens one', () => {
    expect(scaledText(style, 0.5).haloWidth).toBeCloseTo(1, 6);
    expect(scaledText(style, 2).haloWidth).toBeCloseTo(2, 6);
  });

  it('pins a name at the size it is drawn, not the size it is set to', () => {
    // Three zoom levels inside the plate the name was composed for: the case
    // the switch used to make jump.
    const mpp = PLATE_METERS_PER_PIXEL / 8;
    const factor = labelZoomScale(mpp);
    expect(factor).toBe(8);

    const before = drawn(style, mpp);
    const pinned = pinnedText(style, factor, true);
    expect(pinned.fontSize).toBeCloseTo(before, 2); // pinned: drawn at its own size
    expect(pinned.tracking).toBeCloseTo(style.tracking * factor, 2);
  });

  it('leaves a pinned name the same size at every zoom', () => {
    const pinned = pinnedText(style, labelZoomScale(PLATE_METERS_PER_PIXEL / 8), true);
    const sizes = [PLATE_METERS_PER_PIXEL * 40, PLATE_METERS_PER_PIXEL, PLATE_METERS_PER_PIXEL / 40].map(
      (metersPerPixel) => scaledText(pinned, inscriptionScale({ pinned: true, metersPerPixel })).fontSize,
    );
    expect(sizes).toEqual([pinned.fontSize, pinned.fontSize, pinned.fontSize]);
  });

  it('still scales an unpinned name over the same range', () => {
    const sizes = [PLATE_METERS_PER_PIXEL * 4, PLATE_METERS_PER_PIXEL, PLATE_METERS_PER_PIXEL / 2].map(
      (metersPerPixel) => scaledText(style, inscriptionScale({ pinned: false, metersPerPixel })).fontSize,
    );
    expect(sizes).toEqual([10, 40, 80]);
  });

  it('asks nothing about the label but whether it is pinned', () => {
    // A city's name and an ocean's answer the flag the same way a country's
    // does. The switch that says "do not scale with zoom" cannot explain itself
    // while it is greyed out on most of the map's text.
    const mpp = PLATE_METERS_PER_PIXEL / 8;
    expect(inscriptionScale({ pinned: true, metersPerPixel: mpp })).toBe(1);
    expect(inscriptionScale({ pinned: false, metersPerPixel: mpp })).toBe(8);
  });

  it('unpins without a jump either, at whatever zoom it happens', () => {
    const mpp = PLATE_METERS_PER_PIXEL / 8;
    const pinned = pinnedText(style, labelZoomScale(mpp), true);

    // Unpinned somewhere else entirely: what matters is that the name on screen
    // is the same size the instant before and the instant after.
    const elsewhere = PLATE_METERS_PER_PIXEL * 3;
    const factor = labelZoomScale(elsewhere);
    const loose = pinnedText(pinned, factor, false);
    expect(drawn(loose, elsewhere)).toBeCloseTo(pinned.fontSize, 1);
  });

  it('returns to where it started after a pin and an unpin at one zoom', () => {
    const factor = labelZoomScale(PLATE_METERS_PER_PIXEL / 4);
    const round = pinnedText(pinnedText(style, factor, true), factor, false);
    expect(round.fontSize).toBeCloseTo(style.fontSize, 1);
    expect(round.tracking).toBeCloseTo(style.tracking, 1);
    expect(round.haloWidth).toBeCloseTo(style.haloWidth, 1);
  });

  it('leaves a name off the plate once it is too small to read', () => {
    // The rule the two kinds of label share. A pinned name is culled by the fit
    // test as its land shrinks under it; a scaling name shrinks *with* its land
    // and so answers the fit test the same at every zoom — legibility is what
    // stops it lingering as a smudge on a world view.
    expect(nameIsLegible(scaledText(style, 1))).toBe(true);
    expect(nameIsLegible({ fontSize: MIN_READABLE_FONT_SIZE, tracking: 0, haloWidth: 1 })).toBe(true);
    expect(nameIsLegible({ fontSize: MIN_READABLE_FONT_SIZE - 1, tracking: 0, haloWidth: 1 })).toBe(false);

    // A country name at the map's own type size, on a world view: the zoom
    // scale bottoms out at its floor and the name is a smudge, so it is left
    // off the plate rather than printed unreadably small.
    const country = { fontSize: 17, tracking: 0, haloWidth: 2 };
    const worldView = scaledText(country, labelZoomScale(PLATE_METERS_PER_PIXEL * 200));
    expect(worldView.fontSize).toBeLessThan(MIN_READABLE_FONT_SIZE);
    expect(nameIsLegible(worldView)).toBe(false);
    // At the scale it was composed for, the same name is on the plate.
    expect(nameIsLegible(scaledText(country, labelZoomScale(PLATE_METERS_PER_PIXEL)))).toBe(true);
  });

  it('never lets a name grow wider than the window it is drawn in', () => {
    const window = 1200;
    const capped = fitToPlate(MAX_LABEL_SCALE, 'COUNTY OF BILWI', style, window);
    const width = 'COUNTY OF BILWI'.length * style.fontSize * 0.56 * capped;
    expect(width).toBeLessThanOrEqual(window);
    expect(capped).toBeLessThan(MAX_LABEL_SCALE);
  });

  it('measures the longest line, not the whole text', () => {
    const oneLine = fitToPlate(MAX_LABEL_SCALE, 'COUNTY OF BILWI', style, 1200);
    const broken = fitToPlate(MAX_LABEL_SCALE, 'COUNTY OF\nBILWI', style, 1200);
    expect(broken).toBeGreaterThan(oneLine);
  });

  it('leaves a name alone until it is actually near the edge', () => {
    // Same name, same type, a window four times as wide: nothing to cap.
    expect(fitToPlate(3, 'COUNTY OF BILWI', style, 4000)).toBe(3);
  });

  it('never caps a name out of existence', () => {
    const tiny = fitToPlate(MAX_LABEL_SCALE, 'A VERY LONG NAME INDEED', style, 10);
    expect(tiny).toBe(MIN_LABEL_SCALE);
  });

  it('leaves a name off the plate when its country is too small to carry it', () => {
    const name = 'DUCHY OF BELMOPAN';
    // 17 characters of 40px type: something over 400px of ink.
    expect(nameFitsItsLand(name, style, 600)).toBe(true);
    expect(nameFitsItsLand(name, style, 40)).toBe(false);
  });

  it('lets a name hang a little past its borders', () => {
    const name = 'BILWI';
    const width = 5 * style.fontSize * 0.56 + 4 * style.tracking;
    // Slightly narrower country than the name: still printed, as on any plate.
    expect(nameFitsItsLand(name, style, width * 0.9)).toBe(true);
    // Half the room it needs: not printed.
    expect(nameFitsItsLand(name, style, width * 0.5)).toBe(false);
  });

  it('judges a scaling name the same at every zoom', () => {
    // Name and land grow together, so the verdict cannot depend on the zoom —
    // which is what stops names flickering in and out as the map moves.
    const room = 300;
    for (const factor of [0.5, 1, 4, 12]) {
      expect(nameFitsItsLand('COUNTY OF BILWI', scaledText(style, factor), room * factor)).toBe(
        nameFitsItsLand('COUNTY OF BILWI', style, room),
      );
    }
  });

  it('refuses to pin a name down to a speck', () => {
    // Pinned while drawn at a couple of percent of its set size: the honest
    // fold writes a fraction of a pixel, a size no one can read or find again.
    const speck = pinnedText(style, 0.02, true);
    expect(speck.fontSize).toBeGreaterThanOrEqual(4);
    // And an unpin at the same extreme cannot ratchet it back below the floor.
    const loose = pinnedText(speck, 50, false);
    expect(loose.fontSize).toBeGreaterThanOrEqual(4);
  });

  it('carries the halo through a pin at a zoomed-out scale', () => {
    const mpp = PLATE_METERS_PER_PIXEL * 4; // factor 0.25, so the halo has thinned
    const factor = labelZoomScale(mpp);
    const pinned = pinnedText(style, factor, true);
    expect(pinned.haloWidth).toBeCloseTo(scaledText(style, factor).haloWidth, 2);
  });
});

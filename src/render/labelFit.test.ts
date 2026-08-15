/**
 * Label layout derived from the shape being labelled (spec §10, §11, §42).
 *
 * The thing under test is that a name takes the *country's* direction and size
 * rather than the renderer's defaults, so the cases are shapes with obvious
 * right answers: a shape running north-east gets a north-east inscription, a
 * long thin one gets one line, a stubby one gets two.
 */

import { describe, expect, it } from 'vitest';
import { breakTitle, dominantAxis, fitLabel } from './labelFit';
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

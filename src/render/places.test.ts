/**
 * Reference cities: ranking, label thinning and Natural Earth classification
 * (spec §14, §64).
 *
 * The two helpers here are shared by the screen renderer and the SVG exporter,
 * so testing them once covers both — which is the point of their existing.
 */

import { describe, expect, it } from 'vitest';
import { metersPerUnit, placeLabelVisible, placeRankStyle } from './olStyles';
import { settlementTypeFromNaturalEarth } from '@/io/importers';

describe('placeRankStyle', () => {
  it('draws important cities larger', () => {
    expect(placeRankStyle(0).radius).toBeGreaterThan(placeRankStyle(4).radius);
    expect(placeRankStyle(4).radius).toBeGreaterThan(placeRankStyle(9).radius);
  });

  it('never grows or shrinks without bound', () => {
    // Natural Earth's rank is nominally 0–11, but a hand-made file can carry
    // anything at all, including nothing.
    for (const rank of [-40, NaN, Infinity, 999]) {
      const { radius, fontSize } = placeRankStyle(rank);
      expect(radius).toBeGreaterThan(0);
      expect(radius).toBeLessThan(10);
      expect(fontSize).toBeGreaterThan(0);
    }
  });
});

describe('placeLabelVisible', () => {
  it('names only the majors when zoomed out', () => {
    const worldScale = 40000; // metres per pixel: the whole globe on a screen
    expect(placeLabelVisible(0, worldScale)).toBe(false);
    expect(placeLabelVisible(8, worldScale)).toBe(false);
  });

  it('names everything when zoomed into a city', () => {
    const streetScale = 2; // metres per pixel
    expect(placeLabelVisible(0, streetScale)).toBe(true);
    expect(placeLabelVisible(8, streetScale)).toBe(true);
  });

  it('always admits a more important place before a less important one', () => {
    // Whatever the threshold does with zoom, it must never invert the hierarchy:
    // there is no scale at which a hamlet is named and the capital beside it is
    // not.
    for (const resolution of [1, 10, 100, 1000, 5000, 20000]) {
      for (let rank = 1; rank <= 11; rank++) {
        if (placeLabelVisible(rank, resolution)) {
          expect(placeLabelVisible(rank - 1, resolution)).toBe(true);
        }
      }
    }
  });

  it('reveals more names as you zoom in, never fewer', () => {
    const count = (resolution: number) =>
      Array.from({ length: 12 }, (_, r) => r).filter((r) => placeLabelVisible(r, resolution)).length;
    const zoomingIn = [20000, 5000, 1000, 200, 40, 8];
    for (let i = 1; i < zoomingIn.length; i++) {
      expect(count(zoomingIn[i])).toBeGreaterThanOrEqual(count(zoomingIn[i - 1]));
    }
  });
});

describe('metersPerUnit', () => {
  it('makes a degrees-based map answer the same question as a metric one', () => {
    // The whole world across 1000 px. In degrees that reads as 0.36; in metres
    // as 40,000. Without the conversion an equirectangular map would think it
    // was zoomed to street level and name every hamlet on Earth.
    const degreesPerPixel = 360 / 1000;
    const metric = (40_075_017 / 1000) * metersPerUnit('m');
    const geographic = degreesPerPixel * metersPerUnit('degrees');
    expect(geographic / metric).toBeGreaterThan(0.9);
    expect(geographic / metric).toBeLessThan(1.1);
    expect(placeLabelVisible(8, geographic)).toBe(placeLabelVisible(8, metric));
    expect(placeLabelVisible(8, geographic)).toBe(false);
  });
});

describe('settlementTypeFromNaturalEarth', () => {
  it('maps the classifications a historical atlas cares about', () => {
    expect(settlementTypeFromNaturalEarth('Admin-0 capital', 8_000_000)).toBe('national-capital');
    expect(settlementTypeFromNaturalEarth('Admin-0 capital alt', 500_000)).toBe('national-capital');
    expect(settlementTypeFromNaturalEarth('Admin-1 capital', 90_000)).toBe('regional-capital');
    expect(settlementTypeFromNaturalEarth('Admin-1 region capital', 90_000)).toBe('regional-capital');
    expect(settlementTypeFromNaturalEarth('Admin-0 region capital', 90_000)).toBe('regional-capital');
    expect(settlementTypeFromNaturalEarth('Historic place', null)).toBe('ruins');
  });

  it('falls back to population for ordinary populated places', () => {
    expect(settlementTypeFromNaturalEarth('Populated place', 1_200_000)).toBe('city');
    expect(settlementTypeFromNaturalEarth('Populated place', 60_000)).toBe('town');
    expect(settlementTypeFromNaturalEarth('Populated place', 900)).toBe('village');
  });

  it('does not depend on Natural Earth\'s capitalisation', () => {
    expect(settlementTypeFromNaturalEarth('ADMIN-0 CAPITAL', null)).toBe('national-capital');
  });

  it('gives an unclassified point a sensible type rather than throwing', () => {
    expect(settlementTypeFromNaturalEarth('', null)).toBe('city');
  });
});

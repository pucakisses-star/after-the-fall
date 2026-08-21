/**
 * Where the printed sheet is cut (spec §48).
 *
 * The case worth pinning is the one that was wrong: a lat/lon band on a curved
 * projection has a bounding box taller than the band itself, because the
 * corners of an arc sit above its middle. Cutting on the corners printed the
 * southern shore of Hudson Bay above a frame asked to stop at Anticosti Island.
 */

import { describe, expect, it } from 'vitest';
import { PLATE_BOUNDS, PLATE_NORTH_POINT, PLATE_SOUTH_POINT, clampToPlateBand } from './plateFrame';

/**
 * Projected metres, measured on this map's own Americas projection rather than
 * invented: the band's bounding box against the two landmarks' own positions.
 * These are the numbers that show the problem — the box reaches 240 km above
 * Anticosti and 70 km below Cabo Falso, because the corners of a bowed parallel
 * sit outside its middle.
 */
const MEASURED = { boxTop: 3_847_299, boxBottom: 319_582, anticosti: 3_606_874, cabo: 389_908 };
const curved = (_lon: number, lat: number) =>
  lat === PLATE_NORTH_POINT[1] ? MEASURED.anticosti : MEASURED.cabo;

describe('the two landmarks', () => {
  it('are the latitudes the dialog quotes', () => {
    expect(PLATE_BOUNDS.north).toBeCloseTo(49.95, 2); // Anticosti Island
    expect(PLATE_BOUNDS.south).toBeCloseTo(22.87, 2); // Cabo Falso
    expect(PLATE_NORTH_POINT[1]).toBe(PLATE_BOUNDS.north);
    expect(PLATE_SOUTH_POINT[1]).toBe(PLATE_BOUNDS.south);
  });
});

describe('cutting the sheet', () => {
  it('cuts at the landmarks, not at the corners of the band', () => {
    const { boxTop, boxBottom } = MEASURED;
    const [bottom, top] = clampToPlateBand(boxBottom, boxTop, curved);

    expect(top).toBe(curved(...PLATE_NORTH_POINT));
    expect(bottom).toBe(curved(...PLATE_SOUTH_POINT));
    // And that is a real crop, not a no-op: the box genuinely overshot.
    expect(top).toBeLessThan(boxTop);
    expect(bottom).toBeGreaterThan(boxBottom);
  });

  it('never grows a range that is already inside the band', () => {
    const inner: [number, number] = [MEASURED.cabo + 1000, MEASURED.anticosti - 1000];
    expect(clampToPlateBand(inner[0], inner[1], curved)).toEqual(inner);
  });

  it('survives a projection that cannot place the landmarks', () => {
    const broken = () => NaN;
    expect(clampToPlateBand(10, 90, broken)).toEqual([10, 90]);
  });

  it('does not care which way round the projection numbers the poles', () => {
    // Guards the Math.min/max rather than assuming north is the larger number.
    const flipped = (lon: number, lat: number) => -curved(lon, lat);
    const [lo, hi] = clampToPlateBand(-1e9, 1e9, flipped);
    expect(lo).toBe(flipped(...PLATE_NORTH_POINT));
    expect(hi).toBe(flipped(...PLATE_SOUTH_POINT));
  });
});

/**
 * Where the printed sheet is cut (spec §48).
 *
 * The case worth pinning is the one that was wrong: a latitude/longitude band
 * on a curved projection has a bounding box larger than the band itself,
 * because the corners of an arc sit outside its middle. Cutting on the corners
 * printed the southern shore of Hudson Bay above a frame asked to stop at
 * Anticosti Island, and a thousand miles of empty Pacific past California.
 */

import { describe, expect, it } from 'vitest';
import {
  PLATE_BOUNDS,
  PLATE_EAST_POINT,
  PLATE_EDGE_MARGIN,
  PLATE_NORTH_POINT,
  PLATE_SOUTH_POINT,
  PLATE_WEST_POINT,
  clampToPlate,
} from './plateFrame';

/**
 * Projected metres, measured on this map's own Americas projection rather than
 * invented: the vertical numbers are the band's bounding box against the two
 * landmarks' own positions. The box reaches 240 km above Anticosti and 70 km
 * below Cabo Falso, because the corners of a bowed parallel sit outside its
 * middle. The horizontal pair is the same story either side.
 */
const MEASURED = {
  boxTop: 3_847_299,
  boxBottom: 319_582,
  boxLeft: -3_600_000,
  boxRight: 3_600_000,
  north: 3_606_874,
  south: 389_908,
  west: -2_400_000,
  east: 2_500_000,
};

/** A projection stub that answers for the four landmarks and nothing else. */
const projected = (lon: number, lat: number): [number, number] => {
  if (lat === PLATE_NORTH_POINT[1]) return [0, MEASURED.north];
  if (lat === PLATE_SOUTH_POINT[1]) return [0, MEASURED.south];
  if (lon === PLATE_WEST_POINT[0]) return [MEASURED.west, 0];
  if (lon === PLATE_EAST_POINT[0]) return [MEASURED.east, 0];
  return [NaN, NaN];
};

const wholeBox = () => ({
  minX: MEASURED.boxLeft,
  maxX: MEASURED.boxRight,
  minY: MEASURED.boxBottom,
  maxY: MEASURED.boxTop,
});

describe('the four landmarks', () => {
  it('are the coordinates the dialog quotes', () => {
    expect(PLATE_BOUNDS.north).toBeCloseTo(49.95, 2); // Anticosti Island
    expect(PLATE_BOUNDS.south).toBeCloseTo(22.87, 2); // Cabo Falso
    expect(PLATE_BOUNDS.west).toBeCloseTo(-124.41, 2); // Cape Mendocino
    expect(PLATE_BOUNDS.east).toBeCloseTo(-52.62, 2); // Cape Spear
  });
});

describe('cutting the sheet', () => {
  it('cuts every edge at its landmark rather than at the box corner', () => {
    const cut = clampToPlate(wholeBox(), projected);
    const padY = (MEASURED.north - MEASURED.south) * PLATE_EDGE_MARGIN;
    const padX = (MEASURED.east - MEASURED.west) * PLATE_EDGE_MARGIN;

    expect(cut.maxY).toBeCloseTo(MEASURED.north + padY, 6);
    expect(cut.maxX).toBeCloseTo(MEASURED.east + padX, 6);
    expect(cut.minX).toBeCloseTo(MEASURED.west - padX, 6);
    // The southern edge needs no cutting: the box already stops 70 km below
    // Cabo Falso, which is inside the margin. Clamping only ever cuts.
    expect(cut.minY).toBe(MEASURED.boxBottom);
  });

  it('holds every edge within a margin of its landmark', () => {
    const cut = clampToPlate(wholeBox(), projected);
    const padY = (MEASURED.north - MEASURED.south) * PLATE_EDGE_MARGIN;
    const padX = (MEASURED.east - MEASURED.west) * PLATE_EDGE_MARGIN;
    expect(cut.maxY).toBeLessThanOrEqual(MEASURED.north + padY);
    expect(cut.minY).toBeGreaterThanOrEqual(MEASURED.south - padY);
    expect(cut.maxX).toBeLessThanOrEqual(MEASURED.east + padX);
    expect(cut.minX).toBeGreaterThanOrEqual(MEASURED.west - padX);
  });

  it('is a real crop where the box overshot — the ocean either side, and the north', () => {
    const box = wholeBox();
    const cut = clampToPlate(box, projected);
    expect(cut.maxY).toBeLessThan(box.maxY);
    expect(cut.maxX).toBeLessThan(box.maxX);
    expect(cut.minX).toBeGreaterThan(box.minX);
    // The Pacific and Atlantic margins are the point of this: over a third of
    // the sheet's width was open water before the cut.
    expect((cut.maxX - cut.minX) / (box.maxX - box.minX)).toBeLessThan(0.75);
  });

  it('leaves a strip of water past each cape rather than cutting onto it', () => {
    const cut = clampToPlate(wholeBox(), projected);
    expect(cut.minX).toBeLessThan(MEASURED.west);
    expect(cut.maxX).toBeGreaterThan(MEASURED.east);
    // ...but only a strip: a few per cent, not a horizon.
    expect((MEASURED.west - cut.minX) / (cut.maxX - cut.minX)).toBeLessThan(0.05);
  });

  it('never grows a box that already sits inside the landmarks', () => {
    const inner = { minX: -1000, maxX: 1000, minY: MEASURED.south + 1000, maxY: MEASURED.north - 1000 };
    expect(clampToPlate(inner, projected)).toEqual(inner);
  });

  it('survives a projection that cannot place the landmarks', () => {
    const box = wholeBox();
    expect(clampToPlate(box, () => [NaN, NaN])).toEqual(box);
  });

  it('does not assume which way the projection numbers its axes', () => {
    // Guards the min/max pairing rather than trusting the landmarks' names.
    const flipped = (lon: number, lat: number): [number, number] => {
      const [x, y] = projected(lon, lat);
      return [-x, -y];
    };
    const cut = clampToPlate({ minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 }, flipped);
    expect(cut.maxY).toBeGreaterThan(cut.minY);
    expect(cut.maxX).toBeGreaterThan(cut.minX);
  });
});

/** Redrawing part of a boundary by hand (spec §5, §6, §64). */

import { describe, expect, it } from 'vitest';
import { boundaryFollows, reshapeBoundary } from './reshape';
import { areaKm2 } from './operations';
import type { LineString, Polygon, Position } from 'geojson';

/** A ten-degree square with a vertex every degree, so a run has points in it. */
function square(): Polygon {
  const ring: Position[] = [];
  for (let x = 0; x <= 10; x++) ring.push([x, 0]);
  for (let y = 1; y <= 10; y++) ring.push([10, y]);
  for (let x = 9; x >= 0; x--) ring.push([x, 10]);
  for (let y = 9; y >= 1; y--) ring.push([0, y]);
  ring.push([0, 0]);
  return { type: 'Polygon', coordinates: [ring] };
}

const line = (coords: Position[]): LineString => ({ type: 'LineString', coordinates: coords });
const ringOf = (g: Polygon | { coordinates: Position[][][] }) =>
  ('type' in g && g.type === 'Polygon' ? g.coordinates : (g as { coordinates: Position[][][] }).coordinates[0])[0];

describe('reshapeBoundary', () => {
  it('replaces the stretch the stroke was drawn along', () => {
    // A bite taken out of the southern edge, between x=3 and x=7.
    const stroke = line([[3, 0], [4, 2], [5, 2.4], [6, 2], [7, 0]]);
    const out = reshapeBoundary(square(), stroke, 0.5)!;
    expect(out).toBeTruthy();

    const ring = ringOf(out.geometry);
    // The drawn points are in the boundary now...
    expect(ring.some((p) => Math.abs(p[0] - 5) < 1e-9 && Math.abs(p[1] - 2.4) < 1e-9)).toBe(true);
    // ...and the straight run they replaced is not.
    expect(ring.some((p) => Math.abs(p[0] - 5) < 1e-9 && Math.abs(p[1]) < 1e-9)).toBe(false);
    // The corners well away from the stroke are untouched.
    for (const corner of [[0, 0], [10, 0], [10, 10], [0, 10]]) {
      expect(ring.some((p) => p[0] === corner[0] && p[1] === corner[1])).toBe(true);
    }
    // A bite out of it, so the square is smaller.
    expect(areaKm2(out.geometry)).toBeLessThan(areaKm2(square()));
  });

  it('can push a boundary outwards as readily as inwards', () => {
    const stroke = line([[3, 0], [4, -2], [6, -2], [7, 0]]);
    const out = reshapeBoundary(square(), stroke, 0.5)!;
    expect(areaKm2(out.geometry)).toBeGreaterThan(areaKm2(square()));
  });

  it('replaces the long way round when that is where the stroke was drawn', () => {
    // Both ends on the southern edge, but drawn the long way round the outside
    // of the square. Taking the short arc — the obvious rule — would turn the
    // shape inside out; the stroke says which run was meant.
    // Hugging the outside of the west, north and east edges, so it is plainly
    // drawn along the long run and not merely somewhere near both.
    const stroke = line([
      [3, 0], [-0.3, -0.3], [-0.3, 10.3], [10.3, 10.3], [10.3, -0.3], [7, 0],
    ]);
    const out = reshapeBoundary(square(), stroke, 0.5)!;
    const ring = ringOf(out.geometry);
    // The northern edge is gone — that is the run it went round.
    expect(ring.some((p) => p[1] === 10)).toBe(false);
    // And the southern run between the endpoints survives.
    expect(ring.some((p) => p[0] === 5 && p[1] === 0)).toBe(true);
  });

  it('refuses a stroke that does not start and end on the boundary', () => {
    expect(reshapeBoundary(square(), line([[3, 5], [5, 5], [7, 5]]), 0.5)).toBeNull();
    expect(reshapeBoundary(square(), line([[3, 0], [4, 2], [5, 5]]), 0.5)).toBeNull();
  });

  it('refuses a stroke whose ends are on different rings', () => {
    const withHole: Polygon = {
      type: 'Polygon',
      coordinates: [square().coordinates[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]],
    };
    // Starts on the outer ring, ends on the hole.
    expect(reshapeBoundary(withHole, line([[5, 0], [5, 2], [5, 4]]), 0.5)).toBeNull();
  });

  it('reshapes a hole without disturbing the ring around it', () => {
    const withHole: Polygon = {
      type: 'Polygon',
      coordinates: [square().coordinates[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]],
    };
    const out = reshapeBoundary(withHole, line([[4, 4], [5, 3], [6, 4]]), 0.5)!;
    expect(out).toBeTruthy();
    expect(out.geometry.coordinates).toHaveLength(2);
    // The outer ring is exactly as it was.
    expect(out.geometry.coordinates[0]).toEqual(withHole.coordinates[0]);
  });

  it('reports the run it replaced, so a neighbour can follow the same edit', () => {
    const out = reshapeBoundary(square(), line([[3, 0], [5, 2], [7, 0]]), 0.5)!;
    expect(out.replaced.length).toBeGreaterThan(1);
    // It is the southern run between the two ends.
    for (const p of out.replaced) {
      expect(p[1]).toBeCloseTo(0, 6);
      expect(p[0]).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(p[0]).toBeLessThanOrEqual(7 + 1e-9);
    }
  });

  it('snaps the stroke onto the boundary so no gap is left at either end', () => {
    // Drawn a little short of the edge at both ends, as a hand would.
    const out = reshapeBoundary(square(), line([[3, 0.2], [5, 2], [7, 0.2]]), 0.5)!;
    const ring = ringOf(out.geometry);
    // Every vertex still forms a closed ring with no jump at the seam.
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(out.drawn[0][1]).toBeCloseTo(0, 6);
    expect(out.drawn[out.drawn.length - 1][1]).toBeCloseTo(0, 6);
  });

  it('turns down a stroke of one point, or one that goes nowhere', () => {
    expect(reshapeBoundary(square(), line([[3, 0]]), 0.5)).toBeNull();
    expect(reshapeBoundary(square(), line([[3, 0], [3, 0]]), 0.5)).toBeNull();
  });
});

describe('boundaryFollows', () => {
  const neighbour: Polygon = {
    type: 'Polygon',
    coordinates: [[[0, -5], [10, -5], [10, 0], [0, 0], [0, -5]]],
  };

  it('recognises the shape that shares the replaced run', () => {
    expect(boundaryFollows(neighbour, [[3, 0], [5, 0], [7, 0]], 0.1)).toBe(true);
  });

  it('does not claim a shape that only comes near it', () => {
    expect(boundaryFollows(neighbour, [[3, 4], [5, 4], [7, 4]], 0.1)).toBe(false);
  });
});

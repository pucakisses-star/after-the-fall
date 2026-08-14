/**
 * Putting a shape on the coastline (spec §3, §64).
 *
 * The shapes here stand in for the two cases that matter: a division drawn to
 * its own coarse tolerance over a detailed shore, and one nowhere near the sea.
 */

import { describe, expect, it } from 'vitest';
import { boundsOf, clipToLand, indexLand, landPolygonsOf, type LandPolygon } from './coastline';
import { areaKm2, intersection } from './operations';
import type { MultiPolygon, Polygon, Position } from 'geojson';

/**
 * An island with a deep bay cut into its east side — the feature a coarse
 * administrative outline cuts straight across.
 */
function bayIsland(): LandPolygon {
  const ring: Position[] = [[0, 0], [10, 0]];
  // A bay from (10, 3) in to (6, 5) and back out to (10, 7).
  ring.push([10, 3], [8, 3.5], [6, 4.5], [6, 5.5], [8, 6.5], [10, 7]);
  ring.push([10, 10], [0, 10], [0, 0]);
  return [ring];
}

const square = (w: number, s: number, e: number, n: number): Polygon => ({
  type: 'Polygon',
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

const verts = (g: Polygon | MultiPolygon) =>
  (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat()).reduce((s, r) => s + r.length, 0);

describe('clipToLand', () => {
  const land = [bayIsland()];
  const index = indexLand(land, [-5, -5, 15, 15]);

  it('cuts a coarse outline back to the shore', () => {
    // Four corners over the island's east side, straight across the bay — which
    // is exactly what a 155-vertex state looks like on a detailed coastline.
    const coarse = square(5, 2, 12, 8);
    const clipped = clipToLand(coarse, index)!;
    expect(clipped).toBeTruthy();

    // No part of it may be left over water.
    const sea = intersection(clipped, square(10.0001, -5, 15, 15));
    expect(sea ? areaKm2(sea) : 0).toBe(0);

    // And it must have picked up the bay, not merely stopped at x = 10.
    const bay = intersection(clipped, square(6.5, 4.6, 9.5, 5.4));
    expect(bay ? areaKm2(bay) : 0).toBe(0);
    expect(verts(clipped)).toBeGreaterThan(verts(coarse));
  });

  it('leaves an inland shape untouched, object for object', () => {
    // The early-out: no coastline crosses this shape's box, so it is returned
    // as it came without a boolean ever running. Identity is the assertion —
    // a trim that rebuilt it would return an equal but different object.
    const inland = square(2, 2, 4, 4);
    expect(clipToLand(inland, index)).toBe(inland);
  });

  it('drops a shape that is entirely at sea', () => {
    expect(clipToLand(square(11, 2, 14, 4), index)).toBeNull();
    // Including one inside the bay, which is sea reaching into the island.
    expect(clipToLand(square(6.6, 4.7, 7.4, 5.3), index)).toBeNull();
  });

  it('gives the same answer whether or not the early-out applies', () => {
    // A shape that straddles the shore has to go through the boolean; one that
    // does not must come back identical to what the boolean would have said.
    const inland = square(1, 1, 5, 9);
    const viaEarlyOut = clipToLand(inland, index)!;
    // Force the slow path by indexing land whose coastline reaches the shape.
    const wide = indexLand([...land, [[[-2, -2], [-1, -2], [-1, 12], [-2, 12], [-2, -2]]]], [-5, -5, 15, 15]);
    const viaBoolean = clipToLand(inland, wide)!;
    expect(areaKm2(viaBoolean)).toBeCloseTo(areaKm2(viaEarlyOut), 6);
  });

  it('keeps an island in a lake, and drops the lake around it', () => {
    // Holes are water, and a hole inside a hole is land again.
    const withLake: LandPolygon = [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
    ];
    const idx = indexLand([withLake, [[[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]], [-5, -5, 15, 15]);
    expect(clipToLand(square(4.2, 4.2, 5.8, 5.8), idx)).toBeTruthy();  // the island
    expect(clipToLand(square(3.2, 3.2, 3.8, 3.8), idx)).toBeNull();    // the lake
  });

  it('returns nothing when there is no land at all', () => {
    expect(clipToLand(square(1, 1, 2, 2), indexLand([], [-5, -5, 15, 15]))).toBeNull();
  });
});

describe('indexLand', () => {
  it('ignores land outside the extent it was given', () => {
    const far: LandPolygon = [[[100, 40], [110, 40], [110, 50], [100, 50], [100, 40]]];
    expect(indexLand([bayIsland(), far], [-5, -5, 15, 15]).parts).toHaveLength(1);
  });

  it('skips an antimeridian-wrapping part with nothing inside the extent', () => {
    // A ring stepping from +180 to −180 has a bounding box the width of the
    // world, so it "overlaps" every extent on Earth. Afro-Eurasia is one, and
    // taking it at its box is how Eurasia turns up in a map of the Americas.
    const wrapping: LandPolygon = [[[170, 40], [-170, 40], [-170, 50], [170, 50], [170, 40]]];
    expect(indexLand([wrapping], [-100, 0, -60, 60]).parts).toHaveLength(0);
    // But it is kept when the extent really does contain some of it.
    expect(indexLand([wrapping], [-180, 0, -160, 60]).parts.length).toBeGreaterThan(0);
  });
});

describe('landPolygonsOf and boundsOf', () => {
  it('splits multipolygons into parts and keeps their holes', () => {
    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
        [[[8, 8], [9, 8], [9, 9], [8, 9], [8, 8]]],
      ],
    };
    const parts = landPolygonsOf([mp]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(2); // outer ring plus its hole
  });

  it('bounds a set of shapes with a margin', () => {
    expect(boundsOf([square(0, 0, 10, 10)], 1)).toEqual([-1, -1, 11, 11]);
  });

  it('falls back to the whole world for nothing at all', () => {
    expect(boundsOf([])).toEqual([-180, -90, 180, 90]);
  });
});

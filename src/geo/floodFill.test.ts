/**
 * The paint bucket: flood-filling land (spec §6, §57).
 *
 * The geometry is tested against a toy continent rather than the real coastline,
 * because what has to be right is the *rule* — fill stops at the coast, stops at
 * whoever already holds the ground, and goes to the neighbour who holds most of
 * the edge — and a 3 MB land file makes those cases impossible to state.
 */

import { describe, expect, it } from 'vitest';
import { neighbourHoldingMostOf, regionAt, unclaimedRegionAt } from './floodFill';
import { closeBarrierGaps } from './barriers';
import { areaKm2 } from './operations';
import type { MultiPolygon, Polygon } from 'geojson';

/** An axis-aligned rectangle, counter-clockwise. */
function box(x0: number, y0: number, x1: number, y1: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
  };
}

/** Every longitude of a geometry — parsed, not regexed out of its JSON. */
function lonsOf(g: Polygon | MultiPolygon): number[] {
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  return rings.flat().map(([x]) => x);
}

/** A continent from 0,0 to 10,10, with nothing on it. */
const CONTINENT = box(0, 0, 10, 10);

describe('unclaimedRegionAt', () => {
  it('returns nothing at sea', () => {
    // Clicking open water is an ordinary answer, not an error.
    expect(unclaimedRegionAt([20, 20], [CONTINENT], [])).toBeNull();
  });

  it('returns nothing on ground that is already held', () => {
    expect(unclaimedRegionAt([5, 5], [CONTINENT], [CONTINENT])).toBeNull();
  });

  it('fills a gap between two realms and stops at both', () => {
    // A 2°-wide corridor left between neighbours: the fill takes the corridor
    // and none of either realm.
    const west = box(0, 0, 4, 10);
    const east = box(6, 0, 10, 10);
    const result = unclaimedRegionAt([5, 5], [CONTINENT], [west, east]);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);

    // 2° by 10° of the toy continent, and nothing more.
    const area = areaKm2(result!.geometry);
    expect(area).toBeGreaterThan(areaKm2(box(4, 0, 6, 10)) * 0.98);
    expect(area).toBeLessThan(areaKm2(box(4, 0, 6, 10)) * 1.02);
  });

  it('pours around a lake, never over it', () => {
    // A lake in the middle of open country: the fill takes the land around it
    // and none of the water — a lake is subtracted like the sea, not cut like
    // a river, so no healing pass can quietly paste it back.
    const lake = box(4, 4, 6, 6);
    const result = unclaimedRegionAt([1, 1], [CONTINENT], [], [], undefined, [lake]);
    expect(result).not.toBeNull();
    const area = areaKm2(result!.geometry);
    const expected = areaKm2(CONTINENT) - areaKm2(lake);
    expect(area).toBeGreaterThan(expected * 0.98);
    expect(area).toBeLessThan(expected * 1.02);
  });

  it('stops at a lake that walls off a peninsula with the coast', () => {
    // A lake spanning all but a 1° isthmus at the top: the west side is reached
    // from the east only through that gap, so a fill clicked in the west with
    // the gap claimed stays in the west.
    const lake = box(4, 0, 6, 9);
    const plug = box(4, 9, 6, 10);
    const result = unclaimedRegionAt([2, 5], [CONTINENT], [plug], [], undefined, [lake]);
    expect(result).not.toBeNull();
    expect(Math.max(...lonsOf(result!.geometry))).toBeLessThanOrEqual(4.001);
  });

  it('stops at the coast rather than filling the sea', () => {
    // Nothing is claimed at all, so the only thing bounding the fill is the
    // shoreline — the whole continent comes back and not a degree more.
    const result = unclaimedRegionAt([5, 5], [CONTINENT], []);
    expect(result).not.toBeNull();
    expect(areaKm2(result!.geometry)).toBeCloseTo(areaKm2(CONTINENT), -3);
  });

  it('does not leak into a separate landmass', () => {
    // Two islands: filling one must not claim the other, however close it is.
    const island = box(12, 0, 14, 2);
    const result = unclaimedRegionAt([13, 1], [CONTINENT, island], []);
    expect(result).not.toBeNull();
    expect(areaKm2(result!.geometry)).toBeCloseTo(areaKm2(island), -2);
  });

  it('never joins two landmasses the window happens to cover', () => {
    // The bug the real coastline caught: clipping land to a window gives every
    // landmass a straight edge along it, and dissolving the clipped pieces welds
    // any two that reach the same edge. Filling in Iceland came back as
    // 3.4 million km² — Iceland joined to Greenland across the Denmark Strait.
    const neighbourIsland = box(11, 0, 13, 10);
    const result = unclaimedRegionAt([12, 5], [CONTINENT, neighbourIsland], []);
    expect(result).not.toBeNull();
    expect(areaKm2(result!.geometry)).toBeCloseTo(areaKm2(neighbourIsland), -2);
    // And decisively less than the two of them together.
    expect(areaKm2(result!.geometry)).toBeLessThan(areaKm2(CONTINENT));
  });

  it('does not run its window past the pole', () => {
    // A fill at 80°N grows a window that would reach latitude 125° unclamped,
    // which is not a place and which the clipper has no defined answer for.
    const arctic = box(-20, 78, -10, 82);
    const result = unclaimedRegionAt([-15, 80], [arctic], []);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(areaKm2(result!.geometry)).toBeCloseTo(areaKm2(arctic), -2);
  });

  it('grows its window until the region is enclosed', () => {
    // The search starts at a 2° box, and this continent is 10° across. If the
    // window never grew, the answer would come back clipped to 2° and flagged.
    const result = unclaimedRegionAt([5, 5], [CONTINENT], []);
    expect(result!.truncated).toBe(false);
    expect(areaKm2(result!.geometry)).toBeGreaterThan(areaKm2(box(4, 4, 6, 6)) * 5);
  });

  it('says so rather than lying when it hits the cap', () => {
    // Capped below the size of the landmass: what comes back is a piece of
    // something bigger, and the caller is told.
    const result = unclaimedRegionAt([5, 5], [CONTINENT], [], [], 4);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(areaKm2(result!.geometry)).toBeLessThan(areaKm2(CONTINENT));
  });

  it('fills a hole punched in the middle of one realm', () => {
    // The enclave case: a realm with a bite out of it, and the bite filled back.
    const holed: Polygon = {
      type: 'Polygon',
      coordinates: [
        CONTINENT.coordinates[0],
        [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]],
      ],
    };
    const result = unclaimedRegionAt([5, 5], [CONTINENT], [holed]);
    expect(result).not.toBeNull();
    expect(areaKm2(result!.geometry)).toBeCloseTo(areaKm2(box(4, 4, 6, 6)), -2);
  });
});

describe('neighbourHoldingMostOf', () => {
  const region = box(4, 0, 6, 10);

  it('gives the ground to whoever holds most of its edge', () => {
    // West runs the full 10° side of the corridor; south touches 2° of its foot.
    // The long frontier wins, which is the whole point of counting rather than
    // taking the first or nearest neighbour.
    const west = { id: 'west', geometry: box(0, 0, 4, 10) };
    const south = { id: 'south', geometry: box(4, -3, 6, 0) };
    expect(neighbourHoldingMostOf(region, [west, south], 0.03)?.id).toBe('west');
  });

  it('is not swayed by the order the candidates arrive in', () => {
    // The bug this caught: counting boundary vertices instead of measuring
    // frontier length ties on a rectangle, and the tie went to whoever was
    // reached first.
    const west = { id: 'west', geometry: box(0, 0, 4, 10) };
    const south = { id: 'south', geometry: box(4, -3, 6, 0) };
    expect(neighbourHoldingMostOf(region, [south, west], 0.03)?.id).toBe('west');
    expect(neighbourHoldingMostOf(region, [west, south], 0.03)?.id).toBe('west');
  });

  it('weighs a long frontier over many short ones', () => {
    // Three realms nibbling the foot of the corridor still lose to the one
    // realm running its whole flank.
    const west = { id: 'west', geometry: box(0, 0, 4, 10) };
    const nibblers = [
      { id: 'a', geometry: box(4, -3, 4.7, 0) },
      { id: 'b', geometry: box(4.7, -3, 5.3, 0) },
      { id: 'c', geometry: box(5.3, -3, 6, 0) },
    ];
    expect(neighbourHoldingMostOf(region, [...nibblers, west], 0.03)?.id).toBe('west');
  });

  it('returns nothing when the ground borders nobody', () => {
    // An unclaimed island has no neighbour to join, and saying "the nearest
    // realm, 300 km away" would be an invention.
    const far = { id: 'far', geometry: box(50, 50, 60, 60) };
    expect(neighbourHoldingMostOf(region, [far], 0.03)).toBeNull();
    expect(neighbourHoldingMostOf(region, [], 0.03)).toBeNull();
  });
});

describe('regionAt', () => {
  const west = box(0, 0, 4, 10);
  const east = box(6, 0, 10, 10);
  /** A line down the middle of the continent, from coast to coast. */
  const meridian = [[5, -1], [5, 11]];

  it('answers with the owner when the ground is claimed', () => {
    const result = regionAt([2, 5], [CONTINENT], [{ id: 'west', geometry: west }, { id: 'east', geometry: east }]);
    expect(result?.ownerId).toBe('west');
    expect(areaKm2(result!.geometry)).toBeCloseTo(areaKm2(west), -3);
  });

  it('answers with no owner on ground nobody holds', () => {
    const result = regionAt([5, 5], [CONTINENT], [{ id: 'west', geometry: west }, { id: 'east', geometry: east }]);
    expect(result?.ownerId).toBeNull();
  });

  it('still returns nothing at sea', () => {
    expect(regionAt([20, 20], [CONTINENT], [])).toBeNull();
  });

  it('stops a fill of open land at a line', () => {
    // The whole continent is unclaimed, so without the line one click takes all
    // of it; with the line it takes the half the click was on.
    const whole = regionAt([2, 5], [CONTINENT], []);
    const half = regionAt([2, 5], [CONTINENT], [], [meridian]);
    expect(areaKm2(whole!.geometry)).toBeCloseTo(areaKm2(CONTINENT), -3);
    expect(areaKm2(half!.geometry) / areaKm2(whole!.geometry)).toBeCloseTo(0.5, 2);
  });

  it('stops a fill of claimed land at a line', () => {
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const half = regionAt([2, 5], [CONTINENT], claimed, [meridian]);
    expect(half?.ownerId).toBe('all');
    expect(areaKm2(half!.geometry) / areaKm2(CONTINENT)).toBeCloseTo(0.5, 2);
  });

  it('takes the side of the line the click was on', () => {
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const left = regionAt([2, 5], [CONTINENT], claimed, [meridian])!;
    const right = regionAt([8, 5], [CONTINENT], claimed, [meridian])!;
    expect(Math.max(...lonsOf(left.geometry))).toBeLessThan(5.01);
    expect(Math.min(...lonsOf(right.geometry))).toBeGreaterThan(4.99);
  });

  it('leaks past a river that stops short of the lake it runs into', () => {
    // The river runs from the south coast to three hundred metres shy of the
    // lake, and the lake runs off the north coast: together they wall the
    // continent in two — except for the gap, which the flood pours through.
    const lake = box(4.5, 8, 5.5, 11);
    const river = [
      [5, -1],
      [5, 7.997],
    ];
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const leaked = regionAt([2, 5], [CONTINENT], claimed, [river], undefined, [lake])!;
    const dry = areaKm2(CONTINENT) - areaKm2(box(4.5, 8, 5.5, 10));
    expect(areaKm2(leaked.geometry) / dry).toBeGreaterThan(0.9);

    // Closed against the shoreline, the mouth reaches the water and the wall
    // holds: the click keeps its own half.
    const shore = lake.coordinates[0];
    const held = regionAt([2, 5], [CONTINENT], claimed, closeBarrierGaps([river], [shore]), undefined, [lake])!;
    expect(areaKm2(held.geometry) / dry).toBeCloseTo(0.5, 1);
  });

  it('keeps a lake out of a fill of claimed ground', () => {
    // One realm holds the continent, a lake sits in the middle of it: a fill
    // re-taking the realm's ground gets the ground, not the water.
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const lake = box(4, 4, 6, 6);
    const result = regionAt([2, 5], [CONTINENT], claimed, [], undefined, [lake])!;
    expect(result.ownerId).toBe('all');
    const expected = areaKm2(CONTINENT) - areaKm2(lake);
    expect(areaKm2(result.geometry)).toBeGreaterThan(expected * 0.98);
    expect(areaKm2(result.geometry)).toBeLessThan(expected * 1.02);
  });

  it('answers nothing for a click on the lake itself', () => {
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const lake = box(4, 4, 6, 6);
    expect(regionAt([5, 5], [CONTINENT], claimed, [], undefined, [lake])).toBeNull();
  });

  it('lets a river ending in a lake wall off a whole side', () => {
    // The river alone peters out at the lake and stops nothing; the lake alone
    // is rounded at both ends; together they cross the continent. This is the
    // chain a real frontier is made of.
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const lake = box(4, 4, 6, 6);
    const riverNorth = [[5, 11], [5, 6]];
    const riverSouth = [[5, 4], [5, -1]];
    const left = regionAt([2, 5], [CONTINENT], claimed, [riverNorth, riverSouth], undefined, [lake])!;
    expect(Math.max(...lonsOf(left.geometry))).toBeLessThan(5.01);
  });

  it('leaves no ground between the two sides', () => {
    // The cut is subtracted and then given back, half to each side, so the two
    // meet in the middle of it and the halves add back up to the whole. The
    // first version kept the ribbon: thirty metres of ground per line, running
    // the length of the river network, which whichever realm held it turned
    // into fingers reaching into its neighbour.
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const left = regionAt([2, 5], [CONTINENT], claimed, [meridian])!;
    const right = regionAt([8, 5], [CONTINENT], claimed, [meridian])!;
    const lost = 1 - (areaKm2(left.geometry) + areaKm2(right.geometry)) / areaKm2(CONTINENT);
    expect(Math.abs(lost)).toBeLessThan(1e-4);
  });

  it('leaves a shape untouched by a line that does not divide it', () => {
    // Not "all but the slit the cut made": nothing at all. A ribbon of ground
    // thirty metres wide and five hundred kilometres long is not a territory,
    // and it draws as a border hanging in the middle of a country.
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const stub = [[5, -1], [5, 5]];
    const whole = regionAt([2, 5], [CONTINENT], claimed, [stub])!;
    // To within the rounding of a subtract-and-restore round trip: forty square
    // metres of a million and a quarter square kilometres.
    expect(areaKm2(whole.geometry) / areaKm2(CONTINENT)).toBeCloseTo(1, 9);
  });

  it('ignores a line that does not divide the ground', () => {
    // A river that peters out mid-continent leaves the two sides connected
    // around its end, and the fill goes round it — which is the truth about
    // that river, not a bug in the fill.
    const stub = [[5, -1], [5, 5]];
    const result = regionAt([2, 5], [CONTINENT], [], [stub]);
    expect(areaKm2(result!.geometry) / areaKm2(CONTINENT)).toBeGreaterThan(0.99);
  });

  it('does not leave a pocket where two lines cross', () => {
    // A confluence: two lines meeting inside the ground. The strips subtracted
    // for them enclose a scrap between them, wider than the strips are, which
    // survived the grow-back as a hole — a little ring of border sitting inside
    // a country with nothing in it.
    const claimed = [{ id: 'all', geometry: CONTINENT }];
    const forked = [
      [[5, -1], [5, 4], [3, 8], [3, 11]],
      [[5, -1], [5, 4], [7, 8], [7, 11]],
    ];
    const region = regionAt([1, 5], [CONTINENT], claimed, forked)!;
    const holes = (region.geometry.type === 'Polygon' ? [region.geometry.coordinates] : region.geometry.coordinates)
      .reduce((n, rings) => n + rings.length - 1, 0);
    expect(holes).toBe(0);
  });

  it('leaves a hole that was there before the cut alone', () => {
    // An enclave — a free city, a lake somebody excluded — is a hole in the
    // ground before anything is cut, and stays one after.
    const withHole: Polygon = {
      type: 'Polygon',
      coordinates: [
        CONTINENT.coordinates[0],
        [[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]],
      ],
    };
    const claimed = [{ id: 'all', geometry: withHole }];
    const region = regionAt([1, 8], [withHole], claimed, [meridian])!;
    const holes = (region.geometry.type === 'Polygon' ? [region.geometry.coordinates] : region.geometry.coordinates)
      .reduce((n, rings) => n + rings.length - 1, 0);
    expect(holes).toBe(1);
  });

  it('is not confused by a line that misses the region entirely', () => {
    const elsewhere = [[100, 0], [100, 10]];
    const result = regionAt([5, 5], [CONTINENT], [], [elsewhere]);
    expect(areaKm2(result!.geometry)).toBeCloseTo(areaKm2(CONTINENT), -3);
  });
});

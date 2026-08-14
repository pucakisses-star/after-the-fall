/**
 * The After the End realm table and the growth that turns it into shapes
 * (spec §64).
 *
 * The table is checked for the mistakes a hand-written list of a hundred and
 * fifty seats invites — a transposed sign putting a realm in the wrong ocean,
 * two realms seated in the same place, a duplicated name — and the growth is
 * checked for the properties a political map depends on: realms that do not
 * overlap, wilderness that actually survives, and the same map every time.
 */

import { describe, expect, it } from 'vitest';
import { AFTER_THE_END_EMPIRES } from './afterTheEnd';
import { DEFAULT_GROWTH, growRealms, simplifyOpen, type LandPolygon, type RealmSeed } from '@/geo/realmGrowth';
import { areaKm2, intersection } from '@/geo/operations';
import type { MultiPolygon, Polygon, Position } from 'geojson';

const AMERICAS: [number, number, number, number] = [-172, -58, -30, 76];

const realms = AFTER_THE_END_EMPIRES.flatMap((e) =>
  e.realms.map((r) => ({ ...r, empire: e.name })),
);

describe('the After the End realm table', () => {
  it('seats every realm inside the map', () => {
    for (const realm of realms) {
      const [lon, lat] = realm.seat;
      expect(lon, `${realm.name} is off the west edge`).toBeGreaterThan(AMERICAS[0]);
      expect(lon, `${realm.name} is off the east edge`).toBeLessThan(AMERICAS[2]);
      expect(lat, `${realm.name} is off the south edge`).toBeGreaterThan(AMERICAS[1]);
      expect(lat, `${realm.name} is off the north edge`).toBeLessThan(AMERICAS[3]);
    }
  });

  it('names every realm once', () => {
    const seen = new Set<string>();
    const repeats: string[] = [];
    for (const realm of realms) {
      if (seen.has(realm.name)) repeats.push(realm.name);
      seen.add(realm.name);
    }
    expect(repeats, repeats.join(', ')).toEqual([]);
  });

  it('never seats two realms in the same place', () => {
    // Two seats in one cell means one realm never grows at all.
    const clashes: string[] = [];
    for (let i = 0; i < realms.length; i++) {
      for (let j = i + 1; j < realms.length; j++) {
        const dx = realms[i].seat[0] - realms[j].seat[0];
        const dy = realms[i].seat[1] - realms[j].seat[1];
        if (Math.hypot(dx, dy) < DEFAULT_GROWTH.cellSize) {
          clashes.push(`${realms[i].name} and ${realms[j].name}`);
        }
      }
    }
    expect(clashes, clashes.join('; ')).toEqual([]);
  });

  it('gives every empire exactly one capital realm', () => {
    for (const empire of AFTER_THE_END_EMPIRES) {
      const capitals = empire.realms.filter((r) => r.capital);
      expect(capitals.length, `${empire.name} has ${capitals.length} capitals`).toBe(1);
    }
  });

  it('sets every hand-placed empire name within its own realms', () => {
    for (const empire of AFTER_THE_END_EMPIRES) {
      if (!empire.label) continue;
      const lons = empire.realms.map((r) => r.seat[0]);
      const lats = empire.realms.map((r) => r.seat[1]);
      // Generous, because a name may sit over a bay or a gulf its realms ring.
      expect(empire.label[0], `${empire.short} is set far west of its realms`).toBeGreaterThan(Math.min(...lons) - 12);
      expect(empire.label[0], `${empire.short} is set far east of its realms`).toBeLessThan(Math.max(...lons) + 12);
      expect(empire.label[1], `${empire.short} is set far south of its realms`).toBeGreaterThan(Math.min(...lats) - 12);
      expect(empire.label[1], `${empire.short} is set far north of its realms`).toBeLessThan(Math.max(...lats) + 12);
    }
  });

  it('gives every realm a positive reach', () => {
    for (const realm of realms) {
      expect(realm.weight, `${realm.name} has no reach`).toBeGreaterThan(0);
      expect(realm.weight, `${realm.name} would swallow a continent`).toBeLessThan(5);
    }
  });
});

/** A square island, so the growth can be checked without loading a coastline. */
function island(w: number, s: number, e: number, n: number): LandPolygon {
  return [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ];
}

/** A land part with a coast no straight edge can approximate: a ragged fjord. */
function raggedIsland(): LandPolygon {
  const ring: Position[] = [];
  for (let x = 2; x <= 18; x += 0.25) ring.push([x, 2 + (Math.round(x * 4) % 2) * 0.6]);
  for (let y = 2; y <= 18; y += 0.25) ring.push([18 - (Math.round(y * 4) % 2) * 0.6, y]);
  for (let x = 18; x >= 2; x -= 0.25) ring.push([x, 18 - (Math.round(x * 4) % 2) * 0.6]);
  for (let y = 18; y >= 2; y -= 0.25) ring.push([2 + (Math.round(y * 4) % 2) * 0.6, y]);
  ring.push([...ring[0]]);
  return [ring];
}

/** Every vertex of a geometry, whatever its type. */
function vertices(g: Polygon | MultiPolygon): Position[] {
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  return rings.flat();
}

describe('realm growth', () => {
  const extent: [number, number, number, number] = [0, 0, 20, 20];
  const land = [island(1, 1, 19, 19)];
  const seeds: RealmSeed[] = [
    { id: 'north', seeds: [[10, 16]], weight: 1 },
    { id: 'south', seeds: [[10, 4]], weight: 1 },
    { id: 'small', seeds: [[3, 10]], weight: 0.3 },
  ];
  const options = { extent, ...DEFAULT_GROWTH, coverage: 0.6 };

  it('gives every seeded realm a shape', () => {
    const grown = growRealms(land, seeds, options);
    for (const seed of seeds) {
      expect(grown.shapes.get(seed.id), `${seed.id} did not grow`).toBeTruthy();
    }
  });

  it('leaves the land it was told to leave', () => {
    const grown = growRealms(land, seeds, options);
    // Coverage is a budget, so the wilderness left is at least what remains of
    // it — more when a realm is boxed in before it spends its share.
    expect(grown.wilderness).toBeGreaterThanOrEqual(0.35);
    expect(grown.wilderness).toBeLessThan(1);
  });

  it('gives a stronger realm more ground than a weaker one', () => {
    const grown = growRealms(land, seeds, options);
    expect(grown.claimed.get('north')!).toBeGreaterThan(grown.claimed.get('small')!);
  });

  it('never gives one patch of ground to two realms', () => {
    // The lattice claims each cell once, so this holds by construction — but it
    // is the property the whole map rests on, and construction can change.
    const grown = growRealms(land, seeds, options);
    const total = [...grown.claimed.values()].reduce((a, b) => a + b, 0);
    const landCells = Math.round(total / (1 - grown.wilderness));
    expect(total).toBeLessThanOrEqual(landCells);
  });

  it('produces the same map from the same inputs', () => {
    const a = growRealms(land, seeds, options);
    const b = growRealms(land, seeds, options);
    expect(JSON.stringify([...a.shapes])).toEqual(JSON.stringify([...b.shapes]));
  });

  it('grows nothing where there is no land', () => {
    const grown = growRealms([], seeds, options);
    expect(grown.shapes.size).toBe(0);
  });

  it('keeps every realm on dry land', () => {
    // The complaint this answers: a realm claims whole lattice cells, so before
    // trimming its outline ran up to half a cell out to sea and the rounding
    // pushed it further, leaving a smooth blob lying across a detailed coast.
    const grown = growRealms(land, seeds, options);
    for (const seed of seeds) {
      const shape = grown.shapes.get(seed.id)!;
      for (const [x, y] of vertices(shape)) {
        expect(x, `${seed.id} reaches west of the shore`).toBeGreaterThanOrEqual(1 - 1e-6);
        expect(x, `${seed.id} reaches east of the shore`).toBeLessThanOrEqual(19 + 1e-6);
        expect(y, `${seed.id} reaches south of the shore`).toBeGreaterThanOrEqual(1 - 1e-6);
        expect(y, `${seed.id} reaches north of the shore`).toBeLessThanOrEqual(19 + 1e-6);
      }
    }
  });

  it('takes the shape of the coast where it meets the sea', () => {
    // Not merely "inside the land" — a realm shrunk to a smooth blob well clear
    // of the shore would pass that. The coast here is a saw-tooth no smoothed
    // outline can imitate, so the realm has to have picked up its actual
    // vertices to be able to reach the shore at all.
    const ragged = [raggedIsland()];
    const one: RealmSeed[] = [{ id: 'all', seeds: [[10, 10]], weight: 1 }];
    const grown = growRealms(ragged, one, { ...options, coverage: 1 });
    const shape = grown.shapes.get('all')!;

    const coast = new Set(raggedIsland()[0].map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`));
    const shared = vertices(shape).filter(([x, y]) => coast.has(`${x.toFixed(4)},${y.toFixed(4)}`));
    expect(shared.length, 'the realm outline carries none of the coastline').toBeGreaterThan(50);
  });

  it('leaves a border two realms share identical on both sides (§6)', () => {
    // Trimming each realm to the coast independently must not pull neighbours
    // apart: an inland frontier lies inside the land, so the trim has nothing
    // to cut there and both sides keep the same run of vertices.
    const grown = growRealms(land, seeds, { ...options, coverage: 1 });
    const north = grown.shapes.get('north')!;
    const south = grown.shapes.get('south')!;

    const key = ([x, y]: Position) => `${x.toFixed(5)},${y.toFixed(5)}`;
    const inSouth = new Set(vertices(south).map(key));
    const onFrontier = vertices(north).filter((p) => inSouth.has(key(p)));
    expect(onFrontier.length, 'the two realms share no vertices at all').toBeGreaterThan(5);

    // And the areas must not overlap at all, which is what the shared run buys.
    const both = intersection(north, south);
    expect(both ? areaKm2(both) : 0).toBe(0);
  });

  it('simplifies a shared arc the same way from either end', () => {
    // This is what lets the two realms above agree, and it is worth pinning on
    // its own because it is easy to break and invisible when broken until a
    // seam appears along every frontier on the map. A traced border is a
    // staircase, so points tie for "farthest from the chord" constantly;
    // resolving a tie by whichever was found first gives one answer walking the
    // arc forwards and another walking it back, and the realm on each side then
    // keeps a vertex the other drops.
    const staircase: Position[] = [];
    for (let i = 0; i <= 40; i++) staircase.push([i * 0.5, (i % 2) * 0.5]);

    const forward = simplifyOpen(staircase, 1.2);
    const backward = simplifyOpen([...staircase].reverse(), 1.2).reverse();
    expect(forward).toEqual(backward);

    // Not vacuous: it has to have thrown something away to be worth checking.
    expect(forward.length).toBeGreaterThan(1);
    expect(forward.length).toBeLessThan(staircase.length);
  });

  it('leaves no seam where the coastline was diced for speed', () => {
    // Trimming is made affordable by cutting big landmasses on an 8° grid first.
    // Those cuts run through the interior of the land, so they must not survive
    // into a realm's outline as a hairline slit — which is what a sliver ring
    // along a tile edge would draw. Big enough to be diced (the threshold is
    // 2,000 vertices) and wide enough to straddle two of the cuts.
    const ring: Position[] = [];
    const steps = 2400;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      ring.push([12 + 11 * Math.cos(t), 12 + 11 * Math.sin(t)]);
    }
    ring.push([...ring[0]]);
    const big: LandPolygon[] = [[ring]];

    const grown = growRealms(big, [{ id: 'one', seeds: [[12, 12]], weight: 1 }], {
      extent: [0, 0, 24, 24],
      ...DEFAULT_GROWTH,
      coverage: 1,
    });
    const shape = grown.shapes.get('one')!;
    const parts = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;

    // No hole at all: the land is solid, so any interior ring is an artefact.
    const holes = parts.flatMap((rings) => rings.slice(1));
    expect(holes.length, `${holes.length} spurious rings inside the realm`).toBe(0);
    // And no crumbs: one landmass, one realm, so one part.
    expect(parts.length).toBe(1);
    // Nearly all of the land, which a shape slit along the cuts would not be.
    expect(areaKm2(shape)).toBeGreaterThan(areaKm2({ type: 'Polygon', coordinates: [ring] }) * 0.95);
  });

  it('can be told not to trim, for callers that would rather have the speed', () => {
    const trimmed = growRealms(land, seeds, options);
    const raw = growRealms(land, seeds, { ...options, clipToCoast: false });
    // The untrimmed shapes overhang the island, so they are the larger pair.
    expect(areaKm2(raw.shapes.get('north')!)).toBeGreaterThan(areaKm2(trimmed.shapes.get('north')!));
  });

  it('keeps a realm off an island it was not seeded on', () => {
    const twoIslands = [island(1, 1, 8, 19), island(12, 1, 19, 19)];
    const pair: RealmSeed[] = [
      { id: 'west', seeds: [[4, 10]], weight: 1 },
      { id: 'east', seeds: [[15, 10]], weight: 1 },
    ];
    const grown = growRealms(twoIslands, pair, { ...options, coverage: 1 });
    const west = grown.shapes.get('west')!;
    const lons = JSON.stringify(west).match(/-?\d+\.?\d*/g)!.map(Number).filter((_, i) => i % 2 === 0);
    // Growth is four-connected across land cells, so open water is a wall.
    expect(Math.max(...lons)).toBeLessThan(11);
  });
});

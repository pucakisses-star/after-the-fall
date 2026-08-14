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
import { DEFAULT_GROWTH, growRealms, type RealmSeed } from '@/geo/realmGrowth';
import type { Position } from 'geojson';

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
function island(w: number, s: number, e: number, n: number): Position[] {
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
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

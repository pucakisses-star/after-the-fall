/**
 * The After the End realm table (spec §64).
 *
 * These check the table against the bundled subdivision file rather than
 * against itself. Every unit named must exist, and no unit may be claimed
 * twice — a subdivision in two realms would produce overlapping territories,
 * which is exactly what the topology checker exists to find and what a political
 * map must never ship with.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { feature as topoFeature } from 'topojson-client';
import { AFTER_THE_END_EMPIRES } from './afterTheEnd';
import type { Topology, GeometryCollection } from 'topojson-specification';

const topo = JSON.parse(
  readFileSync('public/data/world/admin1-na-10m.json', 'utf8'),
) as Topology<{ admin1: GeometryCollection }>;
const collection = topoFeature(topo, topo.objects.admin1) as unknown as {
  features: { properties: Record<string, unknown> }[];
};

const AVAILABLE = new Set(
  collection.features
    .map((f) => `${f.properties.adm0_a3}:${f.properties.name}`.toLowerCase())
    .filter((k) => !k.endsWith(':undefined')),
);

/** Every realm in the table, empires and their vassals alike. */
function flatten() {
  const out: { name: string; units: string[]; depth: number }[] = [];
  const walk = (realms: readonly { name: string; units: string[]; realms?: readonly never[] }[], depth: number) => {
    for (const r of realms) {
      out.push({ name: r.name, units: r.units, depth });
      if (r.realms) walk(r.realms, depth + 1);
    }
  };
  walk(AFTER_THE_END_EMPIRES as never, 0);
  return out;
}

/** Bounding box of every subdivision a realm and its vassals hold. */
const UNIT_BOXES = new Map<string, [number, number, number, number]>();
for (const f of collection.features as unknown as {
  properties: Record<string, unknown>;
  geometry: { coordinates: unknown };
}[]) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      const [x, y] = c as number[];
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
      return;
    }
    for (const v of c) walk(v);
  };
  walk(f.geometry.coordinates);
  UNIT_BOXES.set(`${f.properties.adm0_a3}:${f.properties.name}`.toLowerCase(), [w, s, e, n]);
}

function boxOfRealm(realm: { units: string[]; realms?: readonly never[] }): [number, number, number, number] {
  const units: string[] = [];
  const collect = (r: { units: string[]; realms?: readonly never[] }) => {
    units.push(...r.units);
    for (const child of r.realms ?? []) collect(child);
  };
  collect(realm);
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const u of units) {
    const b = UNIT_BOXES.get(u.toLowerCase());
    if (!b) continue;
    w = Math.min(w, b[0]);
    s = Math.min(s, b[1]);
    e = Math.max(e, b[2]);
    n = Math.max(n, b[3]);
  }
  return [w, s, e, n];
}

describe('the After the End realm table', () => {
  it('names only subdivisions the bundled dataset actually has', () => {
    const unknown = flatten()
      .flatMap((r) => r.units.map((u) => ({ realm: r.name, unit: u })))
      .filter((u) => !AVAILABLE.has(u.unit.toLowerCase()));
    expect(unknown, `unmatched: ${unknown.map((u) => `${u.unit} (${u.realm})`).join(', ')}`).toEqual([]);
  });

  it('never gives the same subdivision to two realms', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const realm of flatten()) {
      for (const unit of realm.units) {
        const key = unit.toLowerCase();
        const held = owner.get(key);
        if (held) clashes.push(`${unit}: ${held} and ${realm.name}`);
        else owner.set(key, realm.name);
      }
    }
    expect(clashes, clashes.join('; ')).toEqual([]);
  });

  it('gives every realm somewhere to be', () => {
    for (const realm of flatten()) {
      if (realm.depth === 0) continue; // an empire may hold nothing but vassals
      expect(realm.units.length, `${realm.name} has no subdivisions`).toBeGreaterThan(0);
    }
  });

  it('gives every empire a name, a short name and a capital', () => {
    for (const empire of AFTER_THE_END_EMPIRES) {
      expect(empire.name.length, 'empire without a name').toBeGreaterThan(0);
      expect(empire.short.length, `${empire.name} has no short name`).toBeGreaterThan(0);
      expect(empire.capital, `${empire.name} has no capital`).toBeTruthy();
      const { lon, lat } = empire.capital!;
      expect(Math.abs(lat), `${empire.name}'s capital is off the Earth`).toBeLessThanOrEqual(90);
      expect(Math.abs(lon), `${empire.name}'s capital is off the Earth`).toBeLessThanOrEqual(180);
    }
  });

  it('puts every hand-placed name inside its own realm\'s bounding box', () => {
    // A label anchor is written by hand, so a transposed digit puts a realm's
    // name in the sea with nothing to flag it.
    for (const empire of AFTER_THE_END_EMPIRES) {
      if (!empire.label) continue;
      const [w, s, e, n] = boxOfRealm(empire as never);
      expect(empire.label.lon, `${empire.short} is set outside its own realm`).toBeGreaterThanOrEqual(w - 3);
      expect(empire.label.lon, `${empire.short} is set outside its own realm`).toBeLessThanOrEqual(e + 3);
      expect(empire.label.lat, `${empire.short} is set outside its own realm`).toBeGreaterThanOrEqual(s - 3);
      expect(empire.label.lat, `${empire.short} is set outside its own realm`).toBeLessThanOrEqual(n + 3);
    }
  });

  it('puts every capital inside its own realm\'s bounding box', () => {
    // A capital in the wrong hemisphere is the sort of typo that survives a
    // screenshot, because the settlement simply draws somewhere else entirely.
    for (const empire of AFTER_THE_END_EMPIRES) {
      const [w, s, e, n] = boxOfRealm(empire as never);
      const { lon, lat, name } = empire.capital!;
      expect(lon, `${name} is west of ${empire.name}`).toBeGreaterThanOrEqual(w);
      expect(lon, `${name} is east of ${empire.name}`).toBeLessThanOrEqual(e);
      expect(lat, `${name} is south of ${empire.name}`).toBeGreaterThanOrEqual(s);
      expect(lat, `${name} is north of ${empire.name}`).toBeLessThanOrEqual(n);
    }
  });
});

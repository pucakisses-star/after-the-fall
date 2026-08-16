/**
 * Appointing a capital (spec §7, §47).
 *
 * A capital is two facts that have to agree: the realm records the town it is
 * run from, and the town is drawn as a capital rather than as one dot among
 * hundreds. What is checked here is that both move together — including when
 * the town has to be adopted from the reference layer, or invented on the spot,
 * because that is what naming one by typing it means.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Polygon } from 'geojson';
import { createProject } from '@/model/project';
import { useProjectStore, makeTerritory, makeSettlement } from './projectStore';
import { setCapital } from './commands';
import { useUIStore } from './uiStore';
import type { Settlement, Territory } from '@/model/types';

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
}

const AUSTIN = {
  name: 'Austin',
  coordinates: [-97.74, 30.27] as [number, number],
  scalerank: 3,
  population: 1_100_000,
};

/** A realm, a province of it, and two towns inside. */
function setup(): { realm: Territory; province: Territory; alpha: Settlement; beta: Settlement } {
  const p = createProject({ title: 'Capitals' });
  const realm = makeTerritory(p, rect(-100, 28, -95, 33), { name: 'Realm', politicalType: 'kingdom' });
  const province = makeTerritory(p, rect(-99, 29, -97, 31), {
    name: 'Province',
    politicalType: 'county',
    parentId: realm.id,
  });
  const alpha = makeSettlement(p, { type: 'Point', coordinates: [-98, 30] }, { name: 'Alpha', population: 40_000 });
  const beta = makeSettlement(p, { type: 'Point', coordinates: [-96, 32] }, { name: 'Beta', population: 300_000 });
  for (const t of [realm, province]) p.territories[t.id] = t;
  for (const s of [alpha, beta]) p.settlements[s.id] = s;
  useProjectStore.getState().loadProject(p, null);
  return { realm, province, alpha, beta };
}

const project = () => useProjectStore.getState().project;
const town = (id: string) => project().settlements[id];
const realmOf = (id: string) => project().territories[id];

beforeEach(() => useUIStore.getState().clearSelection());

describe('naming a town the map already has', () => {
  it('records it and draws it as a capital', () => {
    const { realm, alpha } = setup();
    setCapital(realm.id, { kind: 'settlement', id: alpha.id });
    expect(realmOf(realm.id).capitalId).toBe(alpha.id);
    expect(town(alpha.id).type).toBe('national-capital');
  });

  it('ranks the seat by what the realm is', () => {
    // A province is run from a regional capital, not a national one — otherwise
    // every county seat on the map is drawn like a country's.
    const { province, alpha } = setup();
    setCapital(province.id, { kind: 'settlement', id: alpha.id });
    expect(town(alpha.id).type).toBe('regional-capital');
  });

  it('puts the town it replaces back to its own size', () => {
    const { realm, alpha, beta } = setup();
    setCapital(realm.id, { kind: 'settlement', id: alpha.id });
    setCapital(realm.id, { kind: 'settlement', id: beta.id });
    // Alpha's forty thousand make it a town again, not a city and not a capital.
    expect(town(alpha.id).type).toBe('town');
    expect(town(beta.id).type).toBe('national-capital');
  });

  it('leaves a town that is still somebody else\'s seat alone', () => {
    // One town can be the seat of a realm and of the province under it, and
    // losing one of those posts is not losing the other.
    const { realm, province, alpha, beta } = setup();
    setCapital(realm.id, { kind: 'settlement', id: alpha.id });
    setCapital(province.id, { kind: 'settlement', id: alpha.id });
    setCapital(realm.id, { kind: 'settlement', id: beta.id });
    expect(town(alpha.id).type).toContain('capital');
  });

  it('clears back to no capital, and stands the town down', () => {
    const { realm, alpha } = setup();
    setCapital(realm.id, { kind: 'settlement', id: alpha.id });
    setCapital(realm.id, { kind: 'none' });
    expect(realmOf(realm.id).capitalId).toBeNull();
    expect(town(alpha.id).type).toBe('town');
  });
});

describe('naming one the map does not have', () => {
  it('adopts a reference city and seats the realm on it', () => {
    const { realm } = setup();
    const id = setCapital(realm.id, { kind: 'place', place: AUSTIN })!;
    expect(town(id).name).toBe('Austin');
    expect(town(id).population).toBe(1_100_000);
    expect(town(id).geometry.coordinates).toEqual(AUSTIN.coordinates);
    expect(town(id).type).toBe('national-capital');
    expect(realmOf(realm.id).capitalId).toBe(id);
  });

  it('gives an invented town ground in the realm that runs it', () => {
    const { realm } = setup();
    const id = setCapital(realm.id, { kind: 'new', name: 'Sunfall' })!;
    const [lon, lat] = town(id).geometry.coordinates;
    expect(town(id).name).toBe('Sunfall');
    expect(lon).toBeGreaterThan(-100);
    expect(lon).toBeLessThan(-95);
    expect(lat).toBeGreaterThan(28);
    expect(lat).toBeLessThan(33);
    expect(town(id).ownerId).toBe(realm.id);
  });

  it('names the new town on the map', () => {
    const { realm } = setup();
    const id = setCapital(realm.id, { kind: 'new', name: 'Sunfall' })!;
    const labelId = town(id).labelId!;
    expect(project().labels[labelId].text).toBe('Sunfall');
  });

  it('takes one press of undo, town and appointment together', () => {
    // The point of doing it in one command: inventing a capital is one
    // decision, and undo should not leave a nameless dot behind.
    const { realm } = setup();
    const before = Object.keys(project().settlements).length;
    setCapital(realm.id, { kind: 'place', place: AUSTIN });
    useProjectStore.getState().undo();
    expect(realmOf(realm.id).capitalId).toBeNull();
    expect(Object.keys(project().settlements)).toHaveLength(before);
  });

  it('re-uses a reference city the map has already adopted', () => {
    const { realm, province } = setup();
    const first = setCapital(realm.id, { kind: 'place', place: AUSTIN });
    const second = setCapital(province.id, { kind: 'place', place: AUSTIN });
    expect(second).toBe(first);
    expect(Object.values(project().settlements).filter((s) => s.name === 'Austin')).toHaveLength(1);
  });
});

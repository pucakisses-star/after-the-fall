/**
 * The paint bucket as a command (spec §6, §57).
 *
 * The geometry of *which* ground a click means is settled in
 * `geo/floodFill.test.ts`. What is checked here is what the document does with
 * the answer: that ground moves rather than being copied, that claimed ground is
 * never taken without being asked for, and that a realm left holding nothing
 * does not survive as an empty shape with a name over the sea.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Polygon } from 'geojson';
import { createProject } from '@/model/project';
import { useProjectStore, makeTerritory, makeLabel } from './projectStore';
import { fillLandAt } from './commands';
import { useUIStore } from './uiStore';
import { areaKm2 } from '@/geo/operations';
import type { Territory } from '@/model/types';

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
}

/** A continent with a realm on each half and nothing else. */
const CONTINENT = rect(0, 0, 10, 10);
/** A line from coast to coast down the middle of the western realm. */
const MERIDIAN = [[2, -1], [2, 11]];

function setup(): { west: Territory; east: Territory } {
  const project = createProject({ title: 'Fill' });
  const west = makeTerritory(project, rect(0, 0, 4, 10), { name: 'West' });
  const east = makeTerritory(project, rect(6, 0, 10, 10), { name: 'East' });
  for (const t of [west, east]) project.territories[t.id] = t;
  useProjectStore.getState().loadProject(project, null);
  return { west, east };
}

const current = (id: string) => useProjectStore.getState().project.territories[id];
const areaOf = (id: string) => areaKm2(current(id).geometry);

beforeEach(() => useUIStore.getState().clearSelection());

describe('filling unclaimed land', () => {
  it('gives the gap between two realms to the one that was selected', () => {
    const { west, east } = setup();
    const before = areaOf(west.id);
    const result = fillLandAt([5, 5], [CONTINENT], west.id);
    expect(result.filled).toBe(true);
    expect(areaOf(west.id)).toBeGreaterThan(before);
    expect(areaOf(east.id)).toBeCloseTo(areaKm2(rect(6, 0, 10, 10)), -3);
  });

  it('says so at sea', () => {
    setup();
    expect(fillLandAt([50, 50], [CONTINENT], null).filled).toBe(false);
  });
});

describe('filling claimed land', () => {
  it('will not take a realm\'s ground without being told where to put it', () => {
    const { west } = setup();
    const result = fillLandAt([1, 5], [CONTINENT], null);
    expect(result.filled).toBe(false);
    expect(result.message).toContain('West');
    expect(areaOf(west.id)).toBeCloseTo(areaKm2(rect(0, 0, 4, 10)), -3);
  });

  it('moves the ground from one realm to the other, losing none of it', () => {
    const { west, east } = setup();
    const total = areaOf(west.id) + areaOf(east.id);

    useUIStore.getState().setSelection([east.id]);
    const result = fillLandAt([1, 5], [CONTINENT], east.id, [MERIDIAN]);
    expect(result.filled).toBe(true);

    // The stripe west of the line is a quarter of the west realm.
    expect(areaOf(west.id) / areaKm2(rect(0, 0, 4, 10))).toBeCloseTo(0.5, 2);
    expect(areaOf(east.id) + areaOf(west.id)).toBeCloseTo(total, -3);
  });

  it('refuses to fill a realm with itself', () => {
    const { west } = setup();
    const result = fillLandAt([1, 5], [CONTINENT], west.id, [MERIDIAN]);
    expect(result.filled).toBe(false);
    expect(result.message).toContain('already holds');
  });

  it('removes a realm the fill left holding nothing, and its name with it', () => {
    const { west, east } = setup();
    const project = useProjectStore.getState().project;
    const label = makeLabel(project, { type: 'Point', coordinates: [2, 5] }, {
      kind: 'country',
      text: 'West',
      attachedToId: west.id,
    });
    useProjectStore.getState().loadProject(
      { ...project, labels: { ...project.labels, [label.id]: label } },
      null,
    );

    // No wall, so the click takes the whole of the western realm.
    const result = fillLandAt([1, 5], [CONTINENT], east.id);
    expect(result.filled).toBe(true);
    expect(current(west.id)).toBeUndefined();
    expect(useProjectStore.getState().project.labels[label.id]).toBeUndefined();
    expect(result.message).toContain('is gone');
  });

  it('leaves no ribbon behind when the line does not divide the ground', () => {
    // The bug this pins: a river that peters out inside a territory does not
    // divide it, so the fill takes everything except the width of the cut —
    // and the owner was left holding that: thirty metres by five hundred
    // kilometres, drawn as a border hanging in the middle of its neighbour and
    // stopping dead where the river stopped.
    const { west, east } = setup();
    const total = areaOf(west.id) + areaOf(east.id);
    const stub = [[2, -1], [2, 5]];

    const result = fillLandAt([1, 8], [CONTINENT], east.id, [stub]);
    expect(result.filled).toBe(true);
    expect(current(west.id)).toBeUndefined();
    expect(areaOf(east.id)).toBeCloseTo(total, -3);
  });

  it('gives the width of the cut to whichever side keeps the ground', () => {
    // Where the line *does* divide, both sides survive and the ribbon still has
    // to go somewhere: to the new owner, so the two meet along one line rather
    // than either losing it or sharing an overlap.
    const { west, east } = setup();
    const total = areaOf(west.id) + areaOf(east.id);
    fillLandAt([1, 5], [CONTINENT], east.id, [MERIDIAN]);
    expect(areaOf(west.id) + areaOf(east.id)).toBeCloseTo(total, -3);
  });

  it('undoes in one step', () => {
    const { west, east } = setup();
    const before = areaOf(west.id);
    fillLandAt([1, 5], [CONTINENT], east.id, [MERIDIAN]);
    useProjectStore.getState().undo();
    expect(areaOf(west.id)).toBeCloseTo(before, -3);
  });
});

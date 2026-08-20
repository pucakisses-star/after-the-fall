/**
 * Which reference layers the paint bucket treats as walls (spec §6, §57).
 *
 * The geometry of stopping is exercised in `floodFill.test.ts`; here it is only
 * the roster: water and administrative divisions count, roads and places do
 * not, and an invisible layer is out of the fill entirely.
 */

import { describe, expect, it } from 'vitest';
import { createProject } from '@/model/project';
import { barrierSources, BARRIER_ROLES, closeBarrierGaps } from './barriers';
import type { Position } from 'geojson';

function withBasemap(sourceIds: string[], visible = true) {
  const project = createProject({ title: 'Barriers' });
  project.basemap = sourceIds.map((sourceId) => ({ sourceId, visible, opacity: 1 }));
  return project;
}

describe('barrier layers', () => {
  it('counts lakes among the barriers, like rivers', () => {
    expect(BARRIER_ROLES).toContain('lakes');
    expect(BARRIER_ROLES).toContain('rivers');
    const project = withBasemap(['world-lakes-10m', 'world-rivers-10m']);
    const ids = barrierSources(project).map((s) => s.id);
    expect(ids).toContain('world-lakes-10m');
    expect(ids).toContain('world-rivers-10m');
  });

  it('does not stop at roads or places', () => {
    const project = withBasemap(['world-roads-10m', 'world-places-10m']);
    expect(barrierSources(project)).toEqual([]);
  });

  it('leaves an invisible lakes layer out of the fill', () => {
    const project = withBasemap(['world-lakes-10m'], false);
    expect(barrierSources(project)).toEqual([]);
  });
});

/**
 * A river that stops short of the lake it runs into (spec §6, §57).
 *
 * The shoreline is not one of the barrier lines — it is water — but it is in
 * the network the dangling ends are closed against, which is what carries a
 * mouth the last few hundred metres to the shore. Without that the fill walks
 * round the end of the river and comes back up the other bank.
 */
describe('a river mouth short of the shore', () => {
  /** A square lake, as a closed ring, standing in for a shoreline. */
  const shore: Position[] = [
    [0, 0],
    [1, 0],
    [1, -1],
    [0, -1],
    [0, 0],
  ];
  /** Flowing due south, stopping 300 m north of the water. */
  const river: Position[] = [
    [0.5, 0.02],
    [0.5, 0.0027],
  ];

  it('is carried to the water rather than left dangling', () => {
    const [closed] = closeBarrierGaps([river], [shore]);
    expect(closed.length).toBe(river.length + 1);
    const mouth = closed[closed.length - 1];
    expect(mouth[1]).toBeCloseTo(0, 6);
    expect(mouth[0]).toBeCloseTo(0.5, 6);
  });

  it('is left where it is when there is no water to reach', () => {
    const [closed] = closeBarrierGaps([river]);
    expect(closed).toEqual(river);
  });
});

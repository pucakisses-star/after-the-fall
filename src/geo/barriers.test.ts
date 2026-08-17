/**
 * Which reference layers the paint bucket treats as walls (spec §6, §57).
 *
 * The geometry of stopping is exercised in `floodFill.test.ts`; here it is only
 * the roster: water and administrative divisions count, roads and places do
 * not, and an invisible layer is out of the fill entirely.
 */

import { describe, expect, it } from 'vitest';
import { createProject } from '@/model/project';
import { barrierSources, BARRIER_ROLES } from './barriers';

function withBasemap(sourceIds: string[], visible = true) {
  const project = createProject({ title: 'Barriers' });
  project.basemap = sourceIds.map((sourceId) => ({ sourceId, visible, opacity: 1 }));
  return project;
}

describe('barrier layers', () => {
  it('counts lakes among the walls, like rivers', () => {
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

/**
 * Assigning a territory to a realm — the paint tool and its relatives
 * (spec §7, §57).
 *
 * These three commands all do the same thing to a territory: give it a parent
 * and switch on colour inheritance. What they have to get right is that
 * inheritance is now driven by *constitutional status*, so a territory that
 * gains a parent has to gain a status to match. Leaving it `sovereign` is not a
 * cosmetic slip — a sovereign's colour variation is zero by definition, so the
 * subdivision takes its parent's exact fill and disappears into it, and painting
 * looks like it did nothing at all.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Polygon } from 'geojson';
import { createProject } from '@/model/project';
import { useProjectStore, makeTerritory } from './projectStore';
import { createTerritoryFromSelection, paintTerritory } from './commands';
import { useUIStore } from './uiStore';
import { inheritedFill } from '@/model/resolveStyle';
import { colorDistance } from '@/model/color';
import type { Territory } from '@/model/types';

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
}

/** A realm and two neighbouring provinces, all sovereign to begin with. */
function setup(): { realm: Territory; a: Territory; b: Territory } {
  const project = createProject({ title: 'Paint' });
  const realm = makeTerritory(project, rect(0, 0, 2, 2), {
    name: 'Realm',
    styleOverrides: { fillColor: '#d99b9b' },
  });
  const a = makeTerritory(project, rect(2, 0, 3, 2), { name: 'Alpha' });
  const b = makeTerritory(project, rect(3, 0, 4, 2), { name: 'Beta' });
  for (const t of [realm, a, b]) project.territories[t.id] = t;
  useProjectStore.getState().loadProject(project, null);
  return { realm, a, b };
}

const current = (id: string) => useProjectStore.getState().project.territories[id];

beforeEach(() => {
  useUIStore.getState().clearSelection();
});

describe('paintTerritory', () => {
  it('makes what it paints a member of the realm, not a sovereign inside one', () => {
    // The regression. A territory with a parent, inheriting its colour, but
    // still marked sovereign is a contradiction the renderer resolves by giving
    // it zero variation — the parent's exact fill.
    const { realm, a } = setup();
    paintTerritory(realm.id, [a.id]);

    const painted = current(a.id);
    expect(painted.parentId).toBe(realm.id);
    expect(painted.inheritParentColor).toBe(true);
    expect(painted.relationship).toBe('constituent');
  });

  it('leaves the painted subdivision visible against its parent', () => {
    // What the user sees. Painting must not make a province vanish into the
    // realm it joined.
    const { realm, a } = setup();
    paintTerritory(realm.id, [a.id]);

    const project = useProjectStore.getState().project;
    const fill = inheritedFill(project, current(a.id));
    expect(fill).not.toBeNull();
    expect(colorDistance(fill!, '#d99b9b')).toBeGreaterThan(0);
  });

  it('gives two painted subdivisions distinguishable shades', () => {
    const { realm, a, b } = setup();
    paintTerritory(realm.id, [a.id, b.id]);

    const project = useProjectStore.getState().project;
    const fa = inheritedFill(project, current(a.id));
    const fb = inheritedFill(project, current(b.id));
    expect(fa).not.toBe(fb);
  });

  it('still grows the parent over what it absorbed', () => {
    // The other half of the command, which the status change must not disturb.
    const { realm, a } = setup();
    const before = current(realm.id).geometry;
    paintTerritory(realm.id, [a.id]);
    expect(current(realm.id).geometry).not.toEqual(before);
  });
});

describe('createTerritoryFromSelection', () => {
  it('demotes the originals to members of the new realm', () => {
    const { a, b } = setup();
    useUIStore.getState().setSelection([a.id, b.id]);
    const id = createTerritoryFromSelection({ name: 'Union' });
    expect(id).toBeTruthy();

    for (const t of [a, b]) {
      const child = current(t.id);
      expect(child.parentId).toBe(id);
      expect(child.relationship).toBe('constituent');
    }
  });
});

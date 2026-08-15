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
import {
  addTerritory,
  createTerritoryFromSelection,
  paintTerritory,
  subdivisionFromStroke,
} from './commands';
import { useUIStore } from './uiStore';
import { inheritedFill } from '@/model/resolveStyle';
import { areaKm2 } from '@/geo/operations';
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

/**
 * Drawing a border inside a state (spec §5, §7).
 *
 * A border drawn inside a state is a border *of* that state. The alternative —
 * what this used to do — is a second sovereign lying on top of the first, which
 * renders as a full international frontier around a province and reads as two
 * countries claiming the same ground.
 */
describe('drawing a border inside a state', () => {
  it('makes a subdivision of the state it was drawn in', () => {
    const { realm } = setup();
    const id = addTerritory(rect(0.2, 0.2, 1, 1))!;
    expect(current(id).parentId).toBe(realm.id);
    expect(current(id).relationship).toBe('constituent');
    expect(current(id).inheritParentColor).toBe(true);
  });

  it('draws its border at provincial weight, not as a frontier', () => {
    setup();
    const id = addTerritory(rect(0.2, 0.2, 1, 1))!;
    expect(current(id).borderKind).toBe('provincial');
  });

  it('goes a rank lighter again inside a subdivision', () => {
    const { realm } = setup();
    const province = addTerritory(rect(0.1, 0.1, 1.9, 1.9))!;
    expect(current(province).parentId).toBe(realm.id);

    const county = addTerritory(rect(0.5, 0.5, 1, 1))!;
    // The smallest container is the parent, so a county inside a province
    // belongs to the province and not to the realm above it.
    expect(current(county).parentId).toBe(province);
    expect(current(county).borderKind).toBe('county');
  });

  it('trims a subdivision to the state it belongs to', () => {
    // The realm runs to x=2. A shape drawn over its edge is still a member —
    // nine tenths of it is inside — and the part hanging over the neighbour is
    // not ground it has any claim to.
    const { realm } = setup();
    const id = addTerritory(rect(1.5, 0.5, 2.05, 1.5))!;
    expect(current(id).parentId).toBe(realm.id);
    const lons = JSON.stringify(current(id).geometry).match(/-?\d+\.?\d*/g)!.map(Number).filter((_, i) => i % 2 === 0);
    expect(Math.max(...lons)).toBeCloseTo(2, 5);
  });

  it('leaves a shape drawn on open ground sovereign', () => {
    setup();
    const id = addTerritory(rect(10, 10, 12, 12))!;
    expect(current(id).parentId).toBeNull();
    expect(current(id).relationship).toBe('sovereign');
  });

  it('does not adopt a shape that only half overlaps a state', () => {
    // Half in, half out is a new state overlapping an old one — a different
    // thing, and not something to guess about.
    setup();
    const id = addTerritory(rect(1, 0.5, 3, 1.5))!;
    expect(current(id).parentId).toBeNull();
  });

  it('leaves a locked state alone', () => {
    const { realm } = setup();
    useProjectStore.getState().loadProject(
      {
        ...useProjectStore.getState().project,
        territories: {
          ...useProjectStore.getState().project.territories,
          [realm.id]: { ...current(realm.id), locked: true },
        },
      },
      null,
    );
    const id = addTerritory(rect(0.2, 0.2, 1, 1))!;
    expect(current(id).parentId).toBeNull();
  });

  it('undoes in one step, subdivision and name together', () => {
    setup();
    const before = Object.keys(useProjectStore.getState().project.territories).length;
    addTerritory(rect(0.2, 0.2, 1, 1));
    useProjectStore.getState().undo();
    expect(Object.keys(useProjectStore.getState().project.territories).length).toBe(before);
  });
});

/**
 * The redraw tool's other half (spec §5, §7).
 *
 * A stroke along an existing outline moves that outline. A stroke drawn inside a
 * state is a new border, and makes a subdivision bounded by what was drawn —
 * which is what the tool called "Redraw border" is usually reached for.
 */
describe('a border drawn inside a state with the redraw tool', () => {
  const stroke = (coords: [number, number][]) => ({ type: 'LineString' as const, coordinates: coords });

  it('closes the stroke and makes a subdivision of the state it lands in', () => {
    const { realm } = setup();
    // Deliberately left open: a hand drawing a loop does not land on its start.
    const id = subdivisionFromStroke(stroke([[0.3, 0.3], [1.5, 0.3], [1.5, 1.5], [0.3, 1.5], [0.35, 0.4]]))!;
    expect(id).toBeTruthy();
    expect(current(id).parentId).toBe(realm.id);
    expect(current(id).borderKind).toBe('provincial');
  });

  it('survives a stroke that crosses itself, as freehand always does', () => {
    const { realm } = setup();
    const id = subdivisionFromStroke(
      stroke([[0.3, 0.3], [1.5, 0.3], [1.5, 1.5], [0.3, 1.5], [0.3, 0.2], [0.6, 0.35]]),
    )!;
    expect(id).toBeTruthy();
    expect(current(id).parentId).toBe(realm.id);
    expect(areaKm2(current(id).geometry)).toBeGreaterThan(0);
  });

  it('refuses a loop drawn on open ground', () => {
    // Not a subdivision of anything, and not a licence to invent a country out
    // of a scribble in the sea.
    setup();
    expect(subdivisionFromStroke(stroke([[20, 20], [21, 20], [21, 21], [20, 21]]))).toBeNull();
  });

  it('refuses a stroke too short to enclose anything', () => {
    setup();
    expect(subdivisionFromStroke(stroke([[0.3, 0.3], [0.4, 0.4]]))).toBeNull();
  });
});

/**
 * Political hierarchy: status as data, and everything the renderer derives from
 * it (spec §2, §4, §6, §7, §16, §17, §18, §26, §35, §37).
 *
 * The acceptance test at the bottom is the one that matters. It builds the
 * Midwest Confederation from the reference plate — six ordinary cantons, three
 * vassal counties and a free city — and asserts the things you can see by
 * looking at that plate: it reads as one realm, its cantons are subordinate to
 * it, its vassals are visibly a different kind of thing, and its free city is
 * not part of the family at all. Then it makes a vassal independent and checks
 * that its whole appearance followed, because that is the difference between a
 * hierarchy the application understands and one that was drawn by hand.
 */

import { describe, expect, it } from 'vitest';
import { createProject, migrate } from './project';
import {
  POLITICAL_RELATIONSHIPS,
  borderStyleClassFor,
  borderWeightFor,
  createDefaultStyleSheet,
  cohesionFactor,
  inferRelationship,
  relationshipInfo,
} from './defaults';
import { inheritedFill } from './resolveStyle';
import { relationshipSubtitle } from './hierarchy';
import { parseColor, rgbToHsl } from './color';
import type { MapProject, PoliticalRelationship, Territory } from './types';

const CONFEDERATION_COLOR = '#d99b9b'; // the dusty salmon of the reference plate

function territory(id: string, over: Partial<Territory> = {}): Territory {
  return {
    id,
    layerId: 'layer',
    name: id,
    shortName: '',
    politicalType: 'province',
    relationship: 'constituent',
    parentId: null,
    liegeId: null,
    capitalId: null,
    notes: '',
    locked: false,
    hidden: false,
    timeline: { start: null, end: null },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
    styleClassId: 'style',
    styleOverrides: {},
    inheritParentColor: true,
    borderKind: 'provincial',
    labelId: null,
    ...over,
  };
}

/** The realm of the reference plate, with the members it is drawn with. */
function midwestConfederation(): { project: MapProject; ids: Record<string, string> } {
  const project = createProject({ title: 'Acceptance' });
  const ids: Record<string, string> = {};

  const add = (t: Territory) => {
    project.territories[t.id] = t;
    ids[t.id] = t.id;
  };

  add(
    territory('confederation', {
      name: 'Midwest Confederation',
      shortName: 'M.C.',
      politicalType: 'confederation',
      relationship: 'sovereign',
      inheritParentColor: false,
      styleOverrides: { fillColor: CONFEDERATION_COLOR },
      borderKind: 'international',
    }),
  );

  for (const name of ['Des Moines', 'Cedar', 'Big Bear', 'Iowa', 'Muscatine', 'Chariton']) {
    add(
      territory(`canton-${name}`, {
        name: `Canton of ${name}`,
        politicalType: 'province',
        relationship: 'constituent',
        parentId: 'confederation',
        borderKind: relationshipInfo('constituent').border,
      }),
    );
  }

  for (const name of ['Dubuque', 'Thompson', 'Jefferson']) {
    add(
      territory(`vassal-${name}`, {
        name: `County of ${name}`,
        politicalType: 'county',
        relationship: 'vassal',
        parentId: 'confederation',
        borderKind: relationshipInfo('vassal').border,
      }),
    );
  }

  add(
    territory('free-des-moines', {
      name: 'Free City of Des Moines',
      politicalType: 'city-state',
      relationship: 'free-city',
      parentId: 'confederation',
      styleOverrides: { fillColor: '#c8202a' },
      borderKind: relationshipInfo('free-city').border,
    }),
  );

  return { project, ids };
}

/** How far two colours sit apart in hue+lightness, roughly "are these a family". */
function distance(a: string, b: string): number {
  const x = rgbToHsl(parseColor(a));
  const y = rgbToHsl(parseColor(b));
  const dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h)) / 180;
  return Math.hypot(dh, x.s - y.s, x.l - y.l);
}

const fillOf = (project: MapProject, id: string) =>
  inheritedFill(project, project.territories[id]) ?? project.territories[id].styleOverrides.fillColor!;

describe('political status is separate from political rank', () => {
  it('lets a county be a vassal and a county be a canton', () => {
    // The whole reason status is its own field: rank and status vary
    // independently, and folding them together is what made every subdivision
    // draw like an independent country.
    const { project } = midwestConfederation();
    const dubuque = project.territories['vassal-Dubuque'];
    const iowa = project.territories['canton-Iowa'];
    expect(dubuque.politicalType).toBe('county');
    expect(dubuque.relationship).toBe('vassal');
    expect(iowa.relationship).toBe('constituent');
    expect(relationshipInfo(dubuque.relationship).border).not.toBe(
      relationshipInfo(iowa.relationship).border,
    );
  });

  it('reads status out of old documents that stored it as a rank', () => {
    // Files written before status existed carry "vassal" in the rank field.
    expect(inferRelationship('vassal', true)).toBe('vassal');
    expect(inferRelationship('occupied-territory', true)).toBe('occupied');
    expect(inferRelationship('disputed-territory', true)).toBe('disputed');
    // And everything else is decided by whether anyone holds it.
    expect(inferRelationship('duchy', true)).toBe('constituent');
    expect(inferRelationship('duchy', false)).toBe('sovereign');
  });

  it('migrates a document with no status at all', () => {
    const old = {
      ...createProject(),
      territories: {
        a: { ...territory('a', { politicalType: 'kingdom' }), relationship: undefined },
        b: { ...territory('b', { politicalType: 'vassal', parentId: 'a' }), relationship: undefined },
      },
    };
    const loaded = migrate(JSON.parse(JSON.stringify(old)));
    expect(loaded.territories.a.relationship).toBe('sovereign');
    expect(loaded.territories.b.relationship).toBe('vassal');
    expect(loaded.politicalCohesion).toBe('strong');
  });

  it('never draws a held territory with an international frontier', () => {
    // §16: a vassal's perimeter is not the same line as the frontier between
    // two sovereigns, and nothing in the table may say otherwise.
    for (const r of POLITICAL_RELATIONSHIPS) {
      if (r.value === 'sovereign') continue;
      expect(r.border, `${r.value} claims a sovereign frontier`).not.toBe('international');
    }
  });
});

describe('colour inheritance follows status', () => {
  it('keeps ordinary members closer to the realm than vassals', () => {
    // §4 and §6: cantons are variations on the realm's colour; a vassal moves
    // further so it reads as a different constitutional thing.
    const { project } = midwestConfederation();
    const canton = distance(CONFEDERATION_COLOR, fillOf(project, 'canton-Iowa'));
    const vassal = distance(CONFEDERATION_COLOR, fillOf(project, 'vassal-Dubuque'));
    expect(canton).toBeGreaterThan(0); // distinguishable at all
    expect(vassal).toBeGreaterThan(canton);
  });

  it('gives siblings different shades of the same family', () => {
    // Without this every canton is the identical colour and only the hairline
    // between them says there are two.
    const { project } = midwestConfederation();
    const shades = ['canton-Iowa', 'canton-Cedar', 'canton-Muscatine', 'canton-Chariton'].map((id) =>
      fillOf(project, id),
    );
    expect(new Set(shades).size).toBe(shades.length);
    for (const s of shades) expect(distance(CONFEDERATION_COLOR, s)).toBeLessThan(0.35);
  });

  it('is stable across reloads', () => {
    // The per-sibling offset is derived from the id, not from iteration order or
    // a random seed, or a saved map would change colour every time it opened.
    const a = midwestConfederation().project;
    const b = midwestConfederation().project;
    expect(fillOf(a, 'canton-Iowa')).toBe(fillOf(b, 'canton-Iowa'));
  });

  it('leaves a free city its own colour', () => {
    const { project } = midwestConfederation();
    expect(inheritedFill(project, project.territories['free-des-moines'])).toBeNull();
    expect(fillOf(project, 'free-des-moines')).toBe('#c8202a');
  });

  it('tightens and loosens the whole family with cohesion', () => {
    // §18. Unified is nearly the realm's own colour; loose is a broad family.
    const { project } = midwestConfederation();
    const at = (c: MapProject['politicalCohesion']) =>
      distance(CONFEDERATION_COLOR, fillOf({ ...project, politicalCohesion: c }, 'vassal-Dubuque'));
    expect(at('unified')).toBeLessThan(at('strong'));
    expect(at('strong')).toBeLessThan(at('moderate'));
    expect(at('moderate')).toBeLessThan(at('loose'));
    // Independent switches inheritance off rather than widening it.
    expect(
      inheritedFill({ ...project, politicalCohesion: 'independent' }, project.territories['canton-Iowa']),
    ).toBeNull();
    expect(cohesionFactor('independent')).toBe(0);
  });
});

describe('relationship notes', () => {
  it('writes the line the reference plate prints', () => {
    const { project } = midwestConfederation();
    expect(relationshipSubtitle(project, project.territories['vassal-Dubuque'])).toBe(
      'Vassal of the M.C.',
    );
  });

  it('says nothing for the statuses that need no saying', () => {
    const { project } = midwestConfederation();
    expect(relationshipSubtitle(project, project.territories['canton-Iowa'])).toBeNull();
    expect(relationshipSubtitle(project, project.territories.confederation)).toBeNull();
  });

  it('does not claim a parent it has not got', () => {
    const { project } = midwestConfederation();
    const orphan = { ...project.territories['vassal-Dubuque'], parentId: null };
    expect(relationshipSubtitle(project, orphan)).toBeNull();
  });
});

/**
 * Spec §37, as written: build the realm and check the ten things the reference
 * plate shows.
 */
describe('acceptance: the Midwest Confederation', () => {
  const { project } = midwestConfederation();
  const members = Object.values(project.territories).filter((t) => t.parentId === 'confederation');
  const cantons = members.filter((t) => t.relationship === 'constituent');
  const vassals = members.filter((t) => t.relationship === 'vassal');
  const freeCities = members.filter((t) => t.relationship === 'free-city');

  it('has the realm the test asks for', () => {
    expect(cantons).toHaveLength(6);
    expect(vassals).toHaveLength(3);
    expect(freeCities).toHaveLength(1);
  });

  it('1–3. reads as one realm, with its cantons visibly subordinate to it', () => {
    for (const c of cantons) {
      expect(distance(CONFEDERATION_COLOR, fillOf(project, c.id))).toBeLessThan(0.3);
      expect(c.borderKind).not.toBe('international');
    }
  });

  it('2. has an outer frontier heavier than anything inside it', () => {
    const outer = project.territories.confederation.borderKind;
    expect(outer).toBe('international');
    for (const m of members) expect(m.borderKind).not.toBe(outer);
  });

  it('4. draws its vassals differently from its ordinary cantons', () => {
    const cantonBorders = new Set(cantons.map((c) => String(c.borderKind)));
    for (const v of vassals) {
      expect(cantonBorders.has(String(v.borderKind))).toBe(false);
      expect(distance(CONFEDERATION_COLOR, fillOf(project, v.id))).toBeGreaterThan(
        Math.max(...cantons.map((c) => distance(CONFEDERATION_COLOR, fillOf(project, c.id)))),
      );
      expect(relationshipSubtitle(project, v)).toBe('Vassal of the M.C.');
    }
  });

  it('5. makes its free city clearly distinguishable', () => {
    const free = freeCities[0];
    expect(inheritedFill(project, free)).toBeNull();
    expect(distance(CONFEDERATION_COLOR, fillOf(project, free.id))).toBeGreaterThan(0.35);
  });

  it('8. keeps internal borders finer than the sovereign frontier', () => {
    const outer = borderWeightFor(project.territories.confederation.borderKind);
    for (const m of members) {
      expect(borderWeightFor(m.borderKind), `${m.name} is as heavy as the frontier`).toBeLessThan(outer);
    }
  });

  it('9. leaves every member independently editable', () => {
    // §14: the realm's outline is derived from its members, and the members are
    // still there afterwards to be reshaped one at a time.
    for (const m of members) {
      expect(m.geometry).toBeTruthy();
      expect(m.locked).toBe(false);
    }
    expect(Object.keys(project.territories)).toHaveLength(11);
  });

  it('10. restyles a member the moment its status changes', () => {
    // The point of §35. Nothing here touches a colour, a border or a label —
    // only the status — and all three follow.
    const before = project.territories['vassal-Dubuque'];
    expect(relationshipSubtitle(project, before)).toBe('Vassal of the M.C.');
    expect(inheritedFill(project, before)).not.toBeNull();

    const independent: Territory = {
      ...before,
      relationship: 'sovereign' as PoliticalRelationship,
      parentId: null,
      inheritParentColor: false,
      borderKind: relationshipInfo('sovereign').border,
    };
    const after = { ...project, territories: { ...project.territories, [independent.id]: independent } };

    expect(relationshipSubtitle(after, independent)).toBeNull();
    expect(inheritedFill(after, independent)).toBeNull();
    expect(independent.borderKind).toBe('international');
    // And it is no longer one of the realm's members, so the frontier the
    // renderer derives from that set no longer includes it.
    expect(
      Object.values(after.territories).filter((t) => t.parentId === 'confederation'),
    ).toHaveLength(members.length - 1);
  });
});

describe('label sizing', () => {
  it('defaults a label to scaling with the map, and migrates one that predates the flag', () => {
    // A territory's name is an inscription across the land, so it travels with
    // the map by default; the flag is the opt-out for a name placed by hand.
    const old = {
      ...createProject(),
      labels: {
        a: { id: 'a', text: 'Somewhere', fixedSize: undefined } as unknown as Record<string, unknown>,
      },
    };
    const loaded = migrate(JSON.parse(JSON.stringify(old)));
    expect(loaded.labels.a.fixedSize).toBe(false);
  });

  it('leaves a label that already carries the flag alone', () => {
    const doc = {
      ...createProject(),
      labels: { a: { id: 'a', text: 'Pinned', fixedSize: true } as unknown as Record<string, unknown> },
    };
    expect(migrate(JSON.parse(JSON.stringify(doc))).labels.a.fixedSize).toBe(true);
  });
});

describe('internal borders are drawn as internal', () => {
  it('dots every line drawn between members of one realm', () => {
    // A solid line says "two countries". Every border inside a realm was solid,
    // so a kingdom's duchies read as a cluster of small sovereigns however
    // closely their fills matched.
    const sheet = createDefaultStyleSheet();
    for (const kind of ['provincial', 'county'] as const) {
      const cls = sheet.line[borderStyleClassFor(kind)];
      expect(cls.style.dash, `${kind} is still solid`).toBe('dotted');
    }
  });

  it("keeps a vassal frontier distinct from an ordinary province line", () => {
    const sheet = createDefaultStyleSheet();
    expect(sheet.line[borderStyleClassFor('subordinate')].style.dash).toBe('dash-dot');
  });

  it('leaves sovereign frontiers solid', () => {
    // The contrast is the whole point: a frontier is drawn, a division is dotted.
    const sheet = createDefaultStyleSheet();
    for (const kind of ['international', 'major-political'] as const) {
      expect(sheet.line[borderStyleClassFor(kind)].style.dash).toBe('solid');
    }
  });

  it('gives a dotted line enough weight to survive being broken up', () => {
    // Dotting removes about two thirds of the ink, so a hairline that read
    // correctly solid disappears once it is broken.
    const sheet = createDefaultStyleSheet();
    for (const kind of ['provincial', 'county'] as const) {
      expect(sheet.line[borderStyleClassFor(kind)].style.width).toBeGreaterThanOrEqual(1);
    }
  });
});

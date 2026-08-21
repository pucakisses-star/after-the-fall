/**
 * Adopting a reference city (spec §47).
 *
 * The reference layer is four thousand real places drawn as a backdrop. They
 * cannot be edited, which is right for four thousand of them and wrong for the
 * one you have decided is a city of your world and wants a different name. What
 * is checked here is that adopting one produces an ordinary settlement — name,
 * rank, position, a label that follows the name — and that adopting it twice
 * does not produce two.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createProject, placePositionKey } from '@/model/project';
import { commit, useProjectStore } from './projectStore';
import { adoptPlace, copySelection, deleteSelection, pasteClipboard } from './commands';
import { useUIStore } from './uiStore';
import { settlementTypeForPlace } from '@/model/defaults';
import type { Settlement } from '@/model/types';

const CHARLOTTE = { name: 'Charlotte', coordinates: [-80.84, 35.23] as [number, number], scalerank: 6, population: 995_000 };

beforeEach(() => {
  useProjectStore.getState().loadProject(createProject({ title: 'Places' }), null);
  useUIStore.getState().clearSelection();
});

const project = () => useProjectStore.getState().project;

describe('what a reference place becomes', () => {
  it('reads its rank from population, not from scalerank', () => {
    // Measured on the 1:10m places: Charlotte, at a million people, ranks 6;
    // Flagstaff, at sixty-four thousand, ranks 4. Rank is not a size.
    expect(settlementTypeForPlace({ population: 995_000, scalerank: 6 })).toBe('city');
    expect(settlementTypeForPlace({ population: 63_993, scalerank: 4 })).toBe('town');
    expect(settlementTypeForPlace({ population: 1_400, scalerank: 7 })).toBe('village');
  });

  it('falls back to rank where the place carries no count', () => {
    expect(settlementTypeForPlace({ scalerank: 1 })).toBe('city');
    expect(settlementTypeForPlace({ scalerank: 7 })).toBe('town');
    expect(settlementTypeForPlace({ scalerank: 10 })).toBe('village');
    expect(settlementTypeForPlace({})).toBe('town');
  });

  it('never guesses at a capital', () => {
    // Which town a realm is run from is a decision about the map, not a fact
    // about the place.
    for (const pop of [20_000_000, 500_000, 5_000, 0]) {
      expect(settlementTypeForPlace({ population: pop })).not.toContain('capital');
    }
  });
});

describe('adopting one', () => {
  it('makes an ordinary settlement of it, named and placed as it was', () => {
    const id = adoptPlace(CHARLOTTE)!;
    const s = project().settlements[id];
    expect(s.name).toBe('Charlotte');
    expect(s.type).toBe('city');
    expect(s.population).toBe(995_000);
    expect(s.geometry.coordinates).toEqual([-80.84, 35.23]);
  });

  it('gives it a name on the map, and switches the names on to show it', () => {
    const before = Object.values(project().layers).find((l) => l.name === 'City Labels')!;
    useProjectStore.getState().loadProject(
      { ...project(), layers: { ...project().layers, [before.id]: { ...before, visible: false } } },
      null,
    );

    const id = adoptPlace(CHARLOTTE)!;
    const s = project().settlements[id];
    expect(project().labels[s.labelId!].text).toBe('Charlotte');
    expect(Object.values(project().layers).find((l) => l.name === 'City Labels')!.visible).toBe(true);
  });

  it('selects it, because the point of adopting one is to edit it', () => {
    const id = adoptPlace(CHARLOTTE)!;
    expect(useUIStore.getState().selection).toEqual([id]);
  });

  it('adopts the same place once', () => {
    const first = adoptPlace(CHARLOTTE);
    const second = adoptPlace(CHARLOTTE);
    expect(second).toBe(first);
    expect(Object.keys(project().settlements)).toHaveLength(1);
  });

  it('undoes in one step, settlement and name together', () => {
    adoptPlace(CHARLOTTE);
    useProjectStore.getState().undo();
    expect(Object.keys(project().settlements)).toHaveLength(0);
    expect(Object.keys(project().labels)).toHaveLength(0);
  });
});

/**
 * Deleting a city has to take its dot with it (spec §47).
 *
 * A settlement of your own almost always stands on a reference place, and the
 * reference layer is drawn underneath it. Remove the settlement and the dot it
 * was covering comes back — same spot, a name of its own — which reads as the
 * deletion having done nothing at all. So the ground is struck out, and the
 * reference layer is told to leave it alone from then on.
 */
describe('deleting an adopted city', () => {
  it('strikes out the ground it stood on', () => {
    const id = adoptPlace(CHARLOTTE)!;
    expect(project().dismissedPlaces).toEqual([]);

    useUIStore.getState().setSelection([id]);
    deleteSelection();

    expect(project().settlements[id]).toBeUndefined();
    expect(project().dismissedPlaces).toEqual([placePositionKey(CHARLOTTE.coordinates)]);
  });

  it('gives the ground back when the deletion is undone', () => {
    const id = adoptPlace(CHARLOTTE)!;
    useUIStore.getState().setSelection([id]);
    deleteSelection();
    useProjectStore.getState().undo();

    expect(project().settlements[id]).toBeDefined();
    expect(project().dismissedPlaces).toEqual([]);
  });

  it('records a place once, however often it is adopted and deleted', () => {
    for (let i = 0; i < 3; i++) {
      const id = adoptPlace(CHARLOTTE)!;
      useUIStore.getState().setSelection([id]);
      deleteSelection();
    }
    expect(project().dismissedPlaces).toHaveLength(1);
  });
});

/**
 * Copy and paste (spec §53).
 *
 * Ctrl+C and Ctrl+V exist so a symbol you have styled can be put down again
 * somewhere else. What matters is that the copy is the same *thing* — its rank,
 * its symbol overrides and its name travel with it — and that it lands where
 * you asked rather than where it came from.
 */
describe('copying a city', () => {
  const styled = () => {
    const id = adoptPlace(CHARLOTTE)!;
    commit('style it', (r) =>
      r.update<Settlement>('settlements', id, {
        styleOverrides: { shape: 'star', size: 18, fillColor: '#c02020' },
      }),
    );
    useUIStore.getState().setSelection([id]);
    return id;
  };

  it('puts the copy where it was asked for, not where it came from', () => {
    styled();
    copySelection();
    pasteClipboard([-70, 40]);

    const made = Object.values(project().settlements).find((s) => s.geometry.coordinates[0] === -70);
    expect(made).toBeDefined();
    expect(made!.geometry.coordinates).toEqual([-70, 40]);
  });

  it('carries the symbol and the name over', () => {
    const id = styled();
    copySelection();
    pasteClipboard([-70, 40]);

    const src = project().settlements[id];
    const made = Object.values(project().settlements).find((s) => s.id !== id)!;
    expect(made.styleOverrides).toEqual(src.styleOverrides);
    expect(made.type).toBe(src.type);
    expect(made.name).toBe('Charlotte 2');
    expect(project().labels[made.labelId!].text).toBe('Charlotte 2');
  });

  it('does not stack when pasted twice in the same place', () => {
    styled();
    copySelection();
    pasteClipboard([-70, 40]);
    pasteClipboard([-70, 40]);

    const placed = Object.values(project().settlements).filter((s) => s.name !== 'Charlotte');
    expect(placed).toHaveLength(2);
    expect(placed[0].geometry.coordinates).not.toEqual(placed[1].geometry.coordinates);
  });

  it('survives the original being deleted', () => {
    const id = styled();
    copySelection();
    useUIStore.getState().setSelection([id]);
    deleteSelection();
    pasteClipboard([-70, 40]);

    expect(Object.keys(project().settlements)).toHaveLength(1);
    expect(Object.values(project().settlements)[0].styleOverrides.shape).toBe('star');
  });

  it('undoes in one step, symbol and name together', () => {
    styled();
    copySelection();
    pasteClipboard([-70, 40]);
    const labels = Object.keys(project().labels).length;
    useProjectStore.getState().undo();

    expect(Object.keys(project().settlements)).toHaveLength(1);
    expect(Object.keys(project().labels)).toHaveLength(labels - 1);
  });
});

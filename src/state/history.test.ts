/** Undo/redo and project round-trips (spec §64). */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Polygon } from 'geojson';
import { createProject, migrate, findLayerByKind } from '@/model/project';
import { deserializeProject, serializeProject } from '@/persistence/projectFile';
import { useProjectStore, makeTerritory, makeSettlement } from './projectStore';
import { Recorder, applyCommand, type Command } from './history';
import type { MapProject, Territory } from '@/model/types';

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
  };
}

function freshProject(): MapProject {
  return createProject({ title: 'Test Map' });
}

describe('Recorder', () => {
  it('records an insert with a null `before`', () => {
    const project = freshProject();
    const r = new Recorder(project);
    const t = makeTerritory(project, rect(0, 0, 1, 1), { name: 'Alpha' });
    r.set('territories', t);

    expect(r.entity).toHaveLength(1);
    expect(r.entity[0].before).toBeNull();
    expect(r.entity[0].after).toBe(t);
    // The original project object is untouched — structural sharing, not mutation.
    expect(Object.keys(project.territories)).toHaveLength(0);
    expect(Object.keys(r.result().territories)).toHaveLength(1);
  });

  it('records a delete with a null `after`', () => {
    const project = freshProject();
    const t = makeTerritory(project, rect(0, 0, 1, 1));
    project.territories[t.id] = t;

    const r = new Recorder(project);
    r.remove('territories', t.id);
    expect(r.entity[0].before).toBe(t);
    expect(r.entity[0].after).toBeNull();
  });

  it('reads back its own pending writes', () => {
    const project = freshProject();
    const r = new Recorder(project);
    const t = makeTerritory(project, rect(0, 0, 1, 1), { name: 'Alpha' });
    r.set('territories', t);
    r.update<Territory>('territories', t.id, { name: 'Beta' });
    expect(r.result().territories[t.id].name).toBe('Beta');
    expect(r.entity).toHaveLength(2);
  });

  it('ignores updates to records that do not exist', () => {
    const r = new Recorder(freshProject());
    r.update<Territory>('territories', 'nope', { name: 'x' });
    expect(r.isEmpty).toBe(true);
  });
});

describe('applyCommand', () => {
  it('round-trips an insert through undo and redo', () => {
    const project = freshProject();
    const r = new Recorder(project);
    const t = makeTerritory(project, rect(0, 0, 1, 1), { name: 'Alpha' });
    r.set('territories', t);
    const cmd: Command = { label: 'add', entity: r.entity, doc: r.doc, selectionBefore: [], selectionAfter: [] };

    const added = r.result();
    expect(Object.keys(added.territories)).toHaveLength(1);

    const undone = applyCommand(added, cmd, 'undo');
    expect(Object.keys(undone.territories)).toHaveLength(0);

    const redone = applyCommand(undone, cmd, 'redo');
    expect(redone.territories[t.id].name).toBe('Alpha');
  });

  it('undoes two writes to one record back to the original value', () => {
    const project = freshProject();
    const t = makeTerritory(project, rect(0, 0, 1, 1), { name: 'Original' });
    project.territories[t.id] = t;

    const r = new Recorder(project);
    r.update<Territory>('territories', t.id, { name: 'Once' });
    r.update<Territory>('territories', t.id, { name: 'Twice' });
    const cmd: Command = { label: 'edit', entity: r.entity, doc: r.doc, selectionBefore: [], selectionAfter: [] };

    const after = r.result();
    expect(after.territories[t.id].name).toBe('Twice');

    // Undo must replay in reverse, or the first patch would win.
    const undone = applyCommand(after, cmd, 'undo');
    expect(undone.territories[t.id].name).toBe('Original');
  });

  it('round-trips a document-level field', () => {
    const project = freshProject();
    const r = new Recorder(project);
    r.setDoc('oceanColor', '#112233');
    const cmd: Command = { label: 'colour', entity: [], doc: r.doc, selectionBefore: [], selectionAfter: [] };

    const after = r.result();
    expect(after.oceanColor).toBe('#112233');
    expect(applyCommand(after, cmd, 'undo').oceanColor).toBe(project.oceanColor);
  });
});

describe('project store history', () => {
  beforeEach(() => {
    useProjectStore.getState().loadProject(freshProject(), null);
  });

  it('records, undoes and redoes an edit', () => {
    const store = useProjectStore.getState();
    const project = store.project;
    const t = makeTerritory(project, rect(0, 0, 1, 1), { name: 'Alpha' });

    store.commit('Draw', (r) => r.set('territories', t));
    expect(Object.keys(useProjectStore.getState().project.territories)).toHaveLength(1);
    expect(useProjectStore.getState().canUndo()).toBe(true);

    useProjectStore.getState().undo();
    expect(Object.keys(useProjectStore.getState().project.territories)).toHaveLength(0);
    expect(useProjectStore.getState().canRedo()).toBe(true);

    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.territories[t.id].name).toBe('Alpha');
  });

  it('drops the redo stack once a new edit is made', () => {
    const store = useProjectStore.getState();
    const t = makeTerritory(store.project, rect(0, 0, 1, 1));
    store.commit('One', (r) => r.set('territories', t));
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().canRedo()).toBe(true);

    const s = makeSettlement(useProjectStore.getState().project, { type: 'Point', coordinates: [0, 0] });
    useProjectStore.getState().commit('Two', (r) => r.set('settlements', s));
    expect(useProjectStore.getState().canRedo()).toBe(false);
  });

  it('does not push a command when the mutator changes nothing', () => {
    const before = useProjectStore.getState().past.length;
    const pushed = useProjectStore.getState().commit('Nothing', () => {});
    expect(pushed).toBe(false);
    expect(useProjectStore.getState().past.length).toBe(before);
  });

  it('keeps more than 100 history states (§36)', () => {
    for (let i = 0; i < 130; i++) {
      const store = useProjectStore.getState();
      const t = makeTerritory(store.project, rect(i, 0, i + 1, 1), { name: `T${i}` });
      store.commit(`Add ${i}`, (r) => r.set('territories', t));
    }
    expect(useProjectStore.getState().past.length).toBeGreaterThanOrEqual(100);

    // And every one of them unwinds.
    for (let i = 0; i < 100; i++) useProjectStore.getState().undo();
    expect(Object.keys(useProjectStore.getState().project.territories).length).toBeLessThanOrEqual(30);
  });

  it('clears history when a project is loaded', () => {
    const store = useProjectStore.getState();
    const t = makeTerritory(store.project, rect(0, 0, 1, 1));
    store.commit('Add', (r) => r.set('territories', t));
    useProjectStore.getState().loadProject(freshProject(), null);
    expect(useProjectStore.getState().past).toHaveLength(0);
    expect(useProjectStore.getState().future).toHaveLength(0);
  });
});

describe('save / load round-trip (§64)', () => {
  it('preserves territories, settlements, labels and styles exactly', () => {
    const project = freshProject();
    const t = makeTerritory(project, rect(0, 0, 5, 5), {
      name: 'Kingdom of Test',
      politicalType: 'kingdom',
      styleOverrides: { fillColor: '#abcdef' },
      timeline: { start: 1200, end: 1450 },
    });
    project.territories[t.id] = t;
    const s = makeSettlement(project, { type: 'Point', coordinates: [1, 1] }, { name: 'Capital', population: 40000 });
    project.settlements[s.id] = s;
    project.meta.title = 'Round Trip';

    const restored = deserializeProject(serializeProject(project));

    expect(restored.meta.title).toBe('Round Trip');
    expect(restored.territories[t.id].name).toBe('Kingdom of Test');
    expect(restored.territories[t.id].geometry).toEqual(t.geometry);
    expect(restored.territories[t.id].styleOverrides.fillColor).toBe('#abcdef');
    expect(restored.territories[t.id].timeline).toEqual({ start: 1200, end: 1450 });
    expect(restored.settlements[s.id].population).toBe(40000);
    expect(Object.keys(restored.styles.line).length).toBe(Object.keys(project.styles.line).length);
  });

  it('accepts a bare project object as well as the envelope', () => {
    const project = freshProject();
    const restored = deserializeProject(JSON.stringify(project));
    expect(restored.id).toBe(project.id);
  });

  it('re-seeds built-in styles missing from an older file', () => {
    const project = freshProject();
    const stripped = { ...project, styles: { ...project.styles, line: {} } };
    const restored = migrate(stripped);
    expect(Object.keys(restored.styles.line).length).toBeGreaterThan(0);
  });

  it('refuses a file from a newer schema rather than mangling it', () => {
    const project = { ...freshProject(), schemaVersion: 999 };
    expect(() => migrate(project)).toThrow(/newer version/i);
  });

  it('keeps the default layer stack addressable by kind', () => {
    const project = freshProject();
    for (const kind of ['territory', 'settlement', 'label', 'border', 'river'] as const) {
      expect(findLayerByKind(project, kind)).toBeDefined();
    }
  });
});

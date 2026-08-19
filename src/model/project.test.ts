/** Project scaffolding and schema migration (spec §49, §64). */

import { describe, expect, it } from 'vitest';
import { createProject, migrate, SCHEMA_VERSION } from './project';

describe('createProject', () => {
  it('honours the requested projection preset', () => {
    const p = createProject({ title: 'Americas', projectionId: 'ATF:AMERICAS' });
    expect(p.projection.id).toBe('ATF:AMERICAS');
    expect(p.projection.proj4).toContain('laea');
  });

  it('falls back to the default projection for an unknown id', () => {
    const p = createProject({ projectionId: 'NOT:A:PRESET' });
    expect(p.projection.id).toBe(createProject().projection.id);
  });

  it('starts on the detailed reference geography only', () => {
    for (const entry of createProject().basemap) {
      expect(entry.sourceId).not.toMatch(/-(110|50)m$/);
    }
  });

  it('names every realm at every zoom to begin with', () => {
    // A name that disappears while you are drawing reads as a name that was
    // lost, so a new map shows all of them and the author thins them by choice.
    expect(createProject().nameEverything).toBe(true);
  });
});

describe('migrate', () => {
  it('repoints a project saved against the coarse editions at the detailed ones', () => {
    const old = {
      ...createProject(),
      schemaVersion: 0,
      basemap: [
        { sourceId: 'world-land-110m', visible: true, opacity: 1 },
        { sourceId: 'world-lakes-50m', visible: true, opacity: 0.5 },
        { sourceId: 'us-states', visible: false, opacity: 1 },
      ],
    };
    const p = migrate(old);
    expect(p.basemap.map((b) => b.sourceId)).toEqual(['world-land-10m', 'world-lakes-10m', 'us-states']);
    // Everything else about the entry survives the repointing.
    expect(p.basemap[1].opacity).toBe(0.5);
    expect(p.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('collapses two editions of the same geography into one layer', () => {
    const old = {
      ...createProject(),
      schemaVersion: 0,
      basemap: [
        { sourceId: 'world-land-110m', visible: true, opacity: 1 },
        { sourceId: 'world-land-50m', visible: true, opacity: 1 },
        { sourceId: 'world-land-10m', visible: true, opacity: 1 },
      ],
    };
    expect(migrate(old).basemap).toHaveLength(1);
  });

  it('opens a file saved before the switch existed with names showing', () => {
    const old = { ...createProject(), schemaVersion: 0 } as Record<string, unknown>;
    delete old.nameEverything;
    expect(migrate(old).nameEverything).toBe(true);
  });

  it('keeps the thinning on a file that asked for it', () => {
    expect(migrate({ ...createProject(), schemaVersion: 0, nameEverything: false }).nameEverything).toBe(false);
  });

  it('refuses a file from a newer build rather than mangling it', () => {
    expect(() => migrate({ ...createProject(), schemaVersion: SCHEMA_VERSION + 1 })).toThrow(/newer version/);
  });
});

/**
 * Project settings: metadata, projection, water/land colours, reference geography
 * and the reference image (spec §4, §17, §25, §32).
 */

import { useRef, useState } from 'react';
import { commit, useProjectStore } from '@/state/projectStore';
import { toast, useUIStore } from '@/state/uiStore';
import { PROJECTION_PRESETS, registerCustomProjection } from '@/geo/projections';
import { BASEMAP_SIZES, BUILTIN_BASEMAPS, allBasemapSources } from '@/geo/basemap';
import { referenceImageForView, registerImportedBasemap } from '@/io/importers';
import { useMapController } from './MapContext';
import { Field, Section, Slider } from './Inspector';
import type { BasemapLayerState, MapProject } from '@/model/types';

export function ProjectPanel() {
  const project = useProjectStore((s) => s.project);
  const controller = useMapController();
  const setDialog = useUIStore((s) => s.setDialog);

  const setMeta = (changes: Partial<MapProject['meta']>) =>
    commit('Edit project details', (r) => r.setDoc('meta', { ...project.meta, ...changes }));

  return (
    <>
      <Section title="Map">
        <Field label="Title">
          <input className="input" value={project.meta.title} onChange={(e) => setMeta({ title: e.target.value })} />
        </Field>
        <Field label="Subtitle">
          <input className="input" value={project.meta.subtitle} onChange={(e) => setMeta({ subtitle: e.target.value })} />
        </Field>
        <Field label="Date line">
          <input
            className="input"
            placeholder="In the Year 1453"
            value={project.meta.dateLine}
            onChange={(e) => setMeta({ dateLine: e.target.value })}
          />
        </Field>
        <Field label="Author">
          <input className="input" value={project.meta.author} onChange={(e) => setMeta({ author: e.target.value })} />
        </Field>
      </Section>

      <Section title="Projection">
        <Field label="Projection">
          <select
            className="select"
            value={project.projection.id}
            onChange={(e) => {
              const preset = PROJECTION_PRESETS.find((p) => p.id === e.target.value);
              if (!preset) return;
              commit('Change projection', (r) =>
                r.setDoc('projection', {
                  id: preset.id,
                  name: preset.name,
                  proj4: preset.proj4,
                  extent: preset.extent,
                  units: preset.units,
                }),
              );
            }}
          >
            {PROJECTION_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {!PROJECTION_PRESETS.some((p) => p.id === project.projection.id) && (
              <option value={project.projection.id}>{project.projection.name} (custom)</option>
            )}
          </select>
        </Field>
        <p className="hint" style={{ marginTop: 2 }}>
          {PROJECTION_PRESETS.find((p) => p.id === project.projection.id)?.description ??
            'Custom proj4 definition.'}
        </p>
        <CustomProjection />
      </Section>

      <Section title="Water & land">
        <Field label="Ocean">
          <input
            className="color-input"
            type="color"
            value={project.oceanColor.slice(0, 7)}
            onChange={(e) => commit('Ocean colour', (r) => r.setDoc('oceanColor', e.target.value))}
          />
        </Field>
        <Field label="Land">
          <input
            className="color-input"
            type="color"
            value={project.landColor.slice(0, 7)}
            onChange={(e) => commit('Land colour', (r) => r.setDoc('landColor', e.target.value))}
          />
        </Field>
        <p className="hint">The ocean colour fills the map background and the exported page.</p>
      </Section>

      <BasemapSection />
      <ReferenceImageSection />

      <Section title="Topology">
        <button className="btn btn--full" onClick={() => setDialog('topology')}>
          Check & Repair Territory Topology…
        </button>
        <p className="hint">Finds gaps, overlaps and slivers between adjacent territories.</p>
      </Section>

      <Section title="Data">
        <div className="btn-row">
          <button className="btn" onClick={() => setDialog('data-table')}>
            Data table
          </button>
          <button className="btn" onClick={() => setDialog('palette')}>
            Recolour map
          </button>
        </div>
        <p className="hint">
          {Object.keys(project.territories).length} territories ·{' '}
          {Object.keys(project.settlements).length} settlements ·{' '}
          {Object.keys(project.labels).length} labels ·{' '}
          {Object.keys(project.linearFeatures).length} lines
        </p>
        <button
          className="btn btn--full"
          style={{ marginTop: 6 }}
          onClick={() => controller?.fitAll()}
        >
          Fit map to contents
        </button>
      </Section>
    </>
  );
}

function CustomProjection() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [def, setDef] = useState('+proj=lcc +lat_1=33 +lat_2=45 +lat_0=39 +lon_0=-96 +units=m +no_defs');

  if (!open) {
    return (
      <button className="btn btn--full" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
        Add custom proj4 definition…
      </button>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My projection" />
      </Field>
      <textarea className="textarea mono" value={def} onChange={(e) => setDef(e.target.value)} />
      <div className="btn-row" style={{ marginTop: 5 }}>
        <button
          className="btn btn--accent"
          disabled={!name.trim() || !def.trim()}
          onClick={() => {
            try {
              const settings = registerCustomProjection(name.trim(), def.trim());
              commit('Add custom projection', (r) => r.setDoc('projection', settings));
              toast(`Switched to "${settings.name}".`, 'success');
              setOpen(false);
            } catch (err) {
              toast(`Invalid proj4 definition: ${(err as Error).message}`, 'error');
            }
          }}
        >
          Use it
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BasemapSection() {
  const project = useProjectStore((s) => s.project);
  const setDialog = useUIStore((s) => s.setDialog);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sources = allBasemapSources();

  const setBasemap = (next: BasemapLayerState[]) =>
    commit('Change reference geography', (r) => r.setDoc('basemap', next));

  const toggle = (sourceId: string, visible: boolean) => {
    const existing = project.basemap.find((b) => b.sourceId === sourceId);
    const next = existing
      ? project.basemap.map((b) => (b.sourceId === sourceId ? { ...b, visible } : b))
      : [...project.basemap, { sourceId, visible, opacity: 1 }];
    setBasemap(next);
  };

  return (
    <Section title="Reference geography">
      {sources.map((s) => {
        const state = project.basemap.find((b) => b.sourceId === s.id);
        return (
          <label key={s.id} className="checkbox">
            <input type="checkbox" checked={state?.visible ?? false} onChange={(e) => toggle(s.id, e.target.checked)} />
            <span style={{ flex: 1 }}>{s.name}</span>
            {BASEMAP_SIZES[s.id] && (
              <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{BASEMAP_SIZES[s.id]}</span>
            )}
          </label>
        );
      })}
      <input
        ref={fileRef}
        type="file"
        accept=".json,.geojson,.topojson"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            const id = registerImportedBasemap(file.name, await file.text());
            toggle(id, true);
            toast(`Added "${file.name}" as reference geography.`, 'success');
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        }}
      />
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Add file…
        </button>
        <button className="btn btn--accent" onClick={() => setDialog('basemap')}>
          Convert to territories…
        </button>
      </div>
      <p className="hint">
        Reference geography is a tracing aid and is not part of the document. Convert it to make it
        editable — {BUILTIN_BASEMAPS.length} datasets ship with the app, fetched only when switched on.
        Pick the scale that matches your zoom: 1:110m for a world map, 1:10m for a region.
      </p>
    </Section>
  );
}

function ReferenceImageSection() {
  const controller = useMapController();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [opacity, setOpacity] = useState(0.6);
  const [placed, setPlaced] = useState(false);

  return (
    <Section title="Reference image">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file || !controller) return;
          try {
            const view = controller.map.getView();
            const extent = view.calculateExtent(controller.map.getSize());
            const a = controller.toLonLat([extent[0], extent[1]]);
            const b = controller.toLonLat([extent[2], extent[3]]);
            const state = await referenceImageForView(file, [a[0], a[1], b[0], b[1]]);
            controller.setReferenceImage(state.url, state.extent, opacity);
            setPlaced(true);
            toast('Reference image placed. Trace over it, then hide it before exporting.', 'success');
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        }}
      />
      <div className="btn-row">
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Place image…
        </button>
        <button
          className="btn"
          disabled={!placed}
          onClick={() => {
            controller?.setReferenceImage(null, null);
            setPlaced(false);
          }}
        >
          Remove
        </button>
      </div>
      <Field label="Opacity">
        <Slider
          value={opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => {
            setOpacity(v);
            controller?.setReferenceOpacity(v);
          }}
        />
      </Field>
      <p className="hint">
        The image is placed to fill the current view. Zoom and re-place to reposition it. It is a
        session aid and is not saved into the project file.
      </p>
    </Section>
  );
}

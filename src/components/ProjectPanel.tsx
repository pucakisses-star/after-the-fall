/**
 * Project settings: metadata, projection, water/land colours, reference geography
 * and the reference image (spec §4, §17, §25, §32).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { commit, useProjectStore } from '@/state/projectStore';
import { toast, useUIStore } from '@/state/uiStore';
import { PROJECTION_PRESETS, registerCustomProjection } from '@/geo/projections';
import { BASEMAP_SIZES, BUILTIN_BASEMAPS, allBasemapSources } from '@/geo/basemap';
import { POLITICAL_COHESION } from '@/model/defaults';
import { referenceImageForView, registerImportedBasemap } from '@/io/importers';
import { MAX_FACTOR, MIN_FACTOR } from '@/render/referenceImage';
import { deriveLegendEntries } from '@/export/legend';
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

      <Section title="Names">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={project.nameEverything}
            onChange={(e) =>
              commit(e.target.checked ? 'Name everything' : 'Thin names by scale', (r) =>
                r.setDoc('nameEverything', e.target.checked),
              )
            }
          />
          Name every realm at every zoom
        </label>
        <p className="hint">
          {project.nameEverything
            ? 'Every realm keeps its name however far out you zoom, overlaps and all, and however small the zoom draws it — and the same on an exported plate.'
            : 'Names thin out as you zoom away, the way an atlas does it: a realm is named on the plate that shows it, and what is inside it waits for a closer one.'}
        </p>
      </Section>

      {/*
        One control over the whole plate, because "how unified should realms
        look" is a decision about the map, not about any one territory. It scales
        the variation each constitutional status already asks for, so vassals
        stay further from their realm's colour than ordinary members do at every
        setting (spec §18).
      */}
      <Section title="Political cohesion">
        <Field label="Members">
          <select
            className="select"
            value={project.politicalCohesion}
            onChange={(e) =>
              commit('Political cohesion', (r) => r.setDoc('politicalCohesion', e.target.value as MapProject['politicalCohesion']))
            }
          >
            {POLITICAL_COHESION.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="hint">
          {POLITICAL_COHESION.find((c) => c.value === project.politicalCohesion)?.hint}{' '}
          Applies to every territory tinted from its parent; a realm that sets its own colour is
          unaffected.
        </p>
      </Section>

      <MapAreaSection />
      <LegendSection />
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

/**
 * The legend and compass rose (§26, §28).
 *
 * The rows are derived from the map's own content while "keep in step" is on.
 * Renaming, hiding or reordering a row switches that off and freezes the
 * arrangement, because at that point the user's ordering is the thing worth
 * preserving — and "Rebuild from the map" puts it back.
 */
function LegendSection() {
  const project = useProjectStore((s) => s.project);
  const legend = project.legend;
  const compass = project.compass;
  const rows = useMemo(
    () => (legend.auto || legend.entries.length === 0 ? deriveLegendEntries(project) : legend.entries),
    [project, legend],
  );

  const setLegend = (changes: Partial<typeof legend>, label = 'Edit legend') =>
    commit(label, (r) => r.setDoc('legend', { ...legend, ...changes }));
  const setCompass = (changes: Partial<typeof compass>) =>
    commit('Edit compass', (r) => r.setDoc('compass', { ...compass, ...changes }));

  /** Any edit to a row takes the rows out of automatic mode, arrangement and all. */
  const editRows = (next: typeof rows, label: string) =>
    setLegend({ auto: false, entries: next }, label);

  const move = (index: number, by: number) => {
    const next = [...rows];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    editRows(next, 'Reorder legend');
  };

  return (
    <Section title="Legend & compass">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={legend.enabled}
          onChange={(e) => setLegend({ enabled: e.target.checked })}
        />
        Show a legend
      </label>
      {legend.enabled && (
        <>
          <Field label="Heading">
            <input className="input" value={legend.title} onChange={(e) => setLegend({ title: e.target.value })} />
          </Field>
          <Field label="Corner">
            <select
              className="select"
              value={legend.position}
              onChange={(e) => setLegend({ position: e.target.value as typeof legend.position })}
            >
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-right">Bottom right</option>
              <option value="top-left">Top left</option>
              <option value="top-right">Top right</option>
            </select>
          </Field>
          <div
            style={{ border: '1px solid var(--line)', borderRadius: 3, maxHeight: 190, overflow: 'auto', marginTop: 6 }}
          >
            {rows.length === 0 && <div className="empty">Nothing to list yet.</div>}
            {rows.map((row, i) => (
              <div key={row.id} className="tree-row" style={{ paddingLeft: 7, gap: 4 }}>
                <input
                  type="checkbox"
                  checked={!row.hidden}
                  title="Include this row"
                  onChange={(e) =>
                    editRows(
                      rows.map((r) => (r.id === row.id ? { ...r, hidden: !e.target.checked } : r)),
                      'Show or hide legend row',
                    )
                  }
                  style={{ accentColor: 'var(--accent)' }}
                />
                <input
                  className="input"
                  value={row.text}
                  style={{ flex: 1, minWidth: 0 }}
                  onChange={(e) =>
                    editRows(
                      rows.map((r) => (r.id === row.id ? { ...r, text: e.target.value } : r)),
                      'Rename legend row',
                    )
                  }
                />
                <button className="btn btn--icon" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  className="btn btn--icon"
                  title="Move down"
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 5 }}>
            <button
              className="btn"
              disabled={legend.auto}
              onClick={() => setLegend({ auto: true, entries: [] }, 'Rebuild legend')}
            >
              Rebuild from the map
            </button>
          </div>
          <p className="hint">
            {legend.auto
              ? 'Rows follow the map: add a fortress or a disputed border and the key gains it. Editing a row takes over from here.'
              : 'Rows are yours now — the map no longer adds or removes them.'}{' '}
            Every swatch is drawn from the style class it names, so restyling the map restyles the key.
          </p>
        </>
      )}

      <label className="checkbox" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={compass.enabled}
          onChange={(e) => setCompass({ enabled: e.target.checked })}
        />
        Show a compass rose
      </label>
      {compass.enabled && (
        <>
          <Field label="Style">
            <select
              className="select"
              value={compass.style}
              onChange={(e) => setCompass({ style: e.target.value as typeof compass.style })}
            >
              <option value="star">Four-point star</option>
              <option value="rose">Full rose</option>
              <option value="arrow">Plain north arrow</option>
            </select>
          </Field>
          <Field label="Corner">
            <select
              className="select"
              value={compass.position}
              onChange={(e) => setCompass({ position: e.target.value as typeof compass.position })}
            >
              <option value="top-right">Top right</option>
              <option value="top-left">Top left</option>
              <option value="bottom-right">Bottom right</option>
              <option value="bottom-left">Bottom left</option>
            </select>
          </Field>
          <Field label="Size">
            <Slider
              min={24}
              max={120}
              step={2}
              value={compass.size}
              suffix="px"
              onChange={(v) => setCompass({ size: v })}
            />
          </Field>
        </>
      )}
      <p className="hint">
        Both are drawn into the exported map — switch them on under Export SVG or Export PNG.
      </p>
    </Section>
  );
}

/** Formats a WGS84 bound the way an atlas index would: 74°W, 42°N. */
function bearing(value: number, axis: 'lon' | 'lat'): string {
  const suffix = axis === 'lon' ? (value < 0 ? 'W' : 'E') : value < 0 ? 'S' : 'N';
  return `${Math.abs(value).toFixed(0)}°${suffix}`;
}

/**
 * The area of the world the map is about (§4).
 *
 * Cropping is not cosmetic: reference geography outside the box is never
 * projected or drawn, and the view cannot pan or zoom past it, so a regional map
 * both draws faster and stops behaving like a window onto the whole globe.
 */
function MapAreaSection() {
  const project = useProjectStore((s) => s.project);
  const controller = useMapController();
  const extent = project.workingExtent;

  const setExtent = (next: [number, number, number, number] | null, label: string) =>
    commit(label, (r) => r.setDoc('workingExtent', next));

  return (
    <Section title="Map area">
      <p className="hint" style={{ marginTop: 0 }}>
        {extent
          ? `Cropped to ${bearing(extent[0], 'lon')}–${bearing(extent[2], 'lon')}, ` +
            `${bearing(extent[1], 'lat')}–${bearing(extent[3], 'lat')}.`
          : 'The whole world. Reference geography is loaded and drawn everywhere.'}
      </p>
      <div className="btn-row">
        <button
          className="btn"
          onClick={() => {
            const visible = controller?.visibleExtentLonLat();
            if (!visible) {
              toast('Could not read the current view.', 'error');
              return;
            }
            // A margin, not the exact box: cropping to precisely what is on
            // screen leaves a map that cannot be panned at all, so the first
            // thing you would want to do is undo it.
            const padX = (visible[2] - visible[0]) * 0.08;
            const padY = (visible[3] - visible[1]) * 0.08;
            setExtent(
              [
                Math.max(-180, visible[0] - padX),
                Math.max(-90, visible[1] - padY),
                Math.min(180, visible[2] + padX),
                Math.min(90, visible[3] + padY),
              ],
              'Crop map area',
            );
            toast('Cropped the map to the current view.', 'success');
          }}
        >
          Crop to current view
        </button>
        <button
          className="btn"
          disabled={!extent}
          onClick={() => {
            setExtent(null, 'Uncrop map area');
            toast('The map covers the whole world again.', 'success');
          }}
        >
          Whole world
        </button>
      </div>
      <p className="hint">
        Cropping keeps a small margin around what you can see. It bounds the reference data and the
        view, never the document — territories, cities and labels you have drawn outside it stay put,
        stay editable and still export.
      </p>
    </Section>
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
        Everything here is Natural Earth's finest published scale.
      </p>
    </Section>
  );
}

function ReferenceImageSection() {
  const controller = useMapController();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [opacity, setOpacity] = useState(0.6);
  const [placed, setPlaced] = useState(false);
  const [movable, setMovable] = useState(true);
  // The sliders read the controller's placement, so a drag on the map and a
  // slider in the panel are two views of the same thing.
  const [size, setSize] = useState({ scale: 1, stretchX: 1, stretchY: 1 });

  useEffect(() => {
    if (!controller) return;
    return controller.onReferenceChange((p) => {
      setPlaced(!!p);
      if (p) setSize({ scale: p.scale, stretchX: p.stretchX, stretchY: p.stretchY });
    });
  }, [controller]);

  const resize = (change: Partial<typeof size>) => {
    const next = { ...size, ...change };
    setSize(next);
    controller?.setReferenceSize(change);
  };

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
            controller.setReferenceMovable(movable);
            setPlaced(true);
            setSize({ scale: 1, stretchX: 1, stretchY: 1 });
            toast('Reference image placed. Drag it into position, then size it.', 'success');
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
      <label className="checkbox">
        <input
          type="checkbox"
          checked={movable}
          disabled={!placed}
          onChange={(e) => {
            setMovable(e.target.checked);
            controller?.setReferenceMovable(e.target.checked);
          }}
        />
        Drag the image to move it
      </label>
      <p className="hint" style={{ marginTop: -2 }}>
        {movable
          ? 'A drag that starts on the image carries it; anywhere else still pans the map.'
          : 'The image is pinned where it is, and dragging pans the map as usual.'}
      </p>
      <Field label="Size">
        <Slider
          value={size.scale}
          min={MIN_FACTOR}
          max={MAX_FACTOR}
          step={0.05}
          onChange={(v) => resize({ scale: v })}
          suffix="×"
        />
      </Field>
      <Field label="Width">
        <Slider
          value={size.stretchX}
          min={MIN_FACTOR}
          max={MAX_FACTOR}
          step={0.05}
          onChange={(v) => resize({ stretchX: v })}
          suffix="×"
        />
      </Field>
      <Field label="Height">
        <Slider
          value={size.stretchY}
          min={MIN_FACTOR}
          max={MAX_FACTOR}
          step={0.05}
          onChange={(v) => resize({ stretchY: v })}
          suffix="×"
        />
      </Field>
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
      <button
        className="btn btn--full"
        disabled={!placed}
        style={{ marginTop: 4 }}
        onClick={() => resize({ scale: 1, stretchX: 1, stretchY: 1 })}
      >
        Reset to the size it was placed at
      </button>
      <p className="hint">
        The image lands filling the view; drag it into place, then size it — Size scales both ways
        at once, Width and Height stretch one at a time. It is a session aid and is not saved into
        the project file.
      </p>
    </Section>
  );
}

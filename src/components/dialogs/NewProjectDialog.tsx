import { useState } from 'react';
import { Dialog } from '../Dialog';
import { Field } from '../Inspector';
import { PROJECTION_PRESETS } from '@/geo/projections';
import { createProject } from '@/model/project';
import { buildDemoProject } from '@/demo/demoProject';
import { useProjectStore } from '@/state/projectStore';
import { toast, useUIStore } from '@/state/uiStore';
import { writeSnapshot } from '@/persistence/db';

const STARTING_POINTS: { id: string; label: string; description: string; basemaps: string[]; center: [number, number]; zoom: number }[] = [
  {
    id: 'blank',
    label: 'Blank map',
    description: 'Nothing but ocean. Draw or import your own geography.',
    basemaps: [],
    center: [0, 20],
    zoom: 2.4,
  },
  {
    id: 'world',
    label: 'World coastlines',
    description: 'Natural Earth land outlines, lakes and cities as a tracing reference.',
    basemaps: ['world-land-50m', 'world-lakes-50m', 'world-places-50m'],
    center: [0, 20],
    zoom: 2.4,
  },
  {
    id: 'countries',
    label: 'World countries',
    description: 'Land, lakes, cities and modern country boundaries, ready to convert.',
    basemaps: ['world-land-50m', 'world-lakes-50m', 'world-countries-50m', 'world-places-50m'],
    center: [0, 20],
    zoom: 2.4,
  },
  {
    id: 'world-detailed',
    label: 'World — detailed coastlines (1:10m)',
    description:
      'Natural Earth at its finest published scale: coastlines, lakes, rivers and 7,000 cities, ~7× the detail of 1:50m. Around 12 MB, so use it when mapping a region rather than the globe.',
    basemaps: [
      'world-land-10m',
      'world-lakes-10m',
      'world-rivers-10m',
      'world-countries-10m',
      'world-places-10m',
    ],
    center: [0, 20],
    zoom: 2.4,
  },
  {
    id: 'us-states',
    label: 'United States — states',
    description: 'State outlines over real coastline, with lakes, rivers and cities.',
    // Land first, always: a lake is filled with the water colour, so without
    // land beneath it there is nothing for it to be a hole in and the whole map
    // reads as open sea with a few boundary lines drawn on it.
    basemaps: ['world-land-10m', 'us-states', 'world-lakes-10m', 'world-rivers-10m', 'world-places-10m'],
    center: [-96, 39],
    zoom: 4.2,
  },
  {
    id: 'us-counties',
    label: 'United States — counties',
    description: '3,000+ counties, with coastline, lakes, rivers and cities. Use the paint tool to build states from them.',
    basemaps: [
      'world-land-10m',
      'us-states',
      'us-counties',
      'world-lakes-10m',
      'world-rivers-10m',
      'world-places-10m',
    ],
    center: [-96, 39],
    zoom: 4.2,
  },
];

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('Untitled Map');
  const [projectionId, setProjectionId] = useState('ATF:LCC');
  const [start, setStart] = useState('us-states');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const current = useProjectStore.getState().project;
    if (Object.keys(current.territories).length > 0) {
      await writeSnapshot(current, 'pre-load').catch(() => undefined);
    }

    const preset = PROJECTION_PRESETS.find((p) => p.id === projectionId)!;
    const chosen = STARTING_POINTS.find((s) => s.id === start)!;
    const project = createProject({ title });
    project.projection = {
      id: preset.id,
      name: preset.name,
      proj4: preset.proj4,
      extent: preset.extent,
      units: preset.units,
    };
    project.basemap = chosen.basemaps.map((sourceId) => ({ sourceId, visible: true, opacity: 1 }));
    project.view = { center: chosen.center, zoom: chosen.zoom, rotation: 0 };
    useProjectStore.getState().loadProject(project, null);
    onClose();
  };

  const loadDemo = async () => {
    setBusy(true);
    try {
      const { project } = await buildDemoProject();
      useProjectStore.getState().loadProject(project, null);
      toast('Loaded the demonstration map.', 'success');
      onClose();
    } catch (err) {
      toast(`Could not build the demo map: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New map"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={loadDemo} disabled={busy}>
            {busy ? 'Building…' : 'Load demonstration map'}
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--accent" onClick={() => void create()} disabled={busy}>
            Create
          </button>
        </>
      }
    >
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Projection">
        <select className="select" value={projectionId} onChange={(e) => setProjectionId(e.target.value)}>
          {PROJECTION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="hint" style={{ marginBottom: 12 }}>
        {PROJECTION_PRESETS.find((p) => p.id === projectionId)?.description}
      </p>

      <h3 className="panel__section-title">Starting geography</h3>
      {STARTING_POINTS.map((s) => (
        <label
          key={s.id}
          className="checkbox"
          style={{
            alignItems: 'flex-start',
            padding: '6px 8px',
            border: '1px solid var(--line)',
            borderRadius: 3,
            marginBottom: 4,
            background: start === s.id ? 'var(--panel-3)' : 'transparent',
          }}
        >
          <input
            type="radio"
            name="start"
            checked={start === s.id}
            onChange={() => setStart(s.id)}
            style={{ marginTop: 2 }}
          />
          <span>
            <strong style={{ color: 'var(--text)' }}>{s.label}</strong>
            <br />
            <span style={{ color: 'var(--text-faint)' }}>{s.description}</span>
          </span>
        </label>
      ))}
      <p className="hint">
        Reference geography is a backdrop, not part of the document. Turn it into editable
        territories from the Project panel once you have chosen what you need.
      </p>
    </Dialog>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['V', 'Select tool'],
    ['H', 'Pan tool'],
    ['R', 'Territory tool'],
    ['A', 'Edit vertices'],
    ['B', 'Paint territory'],
    ['C', 'Split with a line'],
    ['S', 'Settlement tool'],
    ['T', 'Label (text) tool'],
    ['W', 'River tool'],
    ['D', 'Road tool'],
    ['M', 'Measure'],
    ['Ctrl+Z', 'Undo'],
    ['Ctrl+Shift+Z', 'Redo'],
    ['Ctrl+S', 'Save'],
    ['Ctrl+D', 'Duplicate selection'],
    ['Ctrl+A', 'Select all territories'],
    ['Ctrl+F', 'Search'],
    ['Delete', 'Delete selection'],
    ['Esc', 'Cancel the current operation'],
    ['Shift+drag', 'Box-select'],
    ['Shift+click', 'Add to selection'],
    ['Alt+click', 'Remove a vertex (vertex tool)'],
    ['F', 'Fit map to contents'],
    ['Z', 'Zoom to selection'],
  ];
  const setDialog = useUIStore((s) => s.setDialog);

  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} footer={<button className="btn" onClick={() => setDialog(null)}>Close</button>}>
      <table className="table">
        <tbody>
          {rows.map(([key, what]) => (
            <tr key={key}>
              <td style={{ width: 130 }}>
                <span className="kbd">{key}</span>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

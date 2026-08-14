import { useState } from 'react';
import { Dialog } from '../Dialog';
import { Field } from '../Inspector';
import { PROJECTION_PRESETS } from '@/geo/projections';
import { createProject } from '@/model/project';
import { buildDemoProject } from '@/demo/demoProject';
import { buildAfterTheEndProject } from '@/demo/afterTheEnd';
import { useProjectStore } from '@/state/projectStore';
import { toast, useUIStore } from '@/state/uiStore';
import { writeSnapshot } from '@/persistence/db';

interface StartingPoint {
  id: string;
  label: string;
  description: string;
  basemaps: string[];
  center: [number, number];
  zoom: number;
  /**
   * WGS84 [w, s, e, n] the map is about, for the regional starting points.
   *
   * Reference geography outside it is never loaded into the renderer and the
   * view cannot pan or zoom past it. Clear it under Project → Map area to go
   * global; nothing about it is baked into the document beyond this one field.
   */
  extent?: [number, number, number, number];
}

const STARTING_POINTS: StartingPoint[] = [
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
    basemaps: ['world-land-10m', 'world-lakes-10m', 'world-places-10m'],
    center: [0, 20],
    zoom: 2.4,
  },
  {
    id: 'countries',
    label: 'World countries',
    description: 'Land, lakes, cities and modern country boundaries, ready to convert.',
    basemaps: ['world-land-10m', 'world-lakes-10m', 'world-countries-10m', 'world-places-10m'],
    center: [0, 20],
    zoom: 2.4,
  },
  {
    id: 'americas-detailed',
    label: 'The Americas',
    description:
      'Coastlines, lakes, rivers, boundaries and cities, cropped to the western hemisphere so nothing off-continent is drawn and the view stays on the subject.',
    basemaps: [
      'world-land-10m',
      'world-lakes-10m',
      'world-rivers-10m',
      'world-countries-10m',
      'world-places-10m',
    ],
    center: [-80, 10],
    zoom: 2.8,
    // Cape Horn to the Arctic, Alaska to the eastern seaboard, with enough water
    // either side that the coasts are not flush against the frame.
    extent: [-172, -58, -28, 74],
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
    // The lower 48 plus Alaska, Hawaii and the near neighbours a US map needs
    // to make sense of its own borders.
    extent: [-172, 10, -52, 74],
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
    extent: [-172, 10, -52, 74],
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
    project.workingExtent = chosen.extent ?? null;
    useProjectStore.getState().loadProject(project, null);
    onClose();
  };

  /** Both prebuilt maps come in through the same path; only the builder differs. */
  const loadPrebuilt = async (
    build: () => Promise<{ project: ReturnType<typeof createProject> }>,
    what: string,
  ) => {
    setBusy(true);
    try {
      const { project } = await build();
      useProjectStore.getState().loadProject(project, null);
      toast(`Loaded ${what}.`, 'success');
      onClose();
    } catch (err) {
      toast(`Could not build ${what}: ${(err as Error).message}`, 'error');
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
          <button
            className="btn"
            onClick={() => void loadPrebuilt(buildAfterTheEndProject, 'the After the End map')}
            disabled={busy}
          >
            {busy ? 'Building…' : 'After the End map'}
          </button>
          <button
            className="btn"
            onClick={() => void loadPrebuilt(buildDemoProject, 'the demonstration map')}
            disabled={busy}
          >
            Demo map
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

/** Export dialogs (spec §48). */

import { useMemo, useState } from 'react';
import { Dialog } from '../Dialog';
import { Field } from '../Inspector';
import { useProjectStore } from '@/state/projectStore';
import { toast } from '@/state/uiStore';
import { DEFAULT_SVG_OPTIONS, exportSvg, type SvgExportOptions } from '@/export/svgExport';
import { checkRasterLimits, exportPng } from '@/export/pngExport';
import { downloadBlob, downloadText, safeFilename } from '@/persistence/projectFile';
import { projectToGeoJson } from '@/io/importers';
import { useMapController } from '../MapContext';

type Common = Omit<SvgExportOptions, 'extent'>;

function useDefaults(): { extent: [number, number, number, number]; viewportWidth: number } {
  const controller = useMapController();
  return useMemo(() => {
    if (!controller) return { extent: [-180, -85, 180, 85] as [number, number, number, number], viewportWidth: 1000 };
    const size = controller.map.getSize() ?? [1000, 700];
    const view = controller.map.getView();
    const e = view.calculateExtent(size);
    const a = controller.toLonLat([e[0], e[1]]);
    const b = controller.toLonLat([e[2], e[3]]);
    return {
      extent: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
      viewportWidth: size[0],
    };
    // Deliberately computed once when the dialog opens.
  }, [controller]);
}

interface ExportState extends Common {
  useFullExtent: boolean;
}

function ExportControls({
  state,
  set,
}: {
  state: ExportState;
  set: (patch: Partial<ExportState>) => void;
}) {
  return (
    <>
      <div className="split-2">
        <Field label="Width" compact>
          <input
            className="input input--number"
            type="number"
            min={64}
            value={state.width}
            onChange={(e) => set({ width: Math.max(1, Number(e.target.value)) })}
          />
        </Field>
        <Field label="Height" compact>
          <input
            className="input input--number"
            type="number"
            min={64}
            value={state.height}
            onChange={(e) => set({ height: Math.max(1, Number(e.target.value)) })}
          />
        </Field>
      </div>

      <div className="btn-row" style={{ marginBottom: 10 }}>
        {([
          [1600, 1200],
          [4000, 3000],
          [8000, 6000],
          [12000, 8000],
        ] as [number, number][]).map(([w, h]) => (
          <button key={w} className="btn" onClick={() => set({ width: w, height: h })}>
            {w} × {h}
          </button>
        ))}
      </div>

      <Field label="Detail scale">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            className="range"
            type="range"
            min={0.25}
            max={6}
            step={0.05}
            value={state.styleScale}
            onChange={(e) => set({ styleScale: Number(e.target.value) })}
          />
          <span className="mono" style={{ width: 40, textAlign: 'right' }}>
            {state.styleScale.toFixed(2)}×
          </span>
        </div>
      </Field>
      <p className="hint" style={{ marginTop: 0 }}>
        Multiplies every stroke width and font size. At 1× the map matches the screen; raise it so
        text and borders stay readable on a large print.
      </p>

      <label className="checkbox">
        <input type="checkbox" checked={state.useFullExtent} onChange={(e) => set({ useFullExtent: e.target.checked })} />
        Export everything (rather than the current view)
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={state.background} onChange={(e) => set({ background: e.target.checked })} />
        Ocean background
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={state.includeBasemap} onChange={(e) => set({ includeBasemap: e.target.checked })} />
        Include reference geography
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={state.includeGraticule} onChange={(e) => set({ includeGraticule: e.target.checked })} />
        Latitude / longitude grid
      </label>
      {state.includeGraticule && (
        <Field label="Interval">
          <select
            className="select"
            value={state.graticuleInterval}
            onChange={(e) => set({ graticuleInterval: Number(e.target.value) })}
          >
            {[1, 2, 2.5, 5, 10, 15, 20, 30].map((v) => (
              <option key={v} value={v}>
                {v}°
              </option>
            ))}
          </select>
        </Field>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={state.includeFrame} onChange={(e) => set({ includeFrame: e.target.checked })} />
        Map frame
      </label>
      {state.includeFrame && (
        <>
          <Field label="Frame style">
            <select
              className="select"
              value={state.frameStyle}
              onChange={(e) => set({ frameStyle: e.target.value as SvgExportOptions['frameStyle'] })}
            >
              <option value="simple">Simple rule</option>
              <option value="double">Double rule</option>
              <option value="coordinate-blocks">Alternating coordinate blocks</option>
            </select>
          </Field>
          <Field label="Margin">
            <input
              className="input input--number"
              type="number"
              min={0}
              value={state.margin}
              onChange={(e) => set({ margin: Math.max(0, Number(e.target.value)) })}
            />
          </Field>
        </>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={state.includeTitle} onChange={(e) => set({ includeTitle: e.target.checked })} />
        Title block
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={state.includeScaleBar} onChange={(e) => set({ includeScaleBar: e.target.checked })} />
        Scale bar
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={state.includeLegend} onChange={(e) => set({ includeLegend: e.target.checked })} />
        Legend
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={state.includeCompass} onChange={(e) => set({ includeCompass: e.target.checked })} />
        Compass rose
      </label>
      <p className="hint">
        The legend lists what this map actually contains, and the compass takes its style and corner
        from Project → Legend &amp; compass.
      </p>
    </>
  );
}

function fullExtentOf(project: ReturnType<typeof useProjectStore.getState>['project']): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (coords: number[]) => {
    minX = Math.min(minX, coords[0]);
    maxX = Math.max(maxX, coords[0]);
    minY = Math.min(minY, coords[1]);
    maxY = Math.max(maxY, coords[1]);
  };
  const walk = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === 'number') consider(arr as number[]);
    else for (const v of arr) walk(v);
  };
  for (const t of Object.values(project.territories)) walk(t.geometry.coordinates);
  for (const s of Object.values(project.settlements)) consider(s.geometry.coordinates);
  for (const f of Object.values(project.linearFeatures)) walk(f.geometry.coordinates);
  for (const l of Object.values(project.labels)) consider(l.anchor.coordinates);
  if (!Number.isFinite(minX)) return null;
  // A little breathing room so nothing sits on the frame.
  const padX = Math.max(0.2, (maxX - minX) * 0.04);
  const padY = Math.max(0.2, (maxY - minY) * 0.04);
  return [minX - padX, minY - padY, maxX + padX, maxY + padY];
}

export function ExportSvgDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const { extent, viewportWidth } = useDefaults();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ExportState>({
    ...DEFAULT_SVG_OPTIONS,
    width: 3000,
    height: 2100,
    styleScale: Number((3000 / viewportWidth).toFixed(2)),
    useFullExtent: false,
  });
  const set = (patch: Partial<ExportState>) => setState((s) => ({ ...s, ...patch }));

  const run = async () => {
    setBusy(true);
    try {
      const chosenExtent = state.useFullExtent ? (fullExtentOf(project) ?? extent) : extent;
      const svg = await exportSvg(project, { ...state, extent: chosenExtent });
      downloadText(svg, safeFilename(project.meta.title, '.svg'), 'image/svg+xml');
      toast('SVG exported. Groups are named per layer for Illustrator and Inkscape.', 'success');
      onClose();
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Export SVG"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              downloadText(
                JSON.stringify(projectToGeoJson(), null, 2),
                safeFilename(project.meta.title, '.geojson'),
                'application/geo+json',
              );
              toast('GeoJSON exported.', 'success');
            }}
          >
            Export GeoJSON instead
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--accent" onClick={() => void run()} disabled={busy}>
            {busy ? 'Rendering…' : 'Export SVG'}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Polygons, borders, symbols and hatch patterns stay vector; text stays text. Output is grouped
        as <span className="mono">water · terrain · territories · internal-borders ·
        international-borders · rivers · roads · settlements · labels · graticule · legend · frame</span>.
      </p>
      <ExportControls state={state} set={set} />
    </Dialog>
  );
}

export function ExportPngDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const { extent, viewportWidth } = useDefaults();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dpi, setDpi] = useState(300);
  const [transparent, setTransparent] = useState(false);
  const [state, setState] = useState<ExportState>({
    ...DEFAULT_SVG_OPTIONS,
    width: 4000,
    height: 3000,
    styleScale: Number((4000 / viewportWidth).toFixed(2)),
    useFullExtent: false,
  });
  const set = (patch: Partial<ExportState>) => setState((s) => ({ ...s, ...patch }));

  const limits = checkRasterLimits(state.width, state.height);

  const run = async () => {
    setBusy(true);
    setProgress(0);
    try {
      const chosenExtent = state.useFullExtent ? (fullExtentOf(project) ?? extent) : extent;
      const blob = await exportPng(
        project,
        { ...state, extent: chosenExtent, dpi, transparent },
        setProgress,
      );
      downloadBlob(blob, safeFilename(project.meta.title, '.png'));
      toast('PNG exported.', 'success');
      onClose();
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const inches = (px: number) => (px / dpi).toFixed(1);

  return (
    <Dialog
      title="Export PNG"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1, color: 'var(--text-faint)' }}>
            {busy ? `${Math.round(progress * 100)}%` : ''}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--accent" onClick={() => void run()} disabled={busy || !limits.ok}>
            {busy ? 'Rendering…' : 'Export PNG'}
          </button>
        </>
      }
    >
      <ExportControls state={state} set={set} />
      <Field label="DPI">
        <select className="select" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
          {[72, 150, 200, 300, 600].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
        Transparent background
      </label>
      <p className="hint">
        At {dpi} dpi this prints {inches(state.width)} × {inches(state.height)} inches.
      </p>
      {!limits.ok && (
        <p className="hint" style={{ color: 'var(--danger)' }}>
          {limits.message}
        </p>
      )}
    </Dialog>
  );
}

/** Export dialogs (spec §48). */

import { useMemo, useRef, useState } from 'react';
import { Dialog } from '../Dialog';
import { Field } from '../Inspector';
import { useProjectStore } from '@/state/projectStore';
import { toast } from '@/state/uiStore';
import { DEFAULT_SVG_OPTIONS, exportSvg, type SvgExportOptions } from '@/export/svgExport';
import { checkRasterLimits, exportPng, fitWithinRaster } from '@/export/pngExport';
import {
  DEFAULT_TILE_PX,
  MANY_TILES,
  canWriteFolder,
  exportTiles,
  folderSink,
  planTiles,
  stitchReadme,
} from '@/export/tileExport';
import { metersPerUnit } from '@/render/olStyles';
import { PLATE_BOUNDS, clampToPlate } from '@/export/plateFrame';
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

/**
 * The pixel size that draws `extent` at the scale the screen is drawing it now.
 *
 * The exporter fits the extent into whatever canvas it is given, so asking for
 * the whole map in a 4000 px box says nothing about the scale it comes out at:
 * a continent in 4000 px is an overview, and a county in 4000 px is a street
 * plan. Sizing the canvas from the view's own resolution — projected units per
 * pixel — is what makes the two the same, and the picture is then the one you
 * would be looking at if the window were big enough to hold the whole map.
 *
 * The edges are sampled rather than just the corners because most projections
 * curve the parallels, and the exporter samples them the same way, so the two
 * agree on the box and the image needs no letterboxing.
 */
function sizeAtScreenScale(
  controller: ReturnType<typeof useMapController>,
  extent: [number, number, number, number],
  clampBand = false,
): [number, number] | null {
  const resolution = controller?.map.getView().getResolution();
  if (!controller || !resolution) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const [w0, s0, e0, n0] = extent;
  const steps = 32;
  const consider = (lon: number, lat: number) => {
    const [x, y] = controller.toView([lon, lat]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    consider(w0 + (e0 - w0) * f, s0);
    consider(w0 + (e0 - w0) * f, n0);
    consider(w0, s0 + (n0 - s0) * f);
    consider(e0, s0 + (n0 - s0) * f);
  }
  if (!Number.isFinite(minX)) return null;
  // The exporter cuts the sheet at the band's landmarks, so the size has to be
  // measured against the same cut or the plate arrives with the wrong aspect
  // and the fit quietly letterboxes ground back onto it.
  if (clampBand) {
    ({ minX, minY, maxX, maxY } = clampToPlate({ minX, minY, maxX, maxY }, (lon, lat) => {
      const [x, y] = controller.toView([lon, lat]);
      return [x, y];
    }));
  }
  return [Math.round((maxX - minX) / resolution), Math.round((maxY - minY) / resolution)];
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

/**
 * The extent the whole-map exports frame.
 *
 * Latitude is the band above. Longitude is measured only from what falls
 * *inside* that band, rather than from everything drawn: taking it from the
 * whole document would stretch the sheet out to the longitude of the Aleutians
 * to hold ground the latitude cut has already removed, and print a thousand
 * miles of empty Pacific to do it.
 */
function fullExtentOf(project: ReturnType<typeof useProjectStore.getState>['project']): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (coords: number[]) => {
    const [lon, lat] = coords;
    if (lat < PLATE_BOUNDS.south || lat > PLATE_BOUNDS.north) return;
    minX = Math.min(minX, lon);
    maxX = Math.max(maxX, lon);
    minY = Math.min(minY, lat);
    maxY = Math.max(maxY, lat);
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
  // Breathing room east and west so nothing sits on the frame. None north or
  // south: the two edges are the landmarks themselves, and padding past them
  // would put the sheet's edge somewhere nobody chose.
  const padX = Math.max(0.2, (maxX - minX) * 0.04);
  return [minX - padX, PLATE_BOUNDS.south, maxX + padX, PLATE_BOUNDS.north];
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
  const { extent } = useDefaults();
  const controller = useMapController();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dpi, setDpi] = useState(300);
  const [transparent, setTransparent] = useState(false);

  const fullExtent = useMemo(() => fullExtentOf(project) ?? extent, [project, extent]);
  /** The size the current extent choice wants, before the browser's ceiling. */
  const wantedFor = (whole: boolean) => sizeAtScreenScale(controller, whole ? fullExtent : extent, whole);
  /** Ground scale of the view, for saying what a tiled run will come out at. */
  const metresPerPixel = controller
    ? (controller.map.getView().getResolution() ?? 0) * metersPerUnit(project.projection.units)
    : null;

  const [state, setState] = useState<ExportState>(() => {
    // The whole map, at the scale the screen is showing it. A picture of the
    // map you are working on rather than a fixed 4000 px box that means a
    // different scale on every project.
    const wanted = sizeAtScreenScale(controller, fullExtent, true);
    const [width, height] = wanted ? fitWithinRaster(wanted[0], wanted[1]) : [4000, 3000];
    return {
      ...DEFAULT_SVG_OPTIONS,
      width,
      height,
      // 1× is screen weight, which is what a screen-scale export wants.
      styleScale: 1,
      useFullExtent: true,
    };
  });

  // Size follows the extent until the size is typed, and stops following once
  // it has been: a number somebody entered is not a default to overwrite.
  const sizeTouched = useRef(false);
  const set = (patch: Partial<ExportState>) => {
    if (patch.width !== undefined || patch.height !== undefined) sizeTouched.current = true;
    setState((s) => {
      const next = { ...s, ...patch };
      if (patch.useFullExtent !== undefined && !sizeTouched.current) {
        const wanted = wantedFor(patch.useFullExtent);
        if (wanted) [next.width, next.height] = fitWithinRaster(wanted[0], wanted[1]);
      }
      return next;
    });
  };

  // What the ceiling cost, if anything, so a capped export says so rather than
  // quietly coming out at a scale nobody asked for.
  const wanted = wantedFor(state.useFullExtent);
  const cappedFrom =
    wanted && !sizeTouched.current && wanted[0] > state.width ? wanted : null;

  const limits = checkRasterLimits(state.width, state.height);

  // Tiles are how the screen-scale answer is actually reachable: one image
  // cannot hold it, so the plate comes out in pieces that reassemble exactly.
  const [tiled, setTiled] = useState(false);
  const [tilePx, setTilePx] = useState(DEFAULT_TILE_PX);
  const plateSize: [number, number] = tiled && wanted ? wanted : [state.width, state.height];
  const plan = useMemo(
    () => (tiled ? planTiles(plateSize[0], plateSize[1], tilePx) : null),
    [tiled, plateSize[0], plateSize[1], tilePx],
  );

  const runTiled = async () => {
    if (!plan) return;
    const folder = canWriteFolder() ? await folderSink() : null;
    if (!folder && plan.tiles.length > 12) {
      toast(
        `This browser cannot be handed a folder, and ${plan.tiles.length} separate downloads will be blocked. Use Chrome or Edge, or raise the tile size.`,
        'error',
      );
      return;
    }
    setBusy(true);
    setProgress(0);
    const base = safeFilename(project.meta.title, '').replace(/\.$/, '') || 'map';
    try {
      const chosenExtent = state.useFullExtent ? (fullExtentOf(project) ?? extent) : extent;
      const sink =
        folder?.sink ??
        (async (_t, blob, filename) => {
          downloadBlob(blob, filename);
        });
      const made = await exportTiles(
        project,
        { ...state, width: plan.plateWidth, height: plan.plateHeight, extent: chosenExtent, clampToBand: state.useFullExtent },
        sink,
        {
          base,
          plan,
          transparent,
          onProgress: (done, total) => setProgress(done / total),
        },
      );
      await folder?.write(`${base}_tiles.txt`, stitchReadme(base, plan, metresPerPixel));
      toast(`Exported ${made} tiles. See ${base}_tiles.txt for how to stitch them.`, 'success');
      onClose();
    } catch (err) {
      // Cancelling the folder picker is a decision, not a failure.
      if ((err as Error).name === 'AbortError') return;
      toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setProgress(0);
    try {
      const chosenExtent = state.useFullExtent ? (fullExtentOf(project) ?? extent) : extent;
      const blob = await exportPng(
        project,
        { ...state, extent: chosenExtent, clampToBand: state.useFullExtent, dpi, transparent },
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
          <button
            className="btn btn--accent"
            onClick={() => void (tiled ? runTiled() : run())}
            disabled={busy || (!tiled && !limits.ok)}
          >
            {busy ? 'Rendering…' : tiled ? `Export ${plan?.tiles.length ?? 0} tiles` : 'Export PNG'}
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
      <p className="hint" style={{ marginTop: 0 }}>
        {sizeTouched.current
          ? 'Size set by hand — the detail scale no longer follows the screen.'
          : `The whole map at the scale it is on screen now. Zoom in or out before opening this
             dialog to export at a different scale.`}
      </p>
      {state.useFullExtent && (
        <p className="hint" style={{ marginTop: 0 }}>
          The sheet is cut at four landmarks: Anticosti Island in the north, the tip of Baja
          California Sur in the south, Cape Mendocino on the Californian coast and the eastern
          tip of Cape Breton, off the Command of Tiramara — with a strip of ocean past each. Anything drawn outside it, including the
          Canadian north, southern Mexico, Cuba and Newfoundland, is not on the page. Turn off “Export everything”
          to export the view you are looking at instead.
        </p>
      )}
      {cappedFrom && !tiled && (
        <p className="hint" style={{ marginTop: 0 }}>
          Screen scale would be {cappedFrom[0].toLocaleString()} × {cappedFrom[1].toLocaleString()} px,
          past what a browser canvas holds, so this is the largest single image of the same map — about{' '}
          {Math.round((cappedFrom[0] / state.width) * (metresPerPixel ?? 0)).toLocaleString()} m to the pixel
          instead of {Math.round(metresPerPixel ?? 0).toLocaleString()}. Tile it to keep the screen's detail.
        </p>
      )}

      <label className="checkbox" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={tiled} onChange={(e) => setTiled(e.target.checked)} />
        Export as tiles, at the screen's own detail
      </label>
      {tiled && plan && (
        <>
          <Field label="Tile size">
            <select className="select" value={tilePx} onChange={(e) => setTilePx(Number(e.target.value))}>
              {[2048, 4096, 8192].map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </select>
          </Field>
          <p className="hint">
            {plan.plateWidth.toLocaleString()} × {plan.plateHeight.toLocaleString()} px —{' '}
            {(plan.totalPixels / 1e9).toFixed(2)} gigapixels — as {plan.cols} × {plan.rows} ={' '}
            {plan.tiles.length.toLocaleString()} tiles
            {metresPerPixel ? `, at about ${Math.round(metresPerPixel).toLocaleString()} m to the pixel` : ''}.
            Roughly {(plan.estimatedBytes / 1e9).toFixed(1)} GB in total.
          </p>
          <p className="hint" style={{ marginTop: 0 }}>
            One drawing, cropped {plan.tiles.length.toLocaleString()} times, so the pieces line up exactly —
            names, dashes and patterns are decided once for the whole plate rather than per tile. You will be
            asked for a folder to write them into, along with a note on how to stitch them.
          </p>
          {plan.tiles.length > MANY_TILES && (
            <p className="hint" style={{ color: 'var(--danger)', marginTop: 0 }}>
              {plan.tiles.length.toLocaleString()} tiles will take a long time and a lot of disk. Zoom out
              before opening this dialog, or raise the tile size, if that is more than you meant.
            </p>
          )}
        </>
      )}
      {!limits.ok && (
        <p className="hint" style={{ color: 'var(--danger)' }}>
          {limits.message}
        </p>
      )}
    </Dialog>
  );
}

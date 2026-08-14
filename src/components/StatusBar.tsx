/** Bottom status bar (spec §52): coordinates, zoom, scale, projection, timeline. */

import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { commit } from '@/state/projectStore';
import { formatDegrees } from '@/export/svgExport';
import { toolHint } from './ToolPalette';

export function StatusBar() {
  const pointer = useUIStore((s) => s.pointer);
  const zoom = useUIStore((s) => s.zoom);
  const scaleText = useUIStore((s) => s.scaleText);
  const tool = useUIStore((s) => s.tool);
  const selection = useUIStore((s) => s.selection);
  const snapEnabled = useUIStore((s) => s.snapEnabled);
  const patch = useUIStore((s) => s.patch);
  const projection = useProjectStore((s) => s.project.projection);
  const timeline = useProjectStore((s) => s.project.timeline);

  return (
    <div className="statusbar">
      <span className="statusbar__item">
        <span className="statusbar__label">Lat</span>
        <span className="statusbar__value" style={{ width: 62, display: 'inline-block' }}>
          {pointer ? formatDegrees(pointer.lat, 'lat') : '—'}
        </span>
        <span className="statusbar__label">Lon</span>
        <span className="statusbar__value" style={{ width: 68, display: 'inline-block' }}>
          {pointer ? formatDegrees(pointer.lon, 'lon') : '—'}
        </span>
      </span>

      <span className="statusbar__item">
        <span className="statusbar__label">Zoom</span>
        <span className="statusbar__value">{zoom.toFixed(2)}</span>
      </span>

      {scaleText && (
        <span className="statusbar__item">
          <span className="statusbar__label">Scale</span>
          <span className="statusbar__value">{scaleText}</span>
        </span>
      )}

      <span className="statusbar__item">
        <span className="statusbar__label">Projection</span>
        <span className="statusbar__value">{projection.name}</span>
      </span>

      <button
        className={`tbtn${snapEnabled ? ' tbtn--active' : ''}`}
        style={{ height: 19 }}
        onClick={() => patch({ snapEnabled: !snapEnabled })}
        title="Snap new and dragged vertices to existing geometry (spec §35)"
      >
        SNAP {snapEnabled ? 'ON' : 'OFF'}
      </button>

      <TimelineControl enabled={timeline.enabled} year={timeline.currentYear} min={timeline.minYear} max={timeline.maxYear} />

      <span className="statusbar__spacer" />

      {selection.length > 0 && (
        <span className="statusbar__item">
          <span className="statusbar__value">{selection.length}</span>
          <span className="statusbar__label">selected</span>
        </span>
      )}

      <span className="statusbar__item" style={{ color: 'var(--text-faint)', maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {toolHint(tool)}
      </span>
    </div>
  );
}

/**
 * Timeline (spec §30). The data model carries start/end years on every feature
 * already; this control sets the current year and is wired to visibility below.
 */
function TimelineControl({
  enabled,
  year,
  min,
  max,
}: {
  enabled: boolean;
  year: number;
  min: number;
  max: number;
}) {
  const timeline = useProjectStore((s) => s.project.timeline);

  return (
    <span className="statusbar__item">
      <label className="statusbar__label" style={{ cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => commit('Toggle timeline', (r) => r.setDoc('timeline', { ...timeline, enabled: e.target.checked }))}
          style={{ accentColor: 'var(--accent)' }}
        />
        Year
      </label>
      {enabled && (
        <>
          <input
            type="range"
            className="range"
            style={{ width: 150 }}
            min={min}
            max={max}
            step={timeline.step}
            value={year}
            onChange={(e) =>
              commit('Set year', (r) => r.setDoc('timeline', { ...timeline, currentYear: Number(e.target.value) }))
            }
          />
          <span className="statusbar__value" style={{ width: 38, textAlign: 'right' }}>
            {year}
          </span>
        </>
      )}
    </span>
  );
}

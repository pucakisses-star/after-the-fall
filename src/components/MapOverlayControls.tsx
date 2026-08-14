/** Floating map controls: zoom, fit, and quick display toggles (spec §2, §23). */

import { useUIStore } from '@/state/uiStore';
import { useMapController } from './MapContext';
import { IconFit, IconGrid, IconZoomIn, IconZoomOut } from './icons';

export function MapOverlayControls() {
  const controller = useMapController();
  const showLabels = useUIStore((s) => s.showLabels);
  const showBorders = useUIStore((s) => s.showBorders);
  const showGraticule = useUIStore((s) => s.showGraticule);
  const patch = useUIStore((s) => s.patch);
  const selection = useUIStore((s) => s.selection);

  return (
    <div className="map-overlay">
      <div className="map-overlay__row">
        <button className="mbtn" title="Zoom in" onClick={() => controller?.zoomBy(1)}>
          <IconZoomIn />
        </button>
        <button className="mbtn" title="Zoom out" onClick={() => controller?.zoomBy(-1)}>
          <IconZoomOut />
        </button>
      </div>
      <div className="map-overlay__row">
        <button className="mbtn" title="Fit the whole map" onClick={() => controller?.fitAll()}>
          <IconFit />
        </button>
        <button
          className="mbtn"
          title="Zoom to selection"
          disabled={selection.length === 0}
          style={selection.length === 0 ? { opacity: 0.4 } : undefined}
          onClick={() => controller?.zoomToSelection()}
        >
          ⤢
        </button>
      </div>
      <div className="map-overlay__row">
        <button
          className={`mbtn mbtn--wide${showLabels ? ' mbtn--on' : ''}`}
          title="Show or hide every label"
          onClick={() => patch({ showLabels: !showLabels })}
        >
          LABELS
        </button>
      </div>
      <div className="map-overlay__row">
        <button
          className={`mbtn mbtn--wide${showBorders ? ' mbtn--on' : ''}`}
          title="Show or hide political borders"
          onClick={() => patch({ showBorders: !showBorders })}
        >
          BORDERS
        </button>
      </div>
      <div className="map-overlay__row">
        <button
          className={`mbtn${showGraticule ? ' mbtn--on' : ''}`}
          title="Latitude / longitude grid"
          onClick={() => patch({ showGraticule: !showGraticule })}
        >
          <IconGrid />
        </button>
      </div>
    </div>
  );
}

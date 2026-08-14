/**
 * Mounts the OpenLayers map exactly once.
 *
 * React is not in the map's render path at all (spec §51): this component renders
 * a host element and never re-renders it. Everything drawn on the map is drawn by
 * `MapController`, driven straight from the store.
 */

import { useEffect, useRef, useState } from 'react';
import { MapController } from '@/render/MapController';
import { ToolManager } from '@/tools/ToolManager';
import type { MapContextValue } from './MapContext';
import { MapOverlayControls } from './MapOverlayControls';
import { ContextMenu } from './ContextMenu';
import { useUIStore } from '@/state/uiStore';

/**
 * Creates the map engine and returns it plus the ref to attach to the host div.
 * Kept as a hook so `App` can own the context provider and share the controller
 * with panels and dialogs alike.
 */
export function useMapEngine(): { value: MapContextValue; hostRef: React.RefObject<HTMLDivElement | null> } {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState<MapContextValue>({ controller: null, tools: null });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const controller = new MapController(host);
    const tools = new ToolManager(controller);
    setValue({ controller, tools });

    // Keep the canvas sized to its container without a window resize listener.
    const observer = new ResizeObserver(() => controller.map.updateSize());
    observer.observe(host);

    return () => {
      observer.disconnect();
      tools.dispose();
      controller.dispose();
      setValue({ controller: null, tools: null });
    };
  }, []);

  return { value, hostRef };
}

export function MapCanvas({
  hostRef,
  controller,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>;
  controller: MapController | null;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div className="map-wrap">
      <div
        ref={hostRef}
        className="map"
        onContextMenu={(e) => {
          e.preventDefault();
          // Right-clicking something that is not selected selects it first, so the
          // menu always acts on what was clicked (spec §54).
          if (controller) {
            const rect = e.currentTarget.getBoundingClientRect();
            const hit = controller.hitTest([e.clientX - rect.left, e.clientY - rect.top]);
            const ui = useUIStore.getState();
            if (hit && !ui.selection.includes(hit.id)) ui.setSelection([hit.id]);
          }
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      <MapStatusLine />
      <MapOverlayControls />
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

function MapStatusLine() {
  const status = useUIStore((s) => s.status);
  if (!status) return null;
  return <div className="map-status">{status}</div>;
}

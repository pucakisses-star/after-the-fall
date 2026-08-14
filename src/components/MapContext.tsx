import { createContext, useContext } from 'react';
import type { MapController } from '@/render/MapController';
import type { ToolManager } from '@/tools/ToolManager';

export interface MapContextValue {
  controller: MapController | null;
  tools: ToolManager | null;
}

export const MapContext = createContext<MapContextValue>({ controller: null, tools: null });

export function useMapController(): MapController | null {
  return useContext(MapContext).controller;
}

export function useToolManager(): ToolManager | null {
  return useContext(MapContext).tools;
}

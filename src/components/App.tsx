import { useCallback, useEffect, useRef } from 'react';
import { TopToolbar } from './TopToolbar';
import { ToolPalette } from './ToolPalette';
import { LayersPanel } from './LayersPanel';
import { Inspector } from './Inspector';
import { StatusBar } from './StatusBar';
import { MapCanvas, useMapEngine } from './MapCanvas';
import { MapContext } from './MapContext';
import { Toasts } from './Toasts';
import { NewProjectDialog, ShortcutsDialog } from './dialogs/NewProjectDialog';
import { OpenProjectDialog } from './dialogs/OpenProjectDialog';
import { ExportPngDialog, ExportSvgDialog } from './dialogs/ExportDialogs';
import { ImportDialog } from './dialogs/ImportDialog';
import { BasemapDialog } from './dialogs/BasemapDialog';
import { PaletteDialog } from './dialogs/PaletteDialog';
import { TopologyDialog } from './dialogs/TopologyDialog';
import { DataTableDialog } from './dialogs/DataTableDialog';
import { useKeyboard, useVertexToolRefresh } from './useKeyboard';
import { useUIStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { startAutosave } from '@/persistence/projectFile';
import { buildDemoProject } from '@/demo/demoProject';

export function App() {
  const { value, hostRef } = useMapEngine();
  const { controller, tools } = value;

  useEffect(() => startAutosave(), []);
  useKeyboard(controller);

  // The vertex tool edits whatever is selected, so rebuild it when that changes.
  const refreshVertexTool = useCallback(() => {
    if (!tools) return;
    tools.setTool('select');
    tools.setTool('vertex');
  }, [tools]);
  useVertexToolRefresh(refreshVertexTool);

  useFirstRunDemo(controller);

  return (
    <MapContext.Provider value={value}>
      <div className="app">
        <TopToolbar />
        <div className="app-body">
          <ToolPalette />
          <LayersPanel />
          <MapCanvas hostRef={hostRef} controller={controller} />
          <Inspector />
        </div>
        <StatusBar />
        <Dialogs />
        <Toasts />
      </div>
    </MapContext.Provider>
  );
}

/**
 * First run lands on the demonstration map rather than blank ocean, so the
 * feature set is immediately visible. Runs once, and only when the document is
 * genuinely empty — a restored autosave is never overwritten.
 */
function useFirstRunDemo(controller: ReturnType<typeof useMapEngine>['value']['controller']): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !controller) return;
    done.current = true;

    const project = useProjectStore.getState().project;
    const empty =
      Object.keys(project.territories).length === 0 && Object.keys(project.settlements).length === 0;
    if (!empty) return;

    void (async () => {
      try {
        const { project: demo } = await buildDemoProject();
        // Bail out if the user started work while the demo was loading.
        const now = useProjectStore.getState().project;
        if (Object.keys(now.territories).length > 0) return;
        useProjectStore.getState().loadProject(demo, null);
        setTimeout(() => controller.fitAll(), 150);
        useUIStore.getState().toast('Loaded the demonstration map. "New" starts a blank one.', 'info');
      } catch {
        useUIStore.getState().toast('Start by drawing a territory, or choose New.', 'info');
      }
    })();
  }, [controller]);
}

function Dialogs() {
  const dialog = useUIStore((s) => s.dialog);
  const setDialog = useUIStore((s) => s.setDialog);
  const close = () => setDialog(null);

  return (
    <>
      {dialog === 'new-project' && <NewProjectDialog onClose={close} />}
      {dialog === 'open-project' && <OpenProjectDialog onClose={close} />}
      {dialog === 'export-svg' && <ExportSvgDialog onClose={close} />}
      {dialog === 'export-png' && <ExportPngDialog onClose={close} />}
      {dialog === 'import' && <ImportDialog onClose={close} />}
      {dialog === 'basemap' && <BasemapDialog onClose={close} />}
      {dialog === 'palette' && <PaletteDialog onClose={close} />}
      {dialog === 'topology' && <TopologyDialog onClose={close} />}
      {dialog === 'data-table' && <DataTableDialog onClose={close} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={close} />}
    </>
  );
}

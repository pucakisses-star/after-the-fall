/**
 * Layer tree (spec §19) with the territory hierarchy underneath it (spec §7).
 */

import { useMemo, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import {
  addLayer,
  deleteLayer,
  duplicateLayer,
  reorderLayer,
  setHiddenFor,
  setLockedFor,
  updateLayer,
} from '@/state/commands';
import { layerTree, territoryTree, type TreeNode } from '@/model/hierarchy';
import { resolveTerritoryStyle } from '@/model/resolveStyle';
import { useMapController } from './MapContext';
import type { MapLayer, Territory } from '@/model/types';
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconLock,
  IconPlus,
  IconTrash,
  IconUnlock,
} from './icons';

type Mode = 'layers' | 'hierarchy';

export function LayersPanel() {
  const [mode, setMode] = useState<Mode>('layers');
  return (
    <div className="panel panel--layers">
      <div className="tabs">
        <button className={`tab${mode === 'layers' ? ' tab--active' : ''}`} onClick={() => setMode('layers')}>
          Layers
        </button>
        <button className={`tab${mode === 'hierarchy' ? ' tab--active' : ''}`} onClick={() => setMode('hierarchy')}>
          Hierarchy
        </button>
      </div>
      <div className="panel__body">{mode === 'layers' ? <LayerTree /> : <HierarchyTree />}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LayerTree() {
  const project = useProjectStore((s) => s.project);
  const tree = useMemo(() => layerTree(project), [project]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const rows: React.ReactNode[] = [];
  const walk = (nodes: TreeNode<MapLayer>[]) => {
    for (const node of nodes) {
      rows.push(
        <LayerRow
          key={node.item.id}
          layer={node.item}
          depth={node.depth}
          hasChildren={node.children.length > 0}
          selected={selectedLayer === node.item.id}
          renaming={renaming === node.item.id}
          onSelect={() => setSelectedLayer(node.item.id)}
          onStartRename={() => setRenaming(node.item.id)}
          onEndRename={() => setRenaming(null)}
        />,
      );
      if (!node.item.collapsed) walk(node.children);
    }
  };
  walk(tree);

  return (
    <>
      <div style={{ padding: '4px 0' }}>{rows}</div>
      <div className="panel__section" style={{ borderBottom: 'none' }}>
        <div className="btn-row">
          <button
            className="btn"
            title="Add a group"
            onClick={() => addLayer('group', 'New Group', null)}
          >
            <IconPlus /> Group
          </button>
          <button
            className="btn"
            disabled={!selectedLayer}
            title="Duplicate the selected layer and its contents"
            onClick={() => selectedLayer && duplicateLayer(selectedLayer)}
          >
            <IconCopy />
          </button>
          <button
            className="btn"
            disabled={!selectedLayer}
            title="Move up"
            onClick={() => selectedLayer && reorderLayer(selectedLayer, 1)}
          >
            <IconArrowUp />
          </button>
          <button
            className="btn"
            disabled={!selectedLayer}
            title="Move down"
            onClick={() => selectedLayer && reorderLayer(selectedLayer, -1)}
          >
            <IconArrowDown />
          </button>
          <button
            className="btn btn--danger"
            disabled={!selectedLayer}
            title="Delete the layer and everything on it"
            onClick={() => {
              if (!selectedLayer) return;
              const name = useProjectStore.getState().project.layers[selectedLayer]?.name ?? 'this layer';
              if (confirm(`Delete "${name}" and everything on it?`)) {
                deleteLayer(selectedLayer);
                setSelectedLayer(null);
              }
            }}
          >
            <IconTrash />
          </button>
        </div>
        <p className="hint">
          Layers draw bottom to top. Opacity and lock cascade to everything inside a group.
        </p>
      </div>
    </>
  );
}

function LayerRow({
  layer,
  depth,
  hasChildren,
  selected,
  renaming,
  onSelect,
  onStartRename,
  onEndRename,
}: {
  layer: MapLayer;
  depth: number;
  hasChildren: boolean;
  selected: boolean;
  renaming: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onEndRename: () => void;
}) {
  return (
    <div
      className={`tree-row${selected ? ' tree-row--selected' : ''}`}
      style={{ paddingLeft: 4 + depth * 12 }}
      onClick={onSelect}
    >
      <span
        className="tree-row__twisty"
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) updateLayer(layer.id, { collapsed: !layer.collapsed }, 'Toggle group');
        }}
      >
        {hasChildren ? layer.collapsed ? <IconChevronRight /> : <IconChevronDown /> : ''}
      </span>

      <button
        className={`icon-btn${layer.visible ? '' : ' icon-btn--on'}`}
        title={layer.visible ? 'Hide layer' : 'Show layer'}
        onClick={(e) => {
          e.stopPropagation();
          updateLayer(layer.id, { visible: !layer.visible }, layer.visible ? 'Hide layer' : 'Show layer');
        }}
      >
        {layer.visible ? <IconEye /> : <IconEyeOff />}
      </button>

      <button
        className={`icon-btn${layer.locked ? ' icon-btn--on' : ''}`}
        title={layer.locked ? 'Unlock layer' : 'Lock layer'}
        onClick={(e) => {
          e.stopPropagation();
          updateLayer(layer.id, { locked: !layer.locked }, layer.locked ? 'Unlock layer' : 'Lock layer');
        }}
      >
        {layer.locked ? <IconLock /> : <IconUnlock />}
      </button>

      {renaming ? (
        <input
          className="input"
          style={{ height: 18 }}
          autoFocus
          defaultValue={layer.name}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value && value !== layer.name) updateLayer(layer.id, { name: value }, 'Rename layer');
            onEndRename();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') onEndRename();
          }}
        />
      ) : (
        <span
          className={`tree-row__name${layer.visible ? '' : ' tree-row__name--dim'}`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
          title="Double-click to rename"
        >
          {layer.name}
        </span>
      )}

      <input
        className="range"
        style={{ width: 44, flex: 'none' }}
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={layer.opacity}
        title={`Opacity ${Math.round(layer.opacity * 100)}%`}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => updateLayer(layer.id, { opacity: Number(e.target.value) }, 'Layer opacity')}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function HierarchyTree() {
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const controller = useMapController();
  const tree = useMemo(() => territoryTree(project), [project]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (Object.keys(project.territories).length === 0) {
    return (
      <div className="empty">
        No territories yet.
        <br />
        Draw one with the Territory tool, or import reference geography from the Basemap panel.
      </div>
    );
  }

  const rows: React.ReactNode[] = [];
  const walk = (nodes: TreeNode<Territory>[]) => {
    for (const node of nodes) {
      const t = node.item;
      const isCollapsed = collapsed.has(t.id);
      rows.push(
        <div
          key={t.id}
          className={`tree-row${selection.includes(t.id) ? ' tree-row--selected' : ''}`}
          style={{ paddingLeft: 4 + node.depth * 12 }}
          onClick={(e) => useUIStore.getState().toggleSelection(t.id, e.shiftKey || e.metaKey || e.ctrlKey)}
          onDoubleClick={() => controller?.zoomToFeature(t.id)}
          title={`${t.name} — double-click to zoom`}
        >
          <span
            className="tree-row__twisty"
            onClick={(e) => {
              e.stopPropagation();
              if (!node.children.length) return;
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                return next;
              });
            }}
          >
            {node.children.length ? isCollapsed ? <IconChevronRight /> : <IconChevronDown /> : ''}
          </span>
          <span
            className="tree-row__swatch"
            style={{ background: resolveTerritoryStyle(project, t).fillColor }}
          />
          <button
            className={`icon-btn${t.hidden ? ' icon-btn--on' : ''}`}
            title={t.hidden ? 'Show' : 'Hide'}
            onClick={(e) => {
              e.stopPropagation();
              setHiddenFor([t.id], !t.hidden);
            }}
          >
            {t.hidden ? <IconEyeOff /> : <IconEye />}
          </button>
          <button
            className={`icon-btn${t.locked ? ' icon-btn--on' : ''}`}
            title={t.locked ? 'Unlock' : 'Lock'}
            onClick={(e) => {
              e.stopPropagation();
              setLockedFor([t.id], !t.locked);
            }}
          >
            {t.locked ? <IconLock /> : <IconUnlock />}
          </button>
          <span className={`tree-row__name${t.hidden ? ' tree-row__name--dim' : ''}`}>{t.name}</span>
          <span className="tree-row__badge">{String(t.politicalType).replace(/-/g, ' ')}</span>
        </div>,
      );
      if (!isCollapsed) walk(node.children);
    }
  };
  walk(tree);

  return <div style={{ padding: '4px 0' }}>{rows}</div>;
}

/** Left tool palette (spec §52, §53). */

import { useUIStore, type ToolId } from '@/state/uiStore';
import {
  IconCursor,
  IconCut,
  IconHand,
  IconLabel,
  IconMeasure,
  IconPaint,
  IconRiver,
  IconRoad,
  IconSettlement,
  IconTerritory,
  IconVertex,
} from './icons';

interface ToolDef {
  id: ToolId;
  label: string;
  key: string;
  icon: React.ReactNode;
  hint: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', icon: <IconCursor />, hint: 'Click to select. Shift-drag to box-select. Drag cities and labels.' },
  { id: 'pan', label: 'Pan', key: 'H', icon: <IconHand />, hint: 'Drag to pan the map.' },
  { id: 'territory', label: 'Territory', key: 'R', icon: <IconTerritory />, hint: 'Click to place vertices, double-click to close the polygon.' },
  { id: 'vertex', label: 'Edit vertices', key: 'A', icon: <IconVertex />, hint: 'Drag vertices. Click an edge to add one. Alt-click to remove. Neighbours that share a vertex move with it.' },
  { id: 'paint', label: 'Paint territory', key: 'B', icon: <IconPaint />, hint: 'Choose a state in the Inspector, then drag across subdivisions to assign them.' },
  { id: 'cut', label: 'Split', key: 'C', icon: <IconCut />, hint: 'Draw a line across a territory to cut it in two.' },
  { id: 'settlement', label: 'Settlement', key: 'S', icon: <IconSettlement />, hint: 'Click to place a city, capital or fortress.' },
  { id: 'label', label: 'Label', key: 'T', icon: <IconLabel />, hint: 'Click to place a free label.' },
  { id: 'river', label: 'River', key: 'W', icon: <IconRiver />, hint: 'Click to draw a river, double-click to finish.' },
  { id: 'road', label: 'Road', key: 'D', icon: <IconRoad />, hint: 'Click to draw a road, double-click to finish.' },
  { id: 'measure', label: 'Measure', key: 'M', icon: <IconMeasure />, hint: 'Draw a line to measure distance.' },
];

export function ToolPalette() {
  const tool = useUIStore((s) => s.tool);
  const setTool = useUIStore((s) => s.setTool);

  return (
    <div className="tools">
      {TOOLS.map((t, i) => (
        <div key={t.id} style={{ display: 'contents' }}>
          {(i === 2 || i === 6 || i === 10) && <div className="tools__sep" />}
          <button
            className={`tool${tool === t.id ? ' tool--active' : ''}`}
            title={`${t.label} (${t.key}) — ${t.hint}`}
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
          >
            {t.icon}
            <span className="tool__key">{t.key}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

export function toolHint(id: ToolId): string {
  return TOOLS.find((t) => t.id === id)?.hint ?? '';
}

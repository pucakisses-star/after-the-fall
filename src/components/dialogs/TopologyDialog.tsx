/**
 * Topology check and repair (spec §6, §58).
 *
 * Validation runs first and is shown as a preview — §58 asks for previews before
 * destructive changes — and only then is the repair applied.
 */

import { useState } from 'react';
import { Dialog } from '../Dialog';
import { Field, Slider } from '../Inspector';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore, toast } from '@/state/uiStore';
import { runRepairTopology } from '@/state/commands';
import { formatArea, validateTopology, type TopologyIssue } from '@/geo/topology';
import { useMapController } from '../MapContext';

export function TopologyDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const controller = useMapController();
  const [issues, setIssues] = useState<TopologyIssue[] | null>(null);
  const [log, setLog] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const [maxSliverKm2, setMaxSliverKm2] = useState(50);
  const [tolerance, setTolerance] = useState(5);
  const [weldVertices, setWeld] = useState(true);
  const [fixOverlaps, setFixOverlaps] = useState(true);
  const [fillGaps, setFillGaps] = useState(true);

  const territoryCount = Object.keys(project.territories).length;

  const check = () => {
    setBusy(true);
    setLog(null);
    // Let the dialog paint the "checking" state before the synchronous sweep.
    setTimeout(() => {
      try {
        const found = validateTopology(Object.values(project.territories), { maxSliverKm2 });
        setIssues(found);
      } catch (err) {
        toast(`Check failed: ${(err as Error).message}`, 'error');
      } finally {
        setBusy(false);
      }
    }, 20);
  };

  const repair = () => {
    setBusy(true);
    setTimeout(() => {
      try {
        const result = runRepairTopology({
          maxSliverKm2,
          tolerance: tolerance * 1e-6,
          weldVertices,
          fixOverlaps,
          fillGaps,
        });
        setLog(result.log);
        setIssues(null);
        toast(
          result.changed > 0
            ? `Repaired ${result.changed} territories. Ctrl+Z undoes it.`
            : 'Nothing needed repairing.',
          result.changed > 0 ? 'success' : 'info',
        );
      } catch (err) {
        toast(`Repair failed: ${(err as Error).message}`, 'error');
      } finally {
        setBusy(false);
      }
    }, 20);
  };

  const counts = issues
    ? {
        overlap: issues.filter((i) => i.kind === 'overlap').length,
        sliver: issues.filter((i) => i.kind === 'sliver').length,
        gap: issues.filter((i) => i.kind === 'gap').length,
        invalid: issues.filter((i) => i.kind === 'invalid').length,
      }
    : null;

  return (
    <Dialog
      title="Territory topology"
      onClose={onClose}
      wide
      footer={
        <>
          <span style={{ flex: 1, color: 'var(--text-faint)' }}>
            {territoryCount} territories
          </span>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={busy || territoryCount === 0} onClick={check}>
            {busy ? 'Working…' : 'Check'}
          </button>
          <button className="btn btn--accent" disabled={busy || territoryCount === 0} onClick={repair}>
            Repair Territory Topology
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Repair runs three passes: it welds near-coincident vertices between neighbours so shared
        borders become genuinely shared, subtracts small overlaps from the smaller territory, and
        hands each sliver gap to whichever neighbour surrounds most of it. Locked territories are
        never modified, and the whole repair is one undo step.
      </p>

      <div className="split-2">
        <div>
          <Field label="Sliver limit">
            <Slider value={maxSliverKm2} min={0.1} max={500} step={0.1} onChange={setMaxSliverKm2} suffix=" km²" />
          </Field>
          <p className="hint" style={{ marginTop: 0 }}>
            Gaps and overlaps up to this size are treated as accidental. Anything larger is reported
            but left alone — it is probably an inland sea or genuinely unclaimed ground.
          </p>
        </div>
        <div>
          <Field label="Weld distance">
            <Slider value={tolerance} min={0.5} max={100} step={0.5} onChange={setTolerance} suffix=" µ°" />
          </Field>
          <p className="hint" style={{ marginTop: 0 }}>
            Vertices closer than this are snapped onto one shared position. 5 µ° is about half a
            metre at the equator.
          </p>
        </div>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={weldVertices} onChange={(e) => setWeld(e.target.checked)} />
        Weld near-coincident vertices
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={fixOverlaps} onChange={(e) => setFixOverlaps(e.target.checked)} />
        Remove overlaps
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={fillGaps} onChange={(e) => setFillGaps(e.target.checked)} />
        Fill sliver gaps
      </label>

      {counts && (
        <>
          <h3 className="panel__section-title" style={{ marginTop: 14 }}>
            Found {issues!.length} issue{issues!.length === 1 ? '' : 's'} — {counts.overlap} overlaps,{' '}
            {counts.sliver} slivers, {counts.gap} gaps
            {counts.invalid ? `, ${counts.invalid} invalid` : ''}
          </h3>
          {issues!.length === 0 ? (
            <div className="empty">No gaps or overlaps. The territory mesh is clean.</div>
          ) : (
            <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 3 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 74 }}>Kind</th>
                    <th style={{ width: 96 }}>Area</th>
                    <th>Detail</th>
                    <th style={{ width: 64 }} />
                  </tr>
                </thead>
                <tbody>
                  {issues!.slice(0, 300).map((issue, i) => (
                    <tr key={i}>
                      <td>
                        <span className="badge">{issue.kind}</span>
                      </td>
                      <td className="mono">{formatArea(issue.areaKm2)}</td>
                      <td style={{ whiteSpace: 'normal' }}>{issue.message}</td>
                      <td>
                        <button
                          className="btn"
                          style={{ height: 18, padding: '0 6px' }}
                          disabled={issue.featureIds.length === 0}
                          onClick={() => {
                            useUIStore.getState().setSelection(issue.featureIds);
                            controller?.zoomToSelection();
                          }}
                        >
                          Show
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {issues!.length > 300 && <p className="hint">Showing the first 300 of {issues!.length}.</p>}
        </>
      )}

      {log && (
        <>
          <h3 className="panel__section-title" style={{ marginTop: 14 }}>
            Repair log
          </h3>
          <div className="log">{log.join('\n')}</div>
        </>
      )}
    </Dialog>
  );
}

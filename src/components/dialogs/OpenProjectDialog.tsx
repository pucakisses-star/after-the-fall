import { useEffect, useState } from 'react';
import { Dialog } from '../Dialog';
import {
  deleteProject,
  duplicateProject,
  listProjects,
  listSnapshots,
  type Snapshot,
  type StoredProject,
} from '@/persistence/db';
import { writeSnapshot } from '@/persistence/db';
import { useProjectStore } from '@/state/projectStore';
import { toast } from '@/state/uiStore';

export function OpenProjectDialog({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<StoredProject[] | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setProjects(await listProjects());
    } catch (err) {
      setError(`Local storage is unavailable: ${(err as Error).message}`);
      setProjects([]);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selected) {
      setSnapshots([]);
      return;
    }
    void listSnapshots(selected).then(setSnapshots).catch(() => setSnapshots([]));
  }, [selected]);

  const open = async (record: StoredProject) => {
    const current = useProjectStore.getState().project;
    if (useProjectStore.getState().dirty && Object.keys(current.territories).length > 0) {
      await writeSnapshot(current, 'pre-load').catch(() => undefined);
    }
    useProjectStore.getState().loadProject(record.data, record.id);
    toast(`Opened "${record.title}".`, 'success');
    onClose();
  };

  return (
    <Dialog
      title="Open map"
      onClose={onClose}
      wide
      footer={
        <>
          <button
            className="btn"
            disabled={!selected}
            onClick={async () => {
              if (!selected) return;
              const source = projects?.find((p) => p.id === selected);
              const name = prompt('Name for the duplicate', `${source?.title ?? 'Map'} copy`);
              if (!name) return;
              await duplicateProject(selected, name);
              await refresh();
            }}
          >
            Duplicate
          </button>
          <button
            className="btn btn--danger"
            disabled={!selected}
            onClick={async () => {
              if (!selected) return;
              const source = projects?.find((p) => p.id === selected);
              if (!confirm(`Delete "${source?.title}" permanently?`)) return;
              await deleteProject(selected);
              setSelected(null);
              await refresh();
            }}
          >
            Delete
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--accent"
            disabled={!selected}
            onClick={() => {
              const record = projects?.find((p) => p.id === selected);
              if (record) void open(record);
            }}
          >
            Open
          </button>
        </>
      }
    >
      {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}
      {projects === null && <div className="empty">Reading local storage…</div>}
      {projects?.length === 0 && (
        <div className="empty">
          No saved maps yet.
          <br />
          Maps are saved into this browser automatically as you work, and can also be downloaded as
          .atfmap files.
        </div>
      )}
      {projects && projects.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th style={{ width: 150 }}>Last saved</th>
              <th style={{ width: 90 }}>Size</th>
              <th style={{ width: 130 }}>Contents</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr
                key={p.id}
                className={selected === p.id ? 'is-selected' : ''}
                onClick={() => setSelected(p.id)}
                onDoubleClick={() => void open(p)}
                style={{ cursor: 'pointer' }}
              >
                <td>{p.title}</td>
                <td>{new Date(p.updatedAt).toLocaleString()}</td>
                <td>{formatBytes(p.bytes)}</td>
                <td>
                  {Object.keys(p.data.territories ?? {}).length} territories,{' '}
                  {Object.keys(p.data.settlements ?? {}).length} cities
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && snapshots.length > 0 && (
        <>
          <h3 className="panel__section-title" style={{ marginTop: 14 }}>
            Recovery snapshots
          </h3>
          <table className="table">
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.key}>
                  <td>{new Date(s.savedAt).toLocaleString()}</td>
                  <td>
                    <span className="badge">{s.reason}</span>
                  </td>
                  <td style={{ width: 90 }}>
                    <button
                      className="btn"
                      onClick={() => {
                        useProjectStore.getState().loadProject(s.data, null);
                        toast('Restored a snapshot. Save it to keep it.', 'success');
                        onClose();
                      }}
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Snapshots are written periodically and before a map is replaced, so a crash or a
            mistaken "New" is recoverable.
          </p>
        </>
      )}
    </Dialog>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

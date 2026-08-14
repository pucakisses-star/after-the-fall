/**
 * Derived political borders (spec §8, §57).
 *
 * Territories store *areas*, not boundaries. The lines between them are computed:
 * every boundary segment is classified by looking at who is on each side.
 *
 *   • two territories under the same sovereign → the finer of their two border
 *     weights (an internal provincial hairline)
 *   • two territories under different sovereigns → the heavier weight (a
 *     sovereign border)
 *   • nobody on the other side → that territory's own border weight (its coast
 *     or outer frontier)
 *
 * That single rule is what §57 asks for: assign counties to states, and the
 * national borders appear and disappear on their own.
 *
 * The result is memoised on the identity of the territories record, so panning
 * and zooming never recompute it.
 */

import { borderWeightFor } from '@/model/defaults';
import { sovereignOf } from '@/model/hierarchy';
import { visibleInTime } from '@/model/timeline';
import { deriveBorders, mergeBorderSegments } from '@/geo/topology';
import type { BorderStyleKind, MapProject, Territory, UUID } from '@/model/types';
import type { LineString } from 'geojson';

export interface ClassifiedBorder {
  geometry: LineString;
  kind: BorderStyleKind;
  /** Territories on each side, for hit-testing and inspection. */
  left: UUID;
  right: UUID | null;
}

let cacheKey: unknown = null;
let cacheTimeKey: string | null = null;
let cacheValue: ClassifiedBorder[] = [];

export function computeBorders(project: MapProject): ClassifiedBorder[] {
  const timeKey = project.timeline.enabled ? String(project.timeline.currentYear) : 'all';
  if (cacheKey === project.territories && cacheTimeKey === timeKey) return cacheValue;

  const territories = Object.values(project.territories).filter(
    (t) => !t.hidden && visibleInTime(t.timeline, project.timeline),
  );
  const byId = new Map<UUID, Territory>(territories.map((t) => [t.id, t]));

  const raw = mergeBorderSegments(deriveBorders(territories));
  const out: ClassifiedBorder[] = [];

  for (const b of raw) {
    const left = byId.get(b.left);
    if (!left) continue;
    const right = b.right ? byId.get(b.right) : undefined;

    let kind: BorderStyleKind;
    if (!right) {
      kind = left.borderKind;
    } else {
      const sovL = sovereignOf(project, left.id)?.id;
      const sovR = sovereignOf(project, right.id)?.id;
      if (sovL && sovR && sovL === sovR) {
        // Same state either side — draw the quieter of the two lines.
        kind =
          borderWeightFor(left.borderKind) <= borderWeightFor(right.borderKind)
            ? left.borderKind
            : right.borderKind;
      } else {
        // Different states — the border is as strong as the stronger claim.
        kind =
          borderWeightFor(left.borderKind) >= borderWeightFor(right.borderKind)
            ? left.borderKind
            : right.borderKind;
      }
    }

    out.push({ geometry: b.geometry, kind, left: b.left, right: b.right });
  }

  // Draw quiet lines first so heavy sovereign borders land on top of them.
  out.sort((a, b) => borderWeightFor(a.kind) - borderWeightFor(b.kind));

  cacheKey = project.territories;
  cacheTimeKey = timeKey;
  cacheValue = out;
  return out;
}

export function invalidateBorderCache(): void {
  cacheKey = null;
  cacheTimeKey = null;
  cacheValue = [];
}

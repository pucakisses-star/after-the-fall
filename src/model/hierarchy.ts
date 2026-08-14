/**
 * Territory hierarchy and layer-tree traversal (spec §7, §19).
 *
 * Both trees are stored flat, as `parentId` pointers, because that keeps the
 * document a set of independent records — which is exactly what the patch-based
 * undo system needs. These helpers rebuild the tree views on demand.
 */

import { relationshipInfo } from './defaults';
import type { MapLayer, MapProject, Territory, UUID } from './types';

export interface TreeNode<T> {
  item: T;
  children: TreeNode<T>[];
  depth: number;
}

/** Build the territory containment tree. Roots are territories with no parent. */
export function territoryTree(project: MapProject): TreeNode<Territory>[] {
  const byParent = new Map<UUID | null, Territory[]>();
  for (const t of Object.values(project.territories)) {
    const key = t.parentId && project.territories[t.parentId] ? t.parentId : null;
    const list = byParent.get(key);
    if (list) list.push(t);
    else byParent.set(key, [t]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const build = (parentId: UUID | null, depth: number, seen: Set<UUID>): TreeNode<Territory>[] =>
    (byParent.get(parentId) ?? [])
      .filter((t) => !seen.has(t.id))
      .map((t) => {
        seen.add(t.id);
        return { item: t, depth, children: build(t.id, depth + 1, seen) };
      });

  return build(null, 0, new Set());
}

export function layerTree(project: MapProject): TreeNode<MapLayer>[] {
  const byParent = new Map<UUID | null, MapLayer[]>();
  for (const l of Object.values(project.layers)) {
    const list = byParent.get(l.parentId);
    if (list) list.push(l);
    else byParent.set(l.parentId, [l]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

  const build = (parentId: UUID | null, depth: number): TreeNode<MapLayer>[] =>
    (byParent.get(parentId) ?? []).map((l) => ({ item: l, depth, children: build(l.id, depth + 1) }));

  return build(null, 0);
}

/** Chain from a territory up to its root, nearest first. Cycle-safe. */
export function ancestorsOf(project: MapProject, id: UUID): Territory[] {
  const out: Territory[] = [];
  const seen = new Set<UUID>([id]);
  let cur = project.territories[id]?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    const t = project.territories[cur];
    if (!t) break;
    out.push(t);
    seen.add(cur);
    cur = t.parentId;
  }
  return out;
}

export function depthOf(project: MapProject, id: UUID): number {
  return ancestorsOf(project, id).length;
}

/** Every descendant of `id`, depth-first. Does not include `id` itself. */
export function descendantsOf(project: MapProject, id: UUID): Territory[] {
  const byParent = new Map<UUID, Territory[]>();
  for (const t of Object.values(project.territories)) {
    if (!t.parentId) continue;
    const list = byParent.get(t.parentId);
    if (list) list.push(t);
    else byParent.set(t.parentId, [t]);
  }
  const out: Territory[] = [];
  const stack = [...(byParent.get(id) ?? [])];
  const seen = new Set<UUID>();
  while (stack.length) {
    const t = stack.pop()!;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    stack.push(...(byParent.get(t.id) ?? []));
  }
  return out;
}

/**
 * Guard against building a cycle when the user re-parents a territory.
 * Returns true when `candidateParent` is `id` or sits below it.
 */
export function wouldCreateCycle(project: MapProject, id: UUID, candidateParent: UUID | null): boolean {
  if (!candidateParent) return false;
  if (candidateParent === id) return true;
  const seen = new Set<UUID>();
  let cur: UUID | null = candidateParent;
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = project.territories[cur]?.parentId ?? null;
  }
  return false;
}

/** The sovereign at the top of a territory's chain (itself, if it has no parent). */
export function sovereignOf(project: MapProject, id: UUID): Territory | undefined {
  const chain = ancestorsOf(project, id);
  return chain.length ? chain[chain.length - 1] : project.territories[id];
}

/**
 * The line that goes under a territory's name, or null (spec §26).
 *
 * Generated from the relationship's own template rather than stored, so the
 * moment Dubuque stops being a vassal the line stops claiming it is one. The
 * only substitution is `{parent}`, which takes the parent's short name where it
 * has one — "Vassal of the M.C." is what the reference plate prints, not "Vassal
 * of the Midwest Confederation", because the note is an annotation and has to
 * fit under the name.
 *
 * A relationship whose meaning is already obvious from the map gets no line: an
 * ordinary canton of a realm does not need telling that it is one, and neither
 * does a sovereign.
 */
export function relationshipSubtitle(project: MapProject, t: Territory): string | null {
  const template = relationshipInfo(t.relationship).subtitle;
  if (!template) return null;
  if (!template.includes('{parent}')) return template;
  const parent = t.parentId ? project.territories[t.parentId] : undefined;
  if (!parent) return null;
  return template.replace('{parent}', parent.shortName || parent.name);
}

/** True when a layer, or any of its ancestors, is hidden/locked. */
export function layerEffective(project: MapProject, layerId: UUID): { visible: boolean; locked: boolean; opacity: number } {
  let visible = true;
  let locked = false;
  let opacity = 1;
  const seen = new Set<UUID>();
  let cur: UUID | null = layerId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const l: MapLayer | undefined = project.layers[cur];
    if (!l) break;
    visible = visible && l.visible;
    locked = locked || l.locked;
    opacity *= l.opacity;
    cur = l.parentId;
  }
  return { visible, locked, opacity };
}

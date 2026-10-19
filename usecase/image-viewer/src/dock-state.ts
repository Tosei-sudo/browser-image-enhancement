/**
 * Where the panels of the viewer are, as plain data (src/dock.ts draws it):
 * three docks around the map (left, right and below), each a row of groups
 * (one under another on the sides, side by side below), each group a stack
 * of panels shown one at a time as tabs; and the panels floating over the
 * map, each at its own place. Panels are named by an id. An id may stay in a
 * group while its panel is not open (a closed dialog), so that it opens
 * there again.
 */

export type DockSide = 'left' | 'right' | 'bottom';
export const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'bottom'];

export interface DockGroupState {
  /** Panel ids, in tab order. */
  panels: string[];
  /** The tab in front. */
  active?: string;
  /** Share of the dock's length, against the other groups of the dock (default 1). */
  weight?: number;
}

/** A floating panel's place and size, in CSS pixels of the page. */
export interface FloatRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockState {
  left: DockGroupState[];
  right: DockGroupState[];
  bottom: DockGroupState[];
  float: Record<string, FloatRect>;
}

/** Where a dragged panel goes. */
export type DropTarget =
  /** Into a group, as a tab. */
  | { kind: 'tab'; side: DockSide; group: number }
  /** A new group of its own, at `index` of the dock's groups. */
  | { kind: 'split'; side: DockSide; index: number }
  /** Floating over the map. */
  | { kind: 'float'; rect: FloatRect };

/** Where a panel is now. */
export type PanelPlace = { side: DockSide; group: number; index: number } | { side: 'float'; rect: FloatRect };

/** The layout as it first was: the layers on the left, the attribute table below, the dashboard on the right. */
export function defaultDockState(): DockState {
  return {
    left: [{ panels: ['layers'], active: 'layers' }],
    right: [{ panels: ['dashboard'], active: 'dashboard' }],
    bottom: [{ panels: ['table'], active: 'table' }],
    float: {},
  };
}

function clone(state: DockState): DockState {
  return {
    left: state.left.map((g) => ({ ...g, panels: [...g.panels] })),
    right: state.right.map((g) => ({ ...g, panels: [...g.panels] })),
    bottom: state.bottom.map((g) => ({ ...g, panels: [...g.panels] })),
    float: Object.fromEntries(Object.entries(state.float).map(([id, r]) => [id, { ...r }])),
  };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A layout read from storage or a project file, checked; null when it is not one. Each id is kept once, its first place. */
export function normalizeDockState(value: unknown): DockState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const seen = new Set<string>();
  const state: DockState = { left: [], right: [], bottom: [], float: {} };
  for (const side of DOCK_SIDES) {
    const groups = v[side];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return null;
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray((g as DockGroupState).panels)) continue;
      const panels: string[] = [];
      for (const p of (g as DockGroupState).panels as unknown[]) {
        if (typeof p !== 'string' || p === '' || seen.has(p)) continue;
        seen.add(p);
        panels.push(p);
      }
      if (!panels.length) continue;
      const { active, weight } = g as DockGroupState;
      state[side].push({
        panels,
        active: typeof active === 'string' && panels.includes(active) ? active : panels[0],
        ...(finite(weight) && weight > 0 ? { weight } : {}),
      });
    }
  }
  const float = v.float;
  if (float && typeof float === 'object') {
    for (const [id, r] of Object.entries(float as Record<string, Partial<FloatRect>>)) {
      if (seen.has(id) || !r || !finite(r.left) || !finite(r.top) || !finite(r.width) || !finite(r.height) || r.width <= 0 || r.height <= 0) continue;
      seen.add(id);
      state.float[id] = { left: r.left, top: r.top, width: r.width, height: r.height };
    }
  }
  return state;
}

/** Where the panel `id` is, or null when the layout has no place for it. */
export function findPanel(state: DockState, id: string): PanelPlace | null {
  for (const side of DOCK_SIDES) {
    const groups = state[side];
    for (let g = 0; g < groups.length; g++) {
      const index = groups[g].panels.indexOf(id);
      if (index >= 0) return { side, group: g, index };
    }
  }
  const rect = state.float[id];
  return rect ? { side: 'float', rect } : null;
}

/** Drops empty groups and keeps every group's front tab one of its panels. */
function tidy(state: DockState): DockState {
  for (const side of DOCK_SIDES) {
    state[side] = state[side].filter((g) => g.panels.length > 0);
    for (const g of state[side]) if (!g.active || !g.panels.includes(g.active)) g.active = g.panels[0];
  }
  return state;
}

/** The layout without the panel `id` (its place forgotten). */
export function removePanel(state: DockState, id: string): DockState {
  const next = clone(state);
  for (const side of DOCK_SIDES) for (const g of next[side]) g.panels = g.panels.filter((p) => p !== id);
  delete next.float[id];
  return tidy(next);
}

/** The layout with the panel `id` moved to `target` (also when it had no place before). */
export function movePanel(state: DockState, id: string, target: DropTarget): DockState {
  const next = clone(state);
  // Taken out first, but its group stays (maybe empty) until the end, so the target's indexes still hold.
  for (const side of DOCK_SIDES) for (const g of next[side]) g.panels = g.panels.filter((p) => p !== id);
  delete next.float[id];
  if (target.kind === 'tab') {
    const group = next[target.side][target.group];
    if (group) {
      group.panels.push(id);
      group.active = id;
    } else next[target.side].push({ panels: [id], active: id });
  } else if (target.kind === 'split') {
    const index = Math.max(0, Math.min(target.index, next[target.side].length));
    next[target.side].splice(index, 0, { panels: [id], active: id });
  } else {
    next.float[id] = { ...target.rect };
  }
  return tidy(next);
}

/**
 * The layout with the panel `id` at its usual place, when it has none: a tab
 * beside the panel `withId` when that one is docked, else a new group at
 * the end of the dock `home`.
 */
export function placeAtHome(state: DockState, id: string, home: DockSide, withId?: string): DockState {
  if (findPanel(state, id)) return state;
  const beside = withId ? findPanel(state, withId) : null;
  if (beside && beside.side !== 'float') {
    const next = clone(state);
    next[beside.side][beside.group].panels.push(id);
    return next;
  }
  return movePanel(state, id, { kind: 'split', side: home, index: state[home].length });
}

/** The layout with `id` in front of its group. */
export function activatePanel(state: DockState, id: string): DockState {
  const at = findPanel(state, id);
  if (!at || at.side === 'float' || state[at.side][at.group].active === id) return state;
  const next = clone(state);
  next[at.side][at.group].active = id;
  return next;
}

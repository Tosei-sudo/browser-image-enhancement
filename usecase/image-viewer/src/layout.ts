/**
 * The screen layout kept in a project: the widths and heights of the panels
 * around the map, which side sections are open, whether the attribute table
 * is folded, and the timeline and the dashboard as they were.
 */
import type { AttributeTable } from './table.js';
import type { Dashboard, DashboardState } from './dashboard.js';
import type { Timeline, TimelineState } from './timeline.js';

/** The layout part of a project file. */
export interface ProjectLayout {
  /** Pixels; absent: the default size. */
  sideWidth?: number;
  dashboardWidth?: number;
  tableHeight?: number;
  tableCollapsed?: boolean;
  /** Side sections (their `data-fold`), open or not. */
  folds?: Record<string, boolean>;
  timeline?: Partial<TimelineState>;
  /** The dashboard; its `layer` is an index in the project's layers. */
  dashboard?: Partial<DashboardState>;
}

/** What the layout is made of. */
export interface LayoutParts {
  app: HTMLElement;
  side: HTMLElement;
  table: AttributeTable;
  timeline: Timeline;
  dashboard: Dashboard;
  /** Called after sizes change (the map needs updateSize). */
  onResize: () => void;
}

const sizes: Array<[key: 'sideWidth' | 'dashboardWidth' | 'tableHeight', property: string, element: (p: LayoutParts) => HTMLElement]> = [
  ['sideWidth', '--side-width', (p) => p.app],
  ['dashboardWidth', '--dash-width', (p) => p.app],
  ['tableHeight', '--table-height', (p) => p.table.element],
];

/** The layout now. `indexOf` turns a layer of the list into its index in the project (-1: not saved). */
export function collectLayout(parts: LayoutParts, indexOf: (listIndex: number) => number): ProjectLayout {
  const layout: ProjectLayout = {};
  for (const [key, property, element] of sizes) {
    const px = parseFloat(element(parts).style.getPropertyValue(property));
    if (Number.isFinite(px) && px > 0) layout[key] = Math.round(px);
  }
  layout.tableCollapsed = parts.table.isCollapsed();
  layout.folds = {};
  for (const fold of parts.side.querySelectorAll<HTMLDetailsElement>('details.fold[data-fold]')) {
    if (!fold.hidden) layout.folds[fold.dataset.fold!] = fold.open;
  }
  layout.timeline = parts.timeline.getState();
  const dashboard = parts.dashboard.getState();
  const layer = dashboard.layer === null ? -1 : indexOf(dashboard.layer);
  layout.dashboard = { ...dashboard, layer: layer >= 0 ? layer : null };
  return layout;
}

/** Puts the layout as saved. `listIndexOf` turns a project's layer index into its index in the list (-1: not open). */
export function applyLayout(parts: LayoutParts, layout: ProjectLayout, listIndexOf: (projectIndex: number) => number): void {
  for (const [key, property, element] of sizes) {
    const px = layout[key];
    if (typeof px === 'number' && px > 0) element(parts).style.setProperty(property, `${px}px`);
    else element(parts).style.removeProperty(property);
  }
  if (typeof layout.tableCollapsed === 'boolean') parts.table.setCollapsed(layout.tableCollapsed);
  for (const fold of parts.side.querySelectorAll<HTMLDetailsElement>('details.fold[data-fold]')) {
    const open = layout.folds?.[fold.dataset.fold!];
    if (typeof open === 'boolean') fold.open = open;
  }
  if (layout.timeline) parts.timeline.setState(layout.timeline);
  else parts.timeline.setOpen(false);
  if (layout.dashboard) {
    const index = typeof layout.dashboard.layer === 'number' ? listIndexOf(layout.dashboard.layer) : -1;
    parts.dashboard.setState({ ...layout.dashboard, layer: index >= 0 ? index : null });
  } else parts.dashboard.setOpen(false);
  parts.onResize();
}

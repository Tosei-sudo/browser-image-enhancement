import { describe, expect, it } from 'vitest';
import { activatePanel, defaultDockState, findPanel, movePanel, normalizeDockState, placeAtHome, removePanel } from '../src/dock-state.js';

describe('dock state', () => {
  it('moves a panel into a group as a tab, and the emptied group goes', () => {
    const s = movePanel(defaultDockState(), 'table', { kind: 'tab', side: 'left', group: 0 });
    expect(s.left).toEqual([{ panels: ['layers', 'table'], active: 'table' }]);
    expect(s.bottom).toEqual([]);
  });

  it('splits a dock, the target index taken before the panel left', () => {
    let s = movePanel(defaultDockState(), 'a', { kind: 'split', side: 'left', index: 1 });
    s = movePanel(s, 'b', { kind: 'split', side: 'left', index: 2 });
    expect(s.left.map((g) => g.panels)).toEqual([['layers'], ['a'], ['b']]);
    // 'a' after 'b': its own group's place still counts while it moves.
    s = movePanel(s, 'a', { kind: 'split', side: 'left', index: 3 });
    expect(s.left.map((g) => g.panels)).toEqual([['layers'], ['b'], ['a']]);
  });

  it('floats and comes back', () => {
    let s = movePanel(defaultDockState(), 'table', { kind: 'float', rect: { left: 10, top: 20, width: 300, height: 200 } });
    expect(findPanel(s, 'table')).toEqual({ side: 'float', rect: { left: 10, top: 20, width: 300, height: 200 } });
    s = movePanel(s, 'table', { kind: 'split', side: 'bottom', index: 0 });
    expect(s.float).toEqual({});
    expect(findPanel(s, 'table')).toEqual({ side: 'bottom', group: 0, index: 0 });
  });

  it('places a new panel beside another, or at the end of its dock', () => {
    let s = placeAtHome(defaultDockState(), 'table:1', 'bottom', 'table');
    expect(s.bottom).toEqual([{ panels: ['table', 'table:1'], active: 'table' }]);
    s = placeAtHome(s, 'dialog:x', 'right');
    expect(s.right.map((g) => g.panels)).toEqual([['dashboard'], ['dialog:x']]);
    // Already placed: unchanged.
    expect(placeAtHome(s, 'table', 'left')).toBe(s);
    s = activatePanel(s, 'table:1');
    expect(s.bottom[0].active).toBe('table:1');
    s = removePanel(s, 'table:1');
    expect(s.bottom).toEqual([{ panels: ['table'], active: 'table' }]);
  });

  it('reads a saved layout, dropping what is not one', () => {
    expect(normalizeDockState(null)).toBeNull();
    expect(normalizeDockState({ left: 'x' })).toBeNull();
    const s = normalizeDockState({
      left: [{ panels: ['layers', 3, 'layers'], active: 'nope', weight: -1 }, { panels: [] }],
      bottom: [{ panels: ['table'], weight: 2 }],
      float: { a: { left: 1, top: 2, width: 3, height: 4 }, table: { left: 0, top: 0, width: 1, height: 1 }, b: { left: 'x' } },
    });
    expect(s).toEqual({
      left: [{ panels: ['layers'], active: 'layers' }],
      right: [],
      bottom: [{ panels: ['table'], active: 'table', weight: 2 }],
      float: { a: { left: 1, top: 2, width: 3, height: 4 } },
    });
  });
});

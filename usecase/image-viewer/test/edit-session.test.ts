import { describe, expect, it, vi } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import type { Field } from '../src/services/index.js';

vi.mock('../src/services/esri.js', () => ({
  esriGeometry: () => ({}),
  queryIds: async () => [],
  // The server refuses the update of OBJECTID 2 and takes everything else.
  applyEdits: async (_info: unknown, edits: { updates: Array<{ attributes: { OBJECTID: number } }> }) => ({
    addResults: [],
    updateResults: edits.updates.map((u) => (u.attributes.OBJECTID === 2 ? { success: false, error: { code: 1, description: 'refused' } } : { success: true })),
    deleteResults: [],
  }),
}));

const { EditSession } = await import('../src/edit-session.js');

const name: Field = { name: 'NAME', alias: 'NAME', type: 'string', editable: true, nullable: true };
const info = { url: 'x', name: 'x', geometryType: 'esriGeometryPoint', objectIdField: 'OBJECTID', canCreate: true, canUpdate: true, canDelete: true, template: {} };

function feature(id: number, value: string): Feature {
  return new Feature({ geometry: new Point([0, 0]), OBJECTID: id, NAME: value });
}

describe('EditSession.save', () => {
  it('drops the undo steps of saved edits when others fail, so undo cannot silently change saved values', async () => {
    const a = feature(1, 'a');
    const b = feature(2, 'b');
    const session = new EditSession(info, new VectorSource({ features: [a, b] }), [name]);
    session.setAttribute(a, name, 'a2');
    session.setAttribute(b, name, 'b2');
    const outcome = await session.save();
    expect(outcome.saved).toBe(1);
    expect(outcome.failed.map((f) => f.feature)).toEqual([b]);
    // Only the failed edit is left to undo; the saved value of `a` stays.
    session.undo();
    expect(a.get('NAME')).toBe('a2');
    expect(b.get('NAME')).toBe('b');
    expect(session.canUndo()).toBe(false);
    expect(session.count()).toBe(0);
  });
});

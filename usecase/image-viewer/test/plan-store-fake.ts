/**
 * A stand-in for an editable Esri polygon layer of imaging plan shots and an
 * image catalog layer, answering the requests imaging-plan-store.ts makes
 * (layer info, query with paging and simple where clauses, applyEdits,
 * deleteFeatures) from memory. Used by the unit tests as their `ask`, and by
 * the browser tests behind page.route.
 */
export interface FakeImage {
  attributes: Record<string, unknown>;
  /** Longitude / latitude box the image covers. */
  box: [number, number, number, number];
}

export function fakeEsri(planUrl: string, catalogUrl: string, images: FakeImage[] = []) {
  const shots: Array<{ attributes: Record<string, unknown>; geometry: { rings: number[][][] } }> = [];
  let next = 1;
  const fields = ['OBJECTID', 'PLAN_ID', 'PLAN_NAME', 'SHOT_TIME', 'SATELLITE', 'SATELLITE_ID', 'TARGET', 'OFF_NADIR', 'INCIDENCE', 'PASS_DIR', 'LOOK_SIDE', 'STATUS', 'IMAGE_ID', 'CREATED_AT'];
  const types: Record<string, string> = { OBJECTID: 'esriFieldTypeOID', SHOT_TIME: 'esriFieldTypeDate', CREATED_AT: 'esriFieldTypeDate', OFF_NADIR: 'esriFieldTypeDouble', INCIDENCE: 'esriFieldTypeDouble' };
  const asked: Array<{ url: string; params: Record<string, string> }> = [];
  /** `A = 'x'`, and `F >= TIMESTAMP '…' AND F <= TIMESTAMP '…'`. */
  const matches = (where: string, a: Record<string, unknown>) => {
    if (!where || where === '1=1') return true;
    return where.split(/\s+AND\s+/i).every((part) => {
      const eq = /^(\w+)\s*=\s*'(.*)'$/.exec(part.trim());
      if (eq) return String(a[eq[1]]) === eq[2].replaceAll("''", "'");
      const cmp = /^(\w+)\s*(>=|<=)\s*TIMESTAMP\s*'(.+)'$/.exec(part.trim());
      if (cmp) {
        const t = Date.parse(`${cmp[3].replace(' ', 'T')}Z`);
        const v = Number(a[cmp[1]]);
        return cmp[2] === '>=' ? v >= t : v <= t;
      }
      return true;
    });
  };
  const boxOf = (rings: number[][][]) => {
    const xs = rings.flat().map((p) => p[0]);
    const ys = rings.flat().map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const overlaps = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const answer = (url: string, params: Record<string, string>): unknown => {
    asked.push({ url, params });
    if (url === planUrl) return { objectIdField: 'OBJECTID', geometryType: 'esriGeometryPolygon', fields: fields.map((name) => ({ name, type: types[name] ?? 'esriFieldTypeString' })) };
    if (url === `${planUrl}/applyEdits`) {
      const adds = JSON.parse(params.adds ?? '[]') as typeof shots;
      const updates = JSON.parse(params.updates ?? '[]') as Array<{ attributes: Record<string, unknown> }>;
      for (const f of adds) shots.push({ attributes: { ...f.attributes, OBJECTID: next++ }, geometry: f.geometry });
      for (const u of updates) {
        const s = shots.find((x) => x.attributes.OBJECTID === u.attributes.OBJECTID);
        if (s) Object.assign(s.attributes, u.attributes);
      }
      return { addResults: adds.map(() => ({ success: true })), updateResults: updates.map(() => ({ success: true })), deleteResults: [] };
    }
    if (url === `${planUrl}/deleteFeatures`) {
      const keep = shots.filter((s) => !matches(params.where, s.attributes));
      shots.splice(0, shots.length, ...keep);
      return { success: true };
    }
    if (url === `${planUrl}/query`) {
      const found = shots.filter((s) => matches(params.where, s.attributes));
      const offset = Number(params.resultOffset ?? 0);
      const count = Number(params.resultRecordCount ?? 2000);
      const page = found.slice(offset, offset + count);
      return { features: page.map((s) => ({ attributes: { ...s.attributes }, ...(params.returnGeometry === 'true' ? { geometry: s.geometry } : {}) })), exceededTransferLimit: offset + count < found.length };
    }
    if (url === catalogUrl) return { fields: [{ name: 'IMAGE_ID', type: 'esriFieldTypeString' }, { name: 'ACQ', type: 'esriFieldTypeDate' }, { name: 'SENSOR', type: 'esriFieldTypeString' }] };
    if (url === `${catalogUrl}/query`) {
      const area = params.geometry ? boxOf((JSON.parse(params.geometry) as { rings: number[][][] }).rings) : null;
      const found = images.filter((im) => matches(params.where, im.attributes) && (!area || overlaps(area, im.box)));
      return {
        features: found.map((im) => ({
          attributes: im.attributes,
          geometry: { rings: [[[im.box[0], im.box[1]], [im.box[0], im.box[3]], [im.box[2], im.box[3]], [im.box[2], im.box[1]], [im.box[0], im.box[1]]]], spatialReference: { wkid: 4326 } },
        })),
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { shots, asked, answer, ask: async (url: string, params: Record<string, string>) => answer(url, params) };
}

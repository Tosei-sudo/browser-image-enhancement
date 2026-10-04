import { describe, expect, it } from 'vitest';
import { formatLatLon, formatMgrs, formatUtm, parseCoordinate } from '../src/coordinates.js';

// Tokyo Station.
const TOKYO: [number, number] = [139.7671, 35.6812];

function near(actual: [number, number] | null, expected: [number, number], digits = 4) {
  expect(actual).not.toBeNull();
  expect(actual![0]).toBeCloseTo(expected[0], digits);
  expect(actual![1]).toBeCloseTo(expected[1], digits);
}

describe('format', () => {
  it('writes latitude first, MGRS and UTM', () => {
    expect(formatLatLon(TOKYO)).toBe('35.681200, 139.767100');
    expect(formatMgrs(TOKYO)).toMatch(/^54S UE \d{5} \d{5}$/);
    expect(formatUtm(TOKYO)).toMatch(/^54N \d{6} \d{7}$/);
    expect(formatUtm([-70.6, -33.45])).toMatch(/^19S \d{6} \d{7}$/); // Santiago: southern hemisphere
  });

  it('round-trips through the parser', () => {
    near(parseCoordinate(formatLatLon(TOKYO)), TOKYO, 6);
    near(parseCoordinate(formatMgrs(TOKYO)!), TOKYO, 4);
    near(parseCoordinate(formatUtm(TOKYO)!), TOKYO, 4);
    near(parseCoordinate(formatUtm([-70.6, -33.45])!), [-70.6, -33.45], 4);
  });
});

describe('parseCoordinate', () => {
  it.each([
    ['35.6812, 139.7671'],
    ['35.6812 139.7671'],
    ['35.6812,139.7671'],
    ['N35.6812 E139.7671'],
    ['35.6812N 139.7671E'],
    ['139.7671E, 35.6812N'],
    ['E139.7671 N35.6812'],
  ])('decimal degrees: %s', (text) => near(parseCoordinate(text), TOKYO));

  it('degrees, minutes and seconds', () => {
    near(parseCoordinate(`35°40'52.32"N 139°46'1.56"E`), TOKYO);
    near(parseCoordinate('35 40 52.32 139 46 1.56'), TOKYO);
    near(parseCoordinate('35°40.872′N, 139°46.026′E'), TOKYO);
    near(parseCoordinate(`33°27'S 70°36'W`), [-70.6, -33.45]);
  });

  it('negative decimals', () => near(parseCoordinate('-33.45, -70.6'), [-70.6, -33.45]));

  it('MGRS at any precision', () => {
    near(parseCoordinate('54SUE8843349290'), TOKYO, 3);
    near(parseCoordinate('54s ue 88433 49290'), TOKYO, 3);
    near(parseCoordinate('54SUE884492'), TOKYO, 2);
  });

  it('UTM with N/S for the hemisphere', () => {
    const utm = formatUtm(TOKYO)!;
    const [zone, e, n] = utm.split(' ');
    near(parseCoordinate(`${zone} ${e}mE ${n}mN`), TOKYO);
    near(parseCoordinate(`${zone}, ${e}, ${n}`), TOKYO);
  });

  it.each([[''], ['hello'], ['95, 10'], ['10, 200'], ['54SUE884'], ['35.6'], ['61N 500000 4000000']])('rejects %s', (text) =>
    expect(parseCoordinate(text)).toBeNull(),
  );
});

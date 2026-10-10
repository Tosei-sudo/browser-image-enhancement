import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import {
  addTime,
  defaultTimeFields,
  floorTime,
  formatTime,
  parseDuration,
  parseTime,
  stepAtLeast,
  timeFields,
  timeFromGdalMetadata,
  timeFromName,
  wmsTimes,
  wmsTimeText,
} from '../src/time.js';
import type { Field } from '../src/services/index.js';

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const field = (name: string, type: Field['type'] = 'string'): Field => ({ name, alias: name, type, editable: false, nullable: true });

describe('parseTime', () => {
  it('reads the common ways of writing a date', () => {
    expect(parseTime('2024-05-01')).toBe(local(2024, 5, 1));
    expect(parseTime('2024/5/1 10:30')).toBe(local(2024, 5, 1, 10, 30));
    expect(parseTime('2024-05-01T10:30:15')).toBe(local(2024, 5, 1, 10, 30, 15));
    expect(parseTime('2024-05-01T01:30:00Z')).toBe(Date.UTC(2024, 4, 1, 1, 30));
    expect(parseTime('2024-05-01T10:30:00+09:00')).toBe(Date.UTC(2024, 4, 1, 1, 30));
    expect(parseTime('2024:05:01 10:30:00')).toBe(local(2024, 5, 1, 10, 30));
    expect(parseTime('20240501')).toBe(local(2024, 5, 1));
    expect(parseTime('20240501T103000Z')).toBe(Date.UTC(2024, 4, 1, 10, 30));
    expect(parseTime('2024年5月1日')).toBe(local(2024, 5, 1));
    expect(parseTime('2024年5月1日 10時30分')).toBe(local(2024, 5, 1, 10, 30));
    expect(parseTime('2024-05')).toBe(local(2024, 5, 1));
  });

  it('leaves out what is not a date', () => {
    expect(parseTime('2024-02-31')).toBeNull();
    expect(parseTime('2024-13-01')).toBeNull();
    expect(parseTime('東京')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(parseTime(null)).toBeNull();
    // Numbers only with a hint.
    expect(parseTime(2024)).toBeNull();
    expect(parseTime('2024')).toBeNull();
    expect(parseTime(2024, 'year')).toBe(local(2024, 1, 1));
    expect(parseTime(1714521600000, 'date')).toBe(1714521600000);
  });
});

describe('timeFields', () => {
  const features = [
    new Feature({ name: 'a', observed: '2024-05-01', year: 2020, count: 3, start_date: '2024-05-01', end_date: '2024-05-03' }),
    new Feature({ name: 'b', observed: '2024-06-01', year: 2021, count: 2020, start_date: '2024-06-01', end_date: null }),
  ];
  const fields = [field('name'), field('observed'), field('year', 'integer'), field('count', 'integer'), field('start_date'), field('end_date'), field('updated', 'date')];

  it('finds date attributes, text that reads as dates, and years', () => {
    const found = timeFields(fields, features).map((f) => `${f.name}:${f.hint}`);
    expect(found[0]).toBe('updated:date');
    expect(found).toContain('observed:text');
    expect(found).toContain('year:year');
    expect(found).toContain('start_date:text');
    expect(found).toContain('end_date:text');
    expect(found.some((f) => f.startsWith('count') || f.startsWith('name'))).toBe(false);
  });

  it('pairs a start attribute with its end, and follows an Esri timeInfo', () => {
    const candidates = timeFields(fields.filter((f) => f.name !== 'updated'), features);
    const { start, end } = defaultTimeFields(candidates);
    expect(start?.name).toBe('start_date');
    expect(end?.name).toBe('end_date');
    expect(defaultTimeFields(candidates, { start: 'observed' }).start?.name).toBe('observed');
    expect(defaultTimeFields(candidates, { start: 'observed' }).end).toBeNull();
  });
});

describe('image times', () => {
  it('reads the time in a file name', () => {
    expect(timeFromName('S2A_MSIL2A_20240501T012345_N0510.tif')).toBe(local(2024, 5, 1, 1, 23, 45));
    expect(timeFromName('/data/img_2024-05-01.tif')).toBe(local(2024, 5, 1));
    expect(timeFromName('scene_20240501.tif')).toBe(local(2024, 5, 1));
    expect(timeFromName('photo_123456789.tif')).toBeNull();
    expect(timeFromName('ortho.tif')).toBeNull();
  });

  it('reads the acquisition time in GDAL metadata', () => {
    const xml = `<GDALMetadata><Item name="PROCESSING_TIME">2025-01-01T00:00:00Z</Item><Item name="ACQUISITION_DATETIME">2024-05-01T01:02:03Z</Item></GDALMetadata>`;
    expect(timeFromGdalMetadata(xml)).toBe(Date.UTC(2024, 4, 1, 1, 2, 3));
    expect(timeFromGdalMetadata('<GDALMetadata><Item name="acquisition_start_utc">2024-05-01T01:02:03.5Z</Item></GDALMetadata>')).toBe(Date.UTC(2024, 4, 1, 1, 2, 3, 500));
    expect(timeFromGdalMetadata('<GDALMetadata><Item name="BAND">1</Item></GDALMetadata>')).toBeNull();
  });
});

describe('the time axis', () => {
  it('steps along the calendar', () => {
    expect(addTime(local(2024, 1, 31), 'month', 1)).toBe(local(2024, 2, 29));
    expect(addTime(local(2024, 5, 1), 'year', 1)).toBe(local(2025, 5, 1));
    expect(floorTime(local(2024, 5, 15, 13), 'month')).toBe(local(2024, 5, 1));
    // Weeks start on Monday: 2024-05-15 is a Wednesday.
    expect(floorTime(local(2024, 5, 15, 13), 'week')).toBe(local(2024, 5, 13));
    expect(floorTime(local(2024, 5, 15, 13, 47), 'hour')).toBe(local(2024, 5, 15, 13));
    expect(floorTime(local(2024, 5, 15), 'year', 10)).toBe(local(2020, 1, 1));
  });

  it('picks steps and formats times', () => {
    expect(stepAtLeast(86_400_000)).toEqual({ unit: 'day', count: 1 });
    expect(stepAtLeast(40 * 86_400_000).unit).toBe('month');
    expect(formatTime(local(2024, 5, 1, 9, 5), 'minute')).toBe('2024-05-01 09:05');
    expect(formatTime(local(2024, 5, 1), 'month')).toBe('2024-05');
  });
});

describe('WMS time dimensions', () => {
  it('reads lists and intervals with a period', () => {
    expect(wmsTimes('2024-01-01,2024-02-01').times).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1)]);
    const { times, dateOnly } = wmsTimes('2024-01-01/2024-04-01/P1M');
    expect(times).toEqual([0, 1, 2, 3].map((m) => Date.UTC(2024, m, 1)));
    expect(dateOnly).toBe(true);
    const hourly = wmsTimes('2024-01-01T00:00:00Z/2024-01-01T03:00:00Z/PT1H');
    expect(hourly.times).toHaveLength(4);
    expect(hourly.dateOnly).toBe(false);
    expect(parseDuration('P1Y2M')).toEqual([
      ['year', 1],
      ['month', 2],
    ]);
    expect(parseDuration('P')).toBeNull();
  });

  it('asks for a day or an instant in UTC', () => {
    expect(wmsTimeText(Date.UTC(2024, 4, 1), true)).toBe('2024-05-01');
    expect(wmsTimeText(Date.UTC(2024, 4, 1, 3), false)).toBe('2024-05-01T03:00:00Z');
  });
});

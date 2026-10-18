import { describe, expect, it } from 'vitest';
import { groupNameOf } from '../src/images.js';
import { RsetCancelled, RsetQueue } from '../src/rset.js';
import { PROJECT_FORMAT, readProject } from '../src/project-file.js';

describe('groupNameOf', () => {
  it('names files opened together by what their names begin with', () => {
    expect(groupNameOf(['LC08_L1TP_107035_B4.TIF', 'LC08_L1TP_107035_B3.TIF', 'LC08_L1TP_107035_B2.TIF'])).toBe('LC08_L1TP_107035');
    expect(groupNameOf(['tokyo-2024-01.tif', 'tokyo-2024-02.tif'])).toBe('tokyo-2024');
    expect(groupNameOf(['image1.png', 'image2.png'])).toBe('image');
    expect(groupNameOf(['scene_a.tif', 'scene_b.tif'])).toBe('scene');
  });

  it('names them by the time they were opened when the names have little in common', () => {
    expect(groupNameOf(['a.tif', 'b.tif'], new Date(2026, 9, 18, 9, 5))).toBe('開いたファイル 09:05');
    expect(groupNameOf(['ab1.tif', 'ab2.tif'], new Date(2026, 9, 18, 21, 30))).toBe('開いたファイル 21:30');
  });
});

describe('RsetQueue', () => {
  const later = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('runs a few at a time, the best ranked next, and drops those no longer wanted', async () => {
    const queue = new RsetQueue(1);
    const started: string[] = [];
    const gate = later();
    const waiting: number[] = [];
    queue.onChange((n) => waiting.push(n));
    const first = queue.run('a', async () => {
      started.push('a');
      await gate.promise;
      return 'a';
    });
    const ranks: Record<string, number | null> = { b: 5, c: 1, d: null };
    const run = (name: string) =>
      queue.run(
        name,
        async () => {
          started.push(name);
          return name;
        },
        () => ranks[name],
      );
    const b = run('b');
    const c = run('c');
    const d = run('d');
    expect(started).toEqual(['a']);
    expect(queue.waiting()).toBe(3);
    gate.resolve();
    expect(await first).toBe('a');
    await expect(d).rejects.toBeInstanceOf(RsetCancelled);
    expect(await c).toBe('c');
    expect(await b).toBe('b');
    expect(started).toEqual(['a', 'c', 'b']);
    expect(waiting.at(-1)).toBe(0);
  });
});

describe('project groups', () => {
  const project = (extra: object) =>
    JSON.stringify({
      format: PROJECT_FORMAT,
      version: 1,
      id: 'p',
      baseMap: '',
      view: null,
      fileSets: [],
      selected: null,
      layers: [
        { type: 'image', name: 'a.tif', source: { kind: 'url', url: 'https://example.com/a.tif' }, visible: true, opacity: 1, group: 0 },
        { type: 'image', name: 'b.tif', source: { kind: 'url', url: 'https://example.com/b.tif' }, visible: true, opacity: 1, group: 3 },
        { type: 'image', name: 'c.tif', source: { kind: 'url', url: 'https://example.com/c.tif' }, visible: true, opacity: 1 },
      ],
      ...extra,
    });

  it('reads the groups and which layers are in them', () => {
    const { project: read } = readProject(project({ groups: [{ name: '衛星', visible: false, collapsed: true }] }));
    expect(read.groups).toEqual([{ name: '衛星', visible: false, collapsed: true }]);
    // A group that is not there is no group.
    expect(read.layers.map((l) => l.group)).toEqual([0, undefined, undefined]);
  });

  it('reads a project without groups as before', () => {
    const { project: read } = readProject(project({}));
    expect(read.groups).toBeUndefined();
    expect(read.layers.every((l) => l.group === undefined)).toBe(true);
  });
});

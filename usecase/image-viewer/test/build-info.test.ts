import { describe, expect, it } from 'vitest';
import { buildLabel } from '../src/build-info.js';

describe('buildLabel', () => {
  it('shows version, run, commit and local build time', () => {
    const date = new Date(2026, 9, 4, 18, 5).toISOString();
    expect(buildLabel({ version: '0.1.0', commit: '1ff993b', run: '42', date })).toBe(
      'v0.1.0 · ビルド #42 · 1ff993b · 2026-10-04 18:05',
    );
  });

  it('leaves out what a local build does not know', () => {
    expect(buildLabel({ version: '0.1.0', commit: '', run: '', date: 'x' })).toBe('v0.1.0');
  });
});

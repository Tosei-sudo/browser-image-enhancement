import { describe, expect, it } from 'vitest';
import { GLOSSARY, HELP_TOPICS, searchHelp } from '../src/help.js';

describe('help', () => {
  it('names every task once', () => {
    const ids = HELP_TOPICS.flatMap(([, topics]) => topics.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, topics] of HELP_TOPICS) for (const t of topics) expect(t.steps.length).toBeGreaterThan(0);
  });

  it('finds tasks by the words of their steps, and kana finds kanji', () => {
    expect(searchHelp('明るく').topics[0].id).toBe('enhance');
    expect(searchHelp('きょり').topics.map((t) => t.id)).toContain('measure');
    expect(searchHelp('pdf').topics[0].id).toBe('print');
  });

  it('finds words of the glossary by their reading', () => {
    expect(searchHelp('おるそ').terms.map(([term]) => term)).toContain('オルソ補正');
    expect(GLOSSARY.every(([term, , text]) => term && text)).toBe(true);
  });

  it('finds nothing for words in neither', () => {
    const { topics, terms } = searchHelp('ぜんぜんない言葉');
    expect(topics).toEqual([]);
    expect(terms).toEqual([]);
  });
});

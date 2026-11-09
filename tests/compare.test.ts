/**
 * Tests for comparison logic:
 * - Whitespace-only differences equal
 * - Paragraph breaks differ
 * - Word diff output
 */

import { describe, it, expect } from 'vitest';
import {
  normaliseForCompare,
  unitsAreEqual,
  wordDiff,
} from '../src/pipeline/parse';

describe('Comparison logic', () => {
  it('treats whitespace-only differences as equal', () => {
    const a = [
      { text: 'Article 1er. —    Le présent décret règle   les conditions.' },
      { text: 'Il   est applicable immédiatement.' },
    ];
    const b = [
      { text: 'Article 1er. — Le présent décret règle les conditions.' },
      { text: 'Il est applicable immédiatement.' },
    ];

    expect(unitsAreEqual(a, b)).toBe(true);
  });

  it('treats differing paragraph breaks as NOT equal', () => {
    const a = [
      { text: 'Premier paragraphe.' },
      { text: 'Deuxième paragraphe.' },
    ];
    const b = [
      { text: 'Premier paragraphe. Deuxième paragraphe.' },
    ];

    expect(unitsAreEqual(a, b)).toBe(false);
  });

  it('treats word changes as NOT equal', () => {
    const a = [{ text: 'Puni de six mois d\'emprisonnement.' }];
    const b = [{ text: 'Puni de huit mois d\'emprisonnement.' }];

    expect(unitsAreEqual(a, b)).toBe(false);
  });

  it('computes word diffs accurately', () => {
    const textA = 'Le ministre de la justice décide';
    const textB = 'Le ministre du commerce décide';

    const diffs = wordDiff(textA, textB);
    expect(diffs).toEqual([
      { a: 'de', b: 'du' },
      { a: 'la', b: 'commerce' },
      { a: 'justice', b: 'décide' },
    ]);
  });

  it('computes empty word diffs for identical strings', () => {
    const diffs = wordDiff('Texte identique', 'Texte   identique');
    expect(diffs).toEqual([]);
  });
});

/**
 * Tests for language profile parsing (FR and AR).
 * Tests article, heading, closing detection; ordinal tables; digit normalization.
 */

import { describe, it, expect } from 'vitest';
import { frProfile, arProfile, normaliseDigits, AR_ORDINAL_MAP } from '../src/pipeline/profiles';
import { splitIntoUnits } from '../src/pipeline/parse';

describe('French profile - article detection', () => {
  const re = frProfile.articlePattern;

  it('matches "Article. 1er. —"', () => {
    expect(re.test('Article. 1er. — Le texte')).toBe(true);
  });

  it('matches "Art.14. —"', () => {
    expect(re.test('Art.14. — Le texte')).toBe(true);
  });

  it('matches "Art. 137.— Est"', () => {
    expect(re.test('Art. 137.— Est')).toBe(true);
  });

  it('matches "Art.138. —"', () => {
    expect(re.test('Art.138. — Le texte')).toBe(true);
  });

  it('matches "Art. 63 ter. — X"', () => {
    expect(re.test('Art. 63 ter. — X')).toBe(true);
  });

  it('does NOT match "Section 1"', () => {
    expect(re.test('Section 1')).toBe(false);
  });

  it('does NOT match "Chapitre 3"', () => {
    expect(re.test('Chapitre 3')).toBe(false);
  });

  it('extracts number from "Art.14. — text"', () => {
    const match = re.exec('Art.14. — text');
    expect(match).not.toBeNull();
    expect(frProfile.articleNumberExtractor(match!)).toBe('14');
  });

  it('extracts number+suffix from "Art. 63 ter. — X"', () => {
    const match = re.exec('Art. 63 ter. — X');
    expect(match).not.toBeNull();
    const key = frProfile.articleNumberExtractor(match!);
    expect(key).toContain('63');
    expect(key.toLowerCase()).toContain('ter');
  });
});

describe('French profile - heading detection', () => {
  const re = frProfile.headingPattern;

  it('matches "Titre I"', () => expect(re.test('Titre I')).toBe(true));
  it('matches "Chapitre 2"', () => expect(re.test('Chapitre 2')).toBe(true));
  it('matches "Section 1"', () => expect(re.test('Section 1')).toBe(true));
  it('matches "Sous-section 3"', () => expect(re.test('Sous-section 3')).toBe(true));
  it('matches "Sous section 1"', () => expect(re.test('Sous section 1')).toBe(true));
  it('does NOT match article text', () => expect(re.test('Art. 1er. — blah')).toBe(false));
});

describe('French profile - closing detection', () => {
  it('matches "Fait à Alger"', () => {
    expect(frProfile.closingPattern.test('Fait à Alger, le 12 octobre 2024.')).toBe(true);
  });
  it('does NOT match "Fait par"', () => {
    // "Fait à" specifically
    expect(frProfile.closingPattern.test('Fait par le ministre')).toBe(false);
  });
});

describe('Arabic profile - article detection', () => {
  const re = arProfile.articlePattern;

  it('matches "المادة 1 :"', () => {
    expect(re.test('المادة 1 : النص هنا')).toBe(true);
  });

  it('matches Arabic-Indic digits "المادة ١٢ -"', () => {
    expect(re.test('المادة ١٢ - النص')).toBe(true);
  });

  it('matches "مادة 5."', () => {
    expect(re.test('مادة 5. النص')).toBe(true);
  });

  it('matches ordinal words "المادة الأولى :"', () => {
    expect(re.test('المادة الأولى : النص')).toBe(true);
    const m = re.exec('المادة الأولى : النص');
    expect(m).not.toBeNull();
    expect(arProfile.articleNumberExtractor(m!)).toBe('1');
  });

  it('matches ordinal words "المادة العاشرة -"', () => {
    expect(re.test('المادة العاشرة - النص')).toBe(true);
    const m = re.exec('المادة العاشرة - النص');
    expect(m).not.toBeNull();
    expect(arProfile.articleNumberExtractor(m!)).toBe('10');
  });

  it('matches compound ordinal words "المادة الخامسة والعشرون :"', () => {
    expect(re.test('المادة الخامسة والعشرون : النص')).toBe(true);
    const m = re.exec('المادة الخامسة والعشرون : النص');
    expect(m).not.toBeNull();
    expect(arProfile.articleNumberExtractor(m!)).toBe('25');
  });

  it('does NOT match random Arabic text', () => {
    expect(re.test('هذا نص عادي بدون مادة')).toBe(false);
  });
});

describe('Arabic digit normalisation', () => {
  it('normalises Arabic-Indic to ASCII', () => {
    expect(normaliseDigits('١٢٣')).toBe('123');
    expect(normaliseDigits('٠٩')).toBe('09');
  });

  it('leaves ASCII digits unchanged', () => {
    expect(normaliseDigits('456')).toBe('456');
  });
});

describe('Arabic ordinal map', () => {
  it('has الأولى -> 1', () => expect(AR_ORDINAL_MAP.get('الأولى')).toBe(1));
  it('has الثانية -> 2', () => expect(AR_ORDINAL_MAP.get('الثانية')).toBe(2));
  it('has العاشرة -> 10', () => expect(AR_ORDINAL_MAP.get('العاشرة')).toBe(10));
  it('has العشرون -> 20', () => expect(AR_ORDINAL_MAP.get('العشرون')).toBe(20));
  it('has الخمسون -> 50', () => expect(AR_ORDINAL_MAP.get('الخمسون')).toBe(50));
  it('covers at least 50 ordinals', () => expect(AR_ORDINAL_MAP.size).toBeGreaterThan(50));
});

describe('Heading stack and ancestor keys', () => {
  it('generates ancestor key chapitre:3/section:1', async () => {
    const pages = [
      {
        page: 1,
        paragraphs: [
          { text: 'Chapitre 3' },
          { text: 'Des dispositions générales' },
          { text: 'Section 1' },
          { text: 'Champ d\'application' },
          { text: 'Art. 1er. — Le présent décret s\'applique...' },
        ],
      },
    ];

    const units = await splitIntoUnits('job1', pages, frProfile);
    const headingUnits = units.filter((u) => u.type === 'heading');

    expect(headingUnits.length).toBe(2);
    expect(headingUnits[0]?.key).toBe('chapitre:3');
    expect(headingUnits[1]?.key).toBe('chapitre:3/section:1');
    expect(headingUnits[1]?.headingTitle).toBe("Champ d'application");
  });
});

describe('Merge rules and boundary preservation', () => {
  it('joins hyphenated words without space keeping the hyphen', async () => {
    const pages = [
      {
        page: 1,
        paragraphs: [
          { text: 'Art. 1. — Il est accordé quarante-' },
          { text: 'cinq jours de délai.', continuesPrevious: true },
        ],
      },
    ];

    const units = await splitIntoUnits('job1', pages, frProfile, true);
    const art = units.find((u) => u.key === 'art:1');
    expect(art).toBeDefined();
    expect(art?.paragraphs[0]?.text).toContain('quarante-cinq');
  });

  it('never glues onto a banner', async () => {
    const pages = [
      {
        page: 1,
        paragraphs: [
          { text: 'LOIS' },
          { text: 'Texte suivant.', continuesPrevious: true },
        ],
      },
    ];

    const units = await splitIntoUnits('job1', pages, frProfile);
    expect(units.length).toBeGreaterThanOrEqual(2);
    const bannerUnit = units.find((u) => u.key.startsWith('banner:'));
    expect(bannerUnit).toBeDefined();
    expect(bannerUnit?.paragraphs[0]?.text).toBe('LOIS');
  });

  it('never glues an article start onto previous paragraph', async () => {
    const pages = [
      {
        page: 1,
        paragraphs: [
          { text: 'Premier paragraphe.' },
          { text: 'Art. 2. — Article deux.', continuesPrevious: true },
        ],
      },
    ];

    const units = await splitIntoUnits('job1', pages, frProfile);
    expect(units.some((u) => u.key === 'art:2')).toBe(true);
  });
});

describe('Article split across pages', () => {
  it('merges an article spanning multiple pages into one unit', async () => {
    const pages = [
      {
        page: 1,
        paragraphs: [
          { text: 'Art. 5. — Début de l\'article sur la page 1.' },
        ],
      },
      {
        page: 2,
        paragraphs: [
          { text: 'Fin de l\'article sur la page 2.' },
          { text: 'Art. 6. — Article suivant.' },
        ],
      },
    ];

    const units = await splitIntoUnits('job1', pages, frProfile);
    const art5 = units.find((u) => u.key === 'art:5');
    expect(art5).toBeDefined();
    expect(art5?.pages).toEqual([1, 2]);
    expect(art5?.paragraphs.length).toBe(2);
  });
});

/**
 * Language profiles for article/heading/closing detection.
 * Editable in Settings as JSON/regex with Reset to default.
 */

export interface LanguageProfile {
  id: string;
  name: string;
  articlePattern: RegExp;
  headingPattern: RegExp;
  closingPattern: RegExp;
  headingLevels: string[];
  articleNumberExtractor: (match: RegExpMatchArray) => string;
  ordinalMap?: Map<string, number>;
}

// ─── French Profile ───────────────────────────────────────────────────────────

const FR_ARTICLE_RE =
  /^(?:Article|Art)\s*\.?\s*(\d+)\s*(?:er|ère|re)?\s*(bis|ter|quater|quinquies)?\s*\.?\s*[—–-]\s*/i;

const FR_HEADING_RE =
  /^(Titre|Chapitre|Section|Sous[- ]section)\b/i;

const FR_CLOSING_RE = /^Fait\s+à(?!\p{L})/iu;

export const frProfile: LanguageProfile = {
  id: 'fr',
  name: 'French',
  articlePattern: FR_ARTICLE_RE,
  headingPattern: FR_HEADING_RE,
  closingPattern: FR_CLOSING_RE,
  headingLevels: ['titre', 'chapitre', 'section', 'sous-section'],
  articleNumberExtractor: (match) => {
    const num = match[1] ?? '';
    const suffix = (match[2] ?? '').toLowerCase().trim();
    return num + (suffix ? ' ' + suffix : '');
  },
};

// ─── Arabic Profile ───────────────────────────────────────────────────────────

// Map Arabic ordinal words to numbers (1-100)
const AR_ORDINALS: Record<string, number> = {
  'الأولى': 1, 'الأول': 1,
  'الثانية': 2, 'الثاني': 2,
  'الثالثة': 3, 'الثالث': 3,
  'الرابعة': 4, 'الرابع': 4,
  'الخامسة': 5, 'الخامس': 5,
  'السادسة': 6, 'السادس': 6,
  'السابعة': 7, 'السابع': 7,
  'الثامنة': 8, 'الثامن': 8,
  'التاسعة': 9, 'التاسع': 9,
  'العاشرة': 10, 'العاشر': 10,
  'الحادية عشرة': 11, 'الحادي عشر': 11,
  'الثانية عشرة': 12, 'الثاني عشر': 12,
  'الثالثة عشرة': 13, 'الثالث عشر': 13,
  'الرابعة عشرة': 14, 'الرابع عشر': 14,
  'الخامسة عشرة': 15, 'الخامس عشر': 15,
  'السادسة عشرة': 16, 'السادس عشر': 16,
  'السابعة عشرة': 17, 'السابع عشر': 17,
  'الثامنة عشرة': 18, 'الثامن عشر': 18,
  'التاسعة عشرة': 19, 'التاسع عشر': 19,
  'العشرون': 20, 'العشرين': 20,
  'الحادية والعشرون': 21, 'الحادي والعشرون': 21,
  'الثانية والعشرون': 22, 'الثاني والعشرون': 22,
  'الثالثة والعشرون': 23, 'الثالث والعشرون': 23,
  'الرابعة والعشرون': 24, 'الرابع والعشرون': 24,
  'الخامسة والعشرون': 25, 'الخامس والعشرون': 25,
  'السادسة والعشرون': 26, 'السادس والعشرون': 26,
  'السابعة والعشرون': 27, 'السابع والعشرون': 27,
  'الثامنة والعشرون': 28, 'الثامن والعشرون': 28,
  'التاسعة والعشرون': 29, 'التاسع والعشرون': 29,
  'الثلاثون': 30, 'الثلاثين': 30,
  'الحادية والثلاثون': 31, 'الحادي والثلاثون': 31,
  'الثانية والثلاثون': 32, 'الثاني والثلاثون': 32,
  'الثالثة والثلاثون': 33, 'الثالث والثلاثون': 33,
  'الرابعة والثلاثون': 34, 'الرابع والثلاثون': 34,
  'الخامسة والثلاثون': 35, 'الخامس والثلاثون': 35,
  'السادسة والثلاثون': 36, 'السادس والثلاثون': 36,
  'السابعة والثلاثون': 37, 'السابع والثلاثون': 37,
  'الثامنة والثلاثون': 38, 'الثامن والثلاثون': 38,
  'التاسعة والثلاثون': 39, 'التاسع والثلاثون': 39,
  'الأربعون': 40, 'الأربعين': 40,
  'الخمسون': 50, 'الخمسين': 50,
  'الستون': 60, 'الستين': 60,
  'السبعون': 70, 'السبعين': 70,
  'الثمانون': 80, 'الثمانين': 80,
  'التسعون': 90, 'التسعين': 90,
  'المئة': 100,
};

export const AR_ORDINAL_MAP = new Map(Object.entries(AR_ORDINALS));

// Normalise Arabic-Indic digits to ASCII
export function normaliseDigits(str: string): string {
  return str.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

// Article: المادة/مادة + number (Western or Arabic-Indic) or ordinal word
// Followed by :, -, ., or space
const AR_ARTICLE_RE =
  /^(?:المادة|مادة)\s+([٠-٩0-9]+|[\u0600-\u06FF]+(?:\s+(?:والعشرون|والثلاثون|والأربعون|والخمسون|والستون|والسبعون|والثمانون|والتسعون))?)\s*[:.\-\s]/u;

const AR_HEADING_RE =
  /^(?:الكتاب|الباب|الفصل|القسم|الفرع)\b/u;

const AR_CLOSING_RE = /^حرر بالجزائر(?!\p{L})/u;

export const arProfile: LanguageProfile = {
  id: 'ar',
  name: 'Arabic',
  articlePattern: AR_ARTICLE_RE,
  headingPattern: AR_HEADING_RE,
  closingPattern: AR_CLOSING_RE,
  headingLevels: ['الكتاب', 'الباب', 'الفصل', 'القسم', 'الفرع'],
  ordinalMap: AR_ORDINAL_MAP,
  articleNumberExtractor: (match) => {
    const raw = (match[1] ?? '').trim();
    // Try ordinal map first
    const fromOrdinal = AR_ORDINAL_MAP.get(raw);
    if (fromOrdinal) return String(fromOrdinal);
    // Normalise Arabic-Indic to ASCII
    return normaliseDigits(raw);
  },
};

// ─── Profile Registry ─────────────────────────────────────────────────────────

const PROFILE_REGISTRY = new Map<string, LanguageProfile>([
  ['fr', frProfile],
  ['ar', arProfile],
]);

export function getProfile(id: string): LanguageProfile | undefined {
  return PROFILE_REGISTRY.get(id);
}

export function getDefaultProfiles(): LanguageProfile[] {
  return [frProfile, arProfile];
}

/** Detect the likely profile from a page's text (by script ratio). */
export function detectProfile(text: string): 'fr' | 'ar' {
  let arabicCount = 0;
  let latinCount = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x0600 && cp <= 0x06ff) arabicCount++;
    else if (cp >= 0x0041 && cp <= 0x007a) latinCount++;
    else if (cp >= 0x00c0 && cp <= 0x024f) latinCount++;
  }
  return arabicCount > latinCount ? 'ar' : 'fr';
}

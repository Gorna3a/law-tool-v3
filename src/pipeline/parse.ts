/**
 * Parse agent outputs and split pages into units.
 */

import type { Paragraph, Unit, UnitType, Resolution, PageResult } from '../storage/schema';
import type { LanguageProfile } from './profiles';
import { hashString } from '../utils/hash';

// ─── JSON output parsing ──────────────────────────────────────────────────────

export interface PageOutput {
  paragraphs: Paragraph[];
}

export interface UnitOutput {
  paragraphs: Omit<Paragraph, 'continuesPrevious'>[];
}

export interface JudgeOutput {
  differences: Array<{ a: string; b: string; truth: string; correct: 'a' | 'b' | 'neither' }>;
  reading: string[];
  confidence: 'high' | 'medium' | 'low';
  note: string;
}

/** Strip markdown code fences and parse JSON robustly. */
export function parseJsonOutput(raw: string): unknown {
  // Strip code fences
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting from first { to last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through
      }
    }
    throw new Error(`Failed to parse JSON: ${text.slice(0, 200)}`);
  }
}

export function validatePageOutput(raw: unknown): PageOutput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Page output is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['paragraphs'])) {
    throw new Error('Page output missing paragraphs array');
  }
  return {
    paragraphs: (obj['paragraphs'] as unknown[]).map((p, i) => {
      if (typeof p !== 'object' || p === null) throw new Error(`Paragraph ${i} not an object`);
      const para = p as Record<string, unknown>;
      if (typeof para['text'] !== 'string') throw new Error(`Paragraph ${i} missing text`);
      return {
        text: para['text'] as string,
        continuesPrevious: Boolean(para['continuesPrevious']),
      };
    }),
  };
}

export function validateJudgeOutput(raw: unknown): JudgeOutput {
  if (typeof raw !== 'object' || raw === null) throw new Error('Judge output not an object');
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['reading'])) throw new Error('Judge output missing reading');
  return {
    differences: Array.isArray(obj['differences'])
      ? (obj['differences'] as Array<Record<string, string>>).map((d) => ({
          a: String(d['a'] ?? ''),
          b: String(d['b'] ?? ''),
          truth: String(d['truth'] ?? ''),
          correct: (['a', 'b', 'neither'].includes(d['correct'] ?? '') ? d['correct'] : 'neither') as 'a' | 'b' | 'neither',
        }))
      : [],
    reading: (obj['reading'] as unknown[]).map((r) => String(r)),
    confidence: (['high', 'medium', 'low'].includes(String(obj['confidence'])) ? obj['confidence'] : 'low') as JudgeOutput['confidence'],
    note: String(obj['note'] ?? ''),
  };
}

// ─── Banner detection ─────────────────────────────────────────────────────────

export function isBanner(text: string): boolean {
  const t = text.trim();
  return /^(?:LOIS|DECRETS|ARRETES|DECISIONS|CIRCULAIRES|AVIS|SOMMAIRE|JOURNAL OFFICIEL)\b/i.test(t);
}

// ─── Unit splitter ────────────────────────────────────────────────────────────

interface HeadingStackEntry {
  level: number;
  label: string;
  levelName: string;
}

function extractHeadingIdentifier(profile: LanguageProfile, text: string, levelName: string): string {
  const re = new RegExp(`^${levelName}\\s*`, 'iu');
  const rest = text.replace(re, '').trim();
  if (!rest) return '1';
  if (profile.ordinalMap?.has(rest)) {
    return String(profile.ordinalMap.get(rest));
  }
  return rest.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export async function splitIntoUnits(
  jobId: string,
  paragraphsByPage: Array<{ page: number; paragraphs: Paragraph[] }>,
  profile: LanguageProfile,
  hyphenJoin = true
): Promise<Unit[]> {
  const units: Unit[] = [];
  const usedKeys = new Map<string, number>();

  let headingStack: HeadingStackEntry[] = [];
  let currentUnit: Unit | null = null;
  let seenArticle = false;
  let seenClosing = false;
  let preambleDone = false;
  let prevPara: { text: string; continuesPrevious?: boolean } | null = null;

  function pushUnit(u: Unit): void {
    // Deduplicate keys
    const n = (usedKeys.get(u.key) ?? 0) + 1;
    usedKeys.set(u.key, n);
    if (n > 1) {
      u.key = `${u.key}#${n}`;
      u.id = ''; // will be reset below
    }
    units.push(u);
  }

  async function finaliseUnit(): Promise<void> {
    if (currentUnit && currentUnit.paragraphs.length > 0) {
      currentUnit.id = await hashString(`${jobId}:${currentUnit.type}:${currentUnit.key}:${units.length}`);
      pushUnit(currentUnit);
    }
    currentUnit = null;
  }

  function headingLevel(prof: LanguageProfile, text: string): number {
    const lower = text.toLowerCase().trim();
    const idx = prof.headingLevels.findIndex((l) =>
      lower.startsWith(l.toLowerCase())
    );
    return idx; // -1 if not found
  }

  function ancestorPath(): string {
    return headingStack.map((e) => `${e.levelName}:${e.label}`).join('/');
  }

  for (const { page, paragraphs } of paragraphsByPage) {
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      if (!para) continue;
      let text = para.text.trim();

      // Hyphen join: if previous paragraph ends with a hyphen and this continues
      // (Never glue onto a heading or banner)
      if (
        hyphenJoin &&
        prevPara &&
        prevPara.text.endsWith('-') &&
        para.continuesPrevious &&
        currentUnit &&
        currentUnit.paragraphs.length > 0 &&
        currentUnit.type !== 'heading' &&
        !isBanner(prevPara.text)
      ) {
        // Join directly (no space - real compound hyphen)
        const last = currentUnit.paragraphs.at(-1);
        if (last) {
          last.text = last.text + text;
          prevPara = last;
          continue;
        }
      }

      prevPara = para;
      if (!text) continue;

      const isClosing = profile.closingPattern.test(text);
      const isHeading = profile.headingPattern.test(text);
      const articleMatch = profile.articlePattern.exec(text);
      const isArticle = !!articleMatch;
      const banner = isBanner(text);

      // Rule: never glue article/heading/closing/banner onto previous paragraph
      if (isArticle || isHeading || isClosing || banner) {
        await finaliseUnit();
      }

      if (banner) {
        currentUnit = {
          id: '',
          jobId,
          type: 'other' as UnitType,
          key: `banner:${text.slice(0, 20)}`,
          pages: [page],
          paragraphs: [{ text, continuesPrevious: false }],
        };
        await finaliseUnit();
        continue;
      }

      if (isClosing && !seenClosing) {
        seenClosing = true;
        preambleDone = true;
        currentUnit = {
          id: '',
          jobId,
          type: 'closing' as UnitType,
          key: 'closing',
          pages: [page],
          paragraphs: [{ text, continuesPrevious: false }],
        };
        continue;
      }

      if (seenClosing && currentUnit) {
        currentUnit.paragraphs.push({ text, continuesPrevious: para.continuesPrevious });
        if (!currentUnit.pages.includes(page)) currentUnit.pages.push(page);
        continue;
      }

      if (isHeading) {
        preambleDone = true;
        const level = headingLevel(profile, text);

        if (level >= 0) {
          // Pop all stack entries at >= this level
          headingStack = headingStack.filter((e) => e.level < level);
          const levelName = profile.headingLevels[level] ?? `level${level}`;
          const id = extractHeadingIdentifier(profile, text, levelName);
          headingStack.push({ level, label: id, levelName });
        }

        const path = ancestorPath();
        const headingKey = path || text.slice(0, 30);

        // Look ahead for heading title (next para that isn't itself a heading/article/closing/banner)
        const nextPara = paragraphs[i + 1];
        let headingTitle: string | undefined;
        if (
          nextPara &&
          !profile.headingPattern.test(nextPara.text) &&
          !profile.articlePattern.test(nextPara.text) &&
          !profile.closingPattern.test(nextPara.text) &&
          !isBanner(nextPara.text)
        ) {
          headingTitle = nextPara.text;
        }

        const headingParagraphs: Paragraph[] = [{ text, continuesPrevious: false }];
        if (headingTitle) {
          headingParagraphs.push({ text: headingTitle, continuesPrevious: false });
          i++; // Consume the title paragraph into this heading unit
        }

        currentUnit = {
          id: '',
          jobId,
          type: 'heading' as UnitType,
          key: headingKey,
          pages: [page],
          paragraphs: headingParagraphs,
          ancestorPath: path,
          headingTitle,
        };
        continue;
      }

      if (isArticle && articleMatch) {
        preambleDone = true;
        seenArticle = true;
        const artNum = profile.articleNumberExtractor(articleMatch);
        const artKey = `art:${artNum}`;

        currentUnit = {
          id: '',
          jobId,
          type: 'article' as UnitType,
          key: artKey,
          pages: [page],
          paragraphs: [{ text, continuesPrevious: false }],
        };
        continue;
      }

      // Regular paragraph
      if (!preambleDone && !seenArticle) {
        // Preamble
        if (!currentUnit || currentUnit.type !== 'preamble') {
          await finaliseUnit();
          currentUnit = {
            id: '',
            jobId,
            type: 'preamble' as UnitType,
            key: 'preamble',
            pages: [page],
            paragraphs: [],
          };
        }
      }

      if (!currentUnit) {
        // Orphan paragraph after articles
        currentUnit = {
          id: '',
          jobId,
          type: 'other' as UnitType,
          key: 'other',
          pages: [page],
          paragraphs: [],
        };
      }

      if (!currentUnit.pages.includes(page)) currentUnit.pages.push(page);
      currentUnit.paragraphs.push({ text, continuesPrevious: para.continuesPrevious });
    }
  }

  await finaliseUnit();
  return units;
}

// ─── Align and compare A and B units ───────────────────────────────────────────

export interface AlignedUnitsResult {
  units: Unit[];
  resolutions: Resolution[];
}

export async function alignAndCompareUnits(
  jobId: string,
  results: PageResult[],
  profile: LanguageProfile,
  hyphenJoin = true,
  existingResolutions: Resolution[] = []
): Promise<AlignedUnitsResult> {
  const aResults = results.filter((r) => r.role === 'A').sort((a, b) => a.page - b.page);
  const bResults = results.filter((r) => r.role === 'B').sort((a, b) => a.page - b.page);
  const cResults = results.filter((r) => r.role === 'C').sort((a, b) => a.page - b.page);

  if (aResults.length === 0 && bResults.length === 0 && cResults.length === 0) {
    return { units: [], resolutions: [] };
  }

  const aPages = aResults.map((r) => ({ page: r.page, paragraphs: r.paragraphs }));
  const bPages = bResults.map((r) => ({ page: r.page, paragraphs: r.paragraphs }));
  const cPages = cResults.map((r) => ({ page: r.page, paragraphs: r.paragraphs }));

  const unitsA = aPages.length > 0 ? await splitIntoUnits(jobId, aPages, profile, hyphenJoin) : [];
  const unitsB = bPages.length > 0 ? await splitIntoUnits(jobId, bPages, profile, hyphenJoin) : [];
  const unitsC = cPages.length > 0 ? await splitIntoUnits(jobId, cPages, profile, hyphenJoin) : [];

  const mapA = new Map(unitsA.map((u) => [u.key, u]));
  const mapB = new Map(unitsB.map((u) => [u.key, u]));
  const mapC = new Map(unitsC.map((u) => [u.key, u]));
  const existingMap = new Map(existingResolutions.map((r) => [r.unitKey, r]));

  const allKeys = Array.from(new Set([...unitsA.map((u) => u.key), ...unitsB.map((u) => u.key), ...unitsC.map((u) => u.key)]));

  const units: Unit[] = [];
  const resolutions: Resolution[] = [];

  for (const key of allKeys) {
    const uA = mapA.get(key);
    const uB = mapB.get(key);
    const uC = mapC.get(key);
    const canonical = uA ?? uB ?? uC!;
    units.push(canonical);

    const existing = existingMap.get(key);
    if (existing && (existing.status === 'human_resolved' || existing.status === 'agreed_after_rerun')) {
      resolutions.push(existing);
      continue;
    }

    const textA = uA ? uA.paragraphs.map((p) => p.text) : undefined;
    const textB = uB ? uB.paragraphs.map((p) => p.text) : undefined;
    const textC = uC ? uC.paragraphs.map((p) => p.text) : undefined;

    // Check 3-way consensus if Extractor C is active
    if (unitsC.length > 0 && uA && uB && uC) {
      const matchAB = unitsAreEqual(uA.paragraphs, uB.paragraphs);
      const matchAC = unitsAreEqual(uA.paragraphs, uC.paragraphs);
      const matchBC = unitsAreEqual(uB.paragraphs, uC.paragraphs);

      if (matchAB && matchBC) {
        // 3/3 unanimous consensus
        resolutions.push({
          id: canonical.id,
          jobId,
          unitId: canonical.id,
          unitKey: key,
          status: 'agreed',
          textA,
          textB,
          textC,
          finalText: textA,
          reruns: existing?.reruns ?? 0,
          resolvedAt: existing?.resolvedAt ?? Date.now(),
          resolvedBy: 'consensus',
          consensusRatio: '3/3',
          matchedRoles: ['A', 'B', 'C'],
          modelUsedA: aResults[0]?.modelUsed,
          modelUsedB: bResults[0]?.modelUsed,
          modelUsedC: cResults[0]?.modelUsed,
        });
      } else if (matchAB) {
        // 2/3 consensus (A and B)
        resolutions.push({
          id: canonical.id,
          jobId,
          unitId: canonical.id,
          unitKey: key,
          status: 'agreed',
          textA,
          textB,
          textC,
          finalText: textA,
          reruns: existing?.reruns ?? 0,
          resolvedAt: existing?.resolvedAt ?? Date.now(),
          resolvedBy: 'consensus',
          consensusRatio: '2/3',
          matchedRoles: ['A', 'B'],
          modelUsedA: aResults[0]?.modelUsed,
          modelUsedB: bResults[0]?.modelUsed,
          modelUsedC: cResults[0]?.modelUsed,
        });
      } else if (matchAC) {
        // 2/3 consensus (A and C)
        resolutions.push({
          id: canonical.id,
          jobId,
          unitId: canonical.id,
          unitKey: key,
          status: 'agreed',
          textA,
          textB,
          textC,
          finalText: textA,
          reruns: existing?.reruns ?? 0,
          resolvedAt: existing?.resolvedAt ?? Date.now(),
          resolvedBy: 'consensus',
          consensusRatio: '2/3',
          matchedRoles: ['A', 'C'],
          modelUsedA: aResults[0]?.modelUsed,
          modelUsedB: bResults[0]?.modelUsed,
          modelUsedC: cResults[0]?.modelUsed,
        });
      } else if (matchBC) {
        // 2/3 consensus (B and C)
        resolutions.push({
          id: canonical.id,
          jobId,
          unitId: canonical.id,
          unitKey: key,
          status: 'agreed',
          textA,
          textB,
          textC,
          finalText: textB,
          reruns: existing?.reruns ?? 0,
          resolvedAt: existing?.resolvedAt ?? Date.now(),
          resolvedBy: 'consensus',
          consensusRatio: '2/3',
          matchedRoles: ['B', 'C'],
          modelUsedA: aResults[0]?.modelUsed,
          modelUsedB: bResults[0]?.modelUsed,
          modelUsedC: cResults[0]?.modelUsed,
        });
      } else {
        // 0/3 all differed
        resolutions.push({
          id: canonical.id,
          jobId,
          unitId: canonical.id,
          unitKey: key,
          status: existing?.status ?? 'needs_review',
          textA,
          textB,
          textC,
          finalText: existing?.finalText,
          reruns: existing?.reruns ?? 0,
          consensusRatio: 'none',
          modelUsedA: aResults[0]?.modelUsed,
          modelUsedB: bResults[0]?.modelUsed,
          modelUsedC: cResults[0]?.modelUsed,
        });
      }
    } else if (uA && uB) {
      // 2 models mode (backwards compat)
      const agreed = unitsAreEqual(uA.paragraphs, uB.paragraphs);
      if (agreed) {
        resolutions.push({
          id: canonical.id,
          jobId,
          unitId: canonical.id,
          unitKey: key,
          status: 'agreed',
          textA,
          textB,
          finalText: textA,
          reruns: existing?.reruns ?? 0,
          resolvedAt: existing?.resolvedAt ?? Date.now(),
          resolvedBy: 'auto',
          modelUsedA: aResults[0]?.modelUsed,
          modelUsedB: bResults[0]?.modelUsed,
        });
      } else {
        resolutions.push({
          id: canonical.id,
          jobId,
          unitId: canonical.id,
          unitKey: key,
          status: existing?.status ?? 'needs_review',
          textA,
          textB,
          finalText: existing?.finalText,
          textJ: existing?.textJ,
          reruns: existing?.reruns ?? 0,
          judgeConfidence: existing?.judgeConfidence,
          judgeNote: existing?.judgeNote,
          resolvedBy: existing?.resolvedBy,
          resolvedAt: existing?.resolvedAt,
          modelUsedA: aResults[0]?.modelUsed,
          modelUsedB: bResults[0]?.modelUsed,
          modelUsedJ: existing?.modelUsedJ,
        });
      }
    } else {
      resolutions.push({
        id: canonical.id,
        jobId,
        unitId: canonical.id,
        unitKey: key,
        status: 'needs_review',
        textA,
        textB,
        textC,
        finalText: existing?.finalText,
        reruns: existing?.reruns ?? 0,
      });
    }
  }

  return { units, resolutions };
}

// ─── Comparison ───────────────────────────────────────────────────────────────

/** Canonical normalisation for comparison across heterogeneous AI models */
export function canonicalNormaliseForCompare(paragraphs: Paragraph[]): string {
  return paragraphs
    .map((p) => {
      let t = p.text;
      // Replace all Unicode whitespace (non-breaking spaces, thin spaces, zero-width) with standard space
      t = t.replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');
      // Standardize dashes (em-dash, en-dash, horizontal bar) to em-dash
      t = t.replace(/[\u2012\u2013\u2014\u2015]/g, '—');
      // Standardize double quotation marks to standard double quote
      t = t.replace(/[\u201C\u201D\u00AB\u00BB\u201E\u201F]/g, '"');
      // Standardize single quotation marks/apostrophes
      t = t.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
      // Collapse multiple whitespace
      t = t.replace(/\s+/g, ' ').trim();
      return t;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Normalise whitespace for comparison (collapse runs, keep paragraph breaks). */
export function normaliseForCompare(paragraphs: Paragraph[]): string {
  return canonicalNormaliseForCompare(paragraphs);
}

export function unitsAreEqual(a: Paragraph[], b: Paragraph[]): boolean {
  return canonicalNormaliseForCompare(a) === canonicalNormaliseForCompare(b);
}

/** Compute word-level diffs between two texts. */
export function wordDiff(a: string, b: string): Array<{ a: string; b: string }> {
  const aWords = a.split(/\s+/).filter(Boolean);
  const bWords = b.split(/\s+/).filter(Boolean);

  const diffs: Array<{ a: string; b: string }> = [];
  const minLen = Math.min(aWords.length, bWords.length);

  for (let i = 0; i < minLen; i++) {
    const aw = aWords[i] ?? '';
    const bw = bWords[i] ?? '';
    if (aw !== bw) {
      diffs.push({ a: aw, b: bw });
    }
  }
  return diffs;
}

// ─── Article numbering checks ─────────────────────────────────────────────────

export function checkArticleNumbering(units: Unit[]): string[] {
  const warnings: string[] = [];
  const seen = new Map<string, number>();

  const articles = units.filter((u) => u.type === 'article');
  let prevNum: number | null = null;

  for (const art of articles) {
    const rawKey = art.key.replace('art:', '');
    const num = parseInt(rawKey, 10);

    if (!isNaN(num)) {
      if (seen.has(rawKey)) {
        warnings.push(`Duplicate article number: ${rawKey}`);
      }
      seen.set(rawKey, (seen.get(rawKey) ?? 0) + 1);

      if (prevNum !== null && num !== prevNum + 1) {
        if (num > prevNum + 1) {
          warnings.push(`Gap in article numbers: ${prevNum} -> ${num}`);
        }
      }
      prevNum = num;
    }
  }

  return warnings;
}

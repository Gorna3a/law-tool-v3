/**
 * TXT exporter: rebuilds plain text from final units in document order.
 * UTF-8, \n, optional header, [[CHECK]] markers for unresolved units.
 */

import type { Job, Unit, Resolution, PageResult } from '../storage/schema';

export interface TxtExportOptions {
  includeHeader?: boolean;
  includeCheckMarkers?: boolean;
}

export async function exportTxt(
  job: Job,
  units: Unit[],
  resolutions: Resolution[],
  options: TxtExportOptions = {},
  pageResults?: PageResult[]
): Promise<string> {
  const { includeHeader = true, includeCheckMarkers = true } = options;
  const lines: string[] = [];

  const resMap = new Map(resolutions.map((r) => [r.unitKey, r]));

  if (includeHeader) {
    lines.push('# ──────────────────────────────────────────────────────');
    lines.push(`# LawText export`);
    lines.push(`# File:        ${job.fileName}`);
    lines.push(`# Date:        ${new Date().toISOString()}`);
    lines.push(`# Profile:     ${job.profile}`);
    lines.push(`# Extractor A: ${job.settingsSnapshot.modelA}`);
    lines.push(`# Extractor B: ${job.settingsSnapshot.modelB}`);
    lines.push(`# Extractor C: ${job.settingsSnapshot.modelC || 'none'}`);
    lines.push(`# Pages:       ${job.pageCount}`);
    lines.push(`# Units:       ${resolutions.length} total`);
    lines.push(`# Agreed:      ${resolutions.filter((r) => r.status === 'agreed' || r.status === 'agreed_after_rerun' || r.status === 'consensus_resolved').length}`);
    lines.push(`# Note:        Ordered sequentially from Page 1 to Page ${job.pageCount}.`);
    lines.push('# ──────────────────────────────────────────────────────');
    lines.push('');
  }

  // If live page results are available, build strictly in page order (1 to N)
  if (pageResults && pageResults.length > 0) {
    const pages = [...new Set(pageResults.map((r) => r.page))].sort((a, b) => a - b);
    for (const page of pages) {
      const pResults = pageResults.filter((r) => r.page === page);
      // Prefer consensus result, otherwise role A
      const consensus = pResults.find((r) => r.taskId.startsWith('consensus:')) || pResults[0];
      if (consensus && consensus.paragraphs.length > 0) {
        lines.push(`--- Page ${page} ---`);
        for (const para of consensus.paragraphs) {
          const normalised = para.text.replace(/[ \t]+/g, ' ').trim();
          if (!normalised) continue;
          lines.push(normalised);
          lines.push('');
        }
      }
    }
    return lines.join('\n');
  }

  // Otherwise export from units, strictly sorted by page number
  const sortedUnits = [...units].sort((a, b) => {
    const minPageA = Math.min(...(a.pages.length ? a.pages : [0]));
    const minPageB = Math.min(...(b.pages.length ? b.pages : [0]));
    return minPageA - minPageB;
  });

  for (const unit of sortedUnits) {
    const res = resMap.get(unit.key);
    const text = res?.finalText ?? res?.humanText ?? res?.textA ?? unit.paragraphs.map((p) => p.text);
    const needsReview = res?.status === 'needs_review' || res?.status === 'needs_attention';

    for (const para of text) {
      const normalised = para.replace(/[ \t]+/g, ' ').trim();
      if (!normalised) continue;
      const prefix = needsReview && includeCheckMarkers ? '[[CHECK]] ' : '';
      lines.push(prefix + normalised);
      lines.push('');
    }
  }

  return lines.join('\n');
}

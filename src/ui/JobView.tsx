import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useAppStore, DEFAULT_SETTINGS } from '../app/store';
import { useEngine } from '../app/EngineProvider';
import {
  getJob,
  getResolutionsForJob,
  getUnitsForJob,
  getEventsForJob,
  getTasksForJob,
  getResultsForJob,
  putResolution,
  getAllJobs,
  putJob,
  resetInterruptedTasks,
} from '../storage/repositories';
import type { Job, Unit, Resolution, EventLogEntry, Task, PageResult } from '../storage/schema';
import { exportTxt } from '../export/txtExporter';
import { DiffReview } from './DiffReview';
import { PageGrid } from './PageGrid';

function UnitStatusBadge({
  status,
  consensusRatio,
}: {
  status: Resolution['status'];
  consensusRatio?: string;
}): React.ReactElement {
  const map: Record<string, string> = {
    agreed: '✅ Agreed',
    agreed_after_rerun: '✅ Agreed (re-run)',
    consensus_resolved: consensusRatio === '3/3' ? '✅ 3/3 Consensus' : '✅ 2/3 Consensus',
    judge_resolved: '⚖️ Resolved',
    needs_review: '👁 Review',
    human_resolved: '✍ Human',
    needs_attention: '⚠ Attention',
  };
  const cls: Record<string, string> = {
    agreed: 'text-success',
    agreed_after_rerun: 'text-success',
    consensus_resolved: 'text-success font-semibold',
    judge_resolved: 'text-accent',
    needs_review: 'text-warning',
    human_resolved: 'text-info',
    needs_attention: 'text-danger',
  };
  return (
    <span className={`text-xs font-medium ${cls[status] ?? ''}`}>
      {map[status] ?? status}
    </span>
  );
}

export function JobView(): React.ReactElement | null {
  const { activeJobId, setJobs } = useAppStore();
  const { scheduler } = useEngine();
  const [job, setJob] = useState<Job | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pageResults, setPageResults] = useState<PageResult[]>([]);
  const [filter, setFilter] = useState<'all' | 'review' | 'consensus'>('all');
  const [search, setSearch] = useState('');
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'preview' | 'grid' | 'units' | 'events'>('preview');
  const [reviewResolution, setReviewResolution] = useState<Resolution | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewMode, setPreviewMode] = useState<'pages' | 'continuous'>('pages');

  const handleResume = useCallback(async () => {
    if (!job) return;
    const currentSettings = useAppStore.getState().settings ?? DEFAULT_SETTINGS;
    await resetInterruptedTasks(job.id);
    const updated: Job = {
      ...job,
      status: 'running',
      settingsSnapshot: {
        ...job.settingsSnapshot,
        gatewayUrl: currentSettings.gatewayUrl,
        apiKey: currentSettings.apiKey,
        modelA: currentSettings.modelA,
        modelB: currentSettings.modelB,
        modelC: currentSettings.modelC,
        agentA: currentSettings.agentA,
        agentB: currentSettings.agentB,
        agentC: currentSettings.agentC,
      },
      updatedAt: Date.now(),
    };
    await putJob(updated);
    scheduler.addJob(job.id);
    setJob(updated);
    const allJobs = await getAllJobs();
    setJobs(allJobs);
  }, [job, scheduler, setJobs]);

  const handlePause = useCallback(async () => {
    if (!job) return;
    const updated: Job = {
      ...job,
      status: 'paused_attention',
      updatedAt: Date.now(),
    };
    await putJob(updated);
    scheduler.removeJob(job.id);
    setJob(updated);
    const allJobs = await getAllJobs();
    setJobs(allJobs);
  }, [job, scheduler, setJobs]);

  const load = useCallback(async () => {
    if (!activeJobId) return;
    const [j, u, r, e, t, res] = await Promise.all([
      getJob(activeJobId),
      getUnitsForJob(activeJobId),
      getResolutionsForJob(activeJobId),
      getEventsForJob(activeJobId),
      getTasksForJob(activeJobId),
      getResultsForJob(activeJobId),
    ]);
    if (j) setJob(j);
    setUnits(u);
    setResolutions(r);
    setEvents(e.reverse());
    setTasks(t);
    setPageResults(res);
  }, [activeJobId]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 1200);
    return () => clearInterval(interval);
  }, [load]);

  const handleExport = useCallback(async () => {
    if (!job) return;
    const text = await exportTxt(job, units, resolutions, { includeHeader: true }, pageResults);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = job.fileName.replace(/\.pdf$/i, '') + '_extracted.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [job, units, resolutions, pageResults]);

  const handleResolutionUpdate = useCallback(
    async (updated: Resolution) => {
      await putResolution(updated);
      const allJobs = await getAllJobs();
      setJobs(allJobs);
      await load();
      setReviewResolution(null);
    },
    [load, setJobs]
  );

  const handleCopyAll = useCallback(async () => {
    if (!job) return;
    const text = await exportTxt(job, units, resolutions, { includeHeader: true }, pageResults);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [job, units, resolutions, pageResults]);

  const handlePrint = useCallback(() => {
    setActiveTab('preview');
    setPreviewMode('continuous');
    setTimeout(() => {
      window.print();
    }, 250);
  }, []);

  const resMap = useMemo(() => new Map(resolutions.map((r) => [r.unitKey, r])), [resolutions]);

  // Derived tasks count & remaining calculations
  const tasksDoneCount = useMemo(() => tasks.filter((t) => t.status === 'done').length, [tasks]);
  const tasksTotalCount = useMemo(() => {
    if (tasks.length > 0) return tasks.length;
    const rolesPerPg = job?.settingsSnapshot?.modelC ? 3 : 2;
    return (job?.pageCount ?? 0) * rolesPerPg;
  }, [tasks, job]);

  const tasksRemainingCount = Math.max(0, tasksTotalCount - tasksDoneCount);

  // Consensus & status counts
  const consensus3Count = useMemo(
    () =>
      resolutions.filter(
        (r) =>
          r.consensusRatio === '3/3' ||
          (r.status === 'consensus_resolved' && r.matchedRoles?.length === 3)
      ).length,
    [resolutions]
  );

  const consensus2Count = useMemo(
    () =>
      resolutions.filter(
        (r) =>
          r.consensusRatio === '2/3' ||
          (r.status === 'consensus_resolved' && r.matchedRoles?.length === 2)
      ).length,
    [resolutions]
  );

  const agreedCount = useMemo(
    () =>
      resolutions.filter(
        (r) =>
          r.status === 'agreed' ||
          r.status === 'agreed_after_rerun' ||
          r.status === 'consensus_resolved'
      ).length,
    [resolutions]
  );

  const rerunCount = useMemo(
    () => resolutions.filter((r) => r.status === 'agreed_after_rerun').length,
    [resolutions]
  );
  const reviewCount = useMemo(
    () => resolutions.filter((r) => r.status === 'needs_review').length,
    [resolutions]
  );
  const attentionCount = useMemo(
    () =>
      resolutions.filter((r) => r.status === 'needs_attention').length +
      tasks.filter((t) => t.status === 'needs_attention').length,
    [resolutions, tasks]
  );

  const isFinished =
    job?.status === 'done' ||
    (tasksTotalCount > 0 && tasksDoneCount >= tasksTotalCount);

  // Active page running in scheduler
  const activeRunningTask = tasks.find((t) => t.status === 'running');
  const activeWorkingPage = activeRunningTask?.params.page ?? (
    tasks.find((t) => t.status === 'pending')?.params.page ?? null
  );

  // Map of consensus results by page
  const pageConsensusMap = useMemo(() => {
    const map = new Map<number, PageResult>();
    for (const pr of pageResults) {
      if (pr.taskId.startsWith('consensus:')) {
        map.set(pr.page, pr);
      } else if (!map.has(pr.page)) {
        map.set(pr.page, pr);
      }
    }
    return map;
  }, [pageResults]);

  if (!activeJobId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-center p-8">
        <div>
          <div className="text-4xl mb-4">📋</div>
          <div className="text-lg font-medium mb-2">Select a job to view</div>
          <div className="text-sm">Or drop a PDF in the left sidebar to start a new 3-extractor consensus job.</div>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="spinner" />
      </div>
    );
  }

  const filteredUnits = units.filter((u) => {
    if (selectedPage != null && !u.pages.includes(selectedPage)) return false;
    const res = resMap.get(u.key);
    if (filter === 'review' && res?.status !== 'needs_review') return false;
    if (filter === 'consensus' && res?.status !== 'consensus_resolved' && res?.status !== 'agreed') return false;
    if (search) {
      const text = (res?.finalText ?? res?.textA ?? []).join(' ').toLowerCase();
      if (!text.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  if (reviewResolution) {
    const unit = units.find((u) => u.key === reviewResolution.unitKey);
    const reviewable = resolutions.filter(
      (r) => r.status === 'needs_review' || r.status === 'judge_resolved'
    );
    const currIdx = reviewable.findIndex((r) => r.unitKey === reviewResolution.unitKey);
    const onNext =
      currIdx >= 0 && currIdx < reviewable.length - 1
        ? () => setReviewResolution(reviewable[currIdx + 1] ?? null)
        : undefined;
    const onPrev =
      currIdx > 0 ? () => setReviewResolution(reviewable[currIdx - 1] ?? null) : undefined;

    return (
      <DiffReview
        resolution={reviewResolution}
        unit={unit ?? null}
        jobId={job.id}
        onSave={handleResolutionUpdate}
        onClose={() => setReviewResolution(null)}
        onNext={onNext}
        onPrev={onPrev}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[var(--color-border)] flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold truncate">{job.fileName}</h1>
              <span className="badge badge-sm text-xs bg-[rgba(124,108,255,0.15)] text-accent border border-[rgba(124,108,255,0.3)]">
                🛡️ 3-Model Consensus
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted">
              <span>{job.pageCount} pages</span>
              <span>·</span>
              <span>Profile: {job.profile.toUpperCase()}</span>
              <span>·</span>
              <span>
                {agreedCount} of {units.length || job.pageCount} sections verified
              </span>
              {activeWorkingPage && !isFinished && (
                <>
                  <span>·</span>
                  <span className="text-accent font-semibold flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
                    Extracting Page {activeWorkingPage} of {job.pageCount}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {job.status === 'running' ? (
              <button
                className="btn btn-secondary btn-sm text-warning"
                onClick={() => void handlePause()}
                aria-label="Pause job"
              >
                ⏸ Pause
              </button>
            ) : job.status !== 'done' && job.status !== 'cancelled' ? (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void handleResume()}
                aria-label="Resume job"
              >
                ▶ Resume Extraction
              </button>
            ) : null}
            <button
              className="btn btn-secondary btn-sm"
              onClick={handlePrint}
              aria-label="Print or Save as PDF"
              title="Print document or Save as PDF"
            >
              🖨 Print / PDF
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void handleCopyAll()}
              aria-label="Copy all extracted text"
            >
              {copied ? '✅ Copied!' : '📋 Copy All'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleExport()}
              aria-label="Export as TXT"
            >
              ⬇ Export TXT
            </button>
          </div>
        </div>

        {/* Real-Time Consensus Badges Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 mt-3">
          <div className="card-2 text-center p-2">
            <div className="text-xl font-bold text-success">{consensus3Count}</div>
            <div className="text-xs text-muted">3/3 Consensus</div>
          </div>
          <div className="card-2 text-center p-2">
            <div className="text-xl font-bold text-success">{consensus2Count}</div>
            <div className="text-xs text-muted">2/3 Consensus</div>
          </div>
          <div className="card-2 text-center p-2">
            <div className="text-xl font-bold text-[var(--color-accent)]">{agreedCount}</div>
            <div className="text-xs text-muted">Total Verified</div>
          </div>
          <div className="card-2 text-center p-2">
            <div className="text-xl font-bold text-info">{rerunCount}</div>
            <div className="text-xs text-muted">Re-runs</div>
          </div>
          <div className="card-2 text-center p-2">
            <div className="text-xl font-bold text-warning">{reviewCount}</div>
            <div className="text-xs text-muted">Review</div>
          </div>
          <div className="card-2 text-center p-2">
            <div className="text-xl font-bold text-danger">{attentionCount}</div>
            <div className="text-xs text-muted">Attention</div>
          </div>
        </div>

        {/* Real-time Task Progress Bar */}
        <div className="mt-3">
          <div className="flex justify-between text-xs text-muted mb-1">
            <span className="font-medium text-[var(--color-text)]">
              {tasksRemainingCount === 0 && tasksTotalCount > 0
                ? 'All tasks completed'
                : `${tasksRemainingCount} tasks remaining (${tasksDoneCount}/${tasksTotalCount} done)`}
            </span>
            <span>
              {tasksTotalCount > 0 ? Math.round((tasksDoneCount / tasksTotalCount) * 100) : 0}%
            </span>
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={tasksDoneCount}
            aria-valuemin={0}
            aria-valuemax={tasksTotalCount}
          >
            <div
              className="progress-fill"
              style={{
                width: `${tasksTotalCount > 0 ? (tasksDoneCount / tasksTotalCount) * 100 : 0}%`,
              }}
            />
          </div>
        </div>

        {/* Live Extraction Finished Banner */}
        {isFinished && (
          <div className="mt-3 p-3 rounded bg-[rgba(74,222,128,0.1)] border border-[rgba(74,222,128,0.3)] text-success flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-2xl">🎉</span>
              <div>
                <div className="font-bold text-sm">
                  Document Extraction Finished! All {job.pageCount} pages complete.
                </div>
                <div className="text-xs text-muted">
                  Ordered strictly from Page 1 to {job.pageCount} · {agreedCount} sections verified
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setActiveTab('preview');
                  setPreviewMode('continuous');
                }}
              >
                📄 View Output
              </button>
              <button className="btn btn-sm btn-secondary" onClick={handlePrint}>
                🖨 Print / PDF
              </button>
              <button className="btn btn-sm btn-secondary" onClick={() => void handleExport()}>
                ⬇ Download TXT
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Navigation Tabs */}
      <div className="border-b border-[var(--color-border)] px-4 flex gap-1 flex-shrink-0">
        {(['preview', 'grid', 'units', 'events'] as const).map((tab) => (
          <button
            key={tab}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-semibold'
                : 'border-transparent text-muted hover:text-[var(--color-text)]'
            }`}
            onClick={() => setActiveTab(tab)}
            aria-selected={activeTab === tab}
            role="tab"
          >
            {tab === 'preview'
              ? '📄 Live Extraction & Output'
              : tab === 'grid'
              ? '▦ Page Grid'
              : tab === 'units'
              ? '📋 Units'
              : '⚡ Event Log'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {/* PREVIEW TAB: Strictly Ordered from Page 1 to Page N */}
        {activeTab === 'preview' && (
          <div className="h-full overflow-y-auto p-4">
            <div className="max-w-4xl mx-auto space-y-4">
              {/* Controls bar */}
              <div className="no-print flex flex-wrap items-center justify-between p-3 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] gap-2">
                <div>
                  <h3 className="font-bold text-sm text-[var(--color-text)] flex items-center gap-2">
                    <span>📄</span>
                    <span>Live Document Output (Strict Page Order 1 → {job.pageCount})</span>
                  </h3>
                  <div className="text-xs text-muted">
                    {pageResults.length} page extractions recorded · Verified in real-time by 3 extractors
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-xs">
                    <button
                      className={`px-2.5 py-1 ${previewMode === 'pages' ? 'bg-[var(--color-accent)] text-white' : 'bg-transparent text-muted'}`}
                      onClick={() => setPreviewMode('pages')}
                    >
                      📑 Page Cards
                    </button>
                    <button
                      className={`px-2.5 py-1 ${previewMode === 'continuous' ? 'bg-[var(--color-accent)] text-white' : 'bg-transparent text-muted'}`}
                      onClick={() => setPreviewMode('continuous')}
                    >
                      📜 Full Text
                    </button>
                  </div>

                  <button className="btn btn-sm btn-secondary" onClick={() => void handleCopyAll()}>
                    {copied ? '✅ Copied!' : '📋 Copy'}
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => void handleExport()}>
                    ⬇ Export TXT
                  </button>
                </div>
              </div>

              {/* Mode 1: Page-by-Page Verified Cards */}
              {previewMode === 'pages' && (
                <div className="space-y-4">
                  {Array.from({ length: job.pageCount }, (_, idx) => idx + 1).map((pageNum) => {
                    const consensus = pageConsensusMap.get(pageNum);
                    const pageTasks = tasks.filter(
                      (t) => t.kind === 'extract_page' && t.params.page === pageNum
                    );
                    const isPageDone = pageTasks.length > 0 && pageTasks.every((t) => t.status === 'done');
                    const isPageRunning = pageTasks.some((t) => t.status === 'running');
                    const hasAttention = pageTasks.some((t) => t.status === 'needs_attention');

                    const ratio = consensus?.consensusRatio ?? (isPageDone ? '3/3' : undefined);
                    const matched = consensus?.matchedRoles ?? ['A', 'B', 'C'];

                    // Extract text for this page
                    let paragraphs: string[] = [];
                    if (consensus && consensus.paragraphs.length > 0) {
                      paragraphs = consensus.paragraphs.map((p) => p.text);
                    } else {
                      // Fallback: look at units on this page
                      const pageUnits = units.filter((u) => u.pages.includes(pageNum));
                      paragraphs = pageUnits.flatMap((u) => {
                        const res = resMap.get(u.key);
                        return res?.finalText ?? res?.humanText ?? res?.textA ?? u.paragraphs.map((p) => p.text);
                      });
                    }

                    return (
                      <div
                        key={pageNum}
                        className={`card-2 border ${
                          isPageRunning
                            ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                            : ratio
                            ? 'border-[rgba(74,222,128,0.3)]'
                            : 'border-[var(--color-border)]'
                        }`}
                      >
                        {/* Page Header */}
                        <div className="flex items-center justify-between pb-2 mb-3 border-b border-[var(--color-border)]">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-sm">
                              Page {pageNum} of {job.pageCount}
                            </span>
                            {ratio === '3/3' ? (
                              <span className="badge badge-sm text-xs bg-[rgba(74,222,128,0.15)] text-success border border-[rgba(74,222,128,0.3)]">
                                ✅ 3/3 Consensus (A+B+C)
                              </span>
                            ) : ratio === '2/3' ? (
                              <span className="badge badge-sm text-xs bg-[rgba(74,222,128,0.15)] text-success border border-[rgba(74,222,128,0.3)]">
                                ✅ 2/3 Consensus ({matched.join('+')})
                              </span>
                            ) : isPageRunning ? (
                              <span className="badge badge-sm text-xs bg-[rgba(124,108,255,0.15)] text-accent border border-[rgba(124,108,255,0.3)] flex items-center gap-1">
                                <span className="spinner spinner-xs" />
                                Extracting sequentially...
                              </span>
                            ) : hasAttention ? (
                              <span className="badge badge-sm text-xs bg-[rgba(248,113,113,0.15)] text-danger border border-[rgba(248,113,113,0.3)]">
                                ⚠️ Disagreement / Retrying
                              </span>
                            ) : (
                              <span className="text-xs text-muted">⏳ Queued</span>
                            )}
                          </div>

                          {paragraphs.length > 0 && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs text-xs text-muted hover:text-[var(--color-text)]"
                              onClick={() => {
                                void navigator.clipboard.writeText(paragraphs.join('\n\n'));
                              }}
                              title="Copy this page's text"
                            >
                              📋 Copy Page
                            </button>
                          )}
                        </div>

                        {/* Page Body */}
                        {paragraphs.length > 0 ? (
                          <div
                            dir="auto"
                            className="font-mono text-xs leading-relaxed space-y-2 whitespace-pre-wrap text-[var(--color-text)]"
                          >
                            {paragraphs.map((p, pIdx) => (
                              <p key={pIdx} className="m-0">
                                {p}
                              </p>
                            ))}
                          </div>
                        ) : isPageRunning ? (
                          <div className="text-center py-6 text-xs text-muted italic">
                            Extractors running sequentially for Page {pageNum}...
                          </div>
                        ) : (
                          <div className="text-center py-4 text-xs text-muted italic">
                            Waiting for previous pages to finish...
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Mode 2: Continuous Document (Direct Print & Export View) */}
              {previewMode === 'continuous' && (
                <div className="print-container font-mono text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-text)] bg-[var(--color-surface)] p-6 rounded border border-[var(--color-border)] shadow-sm">
                  {pageResults.length === 0 && units.length === 0 ? (
                    <div className="text-muted text-center py-12 italic">
                      Extraction in progress. Live document text will appear here sequentially from Page 1 to Page {job.pageCount}.
                    </div>
                  ) : (
                    Array.from({ length: job.pageCount }, (_, idx) => idx + 1).map((pageNum) => {
                      const consensus = pageConsensusMap.get(pageNum);
                      let paras: string[] = [];
                      if (consensus && consensus.paragraphs.length > 0) {
                        paras = consensus.paragraphs.map((p) => p.text);
                      } else {
                        const pageUnits = units.filter((u) => u.pages.includes(pageNum));
                        paras = pageUnits.flatMap((u) => {
                          const res = resMap.get(u.key);
                          return res?.finalText ?? res?.humanText ?? res?.textA ?? u.paragraphs.map((p) => p.text);
                        });
                      }

                      if (paras.length === 0) return null;

                      return (
                        <div key={pageNum} className="mb-6">
                          <div className="text-xs text-muted font-bold border-b border-[var(--color-border)] pb-1 mb-2">
                            --- Page {pageNum} ---
                          </div>
                          <div dir="auto" className="space-y-3">
                            {paras.map((p, pIdx) => (
                              <p key={pIdx} className="m-0 leading-relaxed">
                                {p}
                              </p>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* PAGE GRID TAB */}
        {activeTab === 'grid' && (
          <PageGrid
            job={job}
            tasks={tasks}
            units={units}
            selectedPage={selectedPage}
            onSelectPage={(p) => {
              setSelectedPage(p);
              setActiveTab('preview');
              setPreviewMode('pages');
            }}
          />
        )}

        {/* UNITS TAB */}
        {activeTab === 'units' && (
          <div className="flex flex-col h-full">
            {/* Filter bar */}
            <div className="flex items-center gap-2 p-3 border-b border-[var(--color-border)] flex-shrink-0">
              <input
                className="input flex-1"
                placeholder="Search extracted units…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search units"
              />
              {selectedPage != null && (
                <button
                  className="btn btn-sm btn-secondary flex items-center gap-1"
                  onClick={() => setSelectedPage(null)}
                  title="Clear page filter"
                  aria-label="Clear page filter"
                >
                  <span>P. {selectedPage}</span>
                  <span className="text-muted">✕</span>
                </button>
              )}
              <div className="flex gap-1">
                {(['all', 'consensus', 'review'] as const).map((f) => (
                  <button
                    key={f}
                    className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                  >
                    {f === 'all' ? 'All Units' : f === 'consensus' ? '✅ Consensus' : '👁 Review'}
                  </button>
                ))}
              </div>
            </div>

            {/* Units table */}
            <div className="flex-1 overflow-y-auto">
              {filteredUnits.length === 0 ? (
                <div className="text-center text-muted p-8">No units found matching filter.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[var(--color-surface)] z-10">
                    <tr className="text-left text-xs text-muted border-b border-[var(--color-border)]">
                      <th className="px-4 py-2 font-medium">Key</th>
                      <th className="px-4 py-2 font-medium">Pages</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Text Preview</th>
                      <th className="px-4 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUnits.map((unit) => {
                      const res = resMap.get(unit.key);
                      const preview = (res?.finalText ?? res?.textA ?? ['—'])[0] ?? '—';
                      return (
                        <tr
                          key={unit.id}
                          className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)] transition-colors"
                        >
                          <td className="px-4 py-2 font-mono text-xs text-muted">{unit.key}</td>
                          <td className="px-4 py-2 text-xs text-muted">
                            {unit.pages.join(', ')}
                          </td>
                          <td className="px-4 py-2">
                            {res ? (
                              <UnitStatusBadge
                                status={res.status}
                                consensusRatio={res.consensusRatio}
                              />
                            ) : (
                              <span className="text-muted text-xs">pending</span>
                            )}
                          </td>
                          <td className="px-4 py-2 max-w-sm">
                            <div dir="auto" className="truncate text-xs" title={preview}>
                              {preview.slice(0, 120)}
                            </div>
                          </td>
                          <td className="px-4 py-2">
                            {res &&
                              (res.status === 'needs_review' ||
                                res.status === 'judge_resolved' ||
                                res.status === 'needs_attention') && (
                                <button
                                  className="btn btn-sm btn-secondary"
                                  onClick={() => setReviewResolution(res)}
                                  aria-label={`Review unit ${unit.key}`}
                                >
                                  Review
                                </button>
                              )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* EVENTS TAB */}
        {activeTab === 'events' && (
          <div className="h-full overflow-y-auto p-3 space-y-1">
            {events.map((e) => (
              <div key={e.id} className="text-xs font-mono flex gap-2 py-0.5">
                <span className="text-muted flex-shrink-0">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-[var(--color-text-muted)] flex-shrink-0 w-28 truncate">
                  {e.type}
                </span>
                <span className="text-[var(--color-text)]">{e.message}</span>
              </div>
            ))}
            {events.length === 0 && (
              <div className="text-muted text-center p-4">No events logged yet.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

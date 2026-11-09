import React, { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../app/store';
import { useEngine } from '../app/EngineProvider';
import { storePdfBlob, putJob, appendEvent, getAllJobs } from '../storage/repositories';
import { sha256Blob } from '../utils/hash';
import { loadPdf } from '../pdf/renderer';
import { detectProfile } from '../pipeline/profiles';
import type { Job, JobStatus } from '../storage/schema';
import { DEFAULT_SETTINGS } from '../app/store';
import { exportJobsZip } from '../export/backup';

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  paused_offline: 'Paused',
  paused_attention: 'Needs Attention',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_CHIP: Record<JobStatus, string> = {
  queued: 'chip chip-queued',
  running: 'chip chip-running',
  paused_offline: 'chip chip-paused',
  paused_attention: 'chip chip-attention',
  done: 'chip chip-done',
  cancelled: 'chip chip-cancelled',
};

function ProgressBar({ value, max }: { value: number; max: number }): React.ReactElement {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function JobList(): React.ReactElement {
  const { jobs, setJobs, setActiveJob, activeJobId, settings } = useAppStore();
  const { scheduler } = useEngine();
  const dropRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);

  const effectiveSettings = settings ?? DEFAULT_SETTINGS;

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setImporting(true);
      const currentSettings = useAppStore.getState().settings ?? settings ?? DEFAULT_SETTINGS;
      const fileArr = Array.from(files).filter((f) => f.name.endsWith('.pdf'));

      for (const file of fileArr) {
        try {
          const blob = new Blob([await file.arrayBuffer()], { type: 'application/pdf' });
          const hash = await sha256Blob(blob);

          // Check for duplicate
          const existing = jobs.find((j) => j.sha256 === hash);
          if (existing) {
            alert(`"${file.name}" is already in the list.`);
            continue;
          }

          const jobId = crypto.randomUUID();
          await storePdfBlob(jobId, blob);
          const pageCount = await loadPdf(jobId, blob);

          // Auto-detect profile from first page text
          const profile = currentSettings.profile;

          const job: Job = {
            id: jobId,
            fileName: file.name,
            sha256: hash,
            pageCount,
            profile,
            status: 'queued',
            settingsSnapshot: currentSettings,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            stats: {
              totalPages: pageCount,
              pagesRendered: 0,
              pagesExtracted: 0,
              totalUnits: 0,
              unitsAgreed: 0,
              unitsAgreedAfterRerun: 0,
              unitsJudgeResolved: 0,
              unitsNeedsReview: 0,
              unitsHumanResolved: 0,
              unitsNeedsAttention: 0,
              tasksDone: 0,
              tasksTotal: pageCount * 2, // A + B per page
              startedAt: Date.now(),
            },
          };

          await putJob(job);
          await appendEvent({
            id: crypto.randomUUID(),
            jobId,
            type: 'job_created',
            message: `Job created: "${file.name}" (${pageCount} pages)`,
            timestamp: Date.now(),
          });

          // Start the job
          const startedJob: Job = { ...job, status: 'running' };
          await putJob(startedJob);
          scheduler.addJob(jobId);

          const allJobs = await getAllJobs();
          setJobs(allJobs);
        } catch (err) {
          console.error('[JobList] Failed to import', file.name, err);
          alert(`Failed to import "${file.name}": ${String(err)}`);
        }
      }
      setImporting(false);
    },
    [jobs, effectiveSettings, scheduler, setJobs]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) void handleFiles(e.target.files);
      e.target.value = '';
    },
    [handleFiles]
  );

  const handleDelete = useCallback(
    async (jobId: string) => {
      if (!confirm('Delete this job and all its data?')) return;
      const { deleteJob: del } = await import('../storage/repositories');
      await del(jobId);
      const allJobs = await getAllJobs();
      setJobs(allJobs);
      if (activeJobId === jobId) setActiveJob(null);
    },
    [activeJobId, setActiveJob, setJobs]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Drop zone */}
      <div
        ref={dropRef}
        className={`m-3 rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer flex flex-col items-center justify-center p-6 text-center ${
          dragging
            ? 'border-[var(--color-accent)] bg-[rgba(124,108,255,0.1)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[rgba(124,108,255,0.05)]'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => document.getElementById('pdf-input')?.click()}
        role="button"
        tabIndex={0}
        aria-label="Drop PDF files here or click to browse"
        onKeyDown={(e) => e.key === 'Enter' && document.getElementById('pdf-input')?.click()}
      >
        <input
          id="pdf-input"
          type="file"
          accept=".pdf"
          multiple
          className="hidden"
          onChange={onFileInput}
          aria-label="Select PDF files"
        />
        <div className="text-3xl mb-2">📄</div>
        <div className="text-sm font-medium text-[var(--color-text)]">
          {importing ? 'Importing…' : 'Drop PDFs here'}
        </div>
        <div className="text-xs text-muted mt-1">or click to browse</div>
      </div>

      {jobs.length > 0 && (
        <div className="px-3 pb-1 flex justify-end">
          <button
            className="btn btn-ghost btn-sm text-xs"
            onClick={async () => {
              const blob = await exportJobsZip();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `lawtext_export_${new Date().toISOString().slice(0, 10)}.zip`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            title="Export all jobs as ZIP"
            aria-label="Export all jobs as ZIP"
          >
            📦 Export all (ZIP)
          </button>
        </div>
      )}

      {/* Job list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
        {jobs.length === 0 && (
          <div className="text-center text-muted text-sm py-8">
            No jobs yet. Drop a PDF to get started.
          </div>
        )}
        {jobs
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((job) => (
            <div
              key={job.id}
              className={`card-2 cursor-pointer transition-all duration-150 ${
                activeJobId === job.id
                  ? 'border-[var(--color-accent)] bg-[rgba(124,108,255,0.08)]'
                  : 'hover:border-[rgba(124,108,255,0.4)]'
              }`}
              onClick={() => setActiveJob(job.id)}
              role="button"
              tabIndex={0}
              aria-label={`Open job: ${job.fileName}`}
              onKeyDown={(e) => e.key === 'Enter' && setActiveJob(job.id)}
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="font-medium text-sm truncate flex-1" title={job.fileName}>
                  {job.fileName}
                </div>
                <span className={STATUS_CHIP[job.status]} aria-label={`Status: ${STATUS_LABELS[job.status]}`}>
                  {job.status === 'running' && <span className="spinner" style={{ width: 8, height: 8 }} />}
                  {STATUS_LABELS[job.status]}
                </span>
              </div>
              <div className="text-xs text-muted mb-1.5">
                {job.pageCount} pages · {job.profile.toUpperCase()}
              </div>
              <ProgressBar value={job.stats.tasksDone} max={job.stats.tasksTotal} />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-xs text-muted">
                  {job.stats.tasksDone}/{job.stats.tasksTotal} tasks
                </span>
                <button
                  className="btn btn-ghost btn-sm text-danger"
                  onClick={(e) => { e.stopPropagation(); void handleDelete(job.id); }}
                  aria-label={`Delete job: ${job.fileName}`}
                  title="Delete job"
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

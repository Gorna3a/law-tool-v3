import React from 'react';
import type { Job, Task, Unit, TaskStatus } from '../storage/schema';

interface PageGridProps {
  job: Job;
  tasks: Task[];
  units: Unit[];
  selectedPage?: number | null;
  onSelectPage: (page: number) => void;
}

function RoleStatusBadge({ role, status }: { role: 'A' | 'B'; status: TaskStatus | 'none' }): React.ReactElement {
  const colorClass =
    status === 'done'
      ? 'text-success bg-[rgba(74,222,128,0.1)]'
      : status === 'running'
      ? 'text-accent bg-[rgba(124,108,255,0.15)]'
      : status === 'needs_attention'
      ? 'text-danger bg-[rgba(248,113,113,0.15)]'
      : 'text-muted bg-[rgba(136,136,170,0.1)]';

  const icon =
    status === 'done' ? '✓' : status === 'running' ? '⟳' : status === 'needs_attention' ? '!' : '⋯';

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${colorClass}`}
      title={`Agent ${role}: ${status}`}
    >
      <span>{role}:</span>
      <span>{icon}</span>
    </span>
  );
}

export function PageGrid({
  job,
  tasks,
  units,
  selectedPage,
  onSelectPage,
}: PageGridProps): React.ReactElement {
  const pageTasks = new Map<string, TaskStatus>();
  for (const t of tasks) {
    if (t.kind === 'extract_page' && t.params.page != null) {
      pageTasks.set(`${t.params.page}:${t.role}`, t.status);
    }
  }

  // Count units per page
  const unitsByPage = new Map<number, number>();
  for (const u of units) {
    for (const p of u.pages) {
      unitsByPage.set(p, (unitsByPage.get(p) ?? 0) + 1);
    }
  }

  const pages = Array.from({ length: job.pageCount }, (_, i) => i + 1);

  return (
    <div className="p-3 overflow-y-auto h-full" role="region" aria-label="Page grid">
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
        {pages.map((p) => {
          const statusA = pageTasks.get(`${p}:A`) ?? 'pending';
          const statusB = pageTasks.get(`${p}:B`) ?? 'pending';
          const unitCount = unitsByPage.get(p) ?? 0;
          const isSelected = selectedPage === p;

          return (
            <button
              key={p}
              type="button"
              className={`card-2 flex flex-col gap-1.5 p-2 text-left cursor-pointer transition-all hover:border-[var(--color-accent)] ${
                isSelected ? 'border-[var(--color-accent)] bg-[rgba(124,108,255,0.1)]' : ''
              }`}
              onClick={() => onSelectPage(p)}
              aria-label={`Page ${p}, Agent A: ${statusA}, Agent B: ${statusB}, ${unitCount} units`}
              aria-pressed={isSelected}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-xs">P. {p}</span>
                <span className="text-[10px] text-muted">
                  {unitCount > 0 ? `${unitCount} u.` : ''}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <RoleStatusBadge role="A" status={statusA} />
                <RoleStatusBadge role="B" status={statusB} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

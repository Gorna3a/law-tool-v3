import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { Resolution, Unit } from '../storage/schema';
import { getPageImage } from '../storage/repositories';
import { wordDiff, normaliseForCompare } from '../pipeline/parse';

interface DiffReviewProps {
  resolution: Resolution;
  unit: Unit | null;
  jobId: string;
  onSave: (updated: Resolution) => Promise<void>;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
}

function renderDiff(a: string, b: string): React.ReactElement[] {
  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);
  const maxLen = Math.max(aWords.length, bWords.length);
  const elements: React.ReactElement[] = [];

  for (let i = 0; i < maxLen; i++) {
    const aw = aWords[i] ?? '';
    const bw = bWords[i] ?? '';
    if (aw !== bw) {
      elements.push(<span key={i} className="diff-a">{aw} </span>);
    } else {
      elements.push(<span key={i}>{aw} </span>);
    }
  }
  return elements;
}

function renderDiffB(a: string, b: string): React.ReactElement[] {
  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);
  const maxLen = Math.max(aWords.length, bWords.length);
  const elements: React.ReactElement[] = [];

  for (let i = 0; i < maxLen; i++) {
    const aw = aWords[i] ?? '';
    const bw = bWords[i] ?? '';
    if (aw !== bw) {
      elements.push(<span key={i} className="diff-b">{bw} </span>);
    } else {
      elements.push(<span key={i}>{bw} </span>);
    }
  }
  return elements;
}

export function DiffReview({
  resolution,
  unit,
  jobId,
  onSave,
  onClose,
  onNext,
  onPrev,
}: DiffReviewProps): React.ReactElement {
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const textA = resolution.textA?.join('\n\n') ?? '';
  const textB = resolution.textB?.join('\n\n') ?? '';
  const textJ = resolution.textJ?.join('\n\n') ?? '';

  useEffect(() => {
    // Load page image
    const page = unit?.pages[0];
    if (page == null) return;
    void (async () => {
      const blob = await getPageImage(jobId, page);
      if (blob) {
        const url = URL.createObjectURL(blob);
        setPageImageUrl(url);
        return () => URL.revokeObjectURL(url);
      }
    })();
  }, [jobId, unit]);

  const handleChoose = useCallback(
    async (choice: 'A' | 'B' | 'J') => {
      setSaving(true);
      const finalText =
        choice === 'A'
          ? resolution.textA ?? []
          : choice === 'B'
          ? resolution.textB ?? []
          : resolution.textJ ?? [];

      await onSave({
        ...resolution,
        status: 'human_resolved',
        humanText: finalText,
        finalText,
        resolvedAt: Date.now(),
        resolvedBy: 'human',
      });
      setSaving(false);
    },
    [resolution, onSave]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (!editMode) {
        if (e.key === '1') void handleChoose('A');
        if (e.key === '2') void handleChoose('B');
        if (e.key === '3') void handleChoose('J');
        if (e.key === 'j' || e.key === 'J') onNext?.();
        if (e.key === 'k' || e.key === 'K') onPrev?.();
        if (e.key === 'e' || e.key === 'E') {
          const current = resolution.finalText ?? resolution.textA ?? [];
          setEditText(current.join('\n\n'));
          setEditMode(true);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, resolution, onNext, onPrev, onClose, handleChoose]);

  const handleEditSave = useCallback(async () => {
    setSaving(true);
    const lines = editText.split('\n\n').map((t) => t.trim()).filter(Boolean);
    await onSave({
      ...resolution,
      status: 'human_resolved',
      humanText: lines,
      finalText: lines,
      resolvedAt: Date.now(),
      resolvedBy: 'human',
    });
    setSaving(false);
  }, [editText, resolution, onSave]);

  return (
    <div className="flex flex-col h-full overflow-hidden" role="dialog" aria-label="Review unit">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-[var(--color-border)] flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-medium text-sm">Reviewing: </span>
          <span className="font-mono text-xs text-accent font-semibold">{resolution.unitKey}</span>
          <div className="flex items-center gap-1">
            <button
              className="btn btn-ghost btn-sm"
              onClick={onPrev}
              disabled={!onPrev}
              title="Previous unit (K)"
              aria-label="Previous unit"
            >
              ← <kbd className="text-[10px] ml-1 opacity-70">K</kbd>
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onNext}
              disabled={!onNext}
              title="Next unit (J)"
              aria-label="Next unit"
            >
              → <kbd className="text-[10px] ml-1 opacity-70">J</kbd>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <kbd className="text-xs text-muted bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">ESC to close</kbd>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close review">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {/* Page image with zoom */}
        <div className="w-1/3 border-r border-[var(--color-border)] flex flex-col bg-[var(--color-bg)] overflow-hidden">
          <div className="p-2 border-b border-[var(--color-border)] flex items-center justify-between text-xs text-muted">
            <span>Page {unit?.pages.join(', ') ?? ''}</span>
            <div className="flex items-center gap-1">
              <button
                className="btn btn-ghost btn-sm px-1.5 py-0.5 text-xs"
                onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
                aria-label="Zoom out"
                title="Zoom out"
              >
                −
              </button>
              <span className="w-10 text-center font-mono text-xs">{Math.round(zoom * 100)}%</span>
              <button
                className="btn btn-ghost btn-sm px-1.5 py-0.5 text-xs"
                onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
                aria-label="Zoom in"
                title="Zoom in"
              >
                +
              </button>
              <button
                className="btn btn-ghost btn-sm px-1.5 py-0.5 text-xs"
                onClick={() => setZoom(1)}
                aria-label="Reset zoom"
              >
                1:1
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {pageImageUrl ? (
              <img
                src={pageImageUrl}
                alt={`Page ${unit?.pages[0] ?? ''}`}
                className="rounded transition-transform duration-100 origin-top-left"
                style={{
                  imageRendering: 'crisp-edges',
                  transform: `scale(${zoom})`,
                  maxWidth: zoom <= 1 ? '100%' : 'none',
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted">No image</div>
            )}
          </div>
        </div>

        {/* Text columns */}
        <div className="flex-1 overflow-auto p-3">
          {editMode ? (
            <div className="h-full flex flex-col gap-2">
              <div className="text-sm font-medium">Edit final text:</div>
              <textarea
                ref={textareaRef}
                className="input flex-1 font-mono text-sm resize-none"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                aria-label="Edit final text"
                dir="auto"
              />
              <div className="flex gap-2 justify-end">
                <button className="btn btn-secondary" onClick={() => setEditMode(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => void handleEditSave()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 h-full">
              {/* Agent A */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted uppercase">Agent A</span>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => void handleChoose('A')}
                    disabled={saving}
                    aria-label="Use Agent A reading (press 1)"
                    title="Press 1"
                  >
                    Use A <kbd className="ml-1 opacity-50">1</kbd>
                  </button>
                </div>
                <div
                  className="card-2 flex-1 overflow-auto text-sm font-mono whitespace-pre-wrap leading-relaxed"
                  dir="auto"
                >
                  {renderDiff(textA, textB)}
                </div>
              </div>

              {/* Agent B */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted uppercase">Agent B</span>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => void handleChoose('B')}
                    disabled={saving}
                    aria-label="Use Agent B reading (press 2)"
                    title="Press 2"
                  >
                    Use B <kbd className="ml-1 opacity-50">2</kbd>
                  </button>
                </div>
                <div
                  className="card-2 flex-1 overflow-auto text-sm font-mono whitespace-pre-wrap leading-relaxed"
                  dir="auto"
                >
                  {renderDiffB(textA, textB)}
                </div>
              </div>

              {/* Judge */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted uppercase">
                    Judge {resolution.judgeConfidence && <span className="text-xs">({resolution.judgeConfidence})</span>}
                  </span>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => void handleChoose('J')}
                    disabled={saving || !textJ}
                    aria-label="Use Judge reading (press 3)"
                    title="Press 3"
                  >
                    Use J <kbd className="ml-1 opacity-50">3</kbd>
                  </button>
                </div>
                <div
                  className="card-2 flex-1 overflow-auto text-sm font-mono whitespace-pre-wrap leading-relaxed"
                  dir="auto"
                >
                  {textJ || <span className="text-muted italic">Judge not yet available</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer actions */}
      {!editMode && (
        <div className="flex justify-end gap-2 p-3 border-t border-[var(--color-border)] flex-shrink-0">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              const current = resolution.finalText ?? resolution.textA ?? [];
              setEditText(current.join('\n\n'));
              setEditMode(true);
            }}
            aria-label="Edit text manually"
          >
            ✏ Edit manually
          </button>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useCallback } from 'react';
import { useAppStore } from '../app/store';
import type { GateState } from '../engine/gate';
import { useEngine } from '../app/EngineProvider';

function formatCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function gateMessage(
  state: GateState,
  nextProbeMs: number | undefined,
  pausedReason?: string
): { text: string; subtext?: string } | null {
  if (state === 'ONLINE') return null;

  if (state === 'PAUSING') {
    return { text: 'Connection lost. Saving progress…' };
  }

  if (state === 'PAUSED') {
    const countdown = nextProbeMs !== undefined ? ` Next retry in ${formatCountdown(nextProbeMs)}.` : '';
    if (pausedReason === 'rate_limit') {
      return {
        text: 'OmniRoute is reachable but the models are rate-limited.',
        subtext: `Your progress is saved.${countdown}`,
      };
    }
    if (pausedReason === 'upstream_error') {
      return {
        text: 'OmniRoute is reachable but the models are not responding.',
        subtext: `Your progress is saved.${countdown}`,
      };
    }
    return {
      text: 'Connection to OmniRoute lost. Your progress is saved.',
      subtext: `Reconnecting automatically.${countdown}`,
    };
  }

  if (state === 'PROBING') {
    return { text: 'Testing gateway connection…' };
  }

  if (state === 'RESUMING') {
    return { text: 'Connection restored. Running canary task…' };
  }

  return null;
}

export function ConnectionBanner(): React.ReactElement | null {
  const { gateState, nextProbeMs, jobs } = useAppStore();
  const { gate } = useEngine();

  const retryNow = useCallback(() => gate.retryNow(), [gate]);

  const pausedJob = jobs.find((j) => j.status === 'paused_offline' || j.status === 'running');
  const pausedReason = pausedJob?.pausedReason;

  const msg = gateMessage(gateState, nextProbeMs, pausedReason);
  if (!msg) return null;

  // Count tasks done / total
  const runningJob = jobs.find((j) => j.status === 'running' || j.status === 'paused_offline');
  const tasksDone = runningJob?.stats.tasksDone ?? 0;
  const tasksTotal = runningJob?.stats.tasksTotal ?? 0;

  return (
    <div
      className="banner banner-warning"
      role="status"
      aria-live="polite"
      aria-label="Connection status"
    >
      <span className="spinner" />
      <div className="flex-1">
        <span className="font-medium">{msg.text}</span>
        {tasksTotal > 0 && (
          <span className="text-muted ml-2">
            ({tasksDone} of {tasksTotal} tasks done.)
          </span>
        )}
        {msg.subtext && (
          <span className="ml-2 opacity-80">{msg.subtext}</span>
        )}
      </div>
      <div className="flex gap-2 flex-shrink-0">
        <button
          className="btn btn-sm btn-secondary"
          onClick={retryNow}
          aria-label="Retry connection now"
        >
          Retry now
        </button>
      </div>
    </div>
  );
}

export function AttentionBanner(): React.ReactElement | null {
  const { jobs } = useAppStore();
  const attentionJobs = jobs.filter((j) => j.status === 'paused_attention');

  if (attentionJobs.length === 0) return null;

  return (
    <div className="banner banner-error" role="alert">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0V5zm.75 7a1 1 0 110-2 1 1 0 010 2z"/>
      </svg>
      <span className="flex-1">
        {attentionJobs.length === 1
          ? `"${attentionJobs[0]!.fileName}" needs attention. Check Settings.`
          : `${attentionJobs.length} jobs need attention. Check Settings.`}
      </span>
    </div>
  );
}

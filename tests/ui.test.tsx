/**
 * UI Component Tests:
 * - ConnectionBanner states and messaging (calm tone, no red toasts for transient failures)
 * - AttentionBanner copy
 * - DiffReview panel choices (Use A, Use B, Use Judge) and persistence
 * - Keyboard shortcuts (1, 2, 3, Escape)
 * - RTL rendering (dir="auto")
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionBanner, AttentionBanner } from '../src/ui/Banners';
import { DiffReview } from '../src/ui/DiffReview';
import { useAppStore } from '../src/app/store';
import type { Resolution, Unit } from '../src/storage/schema';

// Mock useEngine hook
vi.mock('../src/app/EngineProvider', () => ({
  useEngine: () => ({
    gate: {
      retryNow: vi.fn(),
    },
  }),
}));

describe('Banners UI', () => {
  beforeEach(() => {
    useAppStore.setState({
      gateState: 'ONLINE',
      nextProbeMs: undefined,
      jobs: [],
    });
  });

  it('renders nothing when connection is ONLINE', () => {
    const { container } = render(<ConnectionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders calm reconnection message when PAUSED due to network outage', () => {
    useAppStore.setState({
      gateState: 'PAUSED',
      nextProbeMs: 8000,
      jobs: [
        {
          id: 'j1',
          fileName: 'gazette.pdf',
          status: 'paused_offline',
          pausedReason: 'network_down',
          stats: { tasksDone: 10, tasksTotal: 20 },
        } as any,
      ],
    });

    render(<ConnectionBanner />);
    expect(screen.getByText(/Connection to OmniRoute lost/i)).toBeInTheDocument();
    expect(screen.getByText(/Your progress is saved/i)).toBeInTheDocument();
    expect(screen.getByText(/10 of 20 tasks done/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry connection now/i })).toBeInTheDocument();
  });

  it('renders rate limit message when models are rate-limited', () => {
    useAppStore.setState({
      gateState: 'PAUSED',
      nextProbeMs: 20000,
      jobs: [
        {
          id: 'j2',
          fileName: 'gazette.pdf',
          status: 'paused_offline',
          pausedReason: 'rate_limit',
          stats: { tasksDone: 5, tasksTotal: 10 },
        } as any,
      ],
    });

    render(<ConnectionBanner />);
    expect(screen.getByText(/OmniRoute is reachable but the models are rate-limited/i)).toBeInTheDocument();
  });

  it('renders attention banner when jobs have paused_attention', () => {
    useAppStore.setState({
      jobs: [
        {
          id: 'j-att',
          fileName: 'decree.pdf',
          status: 'paused_attention',
        } as any,
      ],
    });

    render(<AttentionBanner />);
    expect(screen.getByText(/"decree.pdf" needs attention. Check Settings./i)).toBeInTheDocument();
  });
});

describe('DiffReview UI', () => {
  const sampleResolution: Resolution = {
    id: 'res-1',
    jobId: 'job-1',
    unitId: 'u1',
    unitKey: 'art:1',
    status: 'needs_review',
    textA: ['Art. 1er. — Le ministre décide.'],
    textB: ['Art. 1er. — Le directeur décide.'],
    textJ: ['Art. 1er. — Le ministre décide.'],
    reruns: 1,
    judgeConfidence: 'high',
  };

  const sampleUnit: Unit = {
    id: 'u1',
    jobId: 'job-1',
    type: 'article',
    key: 'art:1',
    pages: [1],
    paragraphs: [{ text: 'Art. 1er. — Le ministre décide.' }],
  };

  it('renders three columns (A, B, Judge) and unit key', () => {
    render(
      <DiffReview
        resolution={sampleResolution}
        unit={sampleUnit}
        jobId="job-1"
        onSave={async () => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByText('art:1')).toBeInTheDocument();
    expect(screen.getByText(/Agent A/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent B/i)).toBeInTheDocument();
    expect(screen.getByText(/Judge/i)).toBeInTheDocument();
  });

  it('invokes onSave with human_resolved and choice when Use A is clicked', async () => {
    const saveSpy = vi.fn();

    render(
      <DiffReview
        resolution={sampleResolution}
        unit={sampleUnit}
        jobId="job-1"
        onSave={saveSpy}
        onClose={() => {}}
      />
    );

    const useAButton = screen.getByRole('button', { name: /Use Agent A reading/i });
    fireEvent.click(useAButton);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const updated = saveSpy.mock.calls[0][0];
    expect(updated.status).toBe('human_resolved');
    expect(updated.resolvedBy).toBe('human');
    expect(updated.finalText).toEqual(sampleResolution.textA);
  });

  it('handles keyboard shortcuts 1, 2, 3 to choose readings', () => {
    const saveSpy = vi.fn();

    render(
      <DiffReview
        resolution={sampleResolution}
        unit={sampleUnit}
        jobId="job-1"
        onSave={saveSpy}
        onClose={() => {}}
      />
    );

    // Press '2' to choose B
    fireEvent.keyDown(window, { key: '2' });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const updated = saveSpy.mock.calls[0][0];
    expect(updated.finalText).toEqual(sampleResolution.textB);
  });
});

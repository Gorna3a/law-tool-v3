import { create } from 'zustand';
import type { Job, EventLogEntry, JobSettings, Resolution } from '../storage/schema';
import type { GateState } from '../engine/gate';

export interface AppState {
  // Gate
  gateState: GateState;
  nextProbeMs: number | undefined;

  // Jobs
  jobs: Job[];
  activeJobId: string | null;

  // Settings
  settings: JobSettings | null;
  settingsOpen: boolean;

  // Events
  recentEvents: EventLogEntry[];

  // Review
  reviewResolution: Resolution | null;

  // Actions
  setGateState: (state: GateState, nextProbeMs?: number) => void;
  setJobs: (jobs: Job[]) => void;
  updateJob: (job: Job) => void;
  setActiveJob: (id: string | null) => void;
  setSettings: (s: JobSettings | null) => void;
  setSettingsOpen: (open: boolean) => void;
  appendRecentEvent: (event: EventLogEntry) => void;
  setRecentEvents: (events: EventLogEntry[]) => void;
  setReviewResolution: (r: Resolution | null) => void;
}

export const DEFAULT_SETTINGS: JobSettings = {
  gatewayUrl: '/gemini',
  apiKey: '',
  modelA: 'gemini-2.5-flash',
  modelB: 'gemini-2.0-flash',
  modelC: 'gemini-1.5-flash',
  modelJ: 'gemini-2.5-flash',
  agentA: {
    provider: 'gemini',
    gatewayUrl: '/gemini',
    apiKey: '',
    model: 'gemini-2.5-flash',
  },
  agentB: {
    provider: 'gemini',
    gatewayUrl: '/gemini',
    apiKey: '',
    model: 'gemini-2.0-flash',
  },
  agentC: {
    provider: 'gemini',
    gatewayUrl: '/gemini',
    apiKey: '',
    model: 'gemini-1.5-flash',
  },
  rpmA: 0,
  rpmB: 0,
  rpmC: 0,
  rpmJ: 0,
  maxTokens: 8192,
  requestTimeoutMs: 180_000,
  maxReruns: 2,
  judgeEachRound: true,
  neighborPages: 1,
  concurrency: 2,
  imageMaxEdge: 2000,
  imageFormat: 'png',
  useTextLayerHint: true,
  hyphenJoin: true,
  profile: 'fr',
};

export const useAppStore = create<AppState>((set) => ({
  gateState: 'ONLINE',
  nextProbeMs: undefined,
  jobs: [],
  activeJobId: null,
  settings: null,
  settingsOpen: false,
  recentEvents: [],
  reviewResolution: null,

  setGateState: (state, nextProbeMs) => set({ gateState: state, nextProbeMs }),
  setJobs: (jobs) => set({ jobs }),
  updateJob: (job) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === job.id ? job : j)),
    })),
  setActiveJob: (id) => set({ activeJobId: id }),
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  appendRecentEvent: (event) =>
    set((s) => ({
      recentEvents: [event, ...s.recentEvents].slice(0, 500),
    })),
  setRecentEvents: (events) => set({ recentEvents: events }),
  setReviewResolution: (r) => set({ reviewResolution: r }),
}));

if (typeof window !== 'undefined') {
  (window as unknown as { __APP_STORE__: typeof useAppStore }).__APP_STORE__ = useAppStore;
}

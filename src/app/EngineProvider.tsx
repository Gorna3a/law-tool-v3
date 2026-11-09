import React, { createContext, useContext, useEffect, useRef } from 'react';
import { GatewayClient } from '../gateway/client';
import { Gate } from '../engine/gate';
import { RoleThrottle } from '../gateway/throttle';
import { Scheduler } from '../engine/scheduler';
import { useAppStore, DEFAULT_SETTINGS } from './store';
import {
  loadSettings,
  getAllJobs,
  getRecentEvents,
  appendEvent,
} from '../storage/repositories';

interface EngineContext {
  gate: Gate;
  client: GatewayClient;
  scheduler: Scheduler;
  throttle: RoleThrottle;
}

const Ctx = createContext<EngineContext | null>(null);

export function useEngine(): EngineContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useEngine must be used within EngineProvider');
  return ctx;
}

export function EngineProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const engineRef = useRef<EngineContext | null>(null);
  const { setGateState, setJobs, setSettings, setRecentEvents, settings } =
    useAppStore();

  if (!engineRef.current) {
    const settingsNow = settings ?? DEFAULT_SETTINGS;
    const client = new GatewayClient({
      baseUrl: settingsNow.gatewayUrl,
      apiKey: settingsNow.apiKey,
      timeoutMs: settingsNow.requestTimeoutMs,
    });
    const throttle = new RoleThrottle();
    const gate = new Gate(client, {
      maxConcurrency: settingsNow.concurrency,
      minBackoffMs: 2_000,
      maxBackoffMs: 60_000,
    });
    const scheduler = new Scheduler(gate, client, throttle, () => useAppStore.getState().settings ?? DEFAULT_SETTINGS);
    engineRef.current = { gate, client, scheduler, throttle };
  }

  const engine = engineRef.current;

  useEffect(() => {
    // Subscribe gate state to store
    const unsub = engine.gate.subscribe((state, nextProbeMs) => {
      setGateState(state, nextProbeMs);
    });

    // Load initial data
    void (async () => {
      const [savedSettings, jobs, events] = await Promise.all([
        loadSettings(),
        getAllJobs(),
        getRecentEvents(200),
      ]);

      if (savedSettings) {
        setSettings(savedSettings);
        engine.client.updateOptions({
          baseUrl: savedSettings.gatewayUrl,
          apiKey: savedSettings.apiKey,
          timeoutMs: savedSettings.requestTimeoutMs,
        });
      }
      setJobs(jobs);
      setRecentEvents(events);

      // Resume interrupted jobs
      await engine.scheduler.resumeJobs(true);
      engine.scheduler.start();

      await appendEvent({
        id: crypto.randomUUID(),
        type: 'job_started',
        message: 'LawText app started.',
        timestamp: Date.now(),
      });
    })();

    // Periodic refresh of jobs in store so tasksDone, progress bars, and stats stay live
    const syncInterval = setInterval(async () => {
      try {
        const freshJobs = await getAllJobs();
        setJobs(freshJobs);
      } catch {}
    }, 1200);

    return () => {
      unsub();
      clearInterval(syncInterval);
      engine.scheduler.stop();
    };
  }, []);

  // Update throttle and gateway client when settings change
  useEffect(() => {
    if (!settings) return;
    engine.throttle.setRpm('A', settings.rpmA ?? 0);
    engine.throttle.setRpm('B', settings.rpmB ?? 0);
    engine.throttle.setRpm('J', settings.rpmJ ?? 0);
    engine.client.updateOptions({
      baseUrl: settings.gatewayUrl,
      apiKey: settings.apiKey,
      timeoutMs: settings.requestTimeoutMs,
    });
  }, [settings]);

  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

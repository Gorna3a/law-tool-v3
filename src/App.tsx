import React from 'react';
import { EngineProvider } from './app/EngineProvider';
import { useAppStore } from './app/store';
import { JobList } from './ui/JobList';
import { JobView } from './ui/JobView';
import { SettingsPanel } from './ui/SettingsPanel';
import { ConnectionBanner, AttentionBanner } from './ui/Banners';
import { ErrorBoundary } from './ui/ErrorBoundary';

function AppShell(): React.ReactElement {
  const { settingsOpen, setSettingsOpen } = useAppStore();

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Top bar */}
      <header
        className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex-shrink-0"
        style={{ zIndex: 10 }}
      >
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold tracking-tight bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] bg-clip-text" style={{ WebkitBackgroundClip: 'text', color: 'transparent' }}>
            LawText
          </span>
          <span className="text-xs text-muted hidden sm:block">AI-powered legal gazette extractor</span>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open Settings"
            id="open-settings-btn"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      {/* Banners */}
      <ErrorBoundary>
        <ConnectionBanner />
        <AttentionBanner />
      </ErrorBoundary>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: Job list */}
        <aside className="sidebar" aria-label="Job list">
          <div className="px-3 pt-3 pb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted uppercase tracking-wide">Jobs</span>
          </div>
          <ErrorBoundary>
            <JobList />
          </ErrorBoundary>
        </aside>

        {/* Main content: Job view */}
        <main className="main-content" aria-label="Job details">
          <ErrorBoundary>
            <JobView />
          </ErrorBoundary>
        </main>
      </div>

      {/* Settings modal */}
      {settingsOpen && (
        <ErrorBoundary>
          <SettingsPanel />
        </ErrorBoundary>
      )}
    </div>
  );
}

export default function App(): React.ReactElement {
  return (
    <EngineProvider>
      <AppShell />
    </EngineProvider>
  );
}

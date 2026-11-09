import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAppStore, DEFAULT_SETTINGS } from '../app/store';
import { saveSettings, getAllJobs, putJob } from '../storage/repositories';
import type { JobSettings, Job, AgentEndpointConfig } from '../storage/schema';
import { GatewayClient } from '../gateway/client';
import { exportStateBackup, importStateBackup } from '../export/backup';
import { getProfile, normaliseDigits } from '../pipeline/profiles';
import { PROMPT_VERSION, SYSTEM_EXTRACTOR, SHARED_RULES } from '../pipeline/prompts';
import {
  PROVIDER_CATALOG,
  filterVisionModels,
  findBestVisionModel,
  testVisionCapability,
} from '../gateway/models';

function Field({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="form-group">
      <label className="label" data-tooltip={tooltip}>
        {label}
      </label>
      {children}
    </div>
  );
}

const CURATED_SUGGESTIONS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'pixtral-12b-2409',
  'mistral-small-latest',
  'pixtral-large-latest',
  'llama-3.2-11b-vision-preview',
  'llama-3.2-90b-vision-preview',
  'llama-3.3-70b-versatile',
  'gpt-4o',
  'gpt-4o-mini',
  'claude-3-5-sonnet',
];

export function SettingsPanel(): React.ReactElement {
  const { settings, setSettings, setSettingsOpen } = useAppStore();
  const [local, setLocal] = useState<JobSettings>(settings ?? DEFAULT_SETTINGS);

  const [useSeparateEndpoints, setUseSeparateEndpoints] = useState(
    Boolean(
      (settings?.agentA && settings?.agentB && (settings.agentA.provider !== settings.agentB.provider || settings.agentA.apiKey !== settings.agentB.apiKey)) ||
      (settings?.agentB && settings?.agentC && (settings.agentB.provider !== settings.agentC.provider || settings.agentB.apiKey !== settings.agentC.apiKey))
    )
  );

  const [sameModelForAll, setSameModelForAll] = useState(
    (settings ?? DEFAULT_SETTINGS).modelA === (settings ?? DEFAULT_SETTINGS).modelB &&
    (settings ?? DEFAULT_SETTINGS).modelA === (settings ?? DEFAULT_SETTINGS).modelC
  );

  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [visionTest, setVisionTest] = useState<Record<string, string>>({});
  const [providerStatus, setProviderStatus] = useState<
    Record<string, { ok?: boolean; message: string; rttMs?: number; count?: number; testing?: boolean }>
  >({});

  const [activeSection, setActiveSection] = useState<'general' | 'profiles' | 'prompts' | 'data'>('general');
  const [testText, setTestText] = useState('Art. 137.— Est puni de...');
  const [testProfileId, setTestProfileId] = useState('fr');
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<string>('Checking…');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = settings ?? DEFAULT_SETTINGS;
    setLocal(s);
    setSameModelForAll(s.modelA === s.modelB && s.modelA === s.modelC);
  }, [settings]);

  useEffect(() => {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        const usageMb = ((est.usage ?? 0) / (1024 * 1024)).toFixed(1);
        const quotaMb = ((est.quota ?? 0) / (1024 * 1024)).toFixed(0);
        setStorageEstimate(`${usageMb} MB used of ${quotaMb} MB total`);
      }).catch(() => setStorageEstimate('Storage API not supported'));
    }
  }, []);

  const handleExportBackup = async () => {
    try {
      const jsonStr = await exportStateBackup();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lawtext_backup_${new Date().toISOString().slice(0, 10)}.lawtext.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupStatus('✅ Backup exported successfully');
    } catch (err) {
      setBackupStatus(`❌ Export failed: ${String(err)}`);
    }
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await importStateBackup(text);
      const allJobs = await getAllJobs();
      useAppStore.getState().setJobs(allJobs);
      setBackupStatus(`✅ Imported ${res.importedJobs} jobs successfully`);
    } catch (err) {
      setBackupStatus(`❌ Import failed: ${String(err)}`);
    }
    e.target.value = '';
  };

  const testProfile = getProfile(testProfileId) ?? getProfile('fr')!;
  const testArticleMatch = testProfile.articlePattern.exec(testText);
  const testIsArticle = !!testArticleMatch;
  const testArticleNum = testArticleMatch ? testProfile.articleNumberExtractor(testArticleMatch) : null;
  const testIsHeading = testProfile.headingPattern.test(testText);
  const testIsClosing = testProfile.closingPattern.test(testText);

  const update = (patch: Partial<JobSettings>) => setLocal((s) => ({ ...s, ...patch }));

  const getProviderKey = useCallback(
    (provider: string): string => {
      if (local.providerKeys?.[provider as keyof typeof local.providerKeys]) {
        return local.providerKeys[provider as keyof typeof local.providerKeys]!;
      }
      const key = local.apiKey ?? '';
      if (!key) return '';
      if (provider === 'gemini') {
        if (key.startsWith('AIzaSy') || local.gatewayUrl?.includes('gemini') || local.gatewayUrl?.includes('googleapis')) {
          return key;
        }
      }
      if (provider === 'groq') {
        if (key.startsWith('gsk_') || local.gatewayUrl?.includes('groq')) {
          return key;
        }
      }
      if (provider === 'mistral') {
        if (!key.startsWith('AIzaSy') && !key.startsWith('gsk_') && local.gatewayUrl?.includes('mistral')) {
          return key;
        }
      }
      return '';
    },
    [local]
  );

  const getEffectiveAgent = (role: 'A' | 'B' | 'C'): AgentEndpointConfig => {
    const key = role === 'A' ? 'agentA' : role === 'B' ? 'agentB' : 'agentC';
    const existing = local[key];
    const defaultModel = (role === 'A' ? local.modelA : role === 'B' ? local.modelB : local.modelC) || 'gemini-2.5-flash';

    const derivedProvider: AgentEndpointConfig['provider'] = existing?.provider ?? (
      local.gatewayUrl?.includes('mistral')
        ? 'mistral'
        : local.gatewayUrl?.includes('groq')
        ? 'groq'
        : local.gatewayUrl?.includes('freetheai')
        ? 'freetheai'
        : local.gatewayUrl?.includes('omniroute') || local.gatewayUrl?.includes('20128')
        ? 'omniroute'
        : 'gemini'
    );

    const effectiveKey = existing?.apiKey || getProviderKey(derivedProvider);
    const catalog = PROVIDER_CATALOG[derivedProvider];
    const effectiveUrl = existing?.gatewayUrl || catalog?.proxyEndpoint || local.gatewayUrl || '/gemini';

    return {
      provider: derivedProvider,
      gatewayUrl: effectiveUrl,
      apiKey: effectiveKey,
      model: existing?.model || defaultModel,
    };
  };

  const updateAgent = (role: 'A' | 'B' | 'C', patch: Partial<AgentEndpointConfig>) => {
    const key = role === 'A' ? 'agentA' : role === 'B' ? 'agentB' : 'agentC';
    const modelKey = role === 'A' ? 'modelA' : role === 'B' ? 'modelB' : 'modelC';
    const current = getEffectiveAgent(role);
    const updated = { ...current, ...patch };

    const statePatch: Partial<JobSettings> = {
      [key]: updated,
    };
    if (patch.model) {
      statePatch[modelKey] = patch.model;
    }
    if (!useSeparateEndpoints && role === 'A') {
      // Sync to all
      if (patch.gatewayUrl) statePatch.gatewayUrl = patch.gatewayUrl;
      if (patch.apiKey !== undefined) statePatch.apiKey = patch.apiKey;
    }
    update(statePatch);
  };

  const handleModelChange = useCallback((role: 'A' | 'B' | 'C', value: string) => {
    if (sameModelForAll) {
      update({
        modelA: value,
        modelB: value,
        modelC: value,
        agentA: { ...getEffectiveAgent('A'), model: value },
        agentB: { ...getEffectiveAgent('B'), model: value },
        agentC: { ...getEffectiveAgent('C'), model: value },
      });
    } else {
      const modelKey = role === 'A' ? 'modelA' : role === 'B' ? 'modelB' : 'modelC';
      const agentKey = role === 'A' ? 'agentA' : role === 'B' ? 'agentB' : 'agentC';
      update({
        [modelKey]: value,
        [agentKey]: { ...getEffectiveAgent(role), model: value },
      });
    }
  }, [sameModelForAll, local]);

  const handleApplyModelToAll = useCallback((value: string) => {
    update({
      modelA: value,
      modelB: value,
      modelC: value,
      agentA: { ...getEffectiveAgent('A'), model: value },
      agentB: { ...getEffectiveAgent('B'), model: value },
      agentC: { ...getEffectiveAgent('C'), model: value },
    });
    setSameModelForAll(true);
  }, [local]);

  const getProviderPreset = (url: string): string => {
    if (url === '/gemini') return 'gemini-proxy';
    if (url.includes('generativelanguage.googleapis.com')) return 'gemini-direct';
    if (url === '/groq') return 'groq-proxy';
    if (url.includes('api.groq.com')) return 'groq-direct';
    if (url === '/mistral') return 'mistral-proxy';
    if (url.includes('api.mistral.ai')) return 'mistral-direct';
    if (url === '/freetheai') return 'freetheai-proxy';
    if (url.includes('api.freetheai.org')) return 'freetheai-direct';
    if (url === '/omniroute') return 'omniroute-proxy';
    if (url.includes('20128')) return 'omniroute-direct';
    return 'custom';
  };

  const handleGlobalProviderPresetChange = (preset: string) => {
    let url = local.gatewayUrl;
    let provider: AgentEndpointConfig['provider'] = 'gemini';
    let defaultModel = 'gemini-2.5-flash';

    switch (preset) {
      case 'gemini-proxy':
        url = '/gemini';
        provider = 'gemini';
        defaultModel = 'gemini-2.5-flash';
        break;
      case 'gemini-direct':
        url = 'https://generativelanguage.googleapis.com/v1beta/openai';
        provider = 'gemini';
        defaultModel = 'gemini-2.5-flash';
        break;
      case 'groq-proxy':
        url = '/groq';
        provider = 'groq';
        defaultModel = 'llama-3.2-11b-vision-preview';
        break;
      case 'groq-direct':
        url = 'https://api.groq.com/openai/v1';
        provider = 'groq';
        defaultModel = 'llama-3.2-11b-vision-preview';
        break;
      case 'mistral-proxy':
        url = '/mistral';
        provider = 'mistral';
        defaultModel = 'pixtral-12b-2409';
        break;
      case 'mistral-direct':
        url = 'https://api.mistral.ai/v1';
        provider = 'mistral';
        defaultModel = 'pixtral-12b-2409';
        break;
      case 'freetheai-proxy':
        url = '/freetheai';
        provider = 'freetheai';
        defaultModel = 'gpt-4o-mini';
        break;
      case 'freetheai-direct':
        url = 'https://api.freetheai.org/v1';
        provider = 'freetheai';
        defaultModel = 'gpt-4o-mini';
        break;
      case 'omniroute-direct':
        url = 'http://localhost:20128';
        provider = 'omniroute';
        defaultModel = 'law-extract-a';
        break;
      case 'omniroute-proxy':
        url = '/omniroute';
        provider = 'omniroute';
        defaultModel = 'law-extract-a';
        break;
      case 'custom':
        provider = 'custom';
        break;
    }

    const providerKey = local.providerKeys?.[provider] || local.apiKey || '';

    update({
      gatewayUrl: url,
      apiKey: providerKey,
      modelA: defaultModel,
      modelB: defaultModel === 'gemini-2.5-flash' ? 'gemini-2.0-flash' : defaultModel,
      modelC: defaultModel === 'gemini-2.5-flash' ? 'gemini-1.5-flash' : defaultModel,
      agentA: { provider, gatewayUrl: url, apiKey: providerKey, model: defaultModel },
      agentB: { provider, gatewayUrl: url, apiKey: providerKey, model: defaultModel === 'gemini-2.5-flash' ? 'gemini-2.0-flash' : defaultModel },
      agentC: { provider, gatewayUrl: url, apiKey: providerKey, model: defaultModel === 'gemini-2.5-flash' ? 'gemini-1.5-flash' : defaultModel },
    });
  };

  const handleProviderKeyChange = (providerName: string, keyVal: string) => {
    const updatedKeys = {
      ...(local.providerKeys ?? {}),
      [providerName]: keyVal,
    };
    const patch: Partial<JobSettings> = {
      providerKeys: updatedKeys,
    };

    // If active global matches, sync apiKey
    const activeProvider = getEffectiveAgent('A').provider;
    if (activeProvider === providerName || !local.apiKey) {
      patch.apiKey = keyVal;
    }

    // Sync to agents using this provider
    (['A', 'B', 'C'] as const).forEach((r) => {
      const agent = getEffectiveAgent(r);
      if (agent.provider === providerName) {
        const agentKey = r === 'A' ? 'agentA' : r === 'B' ? 'agentB' : 'agentC';
        patch[agentKey] = { ...agent, apiKey: keyVal };
      }
    });

    update(patch);
  };

  const allModelSuggestions = Array.from(
    new Set([
      ...models.map((m) => m.id),
      ...Object.values(providerModels).flat(),
      ...CURATED_SUGGESTIONS,
    ])
  );

  const handleSave = useCallback(async () => {
    await saveSettings(local);
    setSettings(local);

    // Update existing active/queued/paused jobs so they immediately use the new gateway and models
    try {
      const allJobs = await getAllJobs();
      let updated = false;
      for (const job of allJobs) {
        if (job.status !== 'done' && job.status !== 'cancelled') {
          const updatedJob: Job = {
            ...job,
            settingsSnapshot: {
              ...job.settingsSnapshot,
              gatewayUrl: local.gatewayUrl,
              apiKey: local.apiKey,
              modelA: local.modelA,
              modelB: local.modelB,
              modelC: local.modelC,
              agentA: local.agentA,
              agentB: local.agentB,
              agentC: local.agentC,
              maxTokens: local.maxTokens,
              requestTimeoutMs: local.requestTimeoutMs,
            },
            updatedAt: Date.now(),
          };
          await putJob(updatedJob);
          updated = true;
        }
      }
      if (updated) {
        const refreshed = await getAllJobs();
        useAppStore.getState().setJobs(refreshed);
      }
    } catch {}

    setSettingsOpen(false);
  }, [local, setSettings, setSettingsOpen]);

  const handleTestSingleProvider = useCallback(
    async (providerId: 'gemini' | 'mistral' | 'groq') => {
      const catalog = PROVIDER_CATALOG[providerId];
      const endpoint = catalog?.proxyEndpoint ?? `/${providerId}`;
      const apiKey = getProviderKey(providerId);
      const provName = providerId === 'gemini' ? 'Google Gemini' : providerId === 'mistral' ? 'Mistral AI' : 'Groq Cloud';

      if (!apiKey) {
        setProviderStatus((prev) => ({
          ...prev,
          [providerId]: { ok: false, message: 'Please enter an API key first' },
        }));
        return;
      }

      setProviderStatus((prev) => ({
        ...prev,
        [providerId]: { testing: true, message: 'Connecting…' },
      }));

      try {
        const client = new GatewayClient({
          baseUrl: endpoint,
          apiKey,
          timeoutMs: 15_000,
        });
        const health = await client.healthCheck(endpoint, apiKey);
        if (!health.ok) {
          setProviderStatus((prev) => ({
            ...prev,
            [providerId]: { ok: false, message: `Failed (${health.raw ?? 'Unreachable'})` },
          }));
          return;
        }

        let modelList: { id: string; owned_by: string }[] = [];
        try {
          modelList = await client.listModels(endpoint, apiKey);
        } catch {
          // fallback
        }

        const msg = `Connected (${modelList.length} models, ${health.rttMs}ms)`;
        setProviderStatus((prev) => ({
          ...prev,
          [providerId]: {
            ok: true,
            message: msg,
            rttMs: health.rttMs,
            count: modelList.length,
          },
        }));

        if (modelList.length > 0) {
          setProviderModels((prev) => ({
            ...prev,
            [providerId]: modelList.map((m) => m.id),
          }));
          setModels((prev) => [...prev, ...modelList]);
        }
      } catch (err: unknown) {
        const errorObj = err as { userMessage?: string; message?: string; raw?: string };
        const msg = errorObj.userMessage || errorObj.raw || errorObj.message || String(err);
        setProviderStatus((prev) => ({
          ...prev,
          [providerId]: { ok: false, message: `Error: ${msg.slice(0, 90)}` },
        }));
      }
    },
    [local, getProviderKey]
  );

  const handleTestAllProviders = useCallback(async () => {
    setTesting(true);
    setTestResult('Testing all configured providers (Gemini, Mistral, Groq)...');

    const providers = ['gemini', 'mistral', 'groq'] as const;
    const summaryLines: string[] = [];

    for (const prov of providers) {
      const catalog = PROVIDER_CATALOG[prov];
      const endpoint = catalog?.proxyEndpoint ?? `/${prov}`;
      const apiKey = getProviderKey(prov);
      const provName = prov === 'gemini' ? '✨ Google Gemini' : prov === 'mistral' ? '🌪️ Mistral AI' : '⚡ Groq Cloud';

      if (!apiKey) {
        summaryLines.push(`${provName}: ⚠️ No API key entered`);
        setProviderStatus((prev) => ({
          ...prev,
          [prov]: { ok: false, message: 'No API key entered' },
        }));
        continue;
      }

      setProviderStatus((prev) => ({
        ...prev,
        [prov]: { testing: true, message: 'Connecting…' },
      }));

      try {
        const client = new GatewayClient({ baseUrl: endpoint, apiKey, timeoutMs: 15_000 });
        const health = await client.healthCheck(endpoint, apiKey);
        if (!health.ok) {
          summaryLines.push(`${provName}: ❌ Failed (${health.raw ?? 'Unreachable'})`);
          setProviderStatus((prev) => ({
            ...prev,
            [prov]: { ok: false, message: `Failed: ${health.raw ?? 'Unreachable'}` },
          }));
          continue;
        }

        let modelList: { id: string; owned_by: string }[] = [];
        try {
          modelList = await client.listModels(endpoint, apiKey);
          if (modelList.length > 0) {
            setProviderModels((prev) => ({ ...prev, [prov]: modelList.map((m) => m.id) }));
            setModels((prev) => [...prev, ...modelList]);
          }
        } catch {}

        summaryLines.push(`${provName}: ✅ Connected (${modelList.length} models, ${health.rttMs}ms RTT)`);
        setProviderStatus((prev) => ({
          ...prev,
          [prov]: {
            ok: true,
            message: `Connected (${modelList.length} models, ${health.rttMs}ms)`,
            rttMs: health.rttMs,
            count: modelList.length,
          },
        }));
      } catch (err: unknown) {
        const errorObj = err as { userMessage?: string; message?: string; raw?: string };
        const msg = errorObj.userMessage || errorObj.raw || errorObj.message || String(err);
        summaryLines.push(`${provName}: ❌ ${msg.slice(0, 90)}`);
        setProviderStatus((prev) => ({
          ...prev,
          [prov]: { ok: false, message: `Error: ${msg.slice(0, 90)}` },
        }));
      }
    }

    setTestResult(summaryLines.join('\n'));
    setTesting(false);
  }, [local, getProviderKey]);

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const client = new GatewayClient({
        baseUrl: local.gatewayUrl,
        apiKey: local.apiKey,
        timeoutMs: 15_000,
      });
      const health = await client.healthCheck();
      if (!health.ok) {
        setTestResult(`❌ Gateway unreachable. ${health.raw ?? ''}`);
        setTesting(false);
        return;
      }
      const modelList = await client.listModels();
      setModels(modelList);
      setTestResult(`✅ Connected. RTT: ${health.rttMs}ms. ${modelList.length} models available.`);
    } catch (err: unknown) {
      const errorObj = err as { userMessage?: string; message?: string; raw?: string };
      const msg = errorObj.userMessage || errorObj.raw || errorObj.message || String(err);
      setTestResult(`❌ Error: ${msg}`);
    }
    setTesting(false);
  }, [local]);

  const handleVisionTest = useCallback(
    async (role: 'A' | 'B' | 'C') => {
      const agent = getEffectiveAgent(role);
      const model = (role === 'A' ? local.modelA : role === 'B' ? local.modelB : local.modelC) || 'gemini-2.5-flash';
      const baseUrl = agent.gatewayUrl || local.gatewayUrl;
      const apiKey = agent.apiKey || getProviderKey(agent.provider);

      if (!apiKey) {
        setVisionTest((v) => ({ ...v, [role]: `⚠️ Please enter an API key for ${agent.provider.toUpperCase()} first.` }));
        return;
      }

      setVisionTest((v) => ({ ...v, [role]: 'Testing vision capability in backend…' }));
      try {
        const client = new GatewayClient({
          baseUrl,
          apiKey,
          timeoutMs: 30_000,
        });
        const res = await testVisionCapability(client, baseUrl, apiKey, model);
        if (res.ok) {
          setVisionTest((v) => ({
            ...v,
            [role]: `✅ Vision Verified (${res.rttMs}ms RTT). Model '${model}' accepts image input.`,
          }));
        } else {
          setVisionTest((v) => ({
            ...v,
            [role]: `❌ Vision Test Failed: ${res.error?.slice(0, 160)}`,
          }));
        }
      } catch (err: unknown) {
        const errorObj = err as { userMessage?: string; message?: string; raw?: string };
        const msg = errorObj.userMessage || errorObj.raw || errorObj.message || String(err);
        setVisionTest((v) => ({ ...v, [role]: `❌ Error: ${msg.slice(0, 160)}` }));
      }
    },
    [local, getProviderKey]
  );

  /**
   * Automatically fetch free vision models from configured provider(s)
   * and auto-select & verify the best vision models for Extractor A, B, and C!
   */
  const handleAutoDetectAndTestVisionModels = useCallback(async () => {
    setAutoDetecting(true);
    setTestResult('⚡ Auto-detecting vision models across configured providers...');

    try {
      // 1. Gather all providers for which the user actually has credentials
      const availableProviders: {
        provider: 'gemini' | 'mistral' | 'groq';
        apiKey: string;
        baseUrl: string;
        name: string;
      }[] = [];

      const gemKey = getProviderKey('gemini');
      if (gemKey) {
        availableProviders.push({ provider: 'gemini', apiKey: gemKey, baseUrl: '/gemini', name: 'Google Gemini' });
      }

      const misKey = getProviderKey('mistral');
      if (misKey) {
        availableProviders.push({ provider: 'mistral', apiKey: misKey, baseUrl: '/mistral', name: 'Mistral AI' });
      }

      const grqKey = getProviderKey('groq');
      if (grqKey) {
        availableProviders.push({ provider: 'groq', apiKey: grqKey, baseUrl: '/groq', name: 'Groq Cloud' });
      }

      // Fallback: If none matched above but local.apiKey exists
      if (availableProviders.length === 0 && local.apiKey) {
        if (local.apiKey.startsWith('AIzaSy')) {
          availableProviders.push({ provider: 'gemini', apiKey: local.apiKey, baseUrl: '/gemini', name: 'Google Gemini' });
        } else if (local.apiKey.startsWith('gsk_')) {
          availableProviders.push({ provider: 'groq', apiKey: local.apiKey, baseUrl: '/groq', name: 'Groq Cloud' });
        } else if (!local.apiKey.startsWith('AIzaSy') && !local.apiKey.startsWith('gsk_')) {
          const prov = local.gatewayUrl?.includes('mistral') ? 'mistral' : local.gatewayUrl?.includes('groq') ? 'groq' : 'gemini';
          availableProviders.push({ provider: prov, apiKey: local.apiKey, baseUrl: local.gatewayUrl || '/gemini', name: prov });
        }
      }

      if (availableProviders.length === 0) {
        setTestResult('⚠️ No API key found. Please enter your API key in the boxes above (Google Gemini, Mistral AI, or Groq Cloud) and try again.');
        setAutoDetecting(false);
        return;
      }

      const roles = ['A', 'B', 'C'] as const;
      const updatedAgents: Record<string, AgentEndpointConfig> = {};
      const newModels: { id: string; owned_by: string }[] = [];

      for (let i = 0; i < roles.length; i++) {
        const role = roles[i]!;
        // Distribute across available authenticated providers
        const provConfig = availableProviders[i % availableProviders.length]!;
        const { provider, baseUrl, apiKey, name } = provConfig;

        setVisionTest((v) => ({ ...v, [role]: `🔍 Fetching models from ${name}...` }));

        const client = new GatewayClient({ baseUrl, apiKey, timeoutMs: 20_000 });
        let modelList: { id: string; owned_by: string }[] = [];
        try {
          modelList = await client.listModels(baseUrl, apiKey);
          newModels.push(...modelList);
        } catch (err: unknown) {
          const errorObj = err as { userMessage?: string; message?: string; raw?: string };
          const msg = errorObj.userMessage || errorObj.raw || errorObj.message || String(err);
          setVisionTest((v) => ({ ...v, [role]: `❌ Auth error on ${name}: ${msg.slice(0, 90)}` }));
          // Do not attempt complete() with failed key
          continue;
        }

        const modelIds = modelList.map((m) => m.id);
        const visionList = filterVisionModels(provider, modelIds);

        // Pick distinct vision models if same provider
        let chosenModel = '';
        if (visionList.length > 0) {
          if (role === 'A') {
            chosenModel = visionList[0]!;
          } else if (role === 'B') {
            chosenModel = visionList.length > 1 && provConfig === availableProviders[0] ? visionList[1]! : visionList[0]!;
          } else {
            chosenModel = visionList.length > 2 && provConfig === availableProviders[0] ? visionList[2]! : visionList[0]!;
          }
        } else {
          chosenModel = findBestVisionModel(provider, modelIds);
        }

        setVisionTest((v) => ({
          ...v,
          [role]: `✅ Auto-Assigned: ${name} - ${chosenModel} (Vision Model)`,
        }));

        updatedAgents[role] = {
          provider,
          gatewayUrl: baseUrl,
          apiKey,
          model: chosenModel,
        };
      }

      setModels((prev) => [...prev, ...newModels]);

      // Apply detected models
      update({
        gatewayUrl: updatedAgents['A']?.gatewayUrl || local.gatewayUrl,
        apiKey: updatedAgents['A']?.apiKey || local.apiKey,
        modelA: updatedAgents['A']?.model || local.modelA,
        modelB: updatedAgents['B']?.model || local.modelB,
        modelC: updatedAgents['C']?.model || local.modelC,
        agentA: updatedAgents['A'],
        agentB: updatedAgents['B'],
        agentC: updatedAgents['C'],
      });

      const summary = roles
        .map((r) => updatedAgents[r] ? `Extractor ${r}: ${updatedAgents[r]!.provider.toUpperCase()} (${updatedAgents[r]!.model})` : null)
        .filter(Boolean)
        .join(' · ');

      setTestResult(`✅ Vision models detected & assigned: ${summary}`);
    } catch (err: unknown) {
      const errorObj = err as { userMessage?: string; message?: string; raw?: string };
      const msg = errorObj.userMessage || errorObj.raw || errorObj.message || String(err);
      setTestResult(`❌ Auto-detection error: ${msg}`);
    }

    setAutoDetecting(false);
  }, [local, getProviderKey]);

  const isHttp = local.gatewayUrl.startsWith('http://');
  const isLocalhost =
    local.gatewayUrl.includes('localhost') || local.gatewayUrl.includes('127.0.0.1');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      role="dialog"
      aria-label="Settings"
      aria-modal="true"
    >
      <div
        className="card w-full max-w-3xl max-h-[92vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <span>⚙️</span>
              <span>Settings & Consensus Extractors</span>
            </h2>
            <p className="text-xs text-muted">
              Configure 3-Extractor Consensus, Multi-Provider Endpoints, and Language Profiles
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen(false)} aria-label="Close settings">✕</button>
        </div>

        {/* Section Tabs */}
        <div className="flex gap-2 border-b border-[var(--color-border)] pb-2 mb-4 overflow-x-auto">
          <button
            className={`btn btn-sm ${activeSection === 'general' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveSection('general')}
          >
            🤖 3 Extractors & Providers
          </button>
          <button
            className={`btn btn-sm ${activeSection === 'profiles' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveSection('profiles')}
          >
            🌐 Profile Tester
          </button>
          <button
            className={`btn btn-sm ${activeSection === 'prompts' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveSection('prompts')}
          >
            📝 Prompts (v{PROMPT_VERSION})
          </button>
          <button
            className={`btn btn-sm ${activeSection === 'data' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveSection('data')}
          >
            💾 Data & Backup
          </button>
        </div>

        {activeSection === 'general' && (
          <div>
            {/* Security warnings */}
            {isHttp && !isLocalhost && (
              <div className="banner banner-warning mb-3">
                ⚠ Using plain HTTP on a non-local address. Your API key is sent unencrypted.
              </div>
            )}

            {/* Architecture Explanation Banner */}
            <div className="p-3 mb-4 rounded bg-[rgba(124,108,255,0.08)] border border-[rgba(124,108,255,0.25)] text-xs space-y-1">
              <div className="font-semibold text-accent flex items-center gap-1.5">
                <span>🛡️</span>
                <span>3-Model Consensus Architecture (No Judge Needed)</span>
              </div>
              <div className="text-muted leading-relaxed">
                Extractor A, B, and C process pages <strong>strictly sequentially</strong> (one at a time per page to eliminate rate-limit errors).
                When <strong>2 or 3 extractors agree</strong> (<code>2/3</code> or <code>3/3</code>), the result is verified and committed directly to the live output.
                If all 3 disagree (<code>0/3</code>), the page is automatically re-extracted.
              </div>
            </div>

            {/* Provider API Keys Quick Config */}
            <div className="card-2 mb-4">
              <h3 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <span>🔑</span>
                <span>Provider API Keys & Testing</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Google Gemini */}
                <div>
                  <label className="label text-xs font-semibold text-accent mb-1">
                    ✨ Google Gemini API Key
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      className="input text-xs flex-1"
                      type="password"
                      value={local.providerKeys?.gemini ?? (getProviderKey('gemini') || '')}
                      onChange={(e) => handleProviderKeyChange('gemini', e.target.value)}
                      placeholder="AIzaSy…"
                      aria-label="Gemini API Key"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs text-xs flex-shrink-0"
                      onClick={() => void handleTestSingleProvider('gemini')}
                      disabled={providerStatus['gemini']?.testing}
                      title="Test Gemini API connection"
                    >
                      {providerStatus['gemini']?.testing ? <span className="spinner spinner-xs" /> : '🔌 Test'}
                    </button>
                  </div>
                  {providerStatus['gemini'] && (
                    <div
                      className={`text-[11px] mt-1 p-1 rounded font-mono ${
                        providerStatus['gemini'].ok
                          ? 'text-success bg-[rgba(74,222,128,0.08)]'
                          : 'text-danger bg-[rgba(248,113,113,0.08)]'
                      }`}
                    >
                      {providerStatus['gemini'].ok ? '✅ ' : '❌ '}
                      {providerStatus['gemini'].message}
                    </div>
                  )}
                </div>

                {/* Mistral AI */}
                <div>
                  <label className="label text-xs font-semibold text-accent mb-1">
                    🌪️ Mistral AI API Key
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      className="input text-xs flex-1"
                      type="password"
                      value={local.providerKeys?.mistral ?? (getProviderKey('mistral') || '')}
                      onChange={(e) => handleProviderKeyChange('mistral', e.target.value)}
                      placeholder="sk-mistral-…"
                      aria-label="Mistral API Key"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs text-xs flex-shrink-0"
                      onClick={() => void handleTestSingleProvider('mistral')}
                      disabled={providerStatus['mistral']?.testing}
                      title="Test Mistral API connection"
                    >
                      {providerStatus['mistral']?.testing ? <span className="spinner spinner-xs" /> : '🔌 Test'}
                    </button>
                  </div>
                  {providerStatus['mistral'] && (
                    <div
                      className={`text-[11px] mt-1 p-1 rounded font-mono ${
                        providerStatus['mistral'].ok
                          ? 'text-success bg-[rgba(74,222,128,0.08)]'
                          : 'text-danger bg-[rgba(248,113,113,0.08)]'
                      }`}
                    >
                      {providerStatus['mistral'].ok ? '✅ ' : '❌ '}
                      {providerStatus['mistral'].message}
                    </div>
                  )}
                </div>

                {/* Groq Cloud */}
                <div>
                  <label className="label text-xs font-semibold text-accent mb-1">
                    ⚡ Groq Cloud API Key
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      className="input text-xs flex-1"
                      type="password"
                      value={local.providerKeys?.groq ?? (getProviderKey('groq') || '')}
                      onChange={(e) => handleProviderKeyChange('groq', e.target.value)}
                      placeholder="gsk_…"
                      aria-label="Groq API Key"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs text-xs flex-shrink-0"
                      onClick={() => void handleTestSingleProvider('groq')}
                      disabled={providerStatus['groq']?.testing}
                      title="Test Groq API connection"
                    >
                      {providerStatus['groq']?.testing ? <span className="spinner spinner-xs" /> : '🔌 Test'}
                    </button>
                  </div>
                  {providerStatus['groq'] && (
                    <div
                      className={`text-[11px] mt-1 p-1 rounded font-mono ${
                        providerStatus['groq'].ok
                          ? 'text-success bg-[rgba(74,222,128,0.08)]'
                          : 'text-danger bg-[rgba(248,113,113,0.08)]'
                      }`}
                    >
                      {providerStatus['groq'].ok ? '✅ ' : '❌ '}
                      {providerStatus['groq'].message}
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary text-xs flex items-center gap-1.5 py-1.5"
                  onClick={() => void handleAutoDetectAndTestVisionModels()}
                  disabled={autoDetecting}
                  id="settings-auto-detect-vision"
                >
                  {autoDetecting ? <span className="spinner spinner-xs" /> : '⚡'}
                  <span>Auto-Detect & Test Vision Models (All Extractors)</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm text-xs flex items-center gap-1.5"
                  onClick={() => void handleTestAllProviders()}
                  disabled={testing}
                  id="settings-test-all-providers"
                >
                  {testing ? <span className="spinner spinner-xs" /> : '🔌'}
                  <span>Test All Providers (Gemini, Mistral, Groq)</span>
                </button>
              </div>
            </div>

            {testResult && (
              <div
                className={`text-xs p-2.5 rounded mb-3 whitespace-pre-wrap font-mono leading-relaxed ${
                  testResult.includes('❌')
                    ? 'text-danger bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.2)]'
                    : testResult.includes('✅')
                    ? 'text-success bg-[rgba(74,222,128,0.08)] border border-[rgba(74,222,128,0.2)]'
                    : 'text-[var(--color-text)] bg-[var(--color-surface-2)]'
                }`}
              >
                {testResult}
              </div>
            )}

            {/* Mode Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <label className="flex items-center gap-2 text-xs cursor-pointer font-medium text-accent">
                <input
                  type="checkbox"
                  checked={useSeparateEndpoints}
                  onChange={(e) => setUseSeparateEndpoints(e.target.checked)}
                  id="settings-separate-endpoints"
                />
                Use different provider / endpoint for each extractor (Multi-Provider)
              </label>

              <label className="flex items-center gap-2 text-xs cursor-pointer font-medium text-accent">
                <input
                  type="checkbox"
                  checked={sameModelForAll}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSameModelForAll(checked);
                    if (checked) {
                      update({ modelB: local.modelA, modelC: local.modelA });
                    }
                  }}
                  id="settings-same-model-for-all"
                />
                Sync same model to all extractors
              </label>
            </div>

            {/* Global Provider Preset when not using separate endpoints */}
            {!useSeparateEndpoints && (
              <div className="mb-4 card-2">
                <label className="label text-xs font-semibold text-accent mb-1">
                  Default AI Provider & Gateway
                </label>
                <select
                  className="input w-full bg-[var(--color-bg)] font-semibold text-sm cursor-pointer border border-[rgba(124,108,255,0.4)] mb-2"
                  value={getProviderPreset(local.gatewayUrl)}
                  onChange={(e) => handleGlobalProviderPresetChange(e.target.value)}
                  aria-label="Provider preset dropdown"
                >
                  <optgroup label="✨ Google Gemini">
                    <option value="gemini-proxy">✨ Google Gemini (Proxy /gemini - Recommended)</option>
                    <option value="gemini-direct">🔗 Google Gemini (Direct API)</option>
                  </optgroup>
                  <optgroup label="⚡ Groq Cloud">
                    <option value="groq-proxy">⚡ Groq Cloud (Proxy /groq - Recommended)</option>
                    <option value="groq-direct">🔗 Groq Cloud (Direct API)</option>
                  </optgroup>
                  <optgroup label="🌪️ Mistral AI">
                    <option value="mistral-proxy">🌪️ Mistral AI (Proxy /mistral - Recommended)</option>
                    <option value="mistral-direct">🔗 Mistral AI (Direct API)</option>
                  </optgroup>
                  <optgroup label="🆓 Free the AI">
                    <option value="freetheai-proxy">🌐 Free the AI (Proxy /freetheai)</option>
                    <option value="freetheai-direct">🔗 Free the AI (Direct API)</option>
                  </optgroup>
                  <optgroup label="🏠 Local / OmniRoute">
                    <option value="omniroute-direct">🏠 OmniRoute Local (http://localhost:20128)</option>
                    <option value="omniroute-proxy">⚡ OmniRoute (Proxy /omniroute)</option>
                  </optgroup>
                  <optgroup label="⚙️ Custom">
                    <option value="custom">⚙️ Custom Endpoint URL...</option>
                  </optgroup>
                </select>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <Field label="Base URL">
                    <input
                      className="input text-xs"
                      value={local.gatewayUrl ?? ''}
                      onChange={(e) => update({ gatewayUrl: e.target.value })}
                      placeholder="/gemini or https://..."
                      id="settings-gateway-url"
                    />
                  </Field>
                  <Field label="Active API Key">
                    <input
                      className="input text-xs"
                      type="password"
                      value={local.apiKey ?? ''}
                      onChange={(e) => update({ apiKey: e.target.value })}
                      placeholder="API Key..."
                      id="settings-api-key"
                      autoComplete="off"
                    />
                  </Field>
                </div>
                <div className="flex justify-end mt-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs text-xs flex items-center gap-1"
                    onClick={() => void handleTestConnection()}
                    disabled={testing}
                  >
                    {testing ? <span className="spinner spinner-xs" /> : '🔌'}
                    <span>Test This Gateway URL</span>
                  </button>
                </div>
              </div>
            )}

            <div className="divider" />

            {/* 3 Extractors Section */}
            <h3 className="text-sm font-semibold text-accent uppercase tracking-wide mb-3 flex items-center justify-between">
              <span>🤖 3-Model Extractors (A, B, C)</span>
              <span className="text-xs font-normal text-muted">Page Consensus Engine</span>
            </h3>

            {(['A', 'B', 'C'] as const).map((role) => {
              const modelKey = role === 'A' ? 'modelA' : role === 'B' ? 'modelB' : 'modelC';
              const agent = getEffectiveAgent(role);

              return (
                <div key={role} className="card-2 mb-3 border border-[rgba(124,108,255,0.15)]">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-[var(--color-text)]">
                        Extractor {role}
                      </span>
                      <span className="text-xs text-muted">
                        ({agent.provider.toUpperCase()})
                      </span>
                    </div>
                    {sameModelForAll && role !== 'A' && (
                      <span className="text-xs text-muted italic">Synced with Extractor A</span>
                    )}
                  </div>

                  {useSeparateEndpoints && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2 p-2 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
                      <div>
                        <label className="label text-xs">Provider</label>
                        <select
                          className="input text-xs w-full"
                          value={agent.provider}
                          onChange={(e) => {
                            const prov = e.target.value as AgentEndpointConfig['provider'];
                            const catalog = PROVIDER_CATALOG[prov];
                            const defUrl = catalog ? catalog.proxyEndpoint : '/gemini';
                            const key = local.providerKeys?.[prov] || '';
                            updateAgent(role, { provider: prov, gatewayUrl: defUrl, apiKey: key });
                          }}
                        >
                          <option value="gemini">✨ Google Gemini</option>
                          <option value="mistral">🌪️ Mistral AI</option>
                          <option value="groq">⚡ Groq Cloud</option>
                          <option value="freetheai">🌐 Free the AI</option>
                          <option value="omniroute">🏠 OmniRoute Local</option>
                          <option value="custom">⚙️ Custom</option>
                        </select>
                      </div>
                      <div>
                        <label className="label text-xs">Endpoint URL</label>
                        <input
                          className="input text-xs w-full"
                          value={agent.gatewayUrl ?? ''}
                          onChange={(e) => updateAgent(role, { gatewayUrl: e.target.value })}
                          placeholder="/gemini"
                        />
                      </div>
                      <div>
                        <label className="label text-xs">API Key</label>
                        <input
                          className="input text-xs w-full"
                          type="password"
                          value={agent.apiKey ?? ''}
                          onChange={(e) => updateAgent(role, { apiKey: e.target.value })}
                          placeholder="API key…"
                        />
                      </div>
                    </div>
                  )}

                  <Field label={`Model for Extractor ${role}`}>
                    <div className="flex gap-2">
                      <input
                        list={`model-options-${role}`}
                        className="input flex-1 text-xs font-mono"
                        value={local[modelKey] ?? ''}
                        onChange={(e) => handleModelChange(role, e.target.value)}
                        placeholder={`gemini-2.5-flash`}
                        aria-label={`Model for Extractor ${role}`}
                        id={`settings-model-${role.toLowerCase()}`}
                      />
                      {!sameModelForAll && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm text-xs text-accent border border-[var(--color-border)]"
                          onClick={() => handleApplyModelToAll(local[modelKey] || 'gemini-2.5-flash')}
                          title="Apply this model to all 3 extractors"
                        >
                          Use for all
                        </button>
                      )}
                      <datalist id={`model-options-${role}`}>
                        {allModelSuggestions.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm flex-shrink-0 text-xs"
                        onClick={() => void handleVisionTest(role)}
                        aria-label={`Vision test for Extractor ${role}`}
                        id={`settings-vision-test-${role.toLowerCase()}`}
                      >
                        👁 Test Vision
                      </button>
                    </div>
                  </Field>

                  {visionTest[role] && (
                    <div className={`text-xs p-1.5 rounded mt-1.5 ${visionTest[role]?.startsWith('✅') ? 'text-success bg-[rgba(74,222,128,0.08)]' : visionTest[role]?.startsWith('⚠️') ? 'text-warning bg-[rgba(250,204,21,0.08)]' : 'text-danger bg-[rgba(248,113,113,0.08)]'}`}>
                      {visionTest[role]}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="divider" />

            {/* Pipeline Configuration */}
            <h3 className="text-sm font-semibold text-accent mb-3 uppercase tracking-wide">
              Pipeline & Constraints
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Max re-runs on disagreement">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  value={local.maxReruns}
                  onChange={(e) => update({ maxReruns: parseInt(e.target.value, 10) || 1 })}
                  aria-label="Max re-runs"
                  id="settings-max-reruns"
                />
              </Field>
              <Field label="Language Profile">
                <select
                  className="input"
                  value={local.profile}
                  onChange={(e) => update({ profile: e.target.value })}
                  aria-label="Language profile"
                  id="settings-profile"
                >
                  <option value="fr">French Gazette (FR)</option>
                  <option value="ar">Arabic Gazette (AR)</option>
                </select>
              </Field>
              <Field label="Image max edge (px)">
                <input
                  className="input"
                  type="number"
                  min={500}
                  max={4000}
                  step={100}
                  value={local.imageMaxEdge}
                  onChange={(e) => update({ imageMaxEdge: parseInt(e.target.value, 10) || 2000 })}
                  aria-label="Image max edge"
                  id="settings-image-max-edge"
                />
              </Field>
              <Field label="Max tokens">
                <input
                  className="input"
                  type="number"
                  min={1024}
                  max={32768}
                  step={1024}
                  value={local.maxTokens}
                  onChange={(e) => update({ maxTokens: parseInt(e.target.value, 10) || 8192 })}
                  aria-label="Max tokens"
                  id="settings-max-tokens"
                />
              </Field>
            </div>

            <div className="flex gap-4 mt-3 mb-3">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={local.useTextLayerHint}
                  onChange={(e) => update({ useTextLayerHint: e.target.checked })}
                  id="settings-text-layer-hint"
                />
                Use text layer hint (PDF text as fallback context)
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={local.hyphenJoin}
                  onChange={(e) => update({ hyphenJoin: e.target.checked })}
                  id="settings-hyphen-join"
                />
                Join compound hyphens across lines
              </label>
            </div>
          </div>
        )}

        {/* Profile Tester */}
        {activeSection === 'profiles' && (
          <div>
            <h3 className="text-sm font-semibold text-accent mb-2 uppercase tracking-wide">
              Language Profiles & Live Tester
            </h3>
            <p className="text-xs text-muted mb-3">
              Test how the regex parser recognizes articles, headings, and closings from legal gazette paragraphs.
            </p>

            <div className="flex gap-2 mb-3">
              <button
                className={`btn btn-sm ${testProfileId === 'fr' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => {
                  setTestProfileId('fr');
                  setTestText('Art. 137.— Est puni de six mois à trois ans d\'emprisonnement...');
                }}
              >
                French Profile (FR)
              </button>
              <button
                className={`btn btn-sm ${testProfileId === 'ar' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => {
                  setTestProfileId('ar');
                  setTestText('المادة 12 : يعاقب بالحبس من شهرين إلى سنتين...');
                }}
              >
                Arabic Profile (AR)
              </button>
            </div>

            <Field label="Test Paragraph">
              <textarea
                className="input font-mono text-sm h-24 resize-none"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                dir="auto"
                aria-label="Test paragraph input"
              />
            </Field>

            <div className="card-2 mb-3 space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span>Article Match:</span>
                <span className={testIsArticle ? 'text-success font-bold' : 'text-muted'}>
                  {testIsArticle ? `YES (Article: "${testArticleNum}")` : 'NO'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Heading Match:</span>
                <span className={testIsHeading ? 'text-accent font-bold' : 'text-muted'}>
                  {testIsHeading ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Closing Formula Match:</span>
                <span className={testIsClosing ? 'text-warning font-bold' : 'text-muted'}>
                  {testIsClosing ? 'YES' : 'NO'}
                </span>
              </div>
              {testProfileId === 'ar' && (
                <div className="flex items-center justify-between">
                  <span>Arabic Digits Normalised:</span>
                  <span className="text-info">{normaliseDigits(testText.slice(0, 40))}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Prompts Viewer */}
        {activeSection === 'prompts' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-accent uppercase tracking-wide">
                Prompts (Version {PROMPT_VERSION})
              </h3>
              <span className="text-xs text-muted">Auditable & Canonical JSON Schema</span>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase text-muted mb-1">Extractor System Prompt</div>
              <pre className="card-2 text-xs font-mono whitespace-pre-wrap leading-relaxed text-[var(--color-text)]">
                {SYSTEM_EXTRACTOR}
              </pre>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase text-muted mb-1">Shared Gazette Canonical Schema Rules</div>
              <pre className="card-2 text-xs font-mono whitespace-pre-wrap leading-relaxed text-[var(--color-text)]">
                {SHARED_RULES}
              </pre>
            </div>
          </div>
        )}

        {/* Data & Backup */}
        {activeSection === 'data' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-accent uppercase tracking-wide">Data Management</h3>

            <div className="card-2 text-xs text-muted space-y-1">
              <div><strong>IndexedDB Storage:</strong> {storageEstimate}</div>
              <div>State backups preserve jobs, results, resolutions, and event logs. API keys are always redacted.</div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn btn-secondary btn-sm" onClick={() => void handleExportBackup()}>
                ⬇ Export State Backup (.lawtext.json)
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                ⬆ Import State Backup
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.lawtext.json"
                className="hidden"
                onChange={(e) => void handleImportBackup(e)}
              />
            </div>

            {backupStatus && (
              <div className="text-xs p-2 rounded bg-[var(--color-surface-2)]">
                {backupStatus}
              </div>
            )}
          </div>
        )}

        <div className="divider" />

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button className="btn btn-secondary" onClick={() => setSettingsOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void handleSave()} id="settings-save">
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}

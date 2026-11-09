# LawText — Multi-Agent Legal Gazette Text Extraction

LawText is a browser-only React 18 + TypeScript web application designed to extract verified, high-fidelity plain text from official legal gazettes (French and Arabic versions, two-column layouts, numbered articles, chapters/sections, scanned or machine-readable PDFs) using **three AI agents** running through a self-hosted **OmniRoute** gateway:

* **Agent A & Agent B**: Two independent transcription extractors reading page images.
* **Agent J (Judge)**: Resolves discrepancies when Agent A and Agent B disagree.
* **Consensus-Driven Efficiency**: If Agents A and B agree on a unit, it passes automatically without calling the judge. When they disagree, only the mismatching unit is re-extracted or judged.
* **Self-Healing Durable Architecture**: Complete resilience to network and model drops. Never fails a job or displays red error banners for transient drops. Pauses calmly, probes with exponential backoff, and resumes automatically via a canary task.

---

## Quick Start

### 1. Prerequisites & Installation

Ensure Node.js (v20+ recommended) is installed.

```bash
# Install dependencies
npm install

# Start local development server (runs at http://localhost:5173)
npm run dev

# Run full test suite (Vitest + RTL + fake-indexeddb: 80 unit & integration tests)
npm test

# Run linter
npm run lint

# Build production bundle (TypeScript strict check + Vite bundle)
npm run build
```

---

## OmniRoute & Provider Integration

LawText connects directly from the browser to your self-hosted OmniRoute gateway or compatible API providers:

### Supported Providers & Quick Presets
1. **Google Gemini (Direct or Local Proxy)**:
   - Proxy Base URL: `/gemini` (zero CORS issues via Vite dev proxy)
   - Direct Base URL: `https://generativelanguage.googleapis.com/v1beta/openai`
   - Authentication: Gemini API Key (`AIzaSy...`)
   - Vision Models: `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-flash`, `gemini-1.5-pro`
   - Single-model toggle: "Use same model for all roles (A, B, J)" lets you use the same model across Agent A, Agent B, and Judge J.
2. **Free the AI**:
   - Proxy Base URL: `/freetheai`
   - Direct Base URL: `https://api.freetheai.org/v1`
3. **OmniRoute Gateway**:
   - Proxy Base URL: `/omniroute`
   - Direct Base URL: `http://localhost:20128`

### Required Endpoints
- `GET /api/health` or `GET /v1/models` -> Liveness probe and model listing.
- `POST /v1/chat/completions` (or `/chat/completions` for Gemini) -> Vision completion endpoint with Bearer token authentication.

### Recommended Gateway Configuration & Combos
1. **Create 3 Combos in OmniRoute**:
   - Role A: `law-extract-a`
   - Role B: `law-extract-b`
   - Role J (Judge): `law-judge`
2. **Model Independence**: For optimal cross-verification, ensure Role A and Role B use different underlying frontier vision models (e.g., Claude 3.5 Sonnet and GPT-4o). The app warns in Settings if the same model ID is assigned to both extractors and records `x-omniroute-model` in task logs to detect post-hoc fallback collisions.
3. **Disable Prompt Compression**: In OmniRoute, disable prompt compression for these combos. LawText detects `x-omniroute-compression` response headers and logs a warning if compression occurred, as compression can degrade legal transcription accuracy.
4. **CORS Configuration**:
   OmniRoute must permit CORS requests from the browser:
   ```yaml
   cors:
     allow_origins: ["http://localhost:5173", "https://your-domain.com"]
     allow_headers: ["Authorization", "Content-Type"]
     expose_headers:
       - "x-omniroute-model"
       - "x-omniroute-provider"
       - "x-omniroute-compression"
       - "x-omniroute-latency"
       - "x-request-id"
   ```

---

## Core Self-Healing Architecture

The core requirement of LawText is zero data loss, zero error storms, and hands-free automatic recovery:

```
[ ONLINE ]  <─── (Canary Success Ramp) ───  [ RESUMING ]
     │                                            ▲
 (Transient Err / 5xx / 429)                 (Probe 200 OK)
     ▼                                            │
 [ PAUSING ] ──> [ PAUSED ] ──(Backoff)──> [ PROBING ]
```

1. **Transient Outages**: Network drops (`fetch` failure), request timeouts (default 180s), upstream 5xx, or 429 rate limits transition the Gate to `PAUSED` and the job to `paused_offline`.
2. **Zero Red Errors**: No red toasts or fatal errors are displayed for transient events. A calm amber notification appears: *"Connection to OmniRoute lost. Your progress is saved (X of Y tasks done). Retrying in Zs..."* with a manual **Retry connection now** button.
3. **In-Flight Task Protection**: When an outage occurs, in-flight tasks are aborted and reverted to `pending` in IndexedDB without incrementing the failure attempt counter.
4. **Exponential Backoff Probing**: The Gate probes the gateway with exponential backoff (2s, 4s, 8s, 16s... up to 60s).
5. **Canary Ramp-Up**: When the health check succeeds, the Gate enters `RESUMING` with concurrency 1. After the single canary task succeeds, concurrency ramps up and the Gate returns to `ONLINE`.
6. **Reload & Crash Durability**: IndexedDB (`idb`) is the single authoritative source of truth. If the tab is closed or the PC sleeps mid-run, reopening the app restores state, resets interrupted tasks, and automatically resumes jobs (or awaits a one-click resume if configured).
7. **Permanent Errors**: Real non-retryable issues (401/403 Bad API key, 404 Model Not Found, repeated malformed output) transition the job to `paused_attention` with clear diagnostic copy pointing to Settings.

---

## Domain Extraction Pipeline

Legal gazettes present unique typesetting requirements handled by LawText's domain rules:

1. **Page Layout & Reading Order**: Two columns per page. Extracted strictly left column first, then right column. Running header bands (journal name, date, issue number) and footers are isolated and excluded.
2. **Source Typographic Fidelity**: Source typography is never "corrected". Quotes (`« »`, curly vs straight apostrophes), degrees (`°`), ligatures (`œ`), and original typos are preserved verbatim. Arabic is stored in logical Unicode order (never presentation forms), preserving Western or Arabic-Indic digits as printed.
3. **Line-End Compound Hyphens**: In official gazettes, a line-end hyphen represents a real compound word (e.g. `quarante-/cinq`). When enabled, words broken across lines with hyphens are joined without spaces, keeping the hyphen.
4. **Heading Hierarchy Stack**: Repeating section headings (e.g., "Section 1" in multiple chapters) are uniquely identified by their full ancestor path (`chapitre:3/section:1`).
5. **Article Gaps & Duplicate Auditing**: Sequential article numbers are validated. Missing numbers or duplicates are surfaced as non-fatal audit warnings in the Job View and export headers.
6. **Token Truncation Fallback**: If a dense page exceeds output token limits (`finish_reason: length`), LawText automatically retries once with doubled `max_tokens`. If still truncated, it splits the page into left and right half column crops and transcribes each separately.

---

## Review UI & Keyboard Shortcuts

The Review screen allows rapid comparison of discrepancies between Agent A, Agent B, and Judge J with synchronized page image inspection:

| Key Shortcut | Action |
|---|---|
| `1` | Select **Agent A** reading |
| `2` | Select **Agent B** reading |
| `3` | Select **Judge J** reading |
| `E` / `e` | Open inline text editor to edit manually |
| `J` / `j` | Navigate to **Next** unit |
| `K` / `k` | Navigate to **Previous** unit |
| `Escape` | Close review modal |
| `+` / `−` / `100%` | Zoom and pan page preview image |

Content blocks feature `dir="auto"` for proper Arabic bidirectional rendering, while UI chrome remains clean LTR.

---

## Data Export & Backup

- **Single Job Text Export (`.txt`)**: Exports normalized plain text with metadata header (job name, sha256, date, article warning audit log).
- **Multi-Job ZIP Export**: One-click download of all completed jobs as a `.zip` archive.
- **State Backup & Restore (`.lawtext.json`)**: Exports or imports complete IndexedDB database state (jobs, tasks, units, resolutions, events, settings) for machine migration or backups.
- **JSON Exporter Seam**: Clean module seam in `src/export/jsonExporter.ts` structured for future shareable schema integration (`exportJson(job: FinalJob, format: unknown)`).

---

## Assumptions & Sensible Defaults

Where specifications permitted design flexibility, the simplest sensible options were adopted:

1. **Gateway Liveness Fallback**: If `GET /api/health` returns 404 or requires authentication on custom OmniRoute setups, the probe falls back automatically to `GET /v1/models` with the Bearer token.
2. **Rate Limiting (RPM)**: Token bucket throttle is configurable per role (`rpmA`, `rpmB`, `rpmJ`). By default `rpm = 0` (unlimited, letting the gateway handle concurrency).
3. **Scanned Page Threshold**: Text layers with fewer than 20 characters are considered scans, disabling the text-layer hint.
4. **Storage Quotas**: Page images and PDF blobs are stored in IndexedDB. Settings panel includes storage usage estimation and data purge utilities.
5. **CORS Header Exposure**: If browser security prevents reading custom response headers (`x-omniroute-*`), the client records fallback model metadata from the completion response body.

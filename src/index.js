require('dotenv').config();

const axios = require('axios');
const { google } = require('googleapis');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// CONFIGURATION
// ============================================================================

// The upstream history endpoint is configuration, not source. Set it as a
// repository secret (and in .env for local runs); there is deliberately no
// fallback baked in, so the URL never appears in this file.
const HISTORY_API_URL = process.env.HISTORY_API_URL || '';
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const GOOGLE_SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || '{}';

const num = (envVar, fallback) => parseInt(process.env[envVar] || String(fallback), 10);

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
//   node src/index.js                        full sync into the default tab
//   node src/index.js --batch 3/10           batch 3 of 10 -> tab "Batch_03"
//   node src/index.js --sheet Batch_03       explicit target tab
//   node src/index.js 0xabc...               manual retry for one wallet
//   node src/index.js --consolidate          fold every Batch_NN tab into one
//   node src/index.js --help
function parseArgs(argv) {
  const out = {
    wallet: null, sheet: null, batchIndex: null, batchTotal: null, help: false,
    consolidate: false, into: null, keepBatches: false, chain: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
      return inline !== null ? inline : argv[++i];
    };

    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--sheet' || arg.startsWith('--sheet=')) {
      out.sheet = takeValue();
    } else if (arg === '--wallet' || arg.startsWith('--wallet=')) {
      out.wallet = takeValue();
    } else if (arg === '--chain' || arg.startsWith('--chain=')) {
      const value = String(takeValue()).toLowerCase();
      if (!['evm', 'sol', 'solana'].includes(value)) {
        throw new Error(`Unknown --chain "${value}" (expected evm or sol)`);
      }
      out.chain = value === 'solana' ? 'sol' : value;
    } else if (arg === '--consolidate') {
      out.consolidate = true;
    } else if (arg === '--into' || arg.startsWith('--into=')) {
      // Target tab for --consolidate; implies it, so `--into X` alone works.
      out.into = takeValue();
      out.consolidate = true;
    } else if (arg === '--keep-batches') {
      out.keepBatches = true;
    } else if (arg === '--batch' || arg.startsWith('--batch=')) {
      // Accepts "3/10" (index/total) or a bare "3" (total comes from BATCH_TOTAL).
      const raw = String(takeValue() || '');
      const [idx, total] = raw.split('/');
      out.batchIndex = parseInt(idx, 10);
      if (total !== undefined) out.batchTotal = parseInt(total, 10);
      if (!Number.isInteger(out.batchIndex)) {
        throw new Error(`Invalid --batch value "${raw}" (expected "N" or "N/TOTAL")`);
      }
    } else if (arg.startsWith('0x')) {
      out.wallet = arg; // positional wallet address (manual retry mode)
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}" (try --help)`);
    }
  }
  return out;
}

const CLI = parseArgs(process.argv.slice(2));

const HELP_TEXT = `
Transaction sync — fetches wallet history and writes it to Google Sheets.

Usage:
  node src/index.js [options]
  node src/index.js <0xWalletAddress>          Manual retry for one wallet (append only)
  node src/index.js --consolidate              Fold every Batch_NN tab into one and
                                               delete them (run after the batches)
  node src/index.js --chain sol                Solana sync (its own feeds, tab and
                                               columns; combine with the flags above)

Options:
  --batch N/TOTAL     Process only batch N of TOTAL. The wallet list is split into
                      TOTAL contiguous slices; this run handles slice N (1-based).
                      Unless --sheet is given, the target tab becomes "<prefix>NN"
                      (default prefix "Batch_", e.g. Batch_03).
  --chain evm|sol     Which chain to sync. Default evm. "sol" reads the two
                      Solana feeds instead, and writes its own column set to its
                      own tab — the EVM columns do not fit it. Works with
                      --batch, --sheet and --consolidate exactly the same way.
  --sheet NAME        Target sheet tab. Overrides the batch-derived name.
  --wallet 0x...      Same as passing the address positionally.
  --consolidate       Merge every "<prefix>NN" tab into ONE tab and delete them,
                      so the spreadsheet keeps a single sheet instead of growing
                      a new batch tab for every slice. Fetches nothing.
  --into NAME         Tab --consolidate merges into (default: MASTER_SHEET_NAME,
                      else GOOGLE_SHEET_NAME). Implies --consolidate.
  --keep-batches      Consolidate but leave the Batch_NN tabs in place.
  -h, --help          Show this help.

Key environment variables:
  WALLET_LIST              Comma-separated wallet addresses
  SOL_WALLET_LIST          Same, for --chain sol (base58, case IS significant)
  SOL_TRANSFERS_API_URL    Solana transfers feed (address is appended to it)
  SOL_SWAPS_API_URL        Solana swaps feed (address is appended to it) (or use WALLETS_FILE)
  WALLETS_FILE             Path to a JSON file: ["0x..."] or { "wallets": ["0x..."] }
  GOOGLE_SPREADSHEET_ID    Target spreadsheet
  GOOGLE_SHEET_NAME        Default tab when no batch/--sheet is given (default: Sheet1)
  MASTER_SHEET_NAME        Tab --consolidate merges into (default: GOOGLE_SHEET_NAME)
  DELETE_BATCH_TABS        0 = keep the Batch_NN tabs after consolidating (default: 1)
  GOOGLE_CREDENTIALS       Service-account JSON
  TARGET_SHEET_NAME        Same as --sheet (CLI wins)
  BATCH_INDEX/BATCH_TOTAL  Same as --batch (CLI wins)
  BATCH_SHEET_PREFIX       Prefix for batch tabs (default: Batch_)
  HISTORY_DAYS             Look-back window in days, by time_at (default: 180; 0 = off)
  ROTATION_PERIOD_MS       Rotate the starting wallet each run (default: 3600000)
  MAX_REQUESTS_PER_RUN     Hard cap on API requests per run (default: 8)
  PAGE_COUNT               Safety ceiling on rows per wallet (default: 2000)
  PAGE_SIZE                Rows per API request (default: 200)
  MAX_PAGES_PER_WALLET     Anti-runaway page cap (default: 20)
  PAGE_DELAY_MIN_MS        Min spacing between pages of one wallet (default: 1500)
  PAGE_DELAY_MAX_MS        Max spacing between pages of one wallet (default: 2000)
  JITTER_MIN_MS/JITTER_MAX_MS  Random spacing between requests (default: 5000/12000)
  PROXY_URL                Route API traffic through a proxy (also honours
                           HTTPS_PROXY / HTTP_PROXY, and NO_PROXY exemptions)

See config/example.env for the full list, including the rate-limit and
safety-timeout settings.
`;

// ---------------------------------------------------------------------------
// Wallet list + batch slicing
// ---------------------------------------------------------------------------
// With 200+ wallets a single run cannot finish inside the workflow timeout, so
// the list is split into contiguous batches and each GitHub Actions matrix job
// handles one slice, writing to its own sheet tab. Slicing is deterministic:
// the same BATCH_INDEX always maps to the same wallets.

/** Read every configured wallet, from WALLET_LIST or WALLETS_FILE. */
function loadAllWallets(opts = {}) {
  const {
    envVar = 'WALLET_LIST',
    fileVar = 'WALLETS_FILE',
    // EVM addresses are case-insensitive hex, so lower-casing them de-duplicates
    // the same wallet written two ways. Solana addresses are base58 and CASE
    // SENSITIVE — lower-casing one produces a different, non-existent account —
    // so the Solana loader turns this off.
    lowercase = true,
  } = opts;
  const raw = [];

  if (process.env[envVar]) {
    raw.push(...process.env[envVar].split(','));
  } else if (process.env[fileVar]) {
    const file = path.resolve(process.env[fileVar]);
    if (!fs.existsSync(file)) throw new Error(`${fileVar} not found: ${file}`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.wallets;
    if (!Array.isArray(list)) {
      throw new Error(`${file} must contain an array, or an object with a "wallets" array`);
    }
    raw.push(...list);
  }

  // Normalise and de-duplicate while preserving order, so batch boundaries are stable.
  const seen = new Set();
  const wallets = [];
  for (const entry of raw) {
    const trimmed = String(entry).trim();
    const addr = lowercase ? trimmed.toLowerCase() : trimmed;
    if (addr && !seen.has(addr)) {
      seen.add(addr);
      wallets.push(addr);
    }
  }
  return wallets;
}

/** Resolve the active batch from CLI flags or env vars (CLI wins). */
function resolveBatch() {
  const index = CLI.batchIndex ?? (process.env.BATCH_INDEX ? num('BATCH_INDEX', 0) : null);
  const total = CLI.batchTotal ?? (process.env.BATCH_TOTAL ? num('BATCH_TOTAL', 0) : null);
  if (index == null) return null; // batching disabled — process every wallet

  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`Batch index ${index} given without a valid total (use --batch N/TOTAL or BATCH_TOTAL)`);
  }
  if (!Number.isInteger(index) || index < 1 || index > total) {
    throw new Error(`Batch index ${index} is out of range 1..${total}`);
  }
  return { index, total };
}

/**
 * Split `items` into `total` contiguous slices and return slice `index` (1-based).
 * Remainders are spread over the first slices, so 200 wallets across 10 batches
 * gives 20 each, and 205 gives 21,21,21,21,21,20,20,20,20,20 — never an empty batch.
 */
function sliceForBatch(items, index, total) {
  const base = Math.floor(items.length / total);
  const remainder = items.length % total;
  const start = (index - 1) * base + Math.min(index - 1, remainder);
  const size = base + (index <= remainder ? 1 : 0);
  return items.slice(start, start + size);
}

/**
 * Rotate the starting position so runs don't always process wallets in the same
 * order. Without this, a soft-block part-way through a batch starves the SAME
 * later wallets on every single run — they would never get fetched at all.
 * The offset is time-derived (no state needed) and deterministic within a run.
 */
function rotateWallets(wallets) {
  const period = RATE_LIMIT_CONFIG.ROTATION_PERIOD_MS;
  if (wallets.length < 2 || period <= 0) return wallets;
  const offset = Math.floor(Date.now() / period) % wallets.length;
  if (offset === 0) return wallets;
  return [...wallets.slice(offset), ...wallets.slice(0, offset)];
}

/** Wallets this particular run is responsible for. */
function getWalletList(batch) {
  const all = loadAllWallets();
  const mine = batch ? sliceForBatch(all, batch.index, batch.total) : all;
  return rotateWallets(mine);
}

/**
 * Target sheet tab, in priority order:
 *   --sheet  >  TARGET_SHEET_NAME  >  "<BATCH_SHEET_PREFIX>NN"  >  GOOGLE_SHEET_NAME
 * Giving every batch its own tab is what keeps parallel runners from clearing and
 * overwriting each other's rows.
 */
function resolveSheetName(batch) {
  if (CLI.sheet) return CLI.sheet;
  if (process.env.TARGET_SHEET_NAME) return process.env.TARGET_SHEET_NAME;
  if (batch) {
    const prefix = process.env.BATCH_SHEET_PREFIX || 'Batch_';
    return `${prefix}${String(batch.index).padStart(2, '0')}`;
  }
  return GOOGLE_SHEET_NAME;
}

/** The single tab --consolidate folds every batch tab into. */
function resolveMasterSheetName() {
  return CLI.into || process.env.MASTER_SHEET_NAME || GOOGLE_SHEET_NAME;
}

/**
 * Matches the tabs --consolidate owns: the batch prefix followed by digits, and
 * nothing else. Anchored on purpose — a hand-made "Batch_notes" tab is yours,
 * not ours, and must never be swept up by the delete.
 */
function batchTabPattern() {
  const prefix = process.env.BATCH_SHEET_PREFIX || 'Batch_';
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`);
}

const RATE_LIMIT_CONFIG = {
  // --- Request spacing (adaptive: widens on push-back, decays on success) ---
  // Requests are spaced by a RANDOM value in [JITTER_MIN_MS, JITTER_MAX_MS].
  // A wide, irregular range matters: perfectly even spacing is itself a bot
  // signal, and the previous 3s fixed cadence contributed to the 403s.
  JITTER_MIN_MS: num('JITTER_MIN_MS', 5000),
  JITTER_MAX_MS: num('JITTER_MAX_MS', 12000),
  MAX_DELAY_MS: num('MAX_DELAY_MS', 20000),

  // --- Pending-job polling (progressive backoff) ---
  // The API answers `{ job: { status: "pending" } }` while it builds the history.
  // Re-querying every few seconds is what gets the IP soft-blocked, so we start at
  // 20s and step up to a 60s ceiling: wait = min(BASE + round * STEP, MAX).
  PENDING_BASE_MS: num('PENDING_BASE_MS', 20000),
  PENDING_STEP_MS: num('PENDING_STEP_MS', 10000),
  PENDING_MAX_MS: num('PENDING_MAX_MS', 60000),
  MAX_PENDING_ROUNDS: num('MAX_PENDING_ROUNDS', 4),

  // --- Block (429/403) handling: fail fast, don't sit in long cooldowns ---
  RATE_LIMIT_WAIT_MS: num('RATE_LIMIT_WAIT_MS', 60000), // base cooldown when no Retry-After
  MAX_COOLDOWN_MS: num('MAX_COOLDOWN_MS', 120000),      // hard cap for a single cooldown
  MAX_BLOCK_RETRIES: num('MAX_BLOCK_RETRIES', 2),       // retries per wallet on 429/403
  WALLET_BLOCK_BUDGET_MS: num('WALLET_BLOCK_BUDGET_MS', 120000), // total cooldown per wallet
  // Once this many wallets in a row are blocked, the whole IP is soft-blocked and
  // hammering the next wallet is both futile and rude — stop fetching and save.
  CIRCUIT_BREAKER_THRESHOLD: num('CIRCUIT_BREAKER_THRESHOLD', 2),

  // --- Other retry budgets ---
  MAX_RETRIES: num('MAX_RETRIES', 10),
  MAX_TIMEOUT_RETRIES: num('MAX_TIMEOUT_RETRIES', 5),

  // Wallets were processed in the same order every run, so whenever a block hit
  // part-way through, the SAME later wallets were starved every single time.
  // Rotating the starting position spreads that cost around. 0 disables it.
  ROTATION_PERIOD_MS: num('ROTATION_PERIOD_MS', 3600000),

  // Hard cap on API requests per run. Measured across two runs, the upstream
  // blocks at request ~10 per IP REGARDLESS of pacing: 11 requests over 149s
  // (4.4/min) and 10 over 215s (2.8/min) both tripped it. So this is a request
  // COUNT quota, not a rate limit, and slowing down cannot help. Each matrix job
  // runs on a fresh runner with a fresh quota, so the fix is fewer requests per
  // job and more jobs. At 2 requests per wallet, 8 covers 4 wallets safely.
  MAX_REQUESTS_PER_RUN: num('MAX_REQUESTS_PER_RUN', 8),

  // --- Global safety guard (prevents a GitHub Actions "Canceled") ---
  // The workflow's own timeout is 30 min. We stop fetching well before that and
  // reserve time to flush whatever we already have to Google Sheets, so the run
  // ends green with partial data instead of being killed with nothing saved.
  GLOBAL_TIMEOUT_MS: num('GLOBAL_TIMEOUT_MS', 20 * 60 * 1000),
  WRITE_RESERVE_MS: num('WRITE_RESERVE_MS', 90000),

  // --- History depth & pagination ---
  // The API caps how many rows one history response can return, so asking
  // for 2000 in a single request silently truncates the history. We instead page
  // through with `start_time` (the oldest time_at seen so far) as the cursor and
  // accumulate up to MAX_TX_PER_WALLET rows.
  // Look-back window: keep transactions newer than this many days and stop
  // paging as soon as the cursor walks past it. This is a TIME window, not a
  // row count — it is what keeps request volume low, because most wallets need
  // one or two pages to cover 90 days instead of ten to reach 2000 rows.
  // Set to 0 to disable and fall back to the MAX_TX_PER_WALLET ceiling alone.
  HISTORY_DAYS: num('HISTORY_DAYS', 180),

  PAGE_SIZE: num('PAGE_SIZE', 200),                       // rows per request
  MAX_TX_PER_WALLET: num('PAGE_COUNT', 2000),             // safety ceiling per wallet
  MAX_PAGES_PER_WALLET: num('MAX_PAGES_PER_WALLET', 20),  // hard anti-runaway cap
  // Spacing between pages of the SAME wallet, picked at random in this range.
  // Smaller than the inter-wallet spacing, but the adaptive delay overrides it
  // as soon as a block is hit. PAGE_DELAY_MS is kept as a legacy alias for min.
  PAGE_DELAY_MIN_MS: num('PAGE_DELAY_MIN_MS', num('PAGE_DELAY_MS', 1500)),
  // Defaults to 4/3 of the min (so 1500 -> 2000) rather than a fixed 2000, which
  // would turn a lowered min into a nonsensically wide band.
  PAGE_DELAY_MAX_MS: num('PAGE_DELAY_MAX_MS',
    Math.round(num('PAGE_DELAY_MIN_MS', num('PAGE_DELAY_MS', 1500)) * 4 / 3)),

  // --- Google Sheets ---
  CHUNK_SIZE: num('CHUNK_SIZE', 500),
  // Pause between chunk writes. Google allows ~60 write requests/minute/user and
  // that quota is shared by every parallel matrix job, so this defaults high
  // enough for 3–4 runners to write concurrently without tripping it.
  SHEETS_WRITE_DELAY_MS: num('SHEETS_WRITE_DELAY_MS', 1500),
  // Safety guard: the sheet is a full-refresh snapshot, so writing a mostly-empty
  // result would destroy a good previous snapshot. Require this share of wallets
  // to have succeeded before the destructive clear+write is allowed.
  // Share of a batch that must succeed before its results are written. Writes
  // merge on transaction id, so partial results are additive and 0 is safe.
  MIN_SUCCESS_RATIO: parseFloat(process.env.MIN_SUCCESS_RATIO || '0'),

  // 1 = the tab holds exactly what this run fetched: no merge with what was
  // already there, so every recorded_at in it comes from the same run. Pair it
  // with MIN_SUCCESS_RATIO=1, or a run that misses a wallet writes a thinner
  // snapshot over a complete one.
  FULL_REFRESH: process.env.FULL_REFRESH === '1',

  // --- Consolidation (--consolidate) ---
  // Delete each Batch_NN tab once its rows are safely in the master tab. On by
  // default: the batch tabs are scratch space, and leaving 50 of them behind is
  // exactly the clutter consolidating is meant to remove. Only ever applied
  // AFTER the master write succeeds, and only to tabs matching batchTabPattern.
  DELETE_BATCH_TABS: process.env.DELETE_BATCH_TABS !== '0',

  // --- Address-poisoning detection (see flagSuspectRows) ---
  // A transfer worth less than this in USD is dust. Combined with the relayer
  // check it is what identifies a poisoning row; 0 disables the detection.
  SUSPECT_DUST_USD: parseFloat(process.env.SUSPECT_DUST_USD || '0.01'),
  // Off by default: rows are FLAGGED in the `suspect` column, not removed, so
  // nothing disappears from the sheet without you asking for it.
  DROP_SUSPECTED: process.env.DROP_SUSPECTED === '1',
};

// Honest client headers — we identify as a normal HTTP/JSON client and rely on
// politeness (spacing + Retry-After) rather than trying to disguise the request.
const API_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': process.env.HTTP_USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// ---------------------------------------------------------------------------
// HTTPS agent (proxy aware)
// ---------------------------------------------------------------------------
// Passing a custom `httpsAgent` to axios bypasses its built-in HTTP_PROXY /
// HTTPS_PROXY handling entirely, so those variables used to be silently ignored.
// We therefore resolve the proxy ourselves and build a tunnelling agent when one
// is configured — ready for routing egress away from the shared runner IP.

const AGENT_OPTIONS = {
  minVersion: 'TLSv1.2',
  keepAlive: true,
  maxSockets: 5,
  timeout: 60000,
  freeSocketTimeout: 30000,
};

/** True when `host` matches a NO_PROXY entry (supports `*`, `.suffix`, exact). */
function isProxyExempt(host) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    .some((entry) => entry === '*' ||
      host === entry ||
      host.endsWith(entry.startsWith('.') ? entry : `.${entry}`));
}

/** Proxy URL for `targetUrl`, honouring PROXY_URL > HTTPS_PROXY > HTTP_PROXY. */
function resolveProxyUrl(targetUrl) {
  let host;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (isProxyExempt(host)) return null;
  return process.env.PROXY_URL ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    null;
}

const PROXY_URL = resolveProxyUrl(HISTORY_API_URL);
const HTTPS_AGENT = PROXY_URL
  ? new HttpsProxyAgent(PROXY_URL, AGENT_OPTIONS)
  : new https.Agent(AGENT_OPTIONS);

// ============================================================================
// LOGGING UTILITIES — ANSI colored, level-filtered, GitHub Actions aware
// ============================================================================

// Colors are on unless NO_COLOR is set (GitHub Actions renders ANSI fine).
const USE_COLOR = !process.env.NO_COLOR;
const wrap = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  reset: wrap('0'),
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

// Level ordering so we can filter (default: hide DEBUG). Set LOG_LEVEL=DEBUG to see everything.
const LEVELS = { DEBUG: 10, INFO: 20, OK: 20, WARN: 30, ERROR: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? 20;

const LEVEL_STYLE = {
  DEBUG: { paint: c.gray, badge: 'DEBUG', icon: '·' },
  INFO: { paint: c.cyan, badge: 'INFO ', icon: 'ℹ' },
  OK: { paint: c.green, badge: 'OK   ', icon: '✔' },
  WARN: { paint: c.yellow, badge: 'WARN ', icon: '⚠' },
  ERROR: { paint: c.red, badge: 'ERROR', icon: '✖' },
};

function log(level, msg) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  const s = LEVEL_STYLE[level] || LEVEL_STYLE.INFO;
  const d = new Date();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const time = c.gray(`${hh}:${mm}:${ss}`);
  const badge = s.paint(c.bold(`${s.icon} ${s.badge}`));
  console.log(`${time} ${badge} ${msg}`);
}

// GitHub Actions collapsible log groups (falls back to a plain line locally).
const IN_GHA = !!process.env.GITHUB_ACTIONS;
function groupStart(title) {
  if (IN_GHA) console.log(`::group::${title}`);
  else log('INFO', title);
}
function groupEnd() {
  if (IN_GHA) console.log('::endgroup::');
}

/** Human-friendly duration, e.g. 74000 -> "1m14s", 8000 -> "8s" */
function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/** Hide any credentials in a proxy URL before logging it. */
function maskProxy(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '(set)';
  }
}

function maskAddr(addr) {
  if (!addr || addr.length < 10) return addr || 'unknown';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ============================================================================
// GLOBAL SAFETY TIMEOUT GUARD
// ============================================================================
// Every wait in this script is checked against a single run-wide deadline. When
// the budget runs out we abandon the remaining wallets, flush what we have to
// Google Sheets and exit(0) — so the workflow finishes green instead of being
// cancelled by GitHub at the 30-minute mark with all fetched data thrown away.

const RUN_STARTED_AT = Date.now();

/** Milliseconds spent since the run began. */
function elapsedMs() {
  return Date.now() - RUN_STARTED_AT;
}

/**
 * Time left for FETCHING, i.e. the global budget minus what we set aside for the
 * Google Sheets write. Can go negative — callers treat <= 0 as "stop now".
 */
function fetchBudgetRemainingMs() {
  return RATE_LIMIT_CONFIG.GLOBAL_TIMEOUT_MS
    - RATE_LIMIT_CONFIG.WRITE_RESERVE_MS
    - elapsedMs();
}

/** Thrown when the global time budget is exhausted — stops the fetch phase. */
class DeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/** Thrown when the run has used its whole API request quota. */
class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

/** Thrown when a wallet is given up on because of a 429/403 soft-block. */
class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterDelay(minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return sleep(delay);
}

function getCurrentTimestampTH() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const YYYY = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${MM}/${DD}/${YYYY} ${hh}:${mm}:${ss}`;
}

function formatDateTH(unixSeconds) {
  if (!unixSeconds) return null;
  const d = new Date(unixSeconds * 1000 + 7 * 3600 * 1000);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const YYYY = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${MM}/${DD}/${YYYY} ${hh}:${mm}:${ss}`;
}

/** Parse the 'MM/DD/YYYY HH:mm:ss' strings written into column Q back to a number. */
function parseDateTH(text) {
  if (!text) return 0;
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return 0;
  return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
}

function v(val) {
  if (val === null || val === undefined) return null;
  if (val === '') return null;
  if (Array.isArray(val) && val.length === 0) return null;
  return val;
}

// ============================================================================
// RATE LIMIT MANAGEMENT
// ============================================================================

/** Parse a Retry-After header (seconds, or an HTTP date) into milliseconds. */
function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(headerValue);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * Shared across all wallets in a run. Enforces:
 *  - a minimum spacing between requests (adaptive: grows on blocks, decays on success)
 *  - a hard cooldown window after a 429/403, so the NEXT wallet also waits instead of
 *    immediately hammering the server (this is what caused the 429 -> 403 cascade)
 */
class RateLimitManager {
  constructor() {
    this.delayMs = RATE_LIMIT_CONFIG.JITTER_MIN_MS; // current spacing between requests
    this.lastRequest = 0;
    this.cooldownUntil = 0; // wall-clock time we're allowed to send again
    this.consecutiveBlocks = 0;
    this.requestsMade = 0;  // counted against MAX_REQUESTS_PER_RUN
  }

  /**
   * Call immediately before every request. Honors cooldown + spacing.
   * Returns false when the remaining wait would run past the global deadline,
   * so the caller can bail out instead of sleeping into a workflow cancellation.
   */
  async beforeRequest(spacingOverrideMs) {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      const waitMs = this.cooldownUntil - now;
      if (waitMs >= fetchBudgetRemainingMs()) return false; // no time left to wait it out
      log('WARN', `Cooldown active — waiting ${c.bold(fmtDuration(waitMs))} before next request`);
      await sleep(waitMs);
    }

    // Base spacing = current adaptive delay + random jitter up to JITTER_MAX_MS.
    // The randomness matters as much as the length: a fixed cadence is itself a
    // bot signal. (JITTER_MAX_MS used to be unused here, so every request went
    // out exactly JITTER_MIN_MS apart.)
    const cfg = RATE_LIMIT_CONFIG;
    const spread = Math.max(0, cfg.JITTER_MAX_MS - cfg.JITTER_MIN_MS);
    const jittered = this.delayMs + Math.random() * spread;

    // Pages of the same wallet may pass their own smaller spacing, but once a
    // block has widened the adaptive delay the wider value wins again — so the
    // pagination loop can never out-run the throttle the server asked for.
    let spacing = jittered;
    if (spacingOverrideMs != null) {
      spacing = this.delayMs > cfg.JITTER_MIN_MS
        ? Math.max(spacingOverrideMs, jittered)
        : spacingOverrideMs;
    }

    const since = Date.now() - this.lastRequest;
    if (since < spacing) {
      await sleep(spacing - since);
    }
    this.lastRequest = Date.now();
    this.requestsMade++;
    return true;
  }

  /** Requests still available before the upstream quota is expected to bite. */
  budgetLeft() {
    return RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_RUN - this.requestsMade;
  }

  /** A request succeeded — relax the throttle gently back toward the floor. */
  onSuccess() {
    this.consecutiveBlocks = 0;
    this.delayMs = Math.max(
      RATE_LIMIT_CONFIG.JITTER_MIN_MS,
      Math.floor(this.delayMs * 0.8)
    );
  }

  /**
   * A request was rate-limited/blocked (429 or 403). Widen spacing and open a hard
   * cooldown window. `maxAllowedMs` clamps the cooldown to the caller's remaining
   * budget (per-wallet and global), so we never sleep longer than we can afford.
   * Returns the cooldown length (ms) for logging.
   */
  onBlock(retryAfterMs, maxAllowedMs) {
    this.consecutiveBlocks++;
    // Widen request spacing for the rest of the run (capped).
    this.delayMs = Math.min(
      RATE_LIMIT_CONFIG.MAX_DELAY_MS,
      Math.max(this.delayMs * 2, 5000)
    );
    // Cooldown: honor Retry-After if present, otherwise exponential backoff.
    const base = retryAfterMs || RATE_LIMIT_CONFIG.RATE_LIMIT_WAIT_MS;
    const raw = base * Math.pow(2, this.consecutiveBlocks - 1);
    const jitter = Math.random() * raw * 0.2; // +0–20% jitter
    // FIX: jitter is applied BEFORE the cap. It used to be added afterwards, which
    // let cooldowns overshoot MAX_COOLDOWN_MS by up to 20% (observed: 5m41s vs a
    // 5m cap) and helped push the job past the workflow timeout.
    let cooldown = Math.min(RATE_LIMIT_CONFIG.MAX_COOLDOWN_MS, Math.round(raw + jitter));
    // An explicit Retry-After is an instruction, not a suggestion: never come back
    // sooner than the server asked, even if our own cap is lower. (The caller only
    // gets here when it can afford the wait; otherwise it skips the wallet.)
    if (retryAfterMs != null) {
      cooldown = Math.max(cooldown, retryAfterMs);
    }
    if (Number.isFinite(maxAllowedMs)) {
      cooldown = Math.min(cooldown, Math.max(0, Math.round(maxAllowedMs)));
    }
    this.cooldownUntil = Date.now() + cooldown;
    return cooldown;
  }
}

// ============================================================================
// API FETCH FUNCTION
// ============================================================================

/**
 * Per-wallet budget shared by every page request for that wallet.
 *
 * Critical for PR #5's fail-fast guarantee: if each page tracked its own block
 * budget, a 20-page wallet could spend 20 x WALLET_BLOCK_BUDGET_MS sitting in
 * cooldowns. Threading one budget through the pagination loop keeps a blocked
 * wallet capped at ~2 minutes total, exactly as before pagination existed.
 */
function newWalletBudget() {
  return { blockRetries: 0, blockWaitMs: 0 };
}

/**
 * Fetch ONE page of history.
 *
 * `startTime` is the pagination cursor: the API returns transactions older than
 * that Unix timestamp. Pass 0 for the first (newest) page.
 *
 * All of the PR #5 retry behaviour lives here — pending-job progressive backoff,
 * 429/403 fail-fast, timeout retries and the global deadline — operating on the
 * shared `budget` so the limits stay per-wallet, not per-page.
 */
async function fetchHistoryPage(walletAddress, startTime, rateLimitMgr, budget, spacingMs) {
  const cfg = RATE_LIMIT_CONFIG;
  const masked = maskAddr(walletAddress);

  const params = new URLSearchParams({
    id: walletAddress,
    page_count: String(cfg.PAGE_SIZE),
  });
  if (startTime > 0) params.set('start_time', String(startTime));
  const url = `${HISTORY_API_URL}?${params.toString()}`;

  let timeoutRetries = 0;
  let pendingRounds = 0;  // how many times the API said "job pending"

  for (let attempt = 1; attempt <= cfg.MAX_RETRIES; attempt++) {
    // Global guard: never start another request if the run is out of time.
    if (fetchBudgetRemainingMs() <= 0) {
      throw new DeadlineError('global time budget exhausted');
    }

    // Request quota: stop cleanly BEFORE the upstream starts refusing us, rather
    // than burning cooldowns on requests that are certain to be blocked.
    if (rateLimitMgr.budgetLeft() <= 0) {
      throw new BudgetError(
        `request quota reached (${cfg.MAX_REQUESTS_PER_RUN} requests this run)`);
    }

    // Honors any open cooldown; false means waiting it out would blow the deadline.
    if (!(await rateLimitMgr.beforeRequest(spacingMs))) {
      throw new DeadlineError('not enough time left to wait out the cooldown');
    }

    try {
      log('DEBUG', `Fetching ${masked} (attempt ${attempt}/${cfg.MAX_RETRIES})`);

      const response = await axios.get(url, {
        headers: API_HEADERS,
        timeout: 60000,
        httpsAgent: HTTPS_AGENT,
        // Our agent already handles the proxy; letting axios apply the env vars
        // as well would double-proxy the request.
        proxy: false,
      });

      const body = response.data;
      const resultPayload = body?.result?.data;

      if (resultPayload && Array.isArray(resultPayload.history_list)) {
        rateLimitMgr.onSuccess();
        return { list: resultPayload.history_list, attempts: attempt };
      }

      // ---- Job still pending: the API is building the history server-side ----
      // Progressive backoff (20s -> 30s -> 40s ... capped at 60s). Polling this
      // every few seconds is exactly what triggered the 403 soft-block before.
      if (body?.job) {
        pendingRounds++;
        if (pendingRounds > cfg.MAX_PENDING_ROUNDS) {
          throw new Error(`job still pending after ${cfg.MAX_PENDING_ROUNDS} polls`);
        }

        const jobId = body.job.id || body.job.job_id || 'n/a';
        // Round 1 waits PENDING_BASE_MS (20s), then +10s each round, capped at 60s.
        const waitMs = Math.min(
          cfg.PENDING_BASE_MS + (pendingRounds - 1) * cfg.PENDING_STEP_MS,
          cfg.PENDING_MAX_MS
        );

        if (waitMs >= fetchBudgetRemainingMs()) {
          throw new DeadlineError('not enough time left to wait for the pending job');
        }

        log('INFO',
          `${c.yellow('⏳ Job pending')} for ${c.magenta(masked)} ` +
          `(job ${c.dim(jobId)}, poll ${pendingRounds}/${cfg.MAX_PENDING_ROUNDS}) — ` +
          `waiting ${c.bold(fmtDuration(waitMs))} before re-querying`);

        await sleep(waitMs);
        continue;
      }

      log('WARN', `Unexpected response structure for ${masked}`);

    } catch (err) {
      if (err instanceof DeadlineError) throw err; // never swallow the deadline

      const status = err.response?.status;

      // ---- 429 / 403: server is pushing back. FAIL FAST. ----
      // Both are treated the same, but unlike before we give up after only
      // MAX_BLOCK_RETRIES attempts AND cap the total cooldown per wallet at
      // WALLET_BLOCK_BUDGET_MS. Previously one blocked wallet could burn 13
      // minutes of the run; now it costs at most ~2 minutes before we move on.
      if (status === 429 || status === 403) {
        budget.blockRetries++;
        const walletBudgetLeft = cfg.WALLET_BLOCK_BUDGET_MS - budget.blockWaitMs;

        if (budget.blockRetries > cfg.MAX_BLOCK_RETRIES || walletBudgetLeft <= 0) {
          throw new BlockedError(
            `${status} soft-block — skipped after ${budget.blockRetries} attempt(s) ` +
            `and ${fmtDuration(budget.blockWaitMs)} of cooldown`
          );
        }

        // Never wait longer than this wallet's budget or the global deadline.
        const allowed = Math.min(walletBudgetLeft, fetchBudgetRemainingMs());
        if (allowed <= 0) {
          throw new DeadlineError('no time left to cool down');
        }

        const retryAfterMs = parseRetryAfter(err.response?.headers?.['retry-after']);

        // If the server asked for longer than we can afford, respect the instruction
        // by giving up on this wallet — retrying early would be exactly the rude
        // behaviour that earns a harder block.
        if (retryAfterMs != null && retryAfterMs > allowed) {
          throw new BlockedError(
            `${status} — server asked for ${fmtDuration(retryAfterMs)}, ` +
            `more than the ${fmtDuration(allowed)} budget left; skipping rather than retrying early`
          );
        }

        const cooldown = rateLimitMgr.onBlock(retryAfterMs, allowed);
        budget.blockWaitMs += cooldown;

        const label = status === 429 ? '429 Too Many Requests' : '403 Forbidden (soft-block)';
        const src = retryAfterMs != null ? ' (Retry-After honored)' : '';
        log('WARN',
          `${c.bold(label)} on ${masked} [${budget.blockRetries}/${cfg.MAX_BLOCK_RETRIES}] — ` +
          `cooling down ${c.bold(fmtDuration(cooldown))}${src}`);

        attempt--; // the cooldown is the penalty; don't also burn a normal attempt
        continue;
      }

      const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' ||
                        err.message?.includes('timeout');

      if (isTimeout) {
        timeoutRetries++;
        if (timeoutRetries > cfg.MAX_TIMEOUT_RETRIES) {
          throw new Error(`Timeout — gave up after ${cfg.MAX_TIMEOUT_RETRIES} retries`);
        }
        const waitMs = (5 + Math.floor(Math.random() * 10)) * 1000;
        if (waitMs >= fetchBudgetRemainingMs()) {
          throw new DeadlineError('not enough time left to retry after timeout');
        }
        log('WARN', `Timeout on ${masked} [${timeoutRetries}/${cfg.MAX_TIMEOUT_RETRIES}] — retrying in ${fmtDuration(waitMs)}`);
        await sleep(waitMs);
        attempt--;
        continue;
      }

      // Other (non-retryable) errors
      throw new Error(`${err.message} (${err.code || status || 'UNKNOWN'})`);
    }
  }

  throw new Error(`Failed after ${cfg.MAX_RETRIES} attempts`);
}

/**
 * Fetch a wallet's full history by paging through the API.
 *
 * Why this exists: asking for `page_count=2000` in one request does NOT return
 * 2000 rows — the API caps a single response, so the history was silently cut
 * off and the most recent transactions never reached the sheet. We now walk
 * backwards through time, using the oldest `time_at` we've seen as `start_time`
 * for the next page, until we have enough rows or the history runs out.
 *
 * Termination is guarded from every angle, so the loop can never run away:
 *   1. MAX_PAGES_PER_WALLET   — hard page cap
 *   2. empty page             — no more history
 *   3. short page             — fewer rows than requested means the last page
 *   4. no new unique ids      — API ignored the cursor / returned the same page
 *   5. cursor didn't move back — timestamps stopped decreasing
 *   6. MAX_TX_PER_WALLET      — collected enough
 *   7. global deadline        — checked inside every page request
 */
async function fetchTransactions(walletAddress, rateLimitMgr) {
  const cfg = RATE_LIMIT_CONFIG;
  const masked = maskAddr(walletAddress);
  const budget = newWalletBudget(); // shared across pages: keeps fail-fast per-wallet

  // Unix seconds; anything older than this is outside the look-back window.
  // Pages arrive newest-first, so the moment the cursor crosses it we are done.
  const cutoff = cfg.HISTORY_DAYS > 0
    ? Math.floor(Date.now() / 1000) - cfg.HISTORY_DAYS * 86400
    : 0;

  const byId = new Map();   // de-duplicates rows that overlap between pages
  let cursor = 0;           // start_time for the next page (0 = newest page)
  let attempts = 0;
  let page = 0;
  let stopReason = null;

  while (page < cfg.MAX_PAGES_PER_WALLET) {
    page++;

    // First page uses the normal inter-wallet spacing; later pages of the SAME
    // wallet use the smaller page delay (still overridden by the adaptive delay
    // if the server has started pushing back).
    // Math.max guards against a hand-configured max below the min.
    const spacingMs = page === 1
      ? undefined
      : cfg.PAGE_DELAY_MIN_MS +
        Math.random() * Math.max(0, cfg.PAGE_DELAY_MAX_MS - cfg.PAGE_DELAY_MIN_MS);
    let list, pageAttempts;
    try {
      ({ list, attempts: pageAttempts } =
        await fetchHistoryPage(walletAddress, cursor, rateLimitMgr, budget, spacingMs));
    } catch (err) {
      // Running out of request quota or time part-way through a wallet used to
      // discard every page already fetched — requests we had already spent. Keep
      // them: an incomplete but real slice of history beats nothing. With nothing
      // collected yet there is nothing to salvage, so the error propagates and
      // the caller counts the wallet as skipped.
      if ((err instanceof BudgetError || err instanceof DeadlineError) && byId.size > 0) {
        log('WARN', `${masked}: ${err.message} after ${page - 1} page(s) — ` +
          `keeping the ${c.bold(byId.size)} row(s) already fetched`);
        stopReason = `partial: ${err.message}`;
        break;
      }
      throw err;
    }
    attempts += pageAttempts;

    // Guard 2: the history is exhausted.
    if (list.length === 0) {
      stopReason = `no more history after ${page} page(s)`;
      break;
    }

    // Guard 4: count how many rows on this page we hadn't already seen.
    //
    // The key must include `idx`, not just the transaction id. One on-chain
    // transaction can produce SEVERAL history entries under the same hash —
    // that is exactly what `idx` distinguishes — and a contract call such as
    // `exec` or `swap` is the usual case. Keying on the id alone dropped every
    // entry past the first before it ever reached the sheet.
    let added = 0;
    let oldest = Infinity;
    for (const tx of list) {
      const id = `${tx.id ?? `${tx.chain}:${tx.time_at}`}#${tx.idx ?? 0}`;
      if (!byId.has(id)) {
        byId.set(id, tx);
        added++;
      }
      const t = Number(tx.time_at) || 0;
      if (t > 0 && t < oldest) oldest = t;
    }

    log('DEBUG', `${masked} page ${page}: ${list.length} rows (${added} new, ` +
      `total ${byId.size}), oldest ${Number.isFinite(oldest) ? oldest : 'n/a'}`);

    if (added === 0) {
      stopReason = `page ${page} returned nothing new (cursor exhausted)`;
      break;
    }

    // Guard 6a: the look-back window is covered — the rest of this wallet's
    // history is older than we care about, so stop paging.
    if (cutoff > 0 && Number.isFinite(oldest) && oldest <= cutoff) {
      stopReason = `covered the ${cfg.HISTORY_DAYS}-day window`;
      break;
    }

    // Guard 6b: we have as much as we asked for.
    if (byId.size >= cfg.MAX_TX_PER_WALLET) {
      stopReason = `reached MAX_TX_PER_WALLET (${cfg.MAX_TX_PER_WALLET})`;
      break;
    }

    // Guard 3: a short page means there is nothing older to fetch.
    if (list.length < cfg.PAGE_SIZE) {
      stopReason = `last page was short (${list.length} < ${cfg.PAGE_SIZE})`;
      break;
    }

    // Guard 5: the cursor must strictly move backwards in time, otherwise the
    // next request would return the same window forever.
    if (!Number.isFinite(oldest) || oldest <= 0 || (cursor > 0 && oldest >= cursor)) {
      stopReason = `cursor stopped advancing at ${oldest}`;
      break;
    }
    cursor = oldest;
  }

  // Only when the loop ran to the cap without breaking for its own reason.
  if (stopReason === null) {
    stopReason = `hit MAX_PAGES_PER_WALLET (${cfg.MAX_PAGES_PER_WALLET})`;
  }

  // Drop anything that fell outside the window (the last page usually straddles
  // the cutoff), then sort newest-first so the sheet leads with recent activity.
  let list = [...byId.values()];
  const fetched = list.length;
  if (cutoff > 0) {
    list = list.filter((tx) => (Number(tx.time_at) || 0) >= cutoff);
  }
  list.sort((a, b) => (Number(b.time_at) || 0) - (Number(a.time_at) || 0));

  return { list, attempts, pages: page, stopReason, fetched, cutoff };
}

// ============================================================================
// DATA MAPPING
// ============================================================================

/** Google rejects a cell above 50,000 characters — stay clear of the ceiling. */
const MAX_RAW_CELL_CHARS = 49000;

/** Stable short digest of the raw JSON, used as the merge key. */
function rawDigest(raw) {
  return crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 16);
}

/**
 * Serialise the API object verbatim for the `raw` column.
 *
 * This is the row's source of truth: every field the API returned survives here
 * even when the flat columns cannot express it, so a mapping question can be
 * answered from the sheet instead of by spending scarce request quota to refetch.
 */
function rawCell(tx) {
  let raw;
  try {
    raw = JSON.stringify(tx);
  } catch (err) {
    log('WARN', `Could not serialise tx ${tx?.id}: ${err.message}`);
    return null;
  }
  if (raw.length > MAX_RAW_CELL_CHARS) {
    log('WARN', `Raw JSON for tx ${tx?.id} is ${raw.length} chars — truncated to ` +
      `${MAX_RAW_CELL_CHARS} to fit a Sheets cell (no longer valid JSON)`);
    return `${raw.slice(0, MAX_RAW_CELL_CHARS)}…[truncated]`;
  }
  return raw;
}

/**
 * How many sheet rows one API object becomes.
 *
 * `receives` and `sends` are arrays: a swap holds one of each, a reward claim or
 * a batch payout holds several. Only index [0] used to be read, so every entry
 * past the first was silently discarded. Pairing them by index keeps a swap on a
 * single row (send and receive side by side, as before) while giving a
 * multi-token transaction the rows it needs.
 */
function transferRowCount(tx) {
  const recv = Array.isArray(tx.receives) ? tx.receives.length : 0;
  const sent = Array.isArray(tx.sends) ? tx.sends.length : 0;
  return Math.max(recv, sent, 1);
}

/** Map one API object to all of its sheet rows (see transferRowCount). */
function mapTransactionToRows(tx, walletAddr) {
  const raw = rawCell(tx);
  const total = transferRowCount(tx);
  const rows = [];
  for (let i = 0; i < total; i++) {
    rows.push(mapTransactionToRow(tx, walletAddr, i, raw));
  }
  return rows;
}

/**
 * Map the i-th transfer of one API object to a single sheet row.
 *
 * `transferIdx` selects which element of `receives`/`sends` fills the transfer
 * columns; it is also written to the sheet (column AJ) because the merge key
 * needs to tell sibling rows of one transaction apart after they are read back.
 */
function mapTransactionToRow(tx, walletAddr, transferIdx = 0, raw = undefined) {
  try {
    const cate_id = v(tx.cate_id);
    const cex_id = v(tx.cex_id);
    const chain = v(tx.chain);
    const id = v(tx.id);
    const idx = v(tx.idx);
    const is_scam = v(tx.is_scam);
    const other_addr = v(tx.other_addr);
    const project_id = v(tx.project_id);
    const time_at = formatDateTH(tx.time_at);

    const recv = tx.receives?.[transferIdx];
    const recv_amount = v(recv?.amount) ?? null;
    const recv_from_addr = v(recv?.from_addr) ?? null;
    const recv_price = v(recv?.price) ?? null;
    const recv_token_id = v(recv?.token_id) ?? null;

    const sent = tx.sends?.[transferIdx];
    const send_amount = v(sent?.amount) ?? null;
    const send_price = v(sent?.price) ?? null;
    const send_to_addr = v(sent?.to_addr) ?? null;
    const send_token_id = v(sent?.token_id) ?? null;

    const approve = tx.token_approve || null;
    const approve_label = approve ? 'token_approve' : null;
    const approve_spender = v(approve?.spender) ?? null;
    const approve_token_id = v(approve?.token_id) ?? null;
    const approve_value = v(approve?.value) ?? null;

    const inner = tx.tx || null;
    const tx_label = inner ? 'tx' : null;
    const tx_eth_gas_fee = v(inner?.eth_gas_fee) ?? null;
    const tx_from_addr = v(inner?.from_addr) ?? null;
    const tx_id = v(inner?.id) ?? null;
    const tx_idx = v(inner?.idx) ?? null;
    const tx_message = v(inner?.message) ?? null;
    const tx_name = v(inner?.name) ?? null;
    const tx_params = inner?.params ? JSON.stringify(inner.params) : null;
    const tx_selector = v(inner?.selector) ?? null;
    const tx_status = v(inner?.status) ?? null;
    const tx_to_addr = v(inner?.to_addr) ?? null;
    const tx_usd_gas_fee = v(inner?.usd_gas_fee) ?? null;
    const tx_value = v(inner?.value) ?? null;

    return [
      cate_id, cex_id, chain, id, idx, is_scam, other_addr, project_id,
      recv_amount, recv_from_addr, recv_price, recv_token_id,
      send_amount, send_price, send_to_addr, send_token_id,
      time_at,
      approve_label, approve_spender, approve_token_id, approve_value,
      tx_label, tx_eth_gas_fee, tx_from_addr, tx_id, tx_idx,
      tx_message, tx_name, tx_params, tx_selector, tx_status, tx_to_addr,
      tx_usd_gas_fee, tx_value,
      null, // [34] recorded_at — filled during write
      transferIdx,                                     // [35] transfer_idx
      raw === undefined ? rawCell(tx) : raw,           // [36] raw
      null, // [37] suspect — filled by flagSuspectRows, which needs the whole batch
      // [38] wallet_address — which of YOUR wallets this row was fetched for.
      // It cannot be recovered from the data: on a `receive`, other_addr,
      // tx.from_addr and receives[].from_addr are all the SENDER, and tx.to_addr
      // is the token contract. The receiving wallet appears nowhere at all.
      walletAddr ? String(walletAddr).toLowerCase() : null,
    ];
  } catch (err) {
    log('ERROR', `Mapping failed for wallet ${maskAddr(walletAddr)}: ${err.message}`);
    throw err;
  }
}

// ============================================================================
// GOOGLE SHEETS OPERATIONS
// ============================================================================

async function getGoogleAuth() {
  try {
    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } catch (err) {
    throw new Error(`Failed to parse Google credentials: ${err.message}`);
  }
}

/**
 * Generic retry wrapper for Google API calls.
 *
 * Quota errors (429 / RESOURCE_EXHAUSTED) get a longer exponential backoff: the
 * ~60 writes/minute quota is shared by every parallel matrix job, so a couple of
 * runners can legitimately collide and just need to wait their turn.
 */
async function withRetry(fn, label, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const detail = err.errors?.[0]?.message || err.message;
      const status = err.code || err.response?.status;
      const isQuota = status === 429 ||
        /quota|rate limit|RESOURCE_EXHAUSTED/i.test(detail || '');

      if (attempt === maxRetries) {
        throw new Error(`${label} failed after ${maxRetries} retries: ${detail}`);
      }

      const waitMs = isQuota
        ? Math.min(60000, 10000 * Math.pow(2, attempt - 1)) + Math.random() * 3000
        : 5000 * attempt;
      log('WARN', `${label} failed [${attempt}/${maxRetries}]${isQuota ? ' (quota)' : ''} — ` +
        `retrying in ${fmtDuration(waitMs)}: ${detail}`);
      await sleep(waitMs);
    }
  }
}

// Header written into row 1 when a batch tab is created (mirrors mapTransactionToRow).
const SHEET_HEADER = [
  'cate_id', 'cex_id', 'chain', 'id', 'idx', 'is_scam', 'other_addr', 'project_id',
  'recv_amount', 'recv_from_addr', 'recv_price', 'recv_token_id',
  'send_amount', 'send_price', 'send_to_addr', 'send_token_id',
  'time_at',
  'approve_label', 'approve_spender', 'approve_token_id', 'approve_value',
  'tx_label', 'tx_eth_gas_fee', 'tx_from_addr', 'tx_id', 'tx_idx',
  'tx_message', 'tx_name', 'tx_params', 'tx_selector', 'tx_status', 'tx_to_addr',
  'tx_usd_gas_fee', 'tx_value', 'recorded_at',
  'transfer_idx', 'raw', 'suspect', 'wallet_address',
];

/** 1-based column number to its A1 letter: 1 -> A, 27 -> AA, 39 -> AM. */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Last column letter of the header, used in every A1 range below so the ranges
// cannot drift out of sync with SHEET_HEADER when a column is added.
const LAST_COL = colLetter(SHEET_HEADER.length);
const DATA_RANGE = `A2:${LAST_COL}`;

/**
 * A sheet schema: everything the Sheets layer needs to handle a set of columns
 * without knowing what they mean.
 *
 * Solana rows do not fit the EVM columns (no gas in ETH, a swap has no
 * counterparty, a mint is not an ERC-20 address), so they get their own tab and
 * their own header — but the parts worth trusting are the ones that took three
 * PRs to get right: the merge that never loses a row, the grid growing and
 * trimming, the batch tabs and their consolidation. Those are schema-agnostic,
 * so the schema is passed in rather than hard-coded and both chains share them.
 *
 *   timeIdx     column sorted on, and compared against the HISTORY_DAYS window
 *   stampIdx    recorded_at
 *   keyOf       merge identity of a row (see the EVM keyOf for why it is a hash)
 *   olderKeyOf  key a row written by an EARLIER version would carry, or null
 *               when the row is already current — drives one-time migrations
 */
function makeSchema({ name, header, timeIdx, stampIdx, keyOf, olderKeyOf = () => null }) {
  const lastCol = colLetter(header.length);
  return {
    name, header, timeIdx, stampIdx, keyOf, olderKeyOf,
    lastCol,
    dataRange: `A2:${lastCol}`,
    width: header.length,
  };
}

/** The 39-column EVM schema this project started as, and every default. */
const EVM_SCHEMA = makeSchema({
  name: 'evm',
  header: SHEET_HEADER,
  timeIdx: 16,   // time_at
  stampIdx: 34,  // recorded_at
  keyOf: (row) => keyOf(row),
  olderKeyOf: (row) => {
    if (!hasRaw(row)) return legacyKeyOf(row);
    if (!hasWallet(row)) return walletlessKeyOf(row);
    return null; // current scheme — matched by keyOf directly
  },
});

/** True when a row carries the `raw` column. */
function hasRaw(row) {
  return row[36] != null && String(row[36]) !== '';
}

/** True when a row also carries `wallet_address`, i.e. it is current. */
function hasWallet(row) {
  return row[38] != null && String(row[38]) !== '';
}

// ---------------------------------------------------------------------------
// Address-poisoning detection
// ---------------------------------------------------------------------------
// The API reports these with `is_scam: false`, so the scam filter never sees them.
// The attack: send a dust transfer from an address generated to share the first
// and last few characters of one you really deal with, so the look-alike lands
// in your history and you copy it by mistake next time you pay that counterparty.
//
// Two independent signals, measured against 515 real rows:
//
//   dust_relayed  a tiny transfer whose `receive` did not come from the account
//                 that sent the transaction. A genuine wallet-to-wallet transfer
//                 has tx.from_addr === receives[].from_addr; a poisoning run is
//                 emitted by a contract in bulk, so they differ. 70 rows matched,
//                 worth $0.0058 in total, the largest single one $0.001.
//
//   lookalike     `other_addr` shares its first 4 and last 4 hex characters with
//                 a DIFFERENT address elsewhere in the same batch. Only one of
//                 the pair is the impostor and this signal cannot say which, so
//                 it never drops a row — it is a warning to read before copying
//                 an address out of the sheet.

/** USD value moved by one row, from whichever side of the transfer is filled. */
function rowUsdValue(row) {
  let total = 0;
  for (const [amountIdx, priceIdx] of [[8, 10], [12, 13]]) {
    const amount = Number(row[amountIdx]);
    const price = Number(row[priceIdx]);
    if (Number.isFinite(amount) && Number.isFinite(price)) total += amount * price;
  }
  return total;
}

/** The high-confidence signal: dust that arrived via a relayer, not its sender. */
function isDustRelayed(row) {
  const threshold = RATE_LIMIT_CONFIG.SUSPECT_DUST_USD;
  if (threshold <= 0) return false;

  const value = rowUsdValue(row);
  // A zero-value row is an approve or a bare contract call, not a dust transfer.
  if (!(value > 0 && value < threshold)) return false;

  if (row[0] !== 'receive') return false;
  const txFrom = row[23];      // tx_from_addr — who sent the transaction
  const recvFrom = row[9];     // recv_from_addr — who the tokens came from
  if (typeof txFrom !== 'string' || typeof recvFrom !== 'string') return false;
  return txFrom.toLowerCase() !== recvFrom.toLowerCase();
}

/** First-4 / last-4 fingerprint of an address, or null when it is not one. */
function addrFingerprint(addr) {
  if (typeof addr !== 'string') return null;
  const a = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  return `${a.slice(2, 6)}…${a.slice(-4)}`;
}

/**
 * Fill the `suspect` column (index 37) across a batch of rows, in place.
 *
 * Needs the whole batch at once because `lookalike` is a relationship between
 * addresses, not a property of one row.
 */
function flagSuspectRows(rows) {
  const byFingerprint = new Map();
  for (const row of rows) {
    const fp = addrFingerprint(row[6]); // other_addr
    if (!fp) continue;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, new Set());
    byFingerprint.get(fp).add(String(row[6]).toLowerCase());
  }

  let dust = 0;
  let lookalike = 0;
  for (const row of rows) {
    const reasons = [];
    if (isDustRelayed(row)) reasons.push('dust_relayed');
    const fp = addrFingerprint(row[6]);
    if (fp && byFingerprint.get(fp).size > 1) reasons.push('lookalike');

    row[37] = reasons.length ? reasons.join('+') : null;
    if (reasons.includes('dust_relayed')) dust++;
    if (reasons.includes('lookalike')) lookalike++;
  }

  const groups = [...byFingerprint.values()].filter((s) => s.size > 1).length;
  if (dust || lookalike) {
    log('WARN', `Suspected address poisoning: ${c.bold(dust)} dust row(s) delivered ` +
      `by a relayer, ${c.bold(lookalike)} row(s) whose counterparty looks like another ` +
      `address in this batch (${groups} look-alike group(s))`);
  }
  return { dust, lookalike, groups };
}

/**
 * Drop the rows DROP_SUSPECTED is meant to remove.
 *
 * Only `dust_relayed` is ever dropped. `lookalike` alone flags both halves of a
 * pair and cannot tell the impostor from the address it imitates, so acting on
 * it would delete real history.
 */
function dropSuspectRows(rows) {
  if (!RATE_LIMIT_CONFIG.DROP_SUSPECTED) return rows;
  const kept = rows.filter((row) => !String(row[37] || '').includes('dust_relayed'));
  const dropped = rows.length - kept.length;
  if (dropped) {
    log('WARN', `DROP_SUSPECTED=1 — discarded ${c.bold(dropped)} suspected ` +
      `address-poisoning row(s); ${kept.length} kept`);
  }
  return kept;
}

/**
 * Merge key for a sheet row: the wallet it was fetched for, the digest of the
 * raw API object, and which transfer within it.
 *
 * Each part answers a different collision:
 *   wallet_address  a row is "this transfer, as seen from this wallet" — and the
 *                   wallet is not derivable from the payload, so it has to be
 *                   part of the identity rather than computed from it
 *   raw digest      separates any two rows the API itself considers different,
 *                   including the payer's and the payee's view of one transfer,
 *                   which share a transaction id
 *   transfer_idx    separates the sibling rows one multi-token transaction
 *                   expands into, since those do share a source object
 *
 * Re-fetching a wallet reproduces all three exactly, so its rows are replaced in
 * place rather than duplicated.
 */
function keyOf(row) {
  if (!hasRaw(row)) return legacyKeyOf(row);
  if (!hasWallet(row)) return walletlessKeyOf(row);
  return `${walletlessKeyOf(row)}@${String(row[38]).toLowerCase()}`;
}

/**
 * The key used before `wallet_address` existed. Kept so rows written by the
 * previous version can be recognised and replaced during the migration.
 */
function walletlessKeyOf(row) {
  return `h:${rawDigest(row[36])}#${row[35] ?? 0}`;
}

/**
 * The pre-`raw` merge key, kept only to recognise rows written by earlier
 * versions during the one-time migration in writeToSheet.
 */
function legacyKeyOf(row) {
  return 'l:' + [
    row[3] || `${row[2]}:${row[16]}:${row[4]}`, // id (or a composite fallback)
    row[0],   // cate_id
    row[6],   // other_addr
    row[8],   // recv_amount
    row[9],   // recv_from_addr
    row[12],  // send_amount
    row[14],  // send_to_addr
  ].map((val) => (val == null ? '' : String(val))).join('|');
}

/** Look up a tab's sheetId + current grid size, or null when it doesn't exist. */
async function findSheetProps(sheets, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
  });
  const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  return sheet ? sheet.properties : null;
}

/**
 * Return the tab's properties, creating the tab (with a header row) if missing.
 *
 * Batch tabs like Batch_01..Batch_10 won't exist on the first run, and several
 * matrix jobs may reach this at the same time — a concurrent creation that loses
 * the race surfaces as "already exists", which we resolve by re-reading.
 */
async function ensureSheetTab(sheets, sheetName, schema = EVM_SCHEMA) {
  const existing = await withRetry(
    () => findSheetProps(sheets, sheetName), `Look up tab "${sheetName}"`);

  if (existing) return widenSheetTab(sheets, existing, sheetName, schema);

  log('INFO', `Tab "${sheetName}" not found — creating it`);
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      resource: {
        requests: [{
          addSheet: {
            properties: {
              title: sheetName,
              gridProperties: { rowCount: 1000, columnCount: schema.width },
            },
          },
        }],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [schema.header] },
    });
    log('OK', `Created tab "${sheetName}" with header row`);
  } catch (err) {
    const detail = err.errors?.[0]?.message || err.message;
    if (!/already exists/i.test(detail)) throw err;
    log('DEBUG', `Tab "${sheetName}" was created concurrently by another job`);
  }

  const props = await withRetry(
    () => findSheetProps(sheets, sheetName), `Re-read tab "${sheetName}"`);
  if (!props) throw new Error(`Sheet tab "${sheetName}" could not be created or found`);
  return widenSheetTab(sheets, props, sheetName, schema);
}

/**
 * Grow a tab that is narrower than SHEET_HEADER, and refresh its header row.
 *
 * A tab created before a column was added keeps its old `columnCount`, and every
 * write wider than that grid fails outright with "exceeds grid limits". The
 * manual workaround is not even possible — you cannot type into a column the
 * grid does not have — so this has to happen in code. No spreadsheet edit is
 * needed to pick up new columns.
 */
async function widenSheetTab(sheets, props, sheetName, schema = EVM_SCHEMA) {
  const width = props.gridProperties?.columnCount || 0;
  if (width >= schema.width) return props;

  log('INFO', `Tab "${sheetName}" is ${width} columns wide but the header needs ` +
    `${schema.width} — widening it`);

  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    resource: {
      requests: [{
        updateSheetProperties: {
          properties: {
            sheetId: props.sheetId,
            gridProperties: { columnCount: schema.width },
          },
          fields: 'gridProperties.columnCount',
        },
      }],
    },
  }), `Widen tab "${sheetName}"`);

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [schema.header] },
  }), `Rewrite header of "${sheetName}"`);

  log('OK', `Widened "${sheetName}" ${width} → ${schema.width} columns ` +
    `(A–${schema.lastCol}) and refreshed the header row`);

  return {
    ...props,
    gridProperties: { ...props.gridProperties, columnCount: schema.width },
  };
}

/**
 * Clear every data row (A2 down), leaving the header intact.
 *
 * Always call this immediately before writing a new set, and only after any
 * existing rows that must be preserved have already been read.
 */
async function clearSheetContent(sheets, sheetName, schema = EVM_SCHEMA) {
  await withRetry(() => sheets.spreadsheets.values.clear({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: `${sheetName}!${schema.dataRange}`,
  }), `Clear content of "${sheetName}"`);
  log('OK', `ClearContent: wiped "${sheetName}" ${schema.dataRange} before writing`);
}

/**
 * Write rows to the sheet by OVERWRITING in place (values.update), not appending.
 *
 * The previous implementation used append + INSERT_ROWS, which inserts brand-new
 * rows every run while `clear` only wipes values (not the grid). The grid therefore
 * grew without bound until it hit Google's hard limit of 10,000,000 cells and the
 * job crashed. Overwriting in place keeps the grid a fixed size, and we additionally
 * trim any leftover rows so the grid never bloats again.
 *
 * `sheetName` scopes every operation — clear, write and trim — to one tab, so
 * parallel matrix jobs writing different batches never touch each other's rows.
 *
 * Options (both only ever set by --consolidate, see consolidateBatches):
 *   stamp        false leaves each row's own `recorded_at` alone. Consolidation
 *                moves rows that were fetched earlier, by another job; stamping
 *                them with the consolidation time would claim a freshness they
 *                do not have.
 *   fullRefresh  overrides FULL_REFRESH. The master tab must always merge: the
 *                batch tabs are deleted right after, so a wallet whose batch
 *                came up empty this run survives only in the master.
 */
async function writeToSheet(rows, sheetName, opts = {}) {
  const {
    stamp = true,
    fullRefresh = RATE_LIMIT_CONFIG.FULL_REFRESH,
    schema = EVM_SCHEMA,
  } = opts;
  if (rows.length === 0) {
    log('WARN', `Nothing fetched — leaving "${sheetName}" untouched (safe-guard)`);
    return 0;
  }

  log('INFO', 'Authenticating with Google Sheets...');
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth, timeout: 60000 });

  // Creates the tab on first use so each batch owns its own target.
  const props = await ensureSheetTab(sheets, sheetName, schema);
  const sheetId = props.sheetId;
  const currentRowCount = props.gridProperties?.rowCount || 1000;

  // Stamp recorded_at on every freshly fetched row.
  const recordedAt = getCurrentTimestampTH();
  const fresh = rows.map((row) => {
    if (stamp) row[schema.stampIdx] = recordedAt;
    return row;
  });

  // Merge with whatever is already in the tab. Wallets this run did not reach
  // keep their rows because their keys are not in the fresh set, and rows that
  // aged out of the look-back window are dropped so the tab cannot grow forever.
  //
  // See keyOf: wallet_address + digest of `raw` + transfer_idx. Guessing which
  // flat fields make a row unique failed twice — first on the transaction id
  // alone (which collapsed the payer's and the payee's view of one transfer),
  // then on a hand-picked set of direction fields (which still could not separate
  // two identical-amount transfers) — so the key now comes from the API's own
  // bytes plus the two things those bytes cannot express.
  const merged = new Map(fresh.map((row) => [schema.keyOf(row), row]));
  let carried = 0;
  let expired = 0;
  let superseded = 0;

  // Rows written by an older version key differently, so their key space would
  // never intersect the fresh one and the first run after an upgrade would write
  // every row twice. Each fresh row therefore also claims the keys it WOULD have
  // had under each earlier scheme; an older row whose key is claimed has been
  // re-fetched and is dropped, and the rest are carried over untouched.
  const claimedOlder = new Set();
  if (schema === EVM_SCHEMA) {
    for (const row of fresh) {
      claimedOlder.add(legacyKeyOf(row));     // before `raw` existed
      claimedOlder.add(walletlessKeyOf(row)); // before `wallet_address` existed
    }
  }

  const cutoffMs = RATE_LIMIT_CONFIG.HISTORY_DAYS > 0
    ? Date.now() - RATE_LIMIT_CONFIG.HISTORY_DAYS * 86400000
    : 0;

  // FULL_REFRESH: skip the merge entirely, so the tab ends up holding exactly
  // what this run fetched and nothing else. Every `recorded_at` in the tab is
  // then from the same run, which is the point — the tab answers "how fresh is
  // this?" by construction instead of by reading a column.
  //
  // The merge exists because a run that does not reach every wallet would
  // otherwise delete the rows of the ones it missed, which is the data loss that
  // PR #13 fixed. Turning it off puts that risk back, so MIN_SUCCESS_RATIO is
  // what keeps a partial run from replacing a good snapshot with a thin one.
  if (fullRefresh) {
    log('INFO', `Full refresh of "${sheetName}": writing only the ` +
      `${c.bold(fresh.length)} row(s) fetched this run — previous contents are replaced`);
    if (RATE_LIMIT_CONFIG.MIN_SUCCESS_RATIO < 1) {
      log('WARN', `FULL_REFRESH=1 with MIN_SUCCESS_RATIO=` +
        `${RATE_LIMIT_CONFIG.MIN_SUCCESS_RATIO} — a run that misses a wallet will ` +
        `replace this tab with a thinner snapshot. Set MIN_SUCCESS_RATIO=1 to ` +
        `hold the write back instead.`);
    }
  } else {
    const existing = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${sheetName}!${schema.dataRange}`,
    }), `Read existing rows from "${sheetName}"`);

    for (const row of existing.data.values || []) {
      const key = schema.keyOf(row);
      if (merged.has(key)) continue;                       // refreshed this run
      const older = schema.olderKeyOf(row);
      if (older !== null && claimedOlder.has(older)) {
        superseded++;                                      // older-format row, re-fetched
        continue;
      }
      if (cutoffMs && parseDateTH(row[schema.timeIdx]) < cutoffMs) { // outside the window now
        expired++;
        continue;
      }
      merged.set(key, row);
      carried++;
    }

    if (carried || expired || superseded) {
      log('INFO', `Merged with "${sheetName}": ${c.bold(fresh.length)} fetched, ` +
        `${c.bold(carried)} kept from previous runs` +
        (superseded ? `, ${superseded} older-format row(s) superseded` : '') +
        (expired ? `, ${expired} aged out of the window` : ''));
    }
  }

  const values = [...merged.values()]
    .sort((a, b) => parseDateTH(b[schema.timeIdx]) - parseDateTH(a[schema.timeIdx]));

  if (values.length === 0) {
    log('WARN', `Nothing to write to "${sheetName}" after merge — leaving it untouched`);
    return 0;
  }

  const lastDataRow = values.length + 1; // +1 for the header row
  const targetRowCount = lastDataRow + 50; // keep a small buffer below the data

  // 1) Make sure the grid has enough rows for the data (grow only if needed).
  if (currentRowCount < targetRowCount) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      resource: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { rowCount: targetRowCount } },
            fields: 'gridProperties.rowCount',
          },
        }],
      },
    }), 'Grow sheet rows');
  }

  // 2) Wipe every existing data row before writing the new set. This runs AFTER
  //    the merge read above, so nothing that needs preserving is lost, and it
  //    guarantees no stale row can survive below the rows we are about to write.
  await clearSheetContent(sheets, sheetName, schema);

  // 3) Overwrite in place, chunked (values.update — never inserts rows).
  const totalChunks = Math.ceil(values.length / RATE_LIMIT_CONFIG.CHUNK_SIZE);
  log('INFO', `Writing ${c.bold(values.length)} rows in ${totalChunks} chunk(s)...`);

  for (let i = 0; i < values.length; i += RATE_LIMIT_CONFIG.CHUNK_SIZE) {
    const chunk = values.slice(i, i + RATE_LIMIT_CONFIG.CHUNK_SIZE);
    const chunkNum = Math.floor(i / RATE_LIMIT_CONFIG.CHUNK_SIZE) + 1;
    const startRow = 2 + i; // header is row 1

    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${sheetName}!A${startRow}`,
      valueInputOption: 'RAW',
      resource: { values: chunk },
    }), `Write chunk ${chunkNum}/${totalChunks}`);

    log('INFO', `Chunk ${chunkNum}/${totalChunks} written (${chunk.length} rows @ row ${startRow})`);

    if (i + RATE_LIMIT_CONFIG.CHUNK_SIZE < values.length) {
      // Spaced out so parallel matrix jobs share the Sheets write quota safely.
      await jitterDelay(
        RATE_LIMIT_CONFIG.SHEETS_WRITE_DELAY_MS,
        RATE_LIMIT_CONFIG.SHEETS_WRITE_DELAY_MS * 1.5
      );
    }
  }

  // 4) Trim any excess rows below the data to keep the grid small (reclaim cells).
  const rowCountNow = Math.max(currentRowCount, targetRowCount);
  if (rowCountNow > targetRowCount) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: targetRowCount, // 0-based; keeps rows [0, targetRowCount)
              endIndex: rowCountNow,
            },
          },
        }],
      },
    }), 'Trim excess rows');
    log('OK', `Trimmed grid ${rowCountNow} → ${targetRowCount} rows (reclaimed cells)`);
  }

  log('OK', `Successfully wrote ${c.bold(values.length)} rows to "${sheetName}"` +
    (carried ? ` (${fresh.length} fresh + ${carried} kept)` : ''));
  return values.length;
}

/**
 * Append rows to the end of the sheet WITHOUT clearing it (manual retry mode).
 *
 * Uses values.append with the default OVERWRITE behaviour — deliberately NOT
 * insertDataOption:'INSERT_ROWS', which is what previously grew the grid past
 * Google's 10,000,000-cell limit.
 */
async function appendToSheet(rows, sheetName) {
  if (rows.length === 0) {
    log('WARN', 'No data to append');
    return 0;
  }

  log('INFO', 'Authenticating with Google Sheets...');
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth, timeout: 60000 });

  // Create the tab if this is the first thing to ever write to it.
  await ensureSheetTab(sheets, sheetName);

  const recordedAt = getCurrentTimestampTH();
  const values = rows.map((row) => {
    row[34] = recordedAt;
    return row;
  });

  const totalChunks = Math.ceil(values.length / RATE_LIMIT_CONFIG.CHUNK_SIZE);
  log('INFO', `Appending ${c.bold(values.length)} rows in ${totalChunks} chunk(s)...`);

  for (let i = 0; i < values.length; i += RATE_LIMIT_CONFIG.CHUNK_SIZE) {
    const chunk = values.slice(i, i + RATE_LIMIT_CONFIG.CHUNK_SIZE);
    const chunkNum = Math.floor(i / RATE_LIMIT_CONFIG.CHUNK_SIZE) + 1;

    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${sheetName}!${DATA_RANGE}`,
      valueInputOption: 'RAW',
      resource: { values: chunk },
    }), `Append chunk ${chunkNum}/${totalChunks}`);

    log('INFO', `Chunk ${chunkNum}/${totalChunks} appended (${chunk.length} rows)`);

    if (i + RATE_LIMIT_CONFIG.CHUNK_SIZE < values.length) {
      await jitterDelay(500, 1500);
    }
  }

  log('OK', `Appended ${c.bold(values.length)} rows to "${sheetName}"`);
  return values.length;
}

// ============================================================================
// CONSOLIDATION — fold every Batch_NN tab into one sheet, then remove them
// ============================================================================
// Batch tabs exist for one reason: parallel matrix jobs must not clear and
// overwrite each other's rows, and a tab per job is what guarantees that. They
// are scratch space, not the product — 50 of them is 50 places to look, and the
// count grows with every increase to BATCH_TOTAL.
//
// So once the fetching jobs are done, one final job folds them into a single tab
// and deletes them. It runs after `needs: sync`, never alongside it: deleting a
// tab a batch job is still writing would lose that job's rows.

// Ranges per values.batchGet call. One request for all 50 tabs would work, but
// the response carries the `raw` column of every row in the spreadsheet, so this
// keeps a single response to a sane size.
const CONSOLIDATE_RANGES_PER_CALL = 20;

/** Every tab this run may consolidate: "<prefix><digits>", never the master. */
async function listBatchTabs(sheets, masterName) {
  const meta = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId,title))',
  }), 'List spreadsheet tabs');

  const pattern = batchTabPattern();
  return (meta.data.sheets || [])
    .map((s) => s.properties)
    .filter((p) => pattern.test(p.title) && p.title !== masterName)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Read the data rows of every batch tab, batched into few API calls. */
async function readBatchTabs(sheets, tabs, schema = EVM_SCHEMA) {
  const out = [];

  for (let i = 0; i < tabs.length; i += CONSOLIDATE_RANGES_PER_CALL) {
    const slice = tabs.slice(i, i + CONSOLIDATE_RANGES_PER_CALL);
    const res = await withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      // Quoted so a prefix containing a space or a quote still produces a valid A1 range.
      ranges: slice.map((t) => `'${t.title.replace(/'/g, "''")}'!${schema.dataRange}`),
    }), `Read ${slice.length} batch tab(s)`);

    const valueRanges = res.data.valueRanges || [];
    slice.forEach((tab, j) => out.push({ tab, rows: valueRanges[j]?.values || [] }));

    if (i + CONSOLIDATE_RANGES_PER_CALL < tabs.length) {
      await jitterDelay(RATE_LIMIT_CONFIG.SHEETS_WRITE_DELAY_MS,
        RATE_LIMIT_CONFIG.SHEETS_WRITE_DELAY_MS * 1.5);
    }
  }

  return out;
}

/** Sheets drops trailing empty cells on read; give every row the full width. */
function padRow(row, schema = EVM_SCHEMA) {
  const out = row.slice(0, schema.width);
  while (out.length < schema.width) out.push(null);
  return out;
}

/** True for a row that is entirely blank (a leftover grid row, not data). */
function isBlankRow(row) {
  return !row.some((cell) => String(cell ?? '') !== '');
}

/**
 * Merge every batch tab into one, then delete the tabs.
 *
 * Deleting is the whole point of the mode, so it is deliberately the LAST step
 * and conditional on the master write having succeeded. Nothing is removed until
 * its rows are somewhere else.
 */
async function consolidateBatches(schema = EVM_SCHEMA) {
  const startTime = Date.now();
  const masterName = resolveMasterSheetName();

  if (!GOOGLE_SPREADSHEET_ID) throw new Error('GOOGLE_SPREADSHEET_ID not configured');

  log('INFO', 'Authenticating with Google Sheets...');
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth, timeout: 60000 });

  const tabs = await listBatchTabs(sheets, masterName);
  if (tabs.length === 0) {
    // Not an error: consolidation already ran, or the batches wrote nothing.
    log('INFO', `No "${batchTabPattern().source}" tabs to consolidate — ` +
      `"${masterName}" is already the only sheet holding results`);
    return { success: true, tabs: 0, rows: 0, written: 0, deleted: 0, masterName };
  }

  log('INFO', `Consolidating ${c.bold(tabs.length)} batch tab(s) → ${c.cyan(masterName)} ` +
    c.dim(`(${tabs[0].title} … ${tabs[tabs.length - 1].title})`));

  const read = await readBatchTabs(sheets, tabs, schema);

  // Dedupe across tabs. Wallets belong to exactly one batch, so this normally
  // finds nothing — but a change to BATCH_TOTAL re-slices the list, and a wallet
  // that moved leaves rows behind in its old tab. Same key, two copies: keep the
  // one recorded more recently.
  const byKey = new Map();
  let duplicates = 0;
  let empty = 0;

  for (const { tab, rows } of read) {
    let kept = 0;
    for (const raw of rows) {
      if (isBlankRow(raw)) continue;
      const row = padRow(raw, schema);
      const key = schema.keyOf(row);
      const prev = byKey.get(key);
      if (prev) {
        duplicates++;
        if (parseDateTH(row[schema.stampIdx]) <= parseDateTH(prev[schema.stampIdx])) continue;
      }
      byKey.set(key, row);
      kept++;
    }
    if (kept === 0) empty++;
    log('DEBUG', `${tab.title}: ${kept} row(s)`);
  }

  const rows = [...byKey.values()];
  log('INFO', `Collected ${c.bold(rows.length)} unique row(s) from ${tabs.length} tab(s)` +
    (duplicates ? `, ${duplicates} duplicate(s) resolved by recorded_at` : '') +
    (empty ? `, ${empty} tab(s) empty` : ''));

  if (rows.length === 0) {
    // Every tab was empty. Deleting them would be harmless, but an empty batch
    // tab usually means the fetch jobs failed — leave the spreadsheet exactly as
    // it is so the failure is visible rather than tidied away.
    log('WARN', `Every batch tab is empty — "${masterName}" left untouched and ` +
      `no tab deleted. Check the fetch jobs before re-running.`);
    return { success: true, tabs: tabs.length, rows: 0, written: 0, deleted: 0, masterName };
  }

  // stamp:false keeps each row's own recorded_at — it says when the row was
  // FETCHED, and consolidation does not refetch anything.
  // fullRefresh:false is not optional here: the batch tabs are about to be
  // deleted, so any wallet whose batch was held back this run (MIN_SUCCESS_RATIO)
  // exists only in the master, and only the merge carries it forward.
  const written = await writeToSheet(rows, masterName,
    { stamp: false, fullRefresh: false, schema });

  if (written === 0) {
    log('WARN', `"${masterName}" was not written — keeping every batch tab`);
    return { success: true, tabs: tabs.length, rows: rows.length, written: 0, deleted: 0, masterName };
  }

  let deleted = 0;
  if (!RATE_LIMIT_CONFIG.DELETE_BATCH_TABS || CLI.keepBatches) {
    log('INFO', `Keeping ${tabs.length} batch tab(s) (DELETE_BATCH_TABS=0)`);
  } else {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      resource: { requests: tabs.map((t) => ({ deleteSheet: { sheetId: t.sheetId } })) },
    }), `Delete ${tabs.length} batch tab(s)`);
    deleted = tabs.length;
    log('OK', `Deleted ${c.bold(deleted)} batch tab(s) — their rows are now in ` +
      `"${masterName}"`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('OK', `${c.bold('Consolidation completed')} in ${elapsed}s — ${written} row(s) ` +
    `in "${masterName}", ${deleted} tab(s) removed`);

  return { success: true, tabs: tabs.length, rows: rows.length, written, deleted, masterName };
}

// ============================================================================
// MAIN PROCESSING
// ============================================================================

async function processTransactions() {
  const startTime = Date.now();
  const batch = resolveBatch();
  const sheetName = resolveSheetName(batch);
  const allWallets = loadAllWallets();
  const wallets = getWalletList(batch);

  if (allWallets.length === 0) {
    throw new Error('No wallets configured. Set WALLET_LIST (or WALLETS_FILE).');
  }
  if (wallets.length === 0) {
    // A batch can legitimately come up empty if TOTAL exceeds the wallet count.
    log('WARN', `Batch ${batch?.index}/${batch?.total} has no wallets ` +
      `(only ${allWallets.length} configured) — nothing to do`);
    return { success: true, totalRaw: 0, totalFiltered: 0, written: 0,
      okCount: 0, errorCount: 0, skipped: 0, stopReason: null, sheetName, batch };
  }

  if (!GOOGLE_SPREADSHEET_ID) {
    throw new Error('GOOGLE_SPREADSHEET_ID not configured');
  }
  if (!HISTORY_API_URL) {
    throw new Error('HISTORY_API_URL not configured — set it as a repository ' +
      'secret, or in .env for local runs');
  }

  const scope = batch
    ? `${c.bold(`batch ${batch.index}/${batch.total}`)} — wallets ` +
      `${c.bold(wallets.length)} of ${allWallets.length}`
    : `${c.bold(wallets.length)} wallet(s)`;
  const cfg0 = RATE_LIMIT_CONFIG;
  const windowLabel = cfg0.HISTORY_DAYS > 0
    ? `last ${cfg0.HISTORY_DAYS} days (since ${formatDateTH(Math.floor(Date.now() / 1000) - cfg0.HISTORY_DAYS * 86400)})`
    : `up to ${cfg0.MAX_TX_PER_WALLET} rows`;
  log('INFO', `${c.bold('Starting sync')} for ${scope} → tab ${c.cyan(sheetName)} ` +
    `${c.dim(`(${windowLabel})`)}`);
  log('INFO', `Request quota: ${c.bold(RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_RUN)} this run ` +
    `${c.dim('(~2 per wallet — the API answers the first request with a pending job)')}`);
  log('INFO', `Throttle: ${RATE_LIMIT_CONFIG.JITTER_MIN_MS}-${RATE_LIMIT_CONFIG.JITTER_MAX_MS}ms between ` +
    `requests, ${RATE_LIMIT_CONFIG.PAGE_DELAY_MIN_MS}-${RATE_LIMIT_CONFIG.PAGE_DELAY_MAX_MS}ms between pages | ` +
    `Egress: ${PROXY_URL ? c.cyan('proxy ' + maskProxy(PROXY_URL)) : 'direct'}`);

  const rateLimitMgr = new RateLimitManager();
  const collected = [];   // { timeAt, row } so everything can be sorted before writing
  let totalRaw = 0;
  let totalFiltered = 0;
  let totalScam = 0;
  let errorCount = 0;

  let okCount = 0;
  let consecutiveBlocked = 0; // feeds the circuit breaker
  let processed = 0;
  let stopReason = null;      // set when we abandon the fetch phase early

  // --- Phase 1: fetch every wallet (request spacing/cooldown handled by rateLimitMgr) ---
  for (let i = 0; i < wallets.length; i++) {
    // Guard 1 — global deadline: stop fetching while there's still time to save.
    if (fetchBudgetRemainingMs() <= 0) {
      stopReason = `time budget reached after ${fmtDuration(elapsedMs())}`;
      break;
    }

    // Guard 1b — request quota: a wallet costs ~2 requests (the API answers the
    // first with a pending job), so stop before starting one we cannot finish.
    if (rateLimitMgr.budgetLeft() < 2) {
      stopReason = `request quota reached (${RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_RUN} requests)`;
      break;
    }

    // Guard 2 — circuit breaker: consecutive blocks mean the IP itself is
    // soft-blocked, so every remaining wallet would fail too. Stop and save.
    if (consecutiveBlocked >= RATE_LIMIT_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
      stopReason = `circuit breaker tripped after ${consecutiveBlocked} consecutive soft-blocks`;
      break;
    }

    const walletStartTime = Date.now();
    const addr = wallets[i];
    const masked = maskAddr(addr);
    processed++;

    // Each wallet's chatter (retries, cooldowns) collapses into one group in Actions.
    groupStart(`[${i + 1}/${wallets.length}] ${masked}`);
    try {
      const { list: rawList, attempts, pages, stopReason: pageStop, fetched } =
        await fetchTransactions(addr, rateLimitMgr);

      if (!Array.isArray(rawList)) {
        log('ERROR', `${masked}: unexpected response structure — skipped`);
        errorCount++;
        continue;
      }

      // Drop only transactions the API positively flags as scam. `is_scam === false`
      // also discarded rows where the field is absent or null, which silently threw
      // away legitimate history.
      const filtered = rawList.filter((tx) => tx.is_scam !== true);
      const scamDropped = rawList.length - filtered.length;
      const elapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);

      const newest = rawList.length ? formatDateTH(rawList[0].time_at) : 'n/a';
      const outsideWindow = (fetched ?? rawList.length) - rawList.length;
      log('OK', `${c.magenta(masked)}: ${c.bold(filtered.length)} txs kept ` +
        `(${pages} page(s), ${attempts} request(s), ${scamDropped} scam, ` +
        `${outsideWindow} outside window, ${elapsed}s) — newest ${c.cyan(newest)}`);
      log('DEBUG', `${masked}: pagination stopped because ${pageStop}`);

      totalRaw += rawList.length;
      totalFiltered += filtered.length;
      totalScam += scamDropped;
      okCount++;
      consecutiveBlocked = 0; // a success clears the breaker

      for (const tx of filtered) {
        try {
          // Keep the numeric timestamp alongside the row so every wallet's rows
          // can be merged and sorted newest-first before the write. One tx can
          // expand to several rows when it moves more than one token.
          const timeAt = Number(tx.time_at) || 0;
          for (const row of mapTransactionToRows(tx, addr)) {
            collected.push({ timeAt, row });
          }
        } catch (mapErr) {
          log('WARN', `Mapping error for tx ${tx.id}: ${mapErr.message}`);
        }
      }
    } catch (err) {
      const elapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);

      if (err instanceof DeadlineError || err instanceof BudgetError) {
        // Out of time or out of request quota — abandon the fetch phase and keep
        // what we have. Merge-preserve means the untouched wallets keep their rows.
        processed--;
        stopReason = err instanceof BudgetError
          ? err.message
          : `time budget reached (${err.message})`;
        break;
      }

      errorCount++;
      if (err instanceof BlockedError) {
        consecutiveBlocked++;
        log('ERROR', `${masked}: ${err.message} (${elapsed}s) — moving on to the next wallet`);
      } else {
        consecutiveBlocked = 0; // an ordinary failure isn't evidence of an IP block
        log('ERROR', `${masked}: ${err.message} (${elapsed}s) — skipping this wallet`);
      }
    } finally {
      groupEnd();
    }
  }

  // --- Phase 2: summary + write ---
  const skipped = wallets.length - processed;
  if (stopReason) {
    log('WARN', `${c.bold('Fetch phase stopped early')} — ${stopReason}. ` +
      `${c.bold(skipped)} wallet(s) not fetched this run; saving what we have.`);
  }

  log('INFO', `${c.bold('Summary')} — ${c.green(okCount + ' ok')}, ${c.red(errorCount + ' failed')}, ` +
    `${c.yellow(skipped + ' skipped')} of ${wallets.length} | ` +
    `${totalRaw} fetched → ${c.bold(totalFiltered)} kept (${totalScam} scam) | ` +
    `${rateLimitMgr.requestsMade}/${RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_RUN} requests | ` +
    `elapsed ${fmtDuration(elapsedMs())}`);

  // Newest transaction first across every wallet in this batch.
  collected.sort((a, b) => b.timeAt - a.timeAt);
  let allRows = collected.map((entry) => entry.row);

  // Runs over the whole batch at once: `lookalike` compares addresses against
  // each other, so it cannot be decided one row at a time.
  flagSuspectRows(allRows);
  allRows = dropSuspectRows(allRows);

  if (allRows.length) {
    log('INFO', `Sorted ${c.bold(allRows.length)} rows newest-first — ` +
      `${c.cyan(formatDateTH(collected[0].timeAt))} → ${c.cyan(formatDateTH(collected[collected.length - 1].timeAt))}`);
  }

  // Writes merge on transaction id, so a partial run only ever adds rows — the
  // wallets it missed keep theirs. MIN_SUCCESS_RATIO therefore defaults to 0 and
  // exists only for anyone who wants to hold back partial results anyway.
  const successRatio = wallets.length ? okCount / wallets.length : 0;
  if (okCount > 0 && successRatio < RATE_LIMIT_CONFIG.MIN_SUCCESS_RATIO) {
    log('WARN', `${c.bold('Sheet NOT updated')} — only ${okCount}/${wallets.length} wallets succeeded ` +
      `(below MIN_SUCCESS_RATIO ${RATE_LIMIT_CONFIG.MIN_SUCCESS_RATIO}). ` +
      `Tab "${sheetName}" keeps its previous contents.`);
    return { success: true, totalRaw, totalFiltered, written: 0, okCount, errorCount,
      skipped, stopReason, sheetName, batch };
  }

  const written = await writeToSheet(allRows, sheetName);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('OK', `${c.bold('Sync completed')} in ${elapsed}s — ${written} rows written to "${sheetName}"`);

  return { success: true, totalRaw, totalFiltered, written, okCount, errorCount,
    skipped, stopReason, sheetName, batch };
}

// ============================================================================
// MANUAL RETRY MODE — re-fetch a single wallet and append it
// ============================================================================
// Useful after a run where one wallet was skipped by the soft-block guard:
//   node src/index.js 0xabc...     (appends, never clears the sheet)

/**
 * Work out which batch a wallet belongs to, so a manual retry appends to the same
 * tab the scheduled run would have written it to. Returns null when batching isn't
 * configured or the wallet isn't in the list.
 */
function findBatchForWallet(addr, total) {
  if (!Number.isInteger(total) || total < 1) return null;
  const all = loadAllWallets();
  if (!all.includes(addr)) return null;
  for (let index = 1; index <= total; index++) {
    if (sliceForBatch(all, index, total).includes(addr)) return { index, total };
  }
  return null;
}

async function runManualMode(walletAddress) {
  const addr = walletAddress.trim().toLowerCase();
  const masked = maskAddr(addr);

  // Pick the tab this wallet actually belongs to, so a retry can't land in the
  // wrong batch's tab: explicit --sheet/--batch first, then auto-detection.
  let batch = resolveBatch();
  if (!batch && !CLI.sheet && !process.env.TARGET_SHEET_NAME) {
    const total = process.env.BATCH_TOTAL ? num('BATCH_TOTAL', 0) : null;
    batch = findBatchForWallet(addr, total);
    if (batch) {
      log('INFO', `${c.magenta(masked)} belongs to batch ${batch.index}/${batch.total}`);
    }
  }
  const sheetName = resolveSheetName(batch);

  log('INFO', `${c.bold('Manual retry mode')} — ${c.magenta(masked)} → tab ${c.cyan(sheetName)} ` +
    `${c.dim('(append only, tab not cleared)')}`);

  if (!HISTORY_API_URL) {
    throw new Error('HISTORY_API_URL not configured — set it as a repository ' +
      'secret, or in .env for local runs');
  }

  const rateLimitMgr = new RateLimitManager();
  const { list: rawList, attempts, pages } = await fetchTransactions(addr, rateLimitMgr);

  if (!Array.isArray(rawList)) {
    throw new Error('Unexpected response structure');
  }

  // Already sorted newest-first by fetchTransactions.
  const filtered = rawList.filter((tx) => tx.is_scam !== true);
  const newest = rawList.length ? formatDateTH(rawList[0].time_at) : 'n/a';
  log('OK', `${c.magenta(masked)}: ${c.bold(filtered.length)} txs kept ` +
    `(${rawList.length} fetched over ${pages} page(s), ${attempts} request(s)) — newest ${c.cyan(newest)}`);

  let rows = [];
  for (const tx of filtered) {
    try {
      rows.push(...mapTransactionToRows(tx, addr));
    } catch (mapErr) {
      log('WARN', `Mapping error for tx ${tx.id}: ${mapErr.message}`);
    }
  }
  flagSuspectRows(rows);
  rows = dropSuspectRows(rows);

  const written = await appendToSheet(rows, sheetName);
  log('OK', `${c.bold('Manual retry completed')} in ${fmtDuration(elapsedMs())} — ` +
    `${written} rows appended to "${sheetName}"`);
  return { success: true, written, wallet: masked, sheetName };
}

// ============================================================================
// LOCK FILE — prevent two local runs from clobbering the same sheet
// ============================================================================
// Skipped on GitHub Actions: each run gets a fresh container (so there is nothing
// to collide with), and a lock left behind by a cancelled run would permanently
// break every future run.

const LOCK_STALE_MS = 30 * 60 * 1000;
let lockFile = null;

/**
 * The lock is scoped to the target tab: two batches write different tabs and may
 * safely run side by side locally, but two runs targeting the same tab must not.
 */
function lockFileFor() {
  let suffix = '';
  try {
    // Consolidation writes the master tab, so that is what it must lock.
    const name = CLI.consolidate ? resolveMasterSheetName() : resolveSheetName(resolveBatch());
    suffix = '.' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');
  } catch {
    /* bad batch args are reported later by the real code path */
  }
  return path.join(__dirname, '..', `.bot${suffix}.lock`);
}

function acquireLock() {
  if (IN_GHA) return; // CI runs are isolated; a stale lock would only cause harm

  const file = lockFileFor();

  if (fs.existsSync(file)) {
    const ageMs = Date.now() - fs.statSync(file).mtimeMs;
    if (ageMs < LOCK_STALE_MS) {
      const pid = fs.readFileSync(file, 'utf8').trim();
      throw new Error(`Another instance is already writing this tab (PID ${pid}, ` +
        `lock age ${fmtDuration(ageMs)}). Delete ${file} if that is wrong.`);
    }
    log('WARN', `Ignoring stale lock file (age ${fmtDuration(ageMs)})`);
  }

  fs.writeFileSync(file, String(process.pid));
  lockFile = file;
}

function releaseLock() {
  if (!lockFile) return;
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* already gone — nothing to do */
  }
  lockFile = null;
}

// Release the lock however the process ends, including Ctrl-C and the SIGTERM
// GitHub sends when it cancels a job.
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('WARN', `Received ${sig} — shutting down`);
    releaseLock();
    process.exit(1);
  });
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  try {
    if (CLI.help) {
      console.log(HELP_TEXT.trim());
      process.exit(0);
    }

    acquireLock();

    // A wallet address (positional or --wallet) switches to manual retry mode.
    // Required lazily: src/solana.js requires this module back, and at call
    // time these exports are fully populated.
    const sol = CLI.chain === 'sol' ? require('./solana.js') : null;

    let result;
    if (CLI.consolidate) {
      result = sol ? await sol.consolidateSolana() : await consolidateBatches();
    } else if (sol) {
      result = await sol.processSolana();
    } else if (CLI.wallet) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(CLI.wallet)) {
        throw new Error(`Invalid wallet address: "${CLI.wallet}" (expected 0x + 40 hex chars)`);
      }
      result = await runManualMode(CLI.wallet);
    } else {
      result = await processTransactions();
    }

    log('OK', `Done — ${JSON.stringify(result)}`);
    // Partial results (blocked or skipped wallets) still count as a successful
    // run: the data we did fetch is saved and the workflow stays green. Only a
    // genuine fatal error falls through to the catch below.
    process.exit(0);
  } catch (err) {
    log('ERROR', `Fatal: ${err.message}`);
    if (process.env.LOG_LEVEL?.toUpperCase() === 'DEBUG') {
      log('ERROR', err.stack || 'No stack trace');
    }
    process.exit(1);
  }
}

// The exports MUST be assigned BEFORE the auto-run below.
//
// main() is async, but everything up to its first await runs synchronously —
// and that prefix includes `require('./solana.js')`, which requires this module
// straight back. With the auto-run first, that re-entry saw module.exports still
// empty and every --chain sol run died on "makeSchema is not a function". Unit
// tests could not catch it: they import this file, so main() never runs.
module.exports = {
  RateLimitManager,
  DeadlineError,
  BudgetError,
  BlockedError,
  parseRetryAfter,
  fmtDuration,
  fetchBudgetRemainingMs,
  fetchTransactions,
  fetchHistoryPage,
  clearSheetContent,
  writeToSheet,
  ensureSheetTab,
  widenSheetTab,
  resolveProxyUrl,
  isProxyExempt,
  maskProxy,
  processTransactions,
  parseArgs,
  parseDateTH,
  sliceForBatch,
  rotateWallets,
  loadAllWallets,
  resolveBatch,
  resolveSheetName,
  resolveMasterSheetName,
  // --- shared with src/solana.js (required lazily there to avoid a cycle) ---
  log,
  c,
  sleep,
  jitterDelay,
  withRetry,
  getGoogleAuth,
  colLetter,
  makeSchema,
  EVM_SCHEMA,
  rawCell,
  getCurrentTimestampTH,
  formatDateTH,
  API_HEADERS,
  HTTPS_AGENT,
  CLI,
  batchTabPattern,
  consolidateBatches,
  listBatchTabs,
  readBatchTabs,
  padRow,
  isBlankRow,
  SHEET_HEADER,
  LAST_COL,
  DATA_RANGE,
  mapTransactionToRow,
  mapTransactionToRows,
  transferRowCount,
  keyOf,
  legacyKeyOf,
  hasRaw,
  hasWallet,
  walletlessKeyOf,
  rawDigest,
  rowUsdValue,
  isDustRelayed,
  addrFingerprint,
  flagSuspectRows,
  dropSuspectRows,
  maskAddr,
  RATE_LIMIT_CONFIG,
};

// Only auto-run when executed directly (`node src/index.js`), so the helpers
// above can be imported and unit-tested without triggering a live sync.
if (require.main === module) {
  main();
}

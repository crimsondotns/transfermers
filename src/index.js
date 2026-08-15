require('dotenv').config();

const axios = require('axios');
const { google } = require('googleapis');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const RABBY_API_URL = 'https://api.rabby.io/v1/user/history_all_list';
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const GOOGLE_SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || '{}';

// Wallet list: supports both env var and file
const getWalletList = () => {
  if (process.env.WALLET_LIST) {
    return process.env.WALLET_LIST.split(',')
      .map(w => w.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
};

const num = (envVar, fallback) => parseInt(process.env[envVar] || String(fallback), 10);

const RATE_LIMIT_CONFIG = {
  // --- Request spacing (adaptive: widens on push-back, decays on success) ---
  JITTER_MIN_MS: num('JITTER_MIN_MS', 3000),
  JITTER_MAX_MS: num('JITTER_MAX_MS', 6000),
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

  // --- Global safety guard (prevents a GitHub Actions "Canceled") ---
  // The workflow's own timeout is 30 min. We stop fetching well before that and
  // reserve time to flush whatever we already have to Google Sheets, so the run
  // ends green with partial data instead of being killed with nothing saved.
  GLOBAL_TIMEOUT_MS: num('GLOBAL_TIMEOUT_MS', 20 * 60 * 1000),
  WRITE_RESERVE_MS: num('WRITE_RESERVE_MS', 90000),

  // --- Google Sheets ---
  CHUNK_SIZE: num('CHUNK_SIZE', 500),
  // Safety guard: the sheet is a full-refresh snapshot, so writing a mostly-empty
  // result would destroy a good previous snapshot. Require this share of wallets
  // to have succeeded before the destructive clear+write is allowed.
  MIN_SUCCESS_RATIO: parseFloat(process.env.MIN_SUCCESS_RATIO || '0.5'),
};

// Honest client headers — we identify as a normal HTTP/JSON client and rely on
// politeness (spacing + Retry-After) rather than trying to disguise the request.
const API_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': process.env.HTTP_USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// HTTPS Agent
const HTTPS_AGENT = new https.Agent({
  minVersion: 'TLSv1.2',
  keepAlive: true,
  maxSockets: 5,
  timeout: 60000,
  freeSocketTimeout: 30000,
});

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
  }

  /**
   * Call immediately before every request. Honors cooldown + spacing.
   * Returns false when the remaining wait would run past the global deadline,
   * so the caller can bail out instead of sleeping into a workflow cancellation.
   */
  async beforeRequest() {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      const waitMs = this.cooldownUntil - now;
      if (waitMs >= fetchBudgetRemainingMs()) return false; // no time left to wait it out
      log('WARN', `Cooldown active — waiting ${c.bold(fmtDuration(waitMs))} before next request`);
      await sleep(waitMs);
    }
    const since = Date.now() - this.lastRequest;
    if (since < this.delayMs) {
      await sleep(this.delayMs - since);
    }
    this.lastRequest = Date.now();
    return true;
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

async function fetchTransactions(walletAddress, rateLimitMgr) {
  const url = `${RABBY_API_URL}?id=${walletAddress}`;
  const masked = maskAddr(walletAddress);
  const cfg = RATE_LIMIT_CONFIG;

  let blockRetries = 0;   // 429 + 403 attempts for THIS wallet
  let blockWaitMs = 0;    // total cooldown already spent on THIS wallet
  let timeoutRetries = 0;
  let pendingRounds = 0;  // how many times the API said "job pending"

  for (let attempt = 1; attempt <= cfg.MAX_RETRIES; attempt++) {
    // Global guard: never start another request if the run is out of time.
    if (fetchBudgetRemainingMs() <= 0) {
      throw new DeadlineError('global time budget exhausted');
    }

    // Honors any open cooldown; false means waiting it out would blow the deadline.
    if (!(await rateLimitMgr.beforeRequest())) {
      throw new DeadlineError('not enough time left to wait out the cooldown');
    }

    try {
      log('DEBUG', `Fetching ${masked} (attempt ${attempt}/${cfg.MAX_RETRIES})`);

      const response = await axios.get(url, {
        headers: API_HEADERS,
        timeout: 60000,
        httpsAgent: HTTPS_AGENT,
      });

      const body = response.data;
      const resultPayload = body?.result?.data;

      if (resultPayload && Array.isArray(resultPayload.history_list)) {
        rateLimitMgr.onSuccess();
        return { payload: resultPayload, attempts: attempt };
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
        blockRetries++;
        const walletBudgetLeft = cfg.WALLET_BLOCK_BUDGET_MS - blockWaitMs;

        if (blockRetries > cfg.MAX_BLOCK_RETRIES || walletBudgetLeft <= 0) {
          throw new BlockedError(
            `${status} soft-block — skipped after ${blockRetries} attempt(s) ` +
            `and ${fmtDuration(blockWaitMs)} of cooldown`
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
        blockWaitMs += cooldown;

        const label = status === 429 ? '429 Too Many Requests' : '403 Forbidden (soft-block)';
        const src = retryAfterMs != null ? ' (Retry-After honored)' : '';
        log('WARN',
          `${c.bold(label)} on ${masked} [${blockRetries}/${cfg.MAX_BLOCK_RETRIES}] — ` +
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

// ============================================================================
// DATA MAPPING
// ============================================================================

function mapTransactionToRow(tx, walletAddr) {
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

    const recv_amount = v(tx.receives?.[0]?.amount) ?? null;
    const recv_from_addr = v(tx.receives?.[0]?.from_addr) ?? null;
    const recv_price = v(tx.receives?.[0]?.price) ?? null;
    const recv_token_id = v(tx.receives?.[0]?.token_id) ?? null;

    const send_amount = v(tx.sends?.[0]?.amount) ?? null;
    const send_price = v(tx.sends?.[0]?.price) ?? null;
    const send_to_addr = v(tx.sends?.[0]?.to_addr) ?? null;
    const send_token_id = v(tx.sends?.[0]?.token_id) ?? null;

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
      null, // recorded_at will be filled during write
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

/** Generic retry wrapper for Google API calls (exponential-ish linear backoff). */
async function withRetry(fn, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const detail = err.errors?.[0]?.message || err.message;
      if (attempt === maxRetries) {
        throw new Error(`${label} failed after ${maxRetries} retries: ${detail}`);
      }
      const waitSec = 5 * attempt;
      log('WARN', `${label} failed [${attempt}/${maxRetries}] — retrying in ${waitSec}s: ${detail}`);
      await sleep(waitSec * 1000);
    }
  }
}

/** Look up the target tab's sheetId + current grid size. */
async function getSheetProps(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
  });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties.title === GOOGLE_SHEET_NAME
  );
  if (!sheet) {
    throw new Error(`Sheet tab "${GOOGLE_SHEET_NAME}" not found in spreadsheet`);
  }
  return sheet.properties;
}

/**
 * Write rows to the sheet by OVERWRITING in place (values.update), not appending.
 *
 * The previous implementation used append + INSERT_ROWS, which inserts brand-new
 * rows every run while `clear` only wipes values (not the grid). The grid therefore
 * grew without bound until it hit Google's hard limit of 10,000,000 cells and the
 * job crashed. Overwriting in place keeps the grid a fixed size, and we additionally
 * trim any leftover rows so the grid never bloats again.
 */
async function writeToSheet(rows) {
  if (rows.length === 0) {
    log('WARN', 'No data fetched — leaving the sheet untouched (safe-guard)');
    return 0;
  }

  log('INFO', 'Authenticating with Google Sheets...');
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth, timeout: 60000 });

  const props = await withRetry(() => getSheetProps(sheets), 'Get sheet metadata');
  const sheetId = props.sheetId;
  const currentRowCount = props.gridProperties?.rowCount || 1000;

  // Stamp recorded_at (column AI / index 34) on every row.
  const recordedAt = getCurrentTimestampTH();
  const values = rows.map((row) => {
    row[34] = recordedAt;
    return row;
  });

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

  // 2) Clear old values under the header.
  await withRetry(() => sheets.spreadsheets.values.clear({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: `${GOOGLE_SHEET_NAME}!A2:AI`,
  }), 'Clear sheet');
  log('OK', 'Cleared previous values (A2:AI)');

  // 3) Overwrite in place, chunked (values.update — never inserts rows).
  const totalChunks = Math.ceil(values.length / RATE_LIMIT_CONFIG.CHUNK_SIZE);
  log('INFO', `Writing ${c.bold(values.length)} rows in ${totalChunks} chunk(s)...`);

  for (let i = 0; i < values.length; i += RATE_LIMIT_CONFIG.CHUNK_SIZE) {
    const chunk = values.slice(i, i + RATE_LIMIT_CONFIG.CHUNK_SIZE);
    const chunkNum = Math.floor(i / RATE_LIMIT_CONFIG.CHUNK_SIZE) + 1;
    const startRow = 2 + i; // header is row 1

    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${GOOGLE_SHEET_NAME}!A${startRow}`,
      valueInputOption: 'RAW',
      resource: { values: chunk },
    }), `Write chunk ${chunkNum}/${totalChunks}`);

    log('INFO', `Chunk ${chunkNum}/${totalChunks} written (${chunk.length} rows @ row ${startRow})`);

    if (i + RATE_LIMIT_CONFIG.CHUNK_SIZE < values.length) {
      await jitterDelay(500, 1500);
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

  log('OK', `Successfully wrote ${c.bold(values.length)} rows to "${GOOGLE_SHEET_NAME}"`);
  return values.length;
}

/**
 * Append rows to the end of the sheet WITHOUT clearing it (manual retry mode).
 *
 * Uses values.append with the default OVERWRITE behaviour — deliberately NOT
 * insertDataOption:'INSERT_ROWS', which is what previously grew the grid past
 * Google's 10,000,000-cell limit.
 */
async function appendToSheet(rows) {
  if (rows.length === 0) {
    log('WARN', 'No data to append');
    return 0;
  }

  log('INFO', 'Authenticating with Google Sheets...');
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth, timeout: 60000 });

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
      range: `${GOOGLE_SHEET_NAME}!A2:AI`,
      valueInputOption: 'RAW',
      resource: { values: chunk },
    }), `Append chunk ${chunkNum}/${totalChunks}`);

    log('INFO', `Chunk ${chunkNum}/${totalChunks} appended (${chunk.length} rows)`);

    if (i + RATE_LIMIT_CONFIG.CHUNK_SIZE < values.length) {
      await jitterDelay(500, 1500);
    }
  }

  log('OK', `Appended ${c.bold(values.length)} rows to "${GOOGLE_SHEET_NAME}"`);
  return values.length;
}

// ============================================================================
// MAIN PROCESSING
// ============================================================================

async function processTransactions() {
  const startTime = Date.now();
  const wallets = getWalletList();

  if (wallets.length === 0) {
    throw new Error('No wallets configured. Set WALLET_LIST environment variable.');
  }

  if (!GOOGLE_SPREADSHEET_ID) {
    throw new Error('GOOGLE_SPREADSHEET_ID not configured');
  }

  log('INFO', `${c.bold('Starting sync')} for ${c.bold(wallets.length)} wallet(s)`);

  const rateLimitMgr = new RateLimitManager();
  const allRows = [];
  let totalRaw = 0;
  let totalFiltered = 0;
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
      const { payload, attempts } = await fetchTransactions(addr, rateLimitMgr);
      const rawList = payload.history_list;

      if (!Array.isArray(rawList)) {
        log('ERROR', `${masked}: unexpected response structure — skipped`);
        errorCount++;
        continue;
      }

      const filtered = rawList.filter((tx) => tx.is_scam === false);
      const elapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);

      log('OK', `${c.magenta(masked)}: ${c.bold(filtered.length)} txs kept ` +
        `(${rawList.length} raw, ${attempts} attempt(s), ${elapsed}s)`);

      totalRaw += rawList.length;
      totalFiltered += filtered.length;
      okCount++;
      consecutiveBlocked = 0; // a success clears the breaker

      for (const tx of filtered) {
        try {
          allRows.push(mapTransactionToRow(tx, addr));
        } catch (mapErr) {
          log('WARN', `Mapping error for tx ${tx.id}: ${mapErr.message}`);
        }
      }
    } catch (err) {
      const elapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);

      if (err instanceof DeadlineError) {
        // Out of time mid-wallet — abandon the fetch phase, keep what we have.
        processed--;
        stopReason = `time budget reached (${err.message})`;
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
    `${totalRaw} raw → ${c.bold(totalFiltered)} non-scam rows | elapsed ${fmtDuration(elapsedMs())}`);

  // Safety guard: the sheet is a full-refresh snapshot, so replacing a complete
  // snapshot with a mostly-failed one would destroy good data. Below the ratio we
  // leave the previous contents alone and let the next run try again.
  const successRatio = wallets.length ? okCount / wallets.length : 0;
  if (okCount > 0 && successRatio < RATE_LIMIT_CONFIG.MIN_SUCCESS_RATIO) {
    log('WARN', `${c.bold('Sheet NOT updated')} — only ${okCount}/${wallets.length} wallets succeeded ` +
      `(below MIN_SUCCESS_RATIO ${RATE_LIMIT_CONFIG.MIN_SUCCESS_RATIO}). ` +
      `Previous snapshot preserved.`);
    return { success: true, totalRaw, totalFiltered, written: 0, okCount, errorCount, skipped, stopReason };
  }

  const written = await writeToSheet(allRows);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('OK', `${c.bold('Sync completed')} in ${elapsed}s — ${written} rows written`);

  return { success: true, totalRaw, totalFiltered, written, okCount, errorCount, skipped, stopReason };
}

// ============================================================================
// ENTRY POINT
// ============================================================================

// ============================================================================
// MANUAL RETRY MODE — re-fetch a single wallet and append it
// ============================================================================
// Useful after a run where one wallet was skipped by the soft-block guard:
//   node src/index.js 0xabc...     (appends, never clears the sheet)

async function runManualMode(walletAddress) {
  const addr = walletAddress.trim().toLowerCase();
  const masked = maskAddr(addr);

  log('INFO', `${c.bold('Manual retry mode')} — ${c.magenta(masked)} ${c.dim('(append only, sheet not cleared)')}`);

  const rateLimitMgr = new RateLimitManager();
  const { payload, attempts } = await fetchTransactions(addr, rateLimitMgr);
  const rawList = payload.history_list;

  if (!Array.isArray(rawList)) {
    throw new Error('Unexpected response structure');
  }

  const filtered = rawList.filter((tx) => tx.is_scam === false);
  log('OK', `${c.magenta(masked)}: ${c.bold(filtered.length)} txs kept (${rawList.length} raw, ${attempts} attempt(s))`);

  const rows = [];
  for (const tx of filtered) {
    try {
      rows.push(mapTransactionToRow(tx, addr));
    } catch (mapErr) {
      log('WARN', `Mapping error for tx ${tx.id}: ${mapErr.message}`);
    }
  }

  const written = await appendToSheet(rows);
  log('OK', `${c.bold('Manual retry completed')} in ${fmtDuration(elapsedMs())} — ${written} rows appended`);
  return { success: true, written, wallet: masked };
}

// ============================================================================
// LOCK FILE — prevent two local runs from clobbering the same sheet
// ============================================================================
// Skipped on GitHub Actions: each run gets a fresh container (so there is nothing
// to collide with), and a lock left behind by a cancelled run would permanently
// break every future run.

const LOCK_FILE = path.join(__dirname, '..', '.bot.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;
let lockHeld = false;

function acquireLock() {
  if (IN_GHA) return; // CI runs are isolated; a stale lock would only cause harm

  if (fs.existsSync(LOCK_FILE)) {
    const ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (ageMs < LOCK_STALE_MS) {
      const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      throw new Error(`Another instance appears to be running (PID ${pid}, lock age ${fmtDuration(ageMs)}). ` +
        `Delete ${LOCK_FILE} if that is wrong.`);
    }
    log('WARN', `Ignoring stale lock file (age ${fmtDuration(ageMs)})`);
  }

  fs.writeFileSync(LOCK_FILE, String(process.pid));
  lockHeld = true;
}

function releaseLock() {
  if (!lockHeld) return;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* already gone — nothing to do */
  }
  lockHeld = false;
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
    acquireLock();

    // A single 0x-address argument switches to manual retry mode.
    const arg = process.argv[2];
    let result;

    if (arg) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) {
        throw new Error(`Invalid wallet address: "${arg}" (expected 0x + 40 hex chars)`);
      }
      result = await runManualMode(arg);
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

// Only auto-run when executed directly (`node src/index.js`), so the helpers
// above can be imported and unit-tested without triggering a live sync.
if (require.main === module) {
  main();
}

module.exports = {
  RateLimitManager,
  DeadlineError,
  BlockedError,
  parseRetryAfter,
  fmtDuration,
  fetchBudgetRemainingMs,
  fetchTransactions,
  processTransactions,
  mapTransactionToRow,
  maskAddr,
  RATE_LIMIT_CONFIG,
};

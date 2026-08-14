require('dotenv').config();

const axios = require('axios');
const { google } = require('googleapis');
const https = require('https');

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

// Rate limit config
const RATE_LIMIT_CONFIG = {
  // Base spacing between requests (adaptive throttle floor / ceiling)
  JITTER_MIN_MS: parseInt(process.env.JITTER_MIN_MS || '3000', 10),
  JITTER_MAX_MS: parseInt(process.env.JITTER_MAX_MS || '6000', 10),
  MAX_DELAY_MS: parseInt(process.env.MAX_DELAY_MS || '20000', 10),
  // When rate-limited/blocked (429/403) with no Retry-After, use this as the base cooldown
  RATE_LIMIT_WAIT_MS: parseInt(process.env.RATE_LIMIT_WAIT_MS || '60000', 10),
  MAX_COOLDOWN_MS: parseInt(process.env.MAX_COOLDOWN_MS || '300000', 10), // hard cap 5 min
  // Retry budgets
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '10', 10),
  MAX_BLOCK_RETRIES: parseInt(process.env.MAX_BLOCK_RETRIES || '4', 10), // shared by 429 + 403
  MAX_TIMEOUT_RETRIES: parseInt(process.env.MAX_TIMEOUT_RETRIES || '5', 10),
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || '500', 10),
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

  /** Call immediately before every request. Honors cooldown + spacing. */
  async beforeRequest() {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      const waitMs = this.cooldownUntil - now;
      log('WARN', `Cooldown active — waiting ${c.bold(fmtDuration(waitMs))} before next request`);
      await sleep(waitMs);
    }
    const since = Date.now() - this.lastRequest;
    if (since < this.delayMs) {
      await sleep(this.delayMs - since);
    }
    this.lastRequest = Date.now();
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
   * cooldown window. Returns the cooldown length (ms) for logging.
   */
  onBlock(retryAfterMs) {
    this.consecutiveBlocks++;
    // Widen request spacing for the rest of the run (capped).
    this.delayMs = Math.min(
      RATE_LIMIT_CONFIG.MAX_DELAY_MS,
      Math.max(this.delayMs * 2, 5000)
    );
    // Cooldown: honor Retry-After if present, otherwise exponential backoff.
    const base = retryAfterMs || RATE_LIMIT_CONFIG.RATE_LIMIT_WAIT_MS;
    const backoff = Math.min(
      RATE_LIMIT_CONFIG.MAX_COOLDOWN_MS,
      Math.round(base * Math.pow(2, this.consecutiveBlocks - 1))
    );
    const jitter = Math.floor(Math.random() * backoff * 0.2); // +0–20% jitter
    const cooldown = backoff + jitter;
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
  let blockRetries = 0;   // shared budget for 429 + 403
  let timeoutRetries = 0;

  for (let attempt = 1; attempt <= RATE_LIMIT_CONFIG.MAX_RETRIES; attempt++) {
    try {
      await rateLimitMgr.beforeRequest();

      log('DEBUG', `Fetching ${masked} (attempt ${attempt}/${RATE_LIMIT_CONFIG.MAX_RETRIES})`);

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

      // Job still pending — server is still building the history, back off politely.
      if (body?.job) {
        log('DEBUG', `Job pending for ${masked}, waiting before retry...`);
        await jitterDelay(3000, 8000);
        continue;
      }

      log('WARN', `Unexpected response structure for ${masked}`);

    } catch (err) {
      const status = err.response?.status;

      // 429 (rate limited) and 403 (soft-block after too many requests) are handled the
      // same way: honor Retry-After, open a shared cooldown window, don't burn the
      // normal retry budget. The cooldown persists across wallets via rateLimitMgr.
      if (status === 429 || status === 403) {
        blockRetries++;
        if (blockRetries > RATE_LIMIT_CONFIG.MAX_BLOCK_RETRIES) {
          throw new Error(`${status} blocked — gave up after ${RATE_LIMIT_CONFIG.MAX_BLOCK_RETRIES} cooldowns`);
        }
        const retryAfterMs = parseRetryAfter(err.response?.headers?.['retry-after']);
        const cooldown = rateLimitMgr.onBlock(retryAfterMs);
        const label = status === 429 ? '429 Too Many Requests' : '403 Forbidden (soft-block)';
        const src = retryAfterMs != null ? ' (Retry-After honored)' : '';
        log('WARN', `${c.bold(label)} on ${masked} [${blockRetries}/${RATE_LIMIT_CONFIG.MAX_BLOCK_RETRIES}] — cooling down ${c.bold(fmtDuration(cooldown))}${src}`);
        attempt--; // the cooldown is handled by beforeRequest on the next loop; don't count it
        continue;
      }

      const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' ||
                        err.message?.includes('timeout');

      if (isTimeout) {
        timeoutRetries++;
        if (timeoutRetries > RATE_LIMIT_CONFIG.MAX_TIMEOUT_RETRIES) {
          throw new Error(`Timeout — gave up after ${RATE_LIMIT_CONFIG.MAX_TIMEOUT_RETRIES} retries`);
        }
        const waitSec = 5 + Math.floor(Math.random() * 10);
        log('WARN', `Timeout on ${masked} [${timeoutRetries}/${RATE_LIMIT_CONFIG.MAX_TIMEOUT_RETRIES}] — retrying in ${waitSec}s`);
        await sleep(waitSec * 1000);
        attempt--;
        continue;
      }

      // Other (non-retryable) errors
      throw new Error(`${err.message} (${err.code || status || 'UNKNOWN'})`);
    }
  }

  throw new Error(`Failed after ${RATE_LIMIT_CONFIG.MAX_RETRIES} attempts`);
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

  // --- Phase 1: fetch every wallet (request spacing/cooldown handled by rateLimitMgr) ---
  for (let i = 0; i < wallets.length; i++) {
    const walletStartTime = Date.now();
    const addr = wallets[i];
    const masked = maskAddr(addr);

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

      for (const tx of filtered) {
        try {
          allRows.push(mapTransactionToRow(tx, addr));
        } catch (mapErr) {
          log('WARN', `Mapping error for tx ${tx.id}: ${mapErr.message}`);
        }
      }
    } catch (err) {
      const elapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);
      log('ERROR', `${masked}: ${err.message} (${elapsed}s) — skipping this wallet`);
      errorCount++;
    } finally {
      groupEnd();
    }
  }

  // --- Phase 2: summary + write ---
  const okCount = wallets.length - errorCount;
  log('INFO', `${c.bold('Summary')} — ${c.green(okCount + ' ok')}, ${c.red(errorCount + ' failed')} | ` +
    `${totalRaw} raw → ${c.bold(totalFiltered)} non-scam rows`);

  const written = await writeToSheet(allRows);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('OK', `${c.bold('Sync completed')} in ${elapsed}s — ${written} rows written`);

  return { success: true, totalRaw, totalFiltered, written, errorCount };
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  try {
    const result = await processTransactions();
    log('OK', `Done — ${JSON.stringify(result)}`);
    // A partial failure (some wallets blocked) is still a successful run overall;
    // only a fatal error (thrown below) fails the workflow.
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
  parseRetryAfter,
  fmtDuration,
  mapTransactionToRow,
  maskAddr,
};

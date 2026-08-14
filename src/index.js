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
  JITTER_MIN_MS: parseInt(process.env.JITTER_MIN_MS || '2000', 10),
  JITTER_MAX_MS: parseInt(process.env.JITTER_MAX_MS || '5000', 10),
  RATE_LIMIT_WAIT_MS: parseInt(process.env.RATE_LIMIT_WAIT_MS || '60000', 10),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '10', 10),
  MAX_429_RETRIES: parseInt(process.env.MAX_429_RETRIES || '3', 10),
  MAX_TIMEOUT_RETRIES: parseInt(process.env.MAX_TIMEOUT_RETRIES || '5', 10),
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || '500', 10),
};

// API Headers to mimic browser
const API_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'sec-ch-ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
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
// LOGGING UTILITIES
// ============================================================================

function log(level, msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${msg}`);
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

class RateLimitManager {
  constructor() {
    this.requestCount = 0;
    this.lastResetTime = Date.now();
    this.throttleMs = RATE_LIMIT_CONFIG.JITTER_MIN_MS;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastResetTime;

    if (elapsed < this.throttleMs) {
      const waitMs = this.throttleMs - elapsed;
      log('DEBUG', `Rate limit: waiting ${waitMs}ms`);
      await sleep(waitMs);
    }

    this.lastResetTime = Date.now();
  }

  increaseThrottle() {
    const newThrottle = Math.min(
      this.throttleMs * 1.5,
      RATE_LIMIT_CONFIG.RATE_LIMIT_WAIT_MS
    );
    log('WARN', `Increasing throttle from ${this.throttleMs}ms to ${newThrottle}ms`);
    this.throttleMs = newThrottle;
  }

  resetThrottle() {
    this.throttleMs = RATE_LIMIT_CONFIG.JITTER_MIN_MS;
  }
}

// ============================================================================
// API FETCH FUNCTION
// ============================================================================

async function fetchTransactions(walletAddress, rateLimitMgr) {
  const url = `${RABBY_API_URL}?id=${walletAddress}`;
  let rateLimitRetries = 0;
  let timeoutRetries = 0;

  for (let attempt = 1; attempt <= RATE_LIMIT_CONFIG.MAX_RETRIES; attempt++) {
    try {
      await rateLimitMgr.wait();

      log('DEBUG', `Fetching ${maskAddr(walletAddress)} (attempt ${attempt}/${RATE_LIMIT_CONFIG.MAX_RETRIES})`);

      const response = await axios.get(url, {
        headers: API_HEADERS,
        timeout: 60000,
        httpsAgent: HTTPS_AGENT,
      });

      const body = response.data;
      const resultPayload = body?.result?.data;

      if (resultPayload && Array.isArray(resultPayload.history_list)) {
        rateLimitMgr.resetThrottle();
        return { payload: resultPayload, attempts: attempt };
      }

      // Job still pending
      if (body?.job) {
        log('DEBUG', `Job pending for ${maskAddr(walletAddress)}, waiting before retry...`);
        await jitterDelay(3000, 8000);
        continue;
      }

      log('WARN', `Unexpected response structure for ${maskAddr(walletAddress)}`);

    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        rateLimitRetries++;
        if (rateLimitRetries > RATE_LIMIT_CONFIG.MAX_429_RETRIES) {
          throw new Error(`429 Too Many Requests after ${RATE_LIMIT_CONFIG.MAX_429_RETRIES} retries`);
        }

        rateLimitMgr.increaseThrottle();
        const waitSec = Math.floor(RATE_LIMIT_CONFIG.RATE_LIMIT_WAIT_MS / 1000 + Math.random() * 30);
        log('WARN', `429 Rate limit for ${maskAddr(walletAddress)} (${rateLimitRetries}/${RATE_LIMIT_CONFIG.MAX_429_RETRIES}), waiting ${waitSec}s`);
        await sleep(waitSec * 1000);
        attempt--;
        continue;
      }

      if (status === 403) {
        const backoff = RATE_LIMIT_CONFIG.JITTER_MIN_MS * 2;
        log('WARN', `403 Forbidden for ${maskAddr(walletAddress)}, backing off ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' ||
                        err.message?.includes('timeout');

      if (isTimeout) {
        timeoutRetries++;
        if (timeoutRetries > RATE_LIMIT_CONFIG.MAX_TIMEOUT_RETRIES) {
          throw new Error(`Timeout after ${RATE_LIMIT_CONFIG.MAX_TIMEOUT_RETRIES} retries`);
        }

        const waitSec = 5 + Math.floor(Math.random() * 10);
        log('WARN', `Timeout for ${maskAddr(walletAddress)} (${timeoutRetries}/${RATE_LIMIT_CONFIG.MAX_TIMEOUT_RETRIES}), waiting ${waitSec}s`);
        await sleep(waitSec * 1000);
        attempt--;
        continue;
      }

      // Other errors
      throw new Error(`${err.message} (${err.code || 'UNKNOWN'})`);
    }

    await jitterDelay(
      RATE_LIMIT_CONFIG.JITTER_MIN_MS,
      RATE_LIMIT_CONFIG.JITTER_MAX_MS
    );
  }

  throw new Error(`Failed after ${RATE_LIMIT_CONFIG.MAX_RETRIES} retries`);
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

async function appendWithRetry(sheets, rows, chunkNum, totalChunks, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${GOOGLE_SHEET_NAME}!A2:AI`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: rows },
      }, {
        timeout: 60000,
      });
      return result;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Chunk ${chunkNum}/${totalChunks} failed after ${maxRetries} retries: ${err.message}`);
      }

      const waitSec = 5 * attempt;
      log('WARN', `Chunk ${chunkNum}/${totalChunks} retry ${attempt}/${maxRetries}, waiting ${waitSec}s`);
      await sleep(waitSec * 1000);
    }
  }
}

async function clearSheetWithRetry(sheets, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('INFO', `Clearing sheet ${GOOGLE_SHEET_NAME}...`);
      await sheets.spreadsheets.values.clear({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${GOOGLE_SHEET_NAME}!A2:AI`,
      }, {
        timeout: 30000,
      });
      log('INFO', `Sheet cleared successfully`);
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to clear sheet after ${maxRetries} retries: ${err.message}`);
      }
      const waitSec = 5 * attempt;
      log('WARN', `Clear failed, retry ${attempt}/${maxRetries}, waiting ${waitSec}s`);
      await sleep(waitSec * 1000);
    }
  }
}

async function safeClearAndWrite(rows) {
  if (rows.length === 0) {
    log('WARN', 'No data to write, skipping sheet update');
    return 0;
  }

  const totalRows = rows.length;
  const totalChunks = Math.ceil(rows.length / RATE_LIMIT_CONFIG.CHUNK_SIZE);

  log('INFO', `Authenticating with Google Sheets...`);
  const auth = await getGoogleAuth();

  const sheets = google.sheets({
    version: 'v4',
    auth,
    timeout: 60000,
  });

  await clearSheetWithRetry(sheets);

  const recordedAt = getCurrentTimestampTH();
  const rowsWithTimestamp = rows.map(row => {
    row[34] = recordedAt;
    return row;
  });

  log('INFO', `Writing ${totalRows} rows in ${totalChunks} chunks...`);

  let totalWritten = 0;

  for (let i = 0; i < rowsWithTimestamp.length; i += RATE_LIMIT_CONFIG.CHUNK_SIZE) {
    const chunk = rowsWithTimestamp.slice(i, i + RATE_LIMIT_CONFIG.CHUNK_SIZE);
    const chunkNum = Math.floor(i / RATE_LIMIT_CONFIG.CHUNK_SIZE) + 1;

    log('DEBUG', `Writing chunk ${chunkNum}/${totalChunks} (${chunk.length} rows)...`);

    const result = await appendWithRetry(sheets, chunk, chunkNum, totalChunks);
    const written = result.data.updates?.updatedRows || chunk.length;
    totalWritten += written;

    log('INFO', `Chunk ${chunkNum}/${totalChunks} complete (${written} rows)`);

    if (i + RATE_LIMIT_CONFIG.CHUNK_SIZE < rowsWithTimestamp.length) {
      await jitterDelay(500, 1500);
    }
  }

  log('INFO', `Successfully wrote ${totalWritten} rows`);
  return totalWritten;
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

  log('INFO', `Starting sync for ${wallets.length} wallet(s)`);

  const rateLimitMgr = new RateLimitManager();
  const allRows = [];
  let totalRaw = 0;
  let totalFiltered = 0;
  let errorCount = 0;

  // Fetch all wallets
  for (let i = 0; i < wallets.length; i++) {
    const walletStartTime = Date.now();
    const addr = wallets[i];
    const masked = maskAddr(addr);

    try {
      const { payload, attempts } = await fetchTransactions(addr, rateLimitMgr);
      const rawList = payload.history_list;

      if (!Array.isArray(rawList)) {
        log('ERROR', `${masked}: Unexpected response structure`);
        errorCount++;
        continue;
      }

      const filtered = rawList.filter((tx) => tx.is_scam === false);
      const elapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);

      log('INFO', `${masked}: ${filtered.length} txs (${rawList.length} raw, ${attempts} attempts, ${elapsed}s)`);

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
      log('ERROR', `${masked}: ${err.message} (${elapsed}s)`);
      errorCount++;
    }

    // Jitter between wallets
    if (i < wallets.length - 1) {
      await jitterDelay(
        RATE_LIMIT_CONFIG.JITTER_MIN_MS,
        RATE_LIMIT_CONFIG.JITTER_MAX_MS
      );
    }
  }

  // Summary
  log('INFO', `Summary: ${totalRaw} raw, ${totalFiltered} filtered, ${errorCount} errors`);

  // Write to sheets
  const written = await safeClearAndWrite(allRows);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('INFO', `Sync completed in ${elapsed}s, wrote ${written} rows`);

  return { success: true, totalRaw, totalFiltered, written, errorCount };
}

// ============================================================================
// ENTRY POINT
// ============================================================================

(async () => {
  try {
    const result = await processTransactions();
    log('INFO', `Exiting with success: ${JSON.stringify(result)}`);
    process.exit(0);
  } catch (err) {
    log('ERROR', `Fatal error: ${err.message}`);
    log('ERROR', err.stack || 'No stack trace');
    process.exit(1);
  }
})();

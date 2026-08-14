require('dotenv').config();

const axios = require('axios');
const chalk = require('chalk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Puppeteer with stealth for bypassing bot detection
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// --- Config ---
const RABBY_API_URL = 'https://api.rabby.io/v1/user/history_all_list';
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME;
const FETCH_INTERVAL_MS = (parseInt(process.env.FETCH_INTERVAL_MINUTES, 10) || 15) * 60 * 1000;
const LOCK_FILE = path.join(__dirname, '.bot.lock');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const WALLETS_PATH = path.join(__dirname, 'wallets.json');

// Request headers to mimic Microsoft Edge browser and reduce 403/429 rate-limits
const API_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'th,en-US;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'sec-ch-ua': '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
  'cookie': process.env.RABBY_COOKIE || '',
  'origin': 'https://rabby.io',
  'referer': 'https://rabby.io/',
};

// HTTPS Agent with Chrome-like ciphers to bypass TLS fingerprinting
// Added keepAlive to maintain connections across multiple wallet requests
const HTTPS_AGENT = new https.Agent({
  ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
  honorCipherOrder: true,
  minVersion: 'TLSv1.2',
  keepAlive: true,
  maxSockets: 5,
  maxFreeSockets: 5,
  timeout: 60000,
  freeSocketTimeout: 30000,
});
// ---------------------------------------------------------------------------
// Logging — "The Sleek Auditor" style
// ---------------------------------------------------------------------------
const DIVIDER = chalk.gray('────────────────────────────────────────────────────────────');

/** Get current time as HH:mm:ss in Bangkok timezone */
function timeTag() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return chalk.gray(`[${hh}:${mm}:${ss}]`);
}

/** Mask wallet address: 0x42a8...328e */
function maskAddr(addr) {
  if (!addr || addr.length < 10) return addr || null;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// --- Load Wallet Addresses ---
function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) {
    // Fallback: single wallet from .env for backward compatibility
    const single = process.env.RABBY_WALLET_ID;
    if (!single) throw new Error('No wallets configured. Create wallets.json or set RABBY_WALLET_ID in .env');
    return [single];
  }
  const raw = JSON.parse(fs.readFileSync(WALLETS_PATH, 'utf8'));
  // Support both ["0x..."] and { "wallets": ["0x..."] }
  const list = Array.isArray(raw) ? raw : raw.wallets;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('wallets.json must contain a non-empty array of wallet addresses.');
  }
  return list.map((addr) => addr.trim().toLowerCase()).filter(Boolean);
}

// --- Google Auth ---
function getGoogleAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Service account credentials not found at ${CREDENTIALS_PATH}`);
  }
  
  // Create a clean HTTPS agent without proxy interference
  const authAgent = new https.Agent({
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    keepAlive: false, // Disable keepAlive for auth to prevent stale connections
    maxSockets: 1,
    timeout: 120000, // 120 second timeout for auth requests
  });
  
  return new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    // Add timeout configuration for token requests
    clientOptions: {
      timeout: 120000, // 120 seconds for auth token requests
      agent: authAgent, // Use clean agent without proxy
    },
    // Ensure we get a fresh token each time
    forceRefreshOnFailure: true,
  });
}

/** Get fresh auth client with retry and longer delays */
async function getAuthClientWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Clear any potential proxy settings that might interfere
      const originalProxy = process.env.HTTP_PROXY;
      const originalHttpsProxy = process.env.HTTPS_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      
      const auth = getGoogleAuth();
      const client = await auth.getClient();
      
      // Restore proxy settings
      if (originalProxy) process.env.HTTP_PROXY = originalProxy;
      if (originalHttpsProxy) process.env.HTTPS_PROXY = originalHttpsProxy;
      
      // Verify the client can get a token with timeout
      const tokenPromise = client.getAccessToken();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Token request timeout')), 60000)
      );
      await Promise.race([tokenPromise, timeoutPromise]);
      
      console.log(chalk.gray(`   🔐 Google Auth: Authenticated successfully`));
      return client;
    } catch (err) {
      console.log(chalk.yellow(`   ⚠️  Auth failed (attempt ${attempt}/${maxRetries}): ${err.message}`));
      if (attempt === maxRetries) {
        throw new Error(`Failed to authenticate with Google after ${maxRetries} attempts: ${err.message}`);
      }
      // Random delay between 10-20 seconds before retry
      const delaySec = 10 + Math.floor(Math.random() * 11);
      console.log(chalk.gray(`   ⏳ Waiting ${delaySec}s before auth retry...`));
      await sleep(delaySec * 1000);
    }
  }
}

// --- Helpers ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random jitter delay between min and max (ms) */
function jitterDelay(minMs = 3000, maxMs = 5000) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

/** Longer random delay for pending status (5-15 seconds) */
function pendingDelay() {
  const delay = 5000 + Math.random() * 10000; // 5-15 seconds
  return sleep(delay);
}

/** Random delay for 429 rate limit (120-180 seconds) */
function rateLimitDelay() {
  const delay = 120000 + Math.random() * 60000; // 120-180 seconds
  return sleep(delay);
}

/** Safely access a value, returning null for null/undefined/''/[] */
function v(val) {
  if (val === null || val === undefined) return null;
  if (val === '') return null;
  if (Array.isArray(val) && val.length === 0) return null;
  return val;
}

/** Format Unix timestamp to 'MM/DD/YYYY HH:mm:ss' in GMT+7 (Asia/Bangkok) */
function formatDateTH(unixSeconds) {
  if (unixSeconds === null || unixSeconds === undefined || unixSeconds === 0) return null;
  // Shift UTC by +7 hours to get Bangkok time
  const d = new Date(unixSeconds * 1000 + 7 * 3600 * 1000);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const YYYY = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${MM}/${DD}/${YYYY} ${hh}:${mm}:${ss}`;
}

/** Get current timestamp in 'MM/DD/YYYY HH:mm:ss' format for GMT+7 (Asia/Bangkok) */
function getCurrentTimestampTH() {
  // Shift UTC by +7 hours to get Bangkok time
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const YYYY = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${MM}/${DD}/${YYYY} ${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Data Fetching — with job polling, 429 retry, and browser-like headers
// ---------------------------------------------------------------------------
// Rabby API response: { result: { data: { history_list, ... } }, job: null|{...} }
// Rate-limit strategy:
//   - 403: exponential backoff (delayMs * 2), counted in normal retry loop
//   - 429: hard wait 60s, up to 3 retries, then skip wallet
async function fetchTransactions(walletAddress, maxRetries = 10, delayMs = 5000) {
  const url = `${RABBY_API_URL}?id=${walletAddress}`;
  let rateLimitRetries = 0;
  let timeoutRetries = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;
  const MAX_TIMEOUT_RETRIES = 5;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: API_HEADERS,
        timeout: 60000, // Increased to 60 seconds for large wallets
        httpsAgent: HTTPS_AGENT,
      });

      const body = response.data;
      const resultPayload = body?.result?.data;

      if (resultPayload && Array.isArray(resultPayload.history_list)) {
        return { payload: resultPayload, attempts: attempt };
      }

      // Job is still pending (body.job is non-null)
      if (body?.job) {
        console.log(chalk.gray(`       ⏳ Pending (attempt ${attempt}/${maxRetries}), waiting 5-15s before retry...`));
        await pendingDelay(); // Random 5-15s delay to appear more human-like
        continue; // Skip the normal delay at the end of the loop
      } else {
        console.log(chalk.gray(`       ⚠  Unexpected structure (attempt ${attempt}/${maxRetries})`));
      }
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        rateLimitRetries++;
        if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
          throw new Error(`429 Too Many Requests — gave up after ${MAX_RATE_LIMIT_RETRIES} retries`);
        }
        const waitSec = Math.floor(120 + Math.random() * 60);
        console.log(chalk.yellow(`       🚫 429 Rate-limited (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), waiting ${waitSec}s...`));
        await rateLimitDelay();
        attempt--; // don't count 429 waits against normal retry budget
        continue;
      }

      if (status === 403) {
        const backoff = delayMs * 2;
        console.log(chalk.yellow(`       🚫 403 Forbidden (attempt ${attempt}/${maxRetries}), backing off ${backoff}ms...`));
        await sleep(backoff);
        continue;
      }

      // Handle timeout errors with separate retry logic
      const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' || 
                        err.code === 'REQ_TIMEOUT' || err.message?.includes('timeout');
      
      if (isTimeout) {
        timeoutRetries++;
        if (timeoutRetries > MAX_TIMEOUT_RETRIES) {
          throw new Error(`Connection timeout [code: ${err.code || 'UNKNOWN'}] — gave up after ${MAX_TIMEOUT_RETRIES} retries`);
        }
        const waitSec = Math.floor(5 + Math.random() * 5); // 5-10 seconds
        console.log(chalk.yellow(`       ⏱️ Timeout reached [code: ${err.code || 'UNKNOWN'}] (timeout retry ${timeoutRetries}/${MAX_TIMEOUT_RETRIES}), waiting ${waitSec}s...`));
        await sleep(waitSec * 1000);
        attempt--; // Don't count timeout retries against normal retry budget
        continue;
      }

      // Detailed error classification for non-HTTP errors
      let errorDetail = '';
      if (err.code === 'ECONNREFUSED') errorDetail = 'Connection refused';
      else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') errorDetail = 'DNS lookup failed';
      else if (err.code === 'EPROTO' || err.code?.includes('SSL') || err.code?.includes('TLS')) errorDetail = 'SSL/TLS handshake failed';
      else if (err.code) errorDetail = `Network error (${err.code})`;
      
      // Build detailed error message with code
      let detailedMessage = err.message || 'Unknown error';
      if (errorDetail) detailedMessage = `${errorDetail} [code: ${err.code || 'N/A'}]: ${detailedMessage}`;
      else if (err.code) detailedMessage = `[code: ${err.code}]: ${detailedMessage}`;
      
      const enhancedError = new Error(detailedMessage);
      enhancedError.originalError = err;
      enhancedError.status = status;
      enhancedError.code = err.code;
      enhancedError.responseData = err.response?.data;
      throw enhancedError;
    }

    await sleep(delayMs);
  }

  throw new Error(`Job still pending after ${maxRetries} retries.`);
}

// ---------------------------------------------------------------------------
// Data Mapping — flatten Rabby transaction JSON to a 35-column row (A:AI)
// ---------------------------------------------------------------------------
// Column mapping (matches Google Sheets header A1:AI1):
//   A: cate_id           B: cex_id            C: chain             D: id
//   E: idx               F: is_scam           G: other_addr        H: project_id
//   I: receives amount   J: receives from_addr K: receives price   L: receives token_id
//   M: sends amount      N: sends price       O: sends to_addr     P: sends token_id
//   Q: time_at           R: token_approve     S: spender           T: token_id
//   U: value             V: tx                W: eth_gas_fee       X: from_addr
//   Y: id                Z: idx               AA: message          AB: name
//   AC: params           AD: selector         AE: status           AF: to_addr
//   AG: usd_gas_fee      AH: value            AI: recorded_at
// ---------------------------------------------------------------------------
function mapTransactionToRow(tx, walletAddr = 'unknown') {
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

    // Use optional chaining with nullish coalescing for nested array data
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
    const tx_params = inner?.params != null ? JSON.stringify(inner.params) : null;
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
      null, // Column AI (index 34) - recorded_at will be filled during write
    ];
  } catch (err) {
    // Identify which field caused the error
    const errorField = err.message?.includes('time_at') ? 'time_at' : 
                       err.message?.includes('params') ? 'tx.params' : 
                       err.message?.includes('receives') ? 'receives[0]' :
                       err.message?.includes('sends') ? 'sends[0]' :
                       err.message?.includes('token_approve') ? 'token_approve' :
                       err.message?.includes('tx') ? 'tx' : 'unknown field';
    
    const enhancedError = new Error(`Mapping failed for wallet ${maskAddr(walletAddr)}, field: ${errorField} - ${err.message}`);
    enhancedError.originalError = err;
    enhancedError.walletAddr = walletAddr;
    enhancedError.field = errorField;
    enhancedError.txData = JSON.stringify(tx).substring(0, 500); // First 500 chars for debugging
    throw enhancedError;
  }
}

// ---------------------------------------------------------------------------
// Google Sheets — Safe-Write with Chunking using Append
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 500; // Write 500 rows at a time to avoid rate limits

/** Append rows with enhanced retry logic and re-auth on token errors */
async function appendWithRetry(sheets, rows, chunkNum, totalChunks, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2:AI`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: rows },
      }, {
        timeout: 60000, // 60 second timeout for each API call
      });
      return result;
    } catch (err) {
      const isAuthError = err.message?.includes('token') || err.message?.includes('auth') || 
                         err.message?.includes('credentials') || err.code === 401 || err.code === 403;
      
      if (attempt === maxRetries) {
        throw new Error(`Failed to append chunk ${chunkNum}/${totalChunks} after ${maxRetries} retries: ${err.message}`);
      }
      
      const waitSec = 5 * attempt;
      if (isAuthError) {
        console.log(chalk.yellow(`   ⚠️  Chunk ${chunkNum}/${totalChunks} auth error (attempt ${attempt}/${maxRetries}), retrying in ${waitSec}s...`));
      } else {
        console.log(chalk.yellow(`   ⚠️  Chunk ${chunkNum}/${totalChunks} failed (attempt ${attempt}/${maxRetries}), retrying in ${waitSec}s...`));
      }
      await sleep(waitSec * 1000);
    }
  }
}

/** Clear sheet with retry */
async function clearSheetWithRetry(sheets, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(chalk.yellow(`   🧹 Google Sheets: Clearing A2:AI...`));
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2:AI`,
      }, {
        timeout: 30000, // 30 second timeout for clear
      });
      console.log(chalk.green(`   ✅ Sheet cleared successfully.`));
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to clear sheet after ${maxRetries} retries: ${err.message}`);
      }
      console.log(chalk.yellow(`   ⚠️  Clear failed (attempt ${attempt}/${maxRetries}), retrying in ${5 * attempt}s...`));
      await sleep(5000 * attempt);
    }
  }
}

/** Clear sheet and write data in chunks using append with full retry support */
async function safeClearAndWrite(rows) {
  const totalRows = rows.length;
  const totalChunks = Math.ceil(rows.length / CHUNK_SIZE);
  
  // Step 1: Get fresh auth (right before writing to ensure token is fresh)
  console.log(chalk.cyan(`   🔐 Authenticating with Google Sheets...`));
  const auth = await getAuthClientWithRetry();
  
  const sheets = google.sheets({ 
    version: 'v4', 
    auth,
    timeout: 60000, // Global timeout for this sheets client
  });

  // Step 2: Clear the sheet with retry
  await clearSheetWithRetry(sheets);

  // Step 3: Write data in chunks using append
  if (totalRows === 0) {
    console.log(chalk.yellow(`   ⚠️ No data to write.`));
    return 0;
  }

  // Generate timestamp for this write operation (same for all rows)
  const recordedAt = getCurrentTimestampTH();
  
  // Add recorded_at to all rows (column AI - index 34)
  const rowsWithTimestamp = rows.map(row => {
    row[34] = recordedAt; // Fill column AI with timestamp
    return row;
  });
  
  console.log(chalk.cyan(`   📦 Writing ${totalRows} rows in ${totalChunks} chunks (chunk size: ${CHUNK_SIZE}, recorded_at: ${recordedAt})...`));
  
  let totalWritten = 0;
  
  for (let i = 0; i < rowsWithTimestamp.length; i += CHUNK_SIZE) {
    const chunk = rowsWithTimestamp.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    
    console.log(chalk.gray(`   📝 Writing chunk ${chunkNum}/${totalChunks} (${chunk.length} rows, recorded_at: ${recordedAt})...`));
    
    try {
      const result = await appendWithRetry(sheets, chunk, chunkNum, totalChunks);
      const written = result.data.updates?.updatedRows || chunk.length;
      totalWritten += written;
      
      console.log(chalk.green(`      ✓ Chunk ${chunkNum}/${totalChunks} complete (${written} rows)`));
    } catch (err) {
      console.log(chalk.red(`   ❌ Chunk ${chunkNum}/${totalChunks} failed: ${err.message}`));
      
      // Try to re-authenticate and retry this chunk once more
      if (err.message?.includes('token') || err.message?.includes('auth')) {
        console.log(chalk.yellow(`   🔄 Re-authenticating and retrying chunk ${chunkNum}...`));
        try {
          const freshAuth = await getAuthClientWithRetry(2);
          const freshSheets = google.sheets({ version: 'v4', auth: freshAuth, timeout: 60000 });
          const result = await appendWithRetry(freshSheets, chunk, chunkNum, totalChunks, 2);
          const written = result.data.updates?.updatedRows || chunk.length;
          totalWritten += written;
          console.log(chalk.green(`      ✓ Chunk ${chunkNum}/${totalChunks} complete after re-auth (${written} rows)`));
        } catch (retryErr) {
          console.log(chalk.red(`      ❌ Chunk ${chunkNum} failed even after re-auth: ${retryErr.message}`));
          throw retryErr; // Fail the entire operation
        }
      } else {
        throw err; // Non-auth error, fail immediately
      }
    }
    
    // Throttle: 1-2 second delay between chunks to avoid rate limits
    if (i + CHUNK_SIZE < rowsWithTimestamp.length) {
      const delayMs = 1000 + Math.floor(Math.random() * 1000); // 1-2 seconds
      await sleep(delayMs);
    }
  }
  
  console.log(chalk.green(`   📝 Google Sheets: Wrote ${chalk.bold(totalWritten)} rows successfully (${totalChunks} chunks).`));
  return totalWritten;
}

// ---------------------------------------------------------------------------
// Main Processing — multi-wallet loop with jitter delay & safe-write
// ---------------------------------------------------------------------------
let isSyncing = false;

async function processTransactions() {
  // Prevent overlap: check if previous sync is still running
  if (isSyncing) {
    console.log(`${timeTag()} ${chalk.yellow('⚠️ Previous sync still running, skipping this interval...')}`);
    return;
  }
  
  isSyncing = true;
  const startTime = Date.now();

  try {
    const wallets = loadWallets();
    const intervalMins = FETCH_INTERVAL_MS / 60000;

    console.log('');
    console.log(`${timeTag()} ${chalk.bold.cyan(`🚀 STARTING TRANSACTION SYNC (${wallets.length} Wallets)`)}`);
    console.log('');

    const allRows = [];
    let totalRaw = 0;
    let totalFiltered = 0;
    let errorCount = 0;

    // --- Phase 1: Fetch all wallets ---
    const walletStartTimes = [];
    
    for (let i = 0; i < wallets.length; i++) {
      const walletStartTime = Date.now();
      const addr = wallets[i];
      const masked = maskAddr(addr);
      const idxLabel = chalk.blue(`[${i + 1}/${wallets.length}]`);
      const walletLabel = chalk.magenta(masked);

      try {
        const { payload, attempts } = await fetchTransactions(addr);
        const rawList = payload.history_list;

        if (!Array.isArray(rawList)) {
          console.log(`   ${idxLabel} 🛰️  FETCHING: ${walletLabel} | ${chalk.red('Unexpected structure, skipped')}`);
          errorCount++;
          walletStartTimes.push(Date.now() - walletStartTime);
          continue;
        }

        const filtered = rawList.filter((tx) => tx.is_scam === false);
        const txCount = chalk.yellow(`${filtered.length} txs`);
        const walletElapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);
        
        // Calculate ETA based on average time per wallet
        walletStartTimes.push(Date.now() - walletStartTime);
        const avgTimePerWallet = walletStartTimes.reduce((a, b) => a + b, 0) / walletStartTimes.length;
        const remainingWallets = wallets.length - i - 1;
        const etaSec = Math.round((avgTimePerWallet * remainingWallets) / 1000);
        const etaStr = remainingWallets > 0 ? chalk.gray(` | ETA: ~${etaSec}s`) : '';

        console.log(`   ${idxLabel} 🛰️  FETCHING: ${walletLabel} | Attempts: ${chalk.gray(attempts)} | Result: ${txCount} | ${chalk.cyan(`${walletElapsed}s`)}${etaStr}`);

        totalRaw += rawList.length;
        totalFiltered += filtered.length;

        for (const tx of filtered) {
          try {
            allRows.push(mapTransactionToRow(tx, addr));
          } catch (mapErr) {
            console.log(chalk.red(`       ⚠️  Mapping error for tx ${tx.id || 'unknown'}: ${mapErr.message}`));
            // Continue with other transactions, don't fail the entire wallet
          }
        }
      } catch (err) {
        const walletElapsed = ((Date.now() - walletStartTime) / 1000).toFixed(1);
        
        // Build detailed error message
        let errorMsg = '';
        let errorDetail = '';
        
        if (err.response) {
          // HTTP error with response
          const status = err.response.status;
          const data = err.response.data;
          const dataStr = data ? JSON.stringify(data).substring(0, 200) : 'No data';
          
          if (status === 403) errorMsg = `403 Forbidden (Invalid Cookie/Auth)`;
          else if (status === 401) errorMsg = `401 Unauthorized (Invalid Credentials)`;
          else if (status === 429) errorMsg = `429 Rate Limited`;
          else if (status === 500) errorMsg = `500 Server Error`;
          else if (status === 502) errorMsg = `502 Bad Gateway`;
          else if (status === 503) errorMsg = `503 Service Unavailable`;
          else errorMsg = `HTTP ${status}`;
          
          errorDetail = ` | Response: ${dataStr}`;
        } else if (err.request) {
          // Network error - no response received
          if (err.code === 'ECONNREFUSED') errorMsg = 'Connection Refused (Server down)';
          else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') errorMsg = 'Connection Timeout';
          else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') errorMsg = 'DNS Lookup Failed';
          else if (err.code?.includes('SSL') || err.code?.includes('TLS') || err.code === 'EPROTO') errorMsg = 'SSL/TLS Handshake Failed';
          else if (err.code) errorMsg = `Network Error (${err.code})`;
          else errorMsg = 'Network Error (No response)';
        } else {
          // Other errors (parsing, mapping, etc.)
          errorMsg = err.message || 'Unknown error';
        }
        
        // Log full error details to console for debugging
        console.log(chalk.gray(`       Debug: ${err.stack || err.message || 'No stack trace'}`));
        
        console.log(`   ${idxLabel} 🛰️  FETCHING: ${walletLabel} | ${chalk.red(`❌ ${errorMsg}`)}${errorDetail ? chalk.gray(errorDetail) : ''} | ${chalk.cyan(`${walletElapsed}s`)}`);
        errorCount++;
        walletStartTimes.push(Date.now() - walletStartTime);
      }

      // Jitter delay between wallets (3–5s) to avoid rate-limiting
      if (i < wallets.length - 1) {
        await jitterDelay(3000, 5000);
      }
    }

    // --- Phase 2: Summary & Safe-Write ---
    console.log('');
    console.log(DIVIDER);
    console.log('');
    console.log(`   ${chalk.bgGreen.black.bold(' SUMMARY ')}`);
    console.log(`   📊 Total Raw: ${chalk.white.bold(totalRaw)} | ✅ Non-Scam: ${chalk.green.bold(totalFiltered)} | ❌ Errors: ${chalk.red.bold(errorCount)}`);

    // Safe-Write guard: NEVER clear the sheet if there's no data to write
    if (allRows.length === 0) {
      console.log(chalk.red.bold(`   🛑 Sheet Update: SKIPPED — no data fetched, sheet preserved.`));
    } else {
      // Note: Auth happens inside safeClearAndWrite to ensure fresh token
      await safeClearAndWrite(allRows);
      console.log(chalk.green.bold(`   ✅ Sheet Update: SUCCESS`));
    }

    // Execution time
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(chalk.cyan(`   ✨ Sync Completed in ${chalk.bold(elapsed + 's')}`));
    console.log(DIVIDER);
    console.log('');
    return { success: true, error: null };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(DIVIDER);
    console.log(chalk.red(`   ❌ Fatal error after ${elapsed}s: ${err.message}`));
    if (err.response) {
      console.log(chalk.red(`      Status: ${err.response.status}`));
    }
    console.log(DIVIDER);
    console.log('');
    return { success: false, error: err };
  } finally {
    isSyncing = false; // Release the lock
  }
}

// ---------------------------------------------------------------------------
// Lock File Management — prevent multiple instances
// ---------------------------------------------------------------------------
function createLockFile() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    console.log(chalk.red.bold(`   ❌ Lock file detected (PID: ${pid})! Another instance might be running.`));
    process.exit(1);
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());
}

function removeLockFile() {
  if (fs.existsSync(LOCK_FILE)) {
    fs.unlinkSync(LOCK_FILE);
    console.log(chalk.gray('   🔓 Lock file removed.'));
  }
}

// ---------------------------------------------------------------------------
// Graceful Shutdown — Single Job Mode
// ---------------------------------------------------------------------------
function shutdown(signal, exitCode = 0) {
  console.log('');
  console.log(DIVIDER);
  console.log(chalk.yellow.bold(`   ⚠️  Bot is shutting down gracefully... (${signal})`));
  console.log(DIVIDER);
  console.log('');
  removeLockFile();
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('uncaughtException', (err) => {
  console.error(chalk.red('Uncaught Exception:'), err);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('Unhandled Rejection at:'), promise, 'reason:', reason);
  shutdown('unhandledRejection', 1);
});

// ---------------------------------------------------------------------------
// Puppeteer Fetch — Bypass 403 with headless browser
// ---------------------------------------------------------------------------
/** Fetch transaction data using Puppeteer to bypass 403 errors */
async function fetchWithPuppeteer(walletAddress, headless = true) {
  const url = `${RABBY_API_URL}?id=${walletAddress}`;
  let browser = null;
  
  console.log(chalk.gray(`   🤖 Puppeteer: Launching browser (headless: ${headless})...`));
  
  try {
    browser = await puppeteer.launch({
      headless: headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
      ],
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
    });

    const page = await browser.newPage();
    
    // Set user agent to appear as regular Chrome browser
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0'
    );
    
    // Set extra headers to mimic real browser
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'th,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });

    console.log(chalk.gray(`   🌐 Puppeteer: Navigating to API...`));
    
    // Navigate to the URL
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    console.log(chalk.gray(`   👀 Puppeteer: Waiting for API response...`));
    
    // Wait for the specific API response
    const response = await page.waitForResponse(
      (response) => {
        const requestUrl = response.url();
        return requestUrl.includes('/v1/user/history_all_list') && response.status() === 200;
      },
      { timeout: 30000 }
    );

    console.log(chalk.gray(`   📥 Puppeteer: Capturing JSON response...`));
    
    // Extract JSON data from response
    const responseBody = await response.text();
    const data = JSON.parse(responseBody);
    
    // Check if there's a pending job
    if (data?.job) {
      console.log(chalk.yellow(`   ⏳ Puppeteer: Job pending, waiting 10s before retry...`));
      await new Promise(r => setTimeout(r, 10000));
      
      // Refresh and wait again
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
      
      const retryResponse = await page.waitForResponse(
        (response) => {
          const requestUrl = response.url();
          return requestUrl.includes('/v1/user/history_all_list') && response.status() === 200;
        },
        { timeout: 30000 }
      );
      
      const retryBody = await retryResponse.text();
      const retryData = JSON.parse(retryBody);
      
      if (retryData?.job) {
        throw new Error('Job still pending after retry');
      }
      
      return retryData;
    }
    
    console.log(chalk.green(`   ✓ Puppeteer: Successfully fetched data`));
    return data;
    
  } catch (err) {
    console.log(chalk.red(`   ❌ Puppeteer: ${err.message}`));
    throw err;
  } finally {
    if (browser) {
      await browser.close();
      console.log(chalk.gray(`   🔒 Puppeteer: Browser closed`));
    }
  }
}

// ---------------------------------------------------------------------------
// Manual Retry Mode — Append single wallet data without clearing sheet
// ---------------------------------------------------------------------------
/** Append rows to sheet without clearing (for manual retry mode) */
async function appendRowsToSheet(rows) {
  if (rows.length === 0) {
    console.log(chalk.yellow(`   ⚠️ No data to append.`));
    return 0;
  }

  const totalRows = rows.length;
  const totalChunks = Math.ceil(rows.length / CHUNK_SIZE);
  
  // Generate timestamp for this write operation
  const recordedAt = getCurrentTimestampTH();
  
  // Add recorded_at to all rows (column AI - index 34)
  const rowsWithTimestamp = rows.map(row => {
    row[34] = recordedAt;
    return row;
  });
  
  // Step 1: Get fresh auth
  console.log(chalk.cyan(`   🔐 Authenticating with Google Sheets...`));
  const auth = await getAuthClientWithRetry();
  
  const sheets = google.sheets({ 
    version: 'v4', 
    auth,
    timeout: 60000,
  });

  console.log(chalk.cyan(`   📦 Appending ${totalRows} rows in ${totalChunks} chunks (recorded_at: ${recordedAt})...`));
  
  let totalWritten = 0;
  
  for (let i = 0; i < rowsWithTimestamp.length; i += CHUNK_SIZE) {
    const chunk = rowsWithTimestamp.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    
    console.log(chalk.gray(`   📝 Appending chunk ${chunkNum}/${totalChunks} (${chunk.length} rows)...`));
    
    try {
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2:AI`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: chunk },
      }, {
        timeout: 60000,
      });
      
      const written = result.data.updates?.updatedRows || chunk.length;
      totalWritten += written;
      
      console.log(chalk.green(`      ✓ Chunk ${chunkNum}/${totalChunks} appended (${written} rows)`));
    } catch (err) {
      console.log(chalk.red(`   ❌ Chunk ${chunkNum}/${totalChunks} failed: ${err.message}`));
      
      // Try to re-authenticate and retry this chunk once more
      if (err.message?.includes('token') || err.message?.includes('auth')) {
        console.log(chalk.yellow(`   🔄 Re-authenticating and retrying chunk ${chunkNum}...`));
        try {
          const freshAuth = await getAuthClientWithRetry(2);
          const freshSheets = google.sheets({ version: 'v4', auth: freshAuth, timeout: 60000 });
          const result = await freshSheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:AI`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: { values: chunk },
          }, { timeout: 60000 });
          const written = result.data.updates?.updatedRows || chunk.length;
          totalWritten += written;
          console.log(chalk.green(`      ✓ Chunk ${chunkNum}/${totalChunks} appended after re-auth (${written} rows)`));
        } catch (retryErr) {
          console.log(chalk.red(`      ❌ Chunk ${chunkNum} failed even after re-auth: ${retryErr.message}`));
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
    
    // Throttle between chunks
    if (i + CHUNK_SIZE < rowsWithTimestamp.length) {
      await sleep(1000 + Math.floor(Math.random() * 1000));
    }
  }
  
  console.log(chalk.green(`   📝 Google Sheets: Appended ${chalk.bold(totalWritten)} rows successfully (${totalChunks} chunks).`));
  return totalWritten;
}

/** Run manual retry mode for a single wallet */
async function runManualMode(walletAddress) {
  createLockFile();
  
  const normalizedAddress = walletAddress.trim().toLowerCase();
  
  console.log('');
  console.log(DIVIDER);
  console.log(chalk.bold.magenta('   🛠️ MANUAL RETRY MODE'));
  console.log(chalk.gray(`   Wallet:     ${chalk.white(normalizedAddress)}`));
  console.log(chalk.gray(`   Sheet:      ${chalk.white(SPREADSHEET_ID)}`));
  console.log(chalk.gray(`   Mode:       ${chalk.magenta('Append Only (No Clear)')}`));
  console.log(chalk.gray(`   PID:        ${chalk.white(process.pid)}`));
  console.log(DIVIDER);
  console.log('');
  console.log(chalk.magenta(`   🛠️ MANUAL RETRY MODE: Processing ${maskAddr(normalizedAddress)}...`));
  console.log('');

  const startTime = Date.now();
  let allRows = [];
  
  try {
    // Fetch data for single wallet
    console.log(`   ${chalk.blue('[1/1]')} 🛰️  FETCHING: ${chalk.magenta(maskAddr(normalizedAddress))}...`);
    
    try {
      let data;
      let fetchMethod = 'axios';
      let attempts = 1;
      
      // Try axios first, fallback to Puppeteer on 403
      try {
        const result = await fetchTransactions(normalizedAddress);
        data = result.payload;
        attempts = result.attempts;
      } catch (axiosErr) {
        if (axiosErr.response?.status === 403 || axiosErr.message?.includes('403')) {
          console.log(chalk.yellow(`      ⚠️  Axios got 403, switching to Puppeteer...`));
          const puppeteerData = await fetchWithPuppeteer(normalizedAddress, true);
          data = puppeteerData?.result?.data;
          fetchMethod = 'puppeteer';
          attempts = 1;
        } else {
          throw axiosErr;
        }
      }
      
      const rawList = data?.history_list;

      if (!Array.isArray(rawList)) {
        console.log(`   ${chalk.red('❌ Unexpected structure, aborting')}`);
        removeLockFile();
        process.exit(1);
      }

      const filtered = rawList.filter((tx) => tx.is_scam === false);
      
      console.log(`      ✓ Fetched: ${chalk.yellow(rawList.length)} raw | ${chalk.green(filtered.length)} non-scam | Method: ${chalk.cyan(fetchMethod)} | Attempts: ${chalk.gray(attempts)}`);

      for (const tx of filtered) {
        allRows.push(mapTransactionToRow(tx, normalizedAddress));
      }
      
    } catch (err) {
      let errorMsg = 'Fetch failed';
      let errorDetail = '';
      
      if (err.response) {
        const status = err.response.status;
        errorMsg = `HTTP ${status}`;
        if (status === 403) errorDetail = ' (Forbidden/Rate limit)';
        else if (status === 429) errorDetail = ' (Too many requests)';
        else if (status >= 500) errorDetail = ' (Server error)';
      } else if (err.code) {
        errorMsg = `${err.code}`;
        if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') errorDetail = ' (Timeout)';
        else if (err.code === 'ECONNREFUSED') errorDetail = ' (Connection refused)';
        else if (err.code === 'ENOTFOUND') errorDetail = ' (DNS failed)';
      } else {
        errorMsg = err.message || 'Unknown error';
      }
      
      console.log(chalk.red(`   ❌ ${errorMsg}${errorDetail}`));
      console.log(chalk.gray(`      Debug: ${err.stack || err.message}`));
      removeLockFile();
      process.exit(1);
    }

    // Append to Google Sheets (NO CLEAR)
    console.log('');
    console.log(DIVIDER);
    console.log('');
    
    if (allRows.length === 0) {
      console.log(chalk.yellow(`   ⚠️ No data to append.`));
    } else {
      console.log(`   ${chalk.bgGreen.black.bold(' APPEND MODE ')}`);
      console.log(`   📊 Non-Scam Transactions: ${chalk.green.bold(allRows.length)}`);
      console.log(`   📝 Action: Append to end of sheet (NO CLEAR)`);
      console.log('');
      
      const written = await appendRowsToSheet(allRows);
      
      console.log('');
      console.log(chalk.green.bold(`   ✅ Appended ${written} rows successfully`));
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(chalk.cyan(`   ✨ Manual Retry Completed in ${chalk.bold(elapsed + 's')}`));
    console.log(DIVIDER);
    console.log('');
    
    removeLockFile();
    process.exit(0);
    
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(DIVIDER);
    console.log(chalk.red(`   ❌ Fatal error after ${elapsed}s: ${err.message}`));
    console.log(DIVIDER);
    console.log('');
    removeLockFile();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Single Job Runner — Run once and exit
// ---------------------------------------------------------------------------
/** Run single job and exit */
async function runSingleJob() {
  createLockFile();
  
  const wallets = loadWallets();

  console.log('');
  console.log(DIVIDER);
  console.log(chalk.bold.cyan('   🔗 Crypto Transaction Tracker'));
  console.log(chalk.gray(`   Wallets:    ${chalk.white(wallets.length)} address(es)`));
  console.log(chalk.gray(`   Sheet:      ${chalk.white(SPREADSHEET_ID)}`));
  console.log(chalk.gray(`   Delay:      ${chalk.white('3–5s')} jitter between wallets`));
  console.log(chalk.gray(`   429 Backoff: ${chalk.white('120-180s')} random delay`));
  console.log(chalk.gray(`   Mode:       ${chalk.cyan('Single Job (Run & Exit)')}`));
  console.log(chalk.gray(`   PID:        ${chalk.white(process.pid)}`));
  console.log(DIVIDER);

  try {
    const result = await processTransactions();
    
    if (result.success) {
      console.log(chalk.green.bold('   ✅ Job completed successfully. Exiting...'));
      removeLockFile();
      process.exit(0);
    } else {
      console.log(chalk.red.bold('   ❌ Job failed. Exiting with error...'));
      removeLockFile();
      process.exit(1);
    }
  } catch (err) {
    console.error(chalk.red('Unexpected error:'), err);
    removeLockFile();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry Point — Check for manual mode argument
// ---------------------------------------------------------------------------
const manualWalletArg = process.argv[2];

if (manualWalletArg && manualWalletArg.startsWith('0x') && manualWalletArg.length === 42) {
  // Manual Retry Mode
  runManualMode(manualWalletArg);
} else if (manualWalletArg) {
  // Invalid argument
  console.error(chalk.red(`   ❌ Invalid wallet address: ${manualWalletArg}`));
  console.error(chalk.gray(`      Expected format: 0x... (42 characters)`));
  process.exit(1);
} else {
  // Normal Single Job Mode
  runSingleJob();
}

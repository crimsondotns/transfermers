/**
 * Solana side of the tracker.
 *
 * Two endpoints, both plain public GETs with no authentication, so unlike the
 * EVM side there is no hourly token to keep alive and a scheduled run needs no
 * babysitting:
 *
 *   SOL_TRANSFERS_API_URL/<address>   SPL + native transfers in and out
 *   SOL_SWAPS_API_URL/<address>       AMM trades
 *
 * Like HISTORY_API_URL, both are configuration rather than source: there is no
 * fallback here, so the repository does not name the services it calls.
 *
 * The feeds do not overlap — measured on a real wallet, 0 of 50 swaps shared a
 * txHash with any of its 30 transfers — so both are fetched and neither is
 * filtered against the other.
 *
 * Rows land in their own tab with their own columns (SOL_SCHEMA). Everything
 * downstream of the mapping is shared with the EVM side: the merge that cannot
 * lose a row, the batch tabs, their consolidation, the grid growing and
 * trimming. Those took three PRs to get right and are not worth re-deriving.
 */

const axios = require('axios');
const idx = require('./index.js');

const {
  log, c, sleep, jitterDelay, fmtDuration, withRetry, makeSchema,
  RATE_LIMIT_CONFIG: cfg, DeadlineError, BudgetError, BlockedError,
  parseRetryAfter, fetchBudgetRemainingMs, RateLimitManager,
  loadAllWallets, sliceForBatch, rotateWallets, resolveBatch, resolveSheetName,
  writeToSheet, consolidateBatches, rawCell, rawDigest, parseDateTH,
  formatDateTH, maskAddr, addrFingerprint, API_HEADERS, HTTPS_AGENT,
} = idx;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const TRANSFERS_URL = (process.env.SOL_TRANSFERS_API_URL || '').replace(/\/+$/, '');
const SWAPS_URL = (process.env.SOL_SWAPS_API_URL || '').replace(/\/+$/, '');

/**
 * Cursor parameter names.
 *
 * The transfers feed answers with `next` (a unix timestamp: on a real response
 * it was 1781087567, three minutes before the oldest row returned — i.e. where
 * the following page starts). The swaps feed answers with `hasMoreData: true`
 * and NO cursor at all, so the page-2 parameter cannot be read off the response.
 *
 * Both names are therefore configurable, and requestPage detects a parameter the
 * server ignored (page 2 identical to page 1) and stops instead of looping.
 */
const TRANSFERS_CURSOR_PARAM = process.env.SOL_TRANSFERS_CURSOR_PARAM || 'next';
const SWAPS_CURSOR_PARAM = process.env.SOL_SWAPS_CURSOR_PARAM || 'offset';

/** Wrapped-SOL mint, which the feeds use for native SOL as well. */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ---------------------------------------------------------------------------
// Sheet schema
// ---------------------------------------------------------------------------
// A transfer and a swap share one tab because they are the same question —
// "what moved, and which way?" — and a swap is simply a row with both sides
// filled, exactly as an EVM swap fills send_* and recv_* on one row.
//
// The EVM columns are NOT reused: there is no gas price in ETH, no approve, no
// project_id, and a mint address is not an ERC-20 contract. Forcing Solana into
// them would leave a third of the sheet blank and mislabel the rest.

const SOL_HEADER = [
  'kind',           // 0  transfer | swap
  'chain',          // 1  always "solana"
  'tx_hash',        // 2
  'block_id',       // 3  slot (transfers only)
  'block_time',     // 4  MM/DD/YYYY HH:mm:ss, same format as the EVM tab
  'direction',      // 5  in | out | self | swap
  'counterparty',   // 6  the other side of a transfer
  'from_address',   // 7
  'to_address',     // 8
  'send_amount',    // 9  out leg: transfer amount, or the swap's input
  'send_asset',     // 10 mint
  'recv_amount',    // 11 in leg
  'recv_asset',     // 12 mint
  'amount_raw',     // 13 base units, before decimals
  'usd_volume',     // 14 transfers only — the swaps feed carries no USD at all
  'fee_amount',     // 15 in SOL
  'fee_payer',      // 16
  'is_gasless',     // 17
  'is_inner_ix',    // 18
  'platform',       // 19 swaps only
  'recorded_at',    // 20
  'raw',            // 21
  'suspect',        // 22
  'wallet_address', // 23
];

const WALLET_IDX = 23;
const RAW_IDX = 21;
const SUSPECT_IDX = 22;

/**
 * Merge identity of a Solana row: the wallet it was fetched for, plus a digest
 * of the API object itself.
 *
 * wallet_address has to be part of it, and cannot be derived from the payload.
 * On a gasless swap `feePayerPublicKey` is null and the tracked wallet appears
 * NOWHERE in the object — 7 of 50 swaps on a real wallet. Two tracked wallets
 * trading the same pool would then produce byte-identical rows and one would
 * overwrite the other, which is exactly the collision the EVM side hit.
 *
 * Note there is no transfer_idx: unlike the EVM payload, neither feed nests an
 * array of transfers inside one object, so one object is always one row.
 *
 * The wallet is NOT lower-cased. Base58 is case sensitive — GZ3t… and gz3t… are
 * different accounts, and only one of them exists.
 */
function solKeyOf(row) {
  return `s:${rawDigest(row[RAW_IDX])}@${row[WALLET_IDX] ?? ''}`;
}

const SOL_SCHEMA = makeSchema({
  name: 'solana',
  header: SOL_HEADER,
  timeIdx: 4,   // block_time
  stampIdx: 20, // recorded_at
  keyOf: solKeyOf,
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Both feeds stamp time differently; normalise to the sheet's TH format. */
function solTime(value) {
  if (!value) return null;
  // Transfers: "2026-08-22T09:05:31.000Z" (ISO).
  // Swaps:     "2026-08-22 05:23:20+00"   (space separator, short offset).
  const ms = Date.parse(String(value).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(ms)) {
    log('WARN', `Unparseable blockTime ${JSON.stringify(value)}`);
    return null;
  }
  return formatDateTH(Math.floor(ms / 1000));
}

/** Unix seconds of a feed timestamp, for windowing and cursors. */
function solUnix(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

const v = (val) => (val === undefined || val === '' ? null : val);

/**
 * One transfer -> one row.
 *
 * `direction` is derived by comparing the wallet against from/to, because the
 * feed states neither: it returns the transfer, not your view of it.
 */
function mapTransfer(t, wallet) {
  const from = t.fromAddress ?? null;
  const to = t.toAddress ?? null;
  const isOut = from === wallet;
  const isIn = to === wallet;
  const direction = isOut && isIn ? 'self' : isIn ? 'in' : isOut ? 'out' : 'unrelated';

  const row = new Array(SOL_HEADER.length).fill(null);
  row[0] = 'transfer';
  row[1] = 'solana';
  row[2] = v(t.txHash);
  row[3] = v(t.blockId);
  row[4] = solTime(t.blockTime);
  row[5] = direction;
  row[6] = isIn ? from : isOut ? to : null;
  row[7] = from;
  row[8] = to;
  if (direction === 'out' || direction === 'self') {
    row[9] = v(t.amount);
    row[10] = v(t.assetId);
  }
  if (direction === 'in' || direction === 'self') {
    row[11] = v(t.amount);
    row[12] = v(t.assetId);
  }
  if (direction === 'unrelated') { // keep the numbers rather than silently dropping them
    row[9] = v(t.amount);
    row[10] = v(t.assetId);
  }
  row[13] = v(t.amountRaw);
  row[14] = v(t.usdVolume);
  row[15] = v(t.feeAmount);
  row[16] = v(t.feePayer);
  row[17] = t.isGasless === true;
  row[18] = t.isInnerIx === true;
  row[19] = null; // platform is a swap concept
  row[RAW_IDX] = rawCell(t);
  row[WALLET_IDX] = wallet;
  return row;
}

/** One swap -> one row, input on the send side and output on the receive side. */
function mapSwap(s, wallet) {
  const row = new Array(SOL_HEADER.length).fill(null);
  row[0] = 'swap';
  row[1] = 'solana';
  row[2] = v(s.txHash);
  row[3] = null; // the swaps feed carries no slot
  row[4] = solTime(s.blockTime);
  row[5] = 'swap';
  row[6] = null; // an AMM trade has no counterparty account
  row[7] = v(s.feePayerPublicKey);
  row[8] = null;
  row[9] = v(s.inputAmount);
  row[10] = v(s.inputMint);
  row[11] = v(s.outputAmount);
  row[12] = v(s.outputMint);
  row[13] = null;
  row[14] = null; // no USD on this feed — deliberately blank, not zero
  row[15] = null;
  row[16] = v(s.feePayerPublicKey);
  row[17] = s.isGasless === true;
  row[18] = false;
  row[19] = v(s.platform);
  row[RAW_IDX] = rawCell(s);
  row[WALLET_IDX] = wallet;
  return row;
}

// ---------------------------------------------------------------------------
// Address poisoning
// ---------------------------------------------------------------------------
// Same two signals as the EVM side, re-derived for what this feed actually says.
//
//   dust_relayed  a received transfer worth less than SUSPECT_DUST_USD whose fee
//                 was paid by somebody other than its sender. A real person
//                 paying you signs and pays for their own transfer; poisoning is
//                 sprayed in bulk by a relayer, so feePayer and fromAddress
//                 differ.
//   lookalike     the counterparty shares its first 4 and last 4 characters with
//                 a DIFFERENT counterparty in the same batch — the whole point
//                 of the grind. Compared case-sensitively, because base58 is.

function isSolDustRelayed(row) {
  const threshold = cfg.SUSPECT_DUST_USD;
  if (threshold <= 0) return false;
  if (row[5] !== 'in') return false;

  const usd = Number(row[14]);
  if (!(Number.isFinite(usd) && usd > 0 && usd < threshold)) return false;

  const from = row[7];
  const payer = row[16];
  return typeof from === 'string' && typeof payer === 'string' && from !== payer;
}

/** Fill the `suspect` column across a whole batch of Solana rows, in place. */
function flagSolSuspectRows(rows) {
  const byFingerprint = new Map();
  for (const row of rows) {
    const fp = solFingerprint(row[6]);
    if (!fp) continue;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, new Set());
    byFingerprint.get(fp).add(row[6]);
  }

  let dust = 0;
  let lookalike = 0;
  for (const row of rows) {
    const reasons = [];
    if (isSolDustRelayed(row)) reasons.push('dust_relayed');
    const fp = solFingerprint(row[6]);
    if (fp && byFingerprint.get(fp).size > 1) reasons.push('lookalike');
    row[SUSPECT_IDX] = reasons.length ? reasons.join('+') : null;
    if (reasons.includes('dust_relayed')) dust++;
    if (reasons.includes('lookalike')) lookalike++;
  }

  const groups = [...byFingerprint.values()].filter((s) => s.size > 1).length;
  if (dust || lookalike) {
    log('WARN', `Suspected address poisoning: ${c.bold(dust)} dust row(s) paid for ` +
      `by a relayer, ${c.bold(lookalike)} row(s) whose counterparty looks like another ` +
      `address in this batch (${groups} look-alike group(s))`);
  }
  return { dust, lookalike, groups };
}

/** First-4 / last-4 fingerprint of a base58 account, or null. */
function solFingerprint(addr) {
  if (typeof addr !== 'string') return null;
  const a = addr.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return null;
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** Drop only what DROP_SUSPECTED is meant to drop — never a `lookalike` alone. */
function dropSolSuspectRows(rows) {
  if (!cfg.DROP_SUSPECTED) return rows;
  const kept = rows.filter((row) => !String(row[SUSPECT_IDX] || '').includes('dust_relayed'));
  const dropped = rows.length - kept.length;
  if (dropped) {
    log('WARN', `DROP_SUSPECTED=1 — discarded ${c.bold(dropped)} suspected ` +
      `address-poisoning row(s); ${kept.length} kept`);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One GET, with the same politeness the EVM side learned the hard way: the run
 * quota is checked first, the global deadline is never overrun, Retry-After is
 * honoured in full, and a 429/403 costs a cooldown rather than an immediate
 * retry.
 *
 * There is no pending-job branch here — these feeds answer immediately.
 */
async function requestPage(url, label, rateLimitMgr, budget, spacingMs) {
  let timeoutRetries = 0;

  for (let attempt = 1; attempt <= cfg.MAX_RETRIES; attempt++) {
    if (fetchBudgetRemainingMs() <= 0) throw new DeadlineError('global time budget exhausted');
    if (rateLimitMgr.budgetLeft() <= 0) {
      throw new BudgetError(`request quota reached (${cfg.MAX_REQUESTS_PER_RUN} requests this run)`);
    }
    if (!(await rateLimitMgr.beforeRequest(spacingMs))) {
      throw new DeadlineError('not enough time left to wait out the cooldown');
    }

    try {
      log('DEBUG', `GET ${label} (attempt ${attempt}/${cfg.MAX_RETRIES})`);
      const response = await axios.get(url, {
        headers: API_HEADERS,
        timeout: 60000,
        httpsAgent: HTTPS_AGENT,
        proxy: false, // our agent already applies the proxy; axios must not re-apply it
      });
      rateLimitMgr.onSuccess();
      return response.data;
    } catch (err) {
      if (err instanceof DeadlineError) throw err;
      const status = err.response?.status;

      if (status === 429 || status === 403) {
        budget.blockRetries++;
        const walletBudgetLeft = cfg.WALLET_BLOCK_BUDGET_MS - budget.blockWaitMs;
        if (budget.blockRetries > cfg.MAX_BLOCK_RETRIES || walletBudgetLeft <= 0) {
          throw new BlockedError(`${status} soft-block — skipped after ` +
            `${budget.blockRetries} attempt(s) and ${fmtDuration(budget.blockWaitMs)} of cooldown`);
        }
        const allowed = Math.min(walletBudgetLeft, fetchBudgetRemainingMs());
        if (allowed <= 0) throw new DeadlineError('no time left to cool down');

        const retryAfterMs = parseRetryAfter(err.response?.headers?.['retry-after']);
        if (retryAfterMs != null && retryAfterMs > allowed) {
          throw new BlockedError(`${status} — server asked for ${fmtDuration(retryAfterMs)}, ` +
            `more than the ${fmtDuration(allowed)} budget left; skipping rather than retrying early`);
        }
        const cooldown = rateLimitMgr.onBlock(retryAfterMs, allowed);
        budget.blockWaitMs += cooldown;
        log('WARN', `${c.bold(status === 429 ? '429 Too Many Requests' : '403 Forbidden')} on ` +
          `${label} [${budget.blockRetries}/${cfg.MAX_BLOCK_RETRIES}] — cooling down ` +
          `${c.bold(fmtDuration(cooldown))}${retryAfterMs != null ? ' (Retry-After honored)' : ''}`);
        attempt--; // the cooldown is the penalty; don't also burn an attempt
        continue;
      }

      // A 404 is an answer, not a failure: the feed has nothing for this wallet.
      if (status === 404) {
        log('DEBUG', `${label} → 404, treating as empty`);
        return null;
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
        log('WARN', `Timeout on ${label} [${timeoutRetries}/${cfg.MAX_TIMEOUT_RETRIES}] — ` +
          `retrying in ${fmtDuration(waitMs)}`);
        await sleep(waitMs);
        attempt--;
        continue;
      }

      throw new Error(`${err.message} (${err.code || status || 'UNKNOWN'})`);
    }
  }
  throw new Error(`Failed after ${cfg.MAX_RETRIES} attempts`);
}

/**
 * Page through one feed for one wallet.
 *
 * Termination is guarded from every angle, because the swaps feed announces
 * `hasMoreData` without saying how to ask for it — a wrong parameter name would
 * otherwise re-request page 1 forever:
 *
 *   1. no cursor in the response        — the feed says it is done
 *   2. empty page                       — nothing left
 *   3. page repeats the previous one    — the parameter was IGNORED, stop and say so
 *   4. oldest row older than the window — HISTORY_DAYS reached
 *   5. MAX_PAGES_PER_WALLET             — anti-runaway cap
 *   6. MAX_TX_PER_WALLET                — collected enough
 *   7. the global deadline / run quota  — checked inside every request
 */
async function fetchFeed(spec, wallet, rateLimitMgr) {
  const { base, listKey, cursorParam, cursorOf, label } = spec;
  const budget = { blockRetries: 0, blockWaitMs: 0 };
  const cutoff = cfg.HISTORY_DAYS > 0
    ? Math.floor(Date.now() / 1000) - cfg.HISTORY_DAYS * 86400
    : 0;

  const items = [];
  let cursor = null;
  let pages = 0;
  let firstOfPrevPage = null;
  let stopReason = 'no more data';

  while (pages < cfg.MAX_PAGES_PER_WALLET) {
    const url = cursor == null
      ? `${base}/${wallet}`
      : `${base}/${wallet}?${encodeURIComponent(cursorParam)}=${encodeURIComponent(cursor)}`;

    const body = await requestPage(url, `${label} ${maskAddr(wallet)}`,
      rateLimitMgr, budget, spacingMs());
    pages++;

    const list = Array.isArray(body?.[listKey]) ? body[listKey] : [];
    if (list.length === 0) { stopReason = 'empty page'; break; }

    // The cursor parameter is a guess for the swaps feed (its response carries
    // no cursor at all). If the server ignored it we get page 1 again — detect
    // that on the first row rather than looping and hammering the endpoint.
    const firstId = list[0]?.txHash ?? null;
    if (pages > 1 && firstId != null && firstId === firstOfPrevPage) {
      log('WARN', `${label}: page ${pages} repeats page ${pages - 1} — the ` +
        `"${cursorParam}" parameter was ignored by the server. Stopping at ` +
        `${items.length} row(s). Find the real parameter in the browser's ` +
        `network tab and set ${spec.paramEnv}.`);
      stopReason = 'cursor ignored';
      break;
    }
    firstOfPrevPage = firstId;

    items.push(...list);

    const oldest = Math.min(...list.map((x) => solUnix(x.blockTime)).filter(Boolean));
    if (cutoff && oldest && oldest < cutoff) { stopReason = `${cfg.HISTORY_DAYS}-day window`; break; }
    if (items.length >= cfg.MAX_TX_PER_WALLET) { stopReason = 'row ceiling'; break; }

    cursor = cursorOf(body, items);
    if (cursor == null) { stopReason = 'no cursor in response'; break; }

    await jitterDelay(cfg.PAGE_DELAY_MIN_MS, cfg.PAGE_DELAY_MAX_MS);
  }

  if (pages >= cfg.MAX_PAGES_PER_WALLET) stopReason = 'page cap';

  // Trim to the window: a page is kept whole above, so its tail can reach past it.
  const kept = cutoff ? items.filter((x) => solUnix(x.blockTime) >= cutoff) : items;

  log('DEBUG', `${label} ${maskAddr(wallet)}: ${kept.length} row(s) in ${pages} page(s) ` +
    `(${stopReason})`);
  return { items: kept, pages, dropped: items.length - kept.length };
}

/** Random spacing for the next request, honouring the adaptive floor. */
function spacingMs() {
  return cfg.JITTER_MIN_MS + Math.random() * (cfg.JITTER_MAX_MS - cfg.JITTER_MIN_MS);
}

const TRANSFERS_SPEC = () => ({
  base: TRANSFERS_URL,
  listKey: 'transfers',
  label: 'transfers',
  cursorParam: TRANSFERS_CURSOR_PARAM,
  paramEnv: 'SOL_TRANSFERS_CURSOR_PARAM',
  // The feed hands back `next` — a unix timestamp where the following page starts.
  cursorOf: (body) => (body?.next != null && body.next !== '' ? body.next : null),
});

const SWAPS_SPEC = () => ({
  base: SWAPS_URL,
  listKey: 'swaps',
  label: 'swaps',
  cursorParam: SWAPS_CURSOR_PARAM,
  paramEnv: 'SOL_SWAPS_CURSOR_PARAM',
  // This feed only says whether more exists, never where to continue, so the
  // cursor is how many rows we already hold — an offset. If that guess is wrong
  // the repeat detection above stops the loop on page 2.
  cursorOf: (body, items) => (body?.hasMoreData === true ? items.length : null),
});

/** Everything for one wallet: both feeds, mapped to rows. */
async function fetchWallet(wallet, rateLimitMgr) {
  const rows = [];
  let pages = 0;

  const transfers = await fetchFeed(TRANSFERS_SPEC(), wallet, rateLimitMgr);
  pages += transfers.pages;
  for (const t of transfers.items) rows.push(mapTransfer(t, wallet));

  const swaps = await fetchFeed(SWAPS_SPEC(), wallet, rateLimitMgr);
  pages += swaps.pages;
  for (const s of swaps.items) rows.push(mapSwap(s, wallet));

  return { rows, pages, transfers: transfers.items.length, swaps: swaps.items.length };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function requireEndpoints() {
  const missing = [];
  if (!TRANSFERS_URL) missing.push('SOL_TRANSFERS_API_URL');
  if (!SWAPS_URL) missing.push('SOL_SWAPS_API_URL');
  if (missing.length) {
    throw new Error(`${missing.join(' and ')} not configured — set ` +
      `${missing.length > 1 ? 'them' : 'it'} as repository secret(s), or in .env for local runs`);
  }
}

/** Solana wallets, base58 and case-preserved (lower-casing breaks the address). */
function loadSolWallets() {
  return loadAllWallets({
    envVar: 'SOL_WALLET_LIST',
    fileVar: 'SOL_WALLETS_FILE',
    lowercase: false,
  });
}

async function processSolana() {
  const startTime = Date.now();
  requireEndpoints();

  const batch = resolveBatch();
  const sheetName = resolveSheetName(batch);

  const all = loadSolWallets();
  if (all.length === 0) throw new Error('No Solana wallets configured (set SOL_WALLET_LIST)');

  const invalid = all.filter((a) => !solFingerprint(a));
  if (invalid.length) {
    log('WARN', `${invalid.length} entry(ies) in SOL_WALLET_LIST are not base58 ` +
      `accounts and were kept as-is: ${invalid.slice(0, 3).map(maskAddr).join(', ')}`);
  }

  const sliced = batch ? sliceForBatch(all, batch.index, batch.total) : all;
  const wallets = rotateWallets(sliced);

  log('INFO', `${c.bold('Solana sync')} — ${c.bold(wallets.length)} wallet(s)` +
    (batch ? ` (batch ${batch.index}/${batch.total} of ${all.length})` : '') +
    ` → "${sheetName}"`);

  const rateLimitMgr = new RateLimitManager();
  const collected = [];
  let okCount = 0;
  let errorCount = 0;
  let processed = 0;
  let consecutiveBlocked = 0;
  let stopReason = null;

  for (const wallet of wallets) {
    if (consecutiveBlocked >= cfg.CIRCUIT_BREAKER_THRESHOLD) {
      stopReason = `${consecutiveBlocked} wallets blocked in a row — the IP is soft-blocked`;
      break;
    }
    processed++;
    try {
      const { rows, pages, transfers, swaps } = await fetchWallet(wallet, rateLimitMgr);
      collected.push(...rows);
      okCount++;
      consecutiveBlocked = 0;
      log('INFO', `${c.magenta(maskAddr(wallet))}: ${c.bold(rows.length)} row(s) ` +
        `(${transfers} transfer, ${swaps} swap) in ${pages} page(s)`);
    } catch (err) {
      if (err instanceof DeadlineError || err instanceof BudgetError) {
        processed--;
        stopReason = err instanceof BudgetError ? err.message : `time budget reached (${err.message})`;
        break;
      }
      errorCount++;
      if (err instanceof BlockedError) {
        consecutiveBlocked++;
        log('ERROR', `${maskAddr(wallet)}: ${err.message} — moving on`);
      } else {
        consecutiveBlocked = 0;
        log('ERROR', `${maskAddr(wallet)}: ${err.message} — skipping this wallet`);
      }
    }
  }

  const skipped = wallets.length - processed;
  if (stopReason) {
    log('WARN', `${c.bold('Fetch phase stopped early')} — ${stopReason}. ` +
      `${c.bold(skipped)} wallet(s) not fetched this run; saving what we have.`);
  }

  log('INFO', `${c.bold('Summary')} — ${c.green(okCount + ' ok')}, ${c.red(errorCount + ' failed')}, ` +
    `${c.yellow(skipped + ' skipped')} of ${wallets.length} | ${collected.length} rows | ` +
    `${rateLimitMgr.requestsMade}/${cfg.MAX_REQUESTS_PER_RUN} requests | ` +
    `elapsed ${fmtDuration(Date.now() - startTime)}`);

  collected.sort((a, b) => parseDateTH(b[4]) - parseDateTH(a[4]));
  flagSolSuspectRows(collected);
  const rows = dropSolSuspectRows(collected);

  const successRatio = wallets.length ? okCount / wallets.length : 0;
  if (okCount > 0 && successRatio < cfg.MIN_SUCCESS_RATIO) {
    log('WARN', `${c.bold('Sheet NOT updated')} — only ${okCount}/${wallets.length} wallets ` +
      `succeeded (below MIN_SUCCESS_RATIO ${cfg.MIN_SUCCESS_RATIO}). ` +
      `Tab "${sheetName}" keeps its previous contents.`);
    return { success: true, written: 0, okCount, errorCount, skipped, stopReason, sheetName, batch };
  }

  const written = await writeToSheet(rows, sheetName, { schema: SOL_SCHEMA });

  log('OK', `${c.bold('Solana sync completed')} in ` +
    `${((Date.now() - startTime) / 1000).toFixed(1)}s — ${written} rows written to "${sheetName}"`);

  return { success: true, written, okCount, errorCount, skipped, stopReason, sheetName, batch };
}

/** Consolidate the Solana batch tabs, using the Solana columns. */
function consolidateSolana() {
  return consolidateBatches(SOL_SCHEMA);
}

module.exports = {
  SOL_HEADER,
  SOL_SCHEMA,
  solKeyOf,
  solTime,
  solUnix,
  solFingerprint,
  mapTransfer,
  mapSwap,
  isSolDustRelayed,
  flagSolSuspectRows,
  dropSolSuspectRows,
  fetchFeed,
  fetchWallet,
  processSolana,
  consolidateSolana,
  loadSolWallets,
  requireEndpoints,
  TRANSFERS_SPEC,
  SWAPS_SPEC,
  SOL_MINT,
};

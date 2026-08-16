# 🚀 Rabby Transaction Tracker — GitHub Actions Edition

Track cryptocurrency transaction history from [Rabby Wallet](https://rabby.io) and automatically sync to Google Sheets with **proper rate limit handling** and graceful error recovery.

Designed specifically for **GitHub Actions** — no local setup required, runs on schedule, respects API rate limits.

---

## ✨ Features

✅ **Scales to 200+ Wallets** — Batch split across parallel matrix jobs, one tab each  
✅ **Time-Windowed History** — Last 180 days by `time_at`, paginated newest-first  
✅ **Fair Rotation** — Starting wallet rotates so a block can't starve the same wallets  
✅ **Coverage Accumulates** — A blocked wallet keeps its rows; nothing is wiped  
✅ **No Race Conditions** — Each batch clears and writes only its own sheet tab  
✅ **Rate Limit Aware** — Adaptive throttling + exponential backoff  
✅ **429 Handling** — Respects rate limits, retries intelligently  
✅ **Timeout Recovery** — Auto-retry on network timeouts  
✅ **Google Sheets Integration** — Direct append with chunked writes  
✅ **GitHub Actions Native** — No credentials in repo, uses Secrets  
✅ **Comprehensive Logging** — Detailed console output for debugging  
✅ **Scam Filtering** — Automatically filters out flagged transactions  

---

## 🔧 Setup

### Step 1: Create Google Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable **Google Sheets API** and **Google Drive API**
4. Go to **Service Accounts** → **Create Service Account**
5. Download the JSON key file
6. Share your target Google Sheet with the service account email (found in JSON)

### Step 2: Configure GitHub Secrets

Add these **Repository Secrets** in GitHub Settings → Secrets and variables → Actions:

| Secret Name | Value |
|---|---|
| `WALLET_LIST` | Comma-separated wallet addresses: `0x123...,0xabc...` |
| `GOOGLE_SPREADSHEET_ID` | Found in sheet URL: `docs.google.com/spreadsheets/d/{ID}/edit` |
| `GOOGLE_SHEET_NAME` | Sheet tab name (default: `Sheet1`) |
| `GOOGLE_CREDENTIALS` | Full JSON from service account key |

**Example:**
```bash
WALLET_LIST=0x1234567890abcdef1234567890abcdef12345678,0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
GOOGLE_SPREADSHEET_ID=1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t
GOOGLE_SHEET_NAME=Sheet1
GOOGLE_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
```

### Step 3: Prepare Google Sheet

Create a spreadsheet and share it with the service account email as **Editor**.

> 💡 **Batch tabs are created for you.** When using `--batch` (see
> [Scaling to 200+ Wallets](#-scaling-to-200-wallets-batches--matrix)), tabs like
> `Batch_01`…`Batch_10` are created automatically with the correct header row —
> you only need the spreadsheet itself.

For a single-tab setup, create the tab with headers in row 1:

| A | B | C | D | E | F | ... | AI |
|---|---|---|---|---|---|-----|-----|
| cate_id | cex_id | chain | id | idx | is_scam | ... | recorded_at |

**Or use the provided header template** (35 columns A:AI):

```
cate_id | cex_id | chain | id | idx | is_scam | other_addr | project_id | 
recv_amount | recv_from_addr | recv_price | recv_token_id | 
send_amount | send_price | send_to_addr | send_token_id | 
time_at | approve_label | approve_spender | approve_token_id | approve_value | 
tx_label | tx_eth_gas_fee | tx_from_addr | tx_id | tx_idx | 
tx_message | tx_name | tx_params | tx_selector | tx_status | tx_to_addr | 
tx_usd_gas_fee | tx_value | recorded_at
```

---

## 📋 Configuration

### Environment Variables

All can be configured in `.env` file for local testing, or via GitHub Secrets for Actions.

**Required:**
- `WALLET_LIST` — Comma-separated wallet addresses
- `GOOGLE_SPREADSHEET_ID` — Google Sheet ID
- `GOOGLE_CREDENTIALS` — Service account JSON

**Optional (with sensible defaults):**
- `GOOGLE_SHEET_NAME` — Sheet tab name (default: `Sheet1`)
- `WALLETS_FILE` — JSON file of wallets, alternative to `WALLET_LIST`
- `BATCH_INDEX` / `BATCH_TOTAL` — Batch slice to process (same as `--batch N/TOTAL`)
- `TARGET_SHEET_NAME` — Force a target tab (same as `--sheet`)
- `BATCH_SHEET_PREFIX` — Prefix for batch tabs (default: `Batch_`)
- `HISTORY_DAYS` — Look-back window in days, by `time_at` (default: `180`; `0` = by row count only)
- `ROTATION_PERIOD_MS` — Rotate the starting wallet each run (default: `3600000`; `0` disables)
- `PAGE_COUNT` — Safety ceiling on rows per wallet (default: `2000`)
- `PAGE_SIZE` — Rows per API request (default: `200`)
- `MAX_PAGES_PER_WALLET` — Anti-runaway page cap (default: `20`)
- `PAGE_DELAY_MIN_MS` / `PAGE_DELAY_MAX_MS` — Random spacing between pages of one wallet (default: `1500` / `2000`)
- `PROXY_URL` — Route API traffic through a proxy (also reads `HTTPS_PROXY` / `HTTP_PROXY`, honours `NO_PROXY`)
- `SHEETS_WRITE_DELAY_MS` — Pause between Sheets chunk writes (default: `1500`)
- `LOG_LEVEL` — `INFO` (default) or `DEBUG` for verbose per-request logs
- `NO_COLOR` — set to disable ANSI colors in logs
- `GLOBAL_TIMEOUT_MS` — Stop fetching after this long, ms (default: `1200000` = 20 min)
- `WRITE_RESERVE_MS` — Time reserved for the Sheets write, ms (default: `90000`)
- `JITTER_MIN_MS` / `JITTER_MAX_MS` — Random spacing band per request, ms (default: `4000` / `8000`)
- `MAX_DELAY_MS` — Ceiling for adaptive spacing, ms (default: `30000`)
- `PENDING_BASE_MS` / `PENDING_STEP_MS` / `PENDING_MAX_MS` — Pending-job backoff (default: `20000` / `10000` / `60000`)
- `MAX_PENDING_ROUNDS` — Max pending polls per wallet (default: `4`)
- `RATE_LIMIT_WAIT_MS` — Base cooldown on 429/403 when no `Retry-After`, ms (default: `60000`)
- `MAX_COOLDOWN_MS` — Hard cap on a single cooldown, ms (default: `120000`)
- `MAX_BLOCK_RETRIES` — 429/403 retries per wallet before skipping (default: `2`)
- `WALLET_BLOCK_BUDGET_MS` — Max total cooldown per blocked wallet, ms (default: `120000`)
- `CIRCUIT_BREAKER_THRESHOLD` — Consecutive blocks before stopping the run (default: `2`)
- `MAX_RETRIES` — Max attempts per wallet (default: `10`)
- `MAX_TIMEOUT_RETRIES` — Max retries for timeouts (default: `5`)
- `CHUNK_SIZE` — Rows per Google Sheets write (default: `500`)
- `MAX_REQUESTS_PER_RUN` — Hard cap on API requests per run (default: `8`) — **the key setting**
- `MERGE_PRESERVE` — Keep rows for wallets not refreshed this run (default: `1`; `0` = destructive full refresh)
- `MIN_SUCCESS_RATIO` — Only used when `MERGE_PRESERVE=0` (default: `0.5`)
- `HTTP_USER_AGENT` — Override the request User-Agent (optional)

See `config/example.env` for full template.

---

## 🚀 Usage

### GitHub Actions (Automated)

The workflow runs **every 6 hours**. Modify the cron in `.github/workflows/sync.yml`:

```yaml
schedule:
  - cron: '0 */6 * * *'   # Every 6 hours
  # Other options:
  # - cron: '0 2 * * *'     # Daily at 2 AM UTC
  # - cron: '*/30 * * * *'  # Every 30 minutes (small wallet lists only)
```

Trigger manually:
1. Go to **Actions** tab
2. Select **Rabby Transaction Sync** workflow
3. Click **Run workflow** — no inputs; the split comes from `BATCH_TOTAL`

### Running batches by hand

The quota is **per IP**. On Actions every matrix job gets a fresh runner, and
therefore a fresh quota — that is why 25 small jobs work. Run locally and *all*
batches share your one IP, so the quota applies across the whole session:

```bash
node src/index.js --batch 1/25     # ~4 wallets, ~8 requests — then stop
# wait for the quota window before the next one
node src/index.js --batch 2/25
```

- **One batch per sitting.** `MAX_REQUESTS_PER_RUN=8` stops the run cleanly, but
  the next batch starts against the same, already-spent quota.
- **Wait between batches.** The reset window is not documented; blocks were
  observed lasting over 5 minutes. Start at ~15 minutes and shorten it only if
  runs stay clean.
- To cover everything from one IP, expect ~25 sittings — Actions does it in one
  workflow precisely because each job gets a different IP.

Nothing is lost by stopping early: unfetched wallets keep their rows
(`MERGE_PRESERVE`) and the start position rotates (`ROTATION_PERIOD_MS`), so
coverage converges across runs.

### Local Testing

```bash
npm install
cp config/example.env .env    # then edit .env
npm start

node src/index.js --help      # all options
```

---

## 🧩 Scaling to 200+ Wallets (Batches + Matrix)

Running 200 wallets in one job cannot finish inside the workflow timeout and gets
the IP soft-blocked. Instead the list is **split into batches**, each handled by its
own GitHub Actions matrix job, writing to its **own sheet tab**.

```
        WALLET_LIST secret (200+ wallets, one list)
                          │
        split into 10 contiguous, deterministic slices
                          │
   ┌──────────┬───────────┼───────────┬──────────┐
   ▼          ▼           ▼           ▼          ▼
 batch 1    batch 2     batch 3    …   batch 10        (max-parallel: 1)
   │          │           │           │          │
   ▼          ▼           ▼           ▼          ▼
Batch_01   Batch_02    Batch_03    …   Batch_10        (one tab each)
```

**Why separate tabs?** Each run does a full refresh (`clear` then write). If every
job targeted the same tab they would clear each other's rows mid-write — a genuine
race condition. Per-batch tabs remove the shared resource entirely.

### Running a batch

```bash
node src/index.js --batch 3/10          # slice 3 of 10 → tab "Batch_03"
node src/index.js --batch 3/10 --sheet Custom_Tab
BATCH_INDEX=3 BATCH_TOTAL=10 node src/index.js
```

Tab name is resolved in this order:

| Priority | Source | Example |
|---|---|---|
| 1 | `--sheet` | `--sheet Batch_03` |
| 2 | `TARGET_SHEET_NAME` | `TARGET_SHEET_NAME=Batch_03` |
| 3 | Batch-derived | `--batch 3/10` → `Batch_03` |
| 4 | `GOOGLE_SHEET_NAME` | `Sheet1` |

Tabs are **created automatically** (with a header row) on first use, so you don't
have to pre-make `Batch_01`…`Batch_10`.

### Tuning the split

In `.github/workflows/sync.yml`, keep these two in sync:

```yaml
env:
  BATCH_TOTAL: '10'                          # must equal the matrix length
strategy:
  fail-fast: false                           # one blocked batch ≠ cancel the rest
  max-parallel: 1                            # be polite to Rabby
  matrix:
    batch: [1,2,3,4,5,6,7,8,9,10]
```

- **More batches** → fewer wallets per job → each job finishes faster
- **Lower `max-parallel`** → gentler on Rabby's rate limit. A measured run got a
  429 after 10 requests in 149s (~4 req/min), so `1` is the safe setting.
- `fail-fast: false` matters: without it, one blocked batch cancels the other nine

Slicing is **deterministic and exact** — 200 wallets over 10 batches gives 20 each;
205 gives `21,21,21,21,21,20,20,20,20,20`. No wallet is fetched twice or missed.

### The block is a request *count* quota, not a rate limit

Two measured runs settle it:

| Run | Requests | Elapsed | Rate | Blocked at |
|---|---|---|---|---|
| A | 11 | 149s | 4.4/min | request **11** |
| B | 10 | 215s | 2.8/min | request **10** |

Pacing differed by 60%; the block arrived at the same *request number*. Slowing
down therefore cannot help — only sending fewer requests can.

**`MAX_REQUESTS_PER_RUN` (default 8) is the setting that matters.** The run stops
cleanly when the budget is spent, instead of burning cooldowns on requests that
are certain to be refused.

Because every matrix job gets a **fresh runner, and therefore a fresh quota**, the
way to cover more wallets is *more, smaller batches* — not a bigger budget:

```
98 wallets ÷ 25 batches = ~4 wallets/job × 2 requests = 8 requests   ✓ under quota
98 wallets ÷ 10 batches = ~10 wallets/job × 2 requests = 20 requests ✗ blocked at 10
```

Each wallet costs **2** requests because the API answers the first one with a
pending job and we have to poll for the result.

### Keeping parallel jobs off the rate limiter

All GitHub-hosted runners egress from shared Azure ranges, so the upstream sees
the *combined* rate of every batch running at once. Three layers keep it low:

| Layer | Setting |
|---|---|
| Fewer jobs at once | `max-parallel: 1` (fully serialised) |
| Jobs don't start in lockstep | Random 5–15s **stagger** step before the script runs |
| Requests aren't evenly spaced | Random 15–30s per request, 1.5–2s between pages |

### Optional proxy

If the runner IP keeps getting soft-blocked, route egress elsewhere by setting a
`PROXY_URL` secret (the workflow already passes it through):

```bash
PROXY_URL=http://user:pass@proxy.example.com:8080
```

`HTTPS_PROXY` / `HTTP_PROXY` are honoured too, and `NO_PROXY` exempts hosts
(exact name, `.suffix`, or `*`). Credentials are masked in the logs. Leave the
secret unset to send traffic directly — nothing changes.

> Note: a custom `httpsAgent` makes axios ignore the proxy environment variables,
> so the agent itself is built as a tunnelling agent when a proxy is configured.

### Coverage accumulates across runs

A single run does **not** have to succeed for every wallet. Each row carries a
`wallet_address` (column AJ), so a write only replaces rows for the wallets that
were actually refreshed — everything else is carried over from the sheet.

```
run 1:  w1-w5 ok, w6-w10 blocked  ->  w1-w5 fresh + w6-w10 preserved
run 2:  rotation moves the start  ->  different wallets refresh, none lost
```

Combined with wallet rotation, every wallet's data is refreshed over a few runs
even while some requests are still being soft-blocked. Before this, a partial run
cleared the tab and destroyed the rows of every wallet it didn't reach.

A wallet that succeeds with **zero** in-window transactions correctly ends up with
no rows — that is a real result, not a gap.

> Tabs created before `wallet_address` existed are migrated **automatically**: the
> grid is widened to 36 columns and the header row is rewritten on first write.
> No manual spreadsheet edit is needed. Rows written before the column existed
> cannot be attributed and are dropped once, then repopulate as their wallets are
> refreshed.

### Google Sheets write quota

Sheets allows ~60 write requests/minute/user, **shared across all parallel jobs**.
`SHEETS_WRITE_DELAY_MS` (default `1500`) spaces out chunk writes, and quota errors
get their own exponential backoff. Raise it if you increase `max-parallel`.

---

## 📊 How It Works

### Flow Diagram

```
┌─────────────────────────────────────────────────┐
│  GitHub Actions (Every 15 minutes)              │
└────────────┬────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────┐
│  Load wallet list from WALLET_LIST secret      │
└────────────┬────────────────────────────────────┘
             │
             ▼
     ┌───────────────────┐
     │  For each wallet:  │
     └────────┬──────────┘
              │
              ▼
     ┌──────────────────────────────────┐
     │ Fetch from Rabby API with retry  │
     │ (rate limit aware)               │
     └────────┬─────────────────────────┘
              │
              ▼
     ┌──────────────────────────┐
     │ Filter scam transactions │
     └────────┬─────────────────┘
              │
              ▼
     ┌────────────────────────────────────┐
     │ Map to 35-column row format        │
     │ (cate_id, chain, amount, etc.)     │
     └────────┬─────────────────────────────┘
              │
         ┌────┴────┐
         │ (repeat) │
         └────┬────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│  Clear existing data from Google Sheet          │
└────────────┬────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────┐
│  Append all rows to Sheet (in 500-row chunks)   │
└────────────┬────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────┐
│  Done ✅                                         │
└─────────────────────────────────────────────────┘
```

### Pagination — how full history is actually retrieved

`page_count=2000` in a **single** request does not return 2000 rows: the API caps
each response, so the history was silently truncated and the most recent
transactions never reached the sheet.

The script now walks backwards through time:

```
page 1:  GET ?id=0x…&page_count=200                  → newest 200 rows
page 2:  GET ?id=0x…&page_count=200&start_time=<oldest time_at so far>
page 3:  … repeat until the look-back window is covered
```

**The window is a time range, not a row count.** `HISTORY_DAYS=90` keeps every
transaction whose `time_at` is within the last 90 days, and paging stops the
moment the cursor crosses that boundary. This is the main lever on request
volume — a typical wallet needs **1 request instead of 10**:

| Wallet | With 90-day window | Without (2000 rows) |
|---|---|---|
| 2 txs/day, years of history | 1 page, 181 rows | 10 pages, 2000 rows |
| Quiet (nothing recent) | 1 page, 10 rows | 10 pages |
| Very busy (1 tx/min) | 10 pages (hits the 2000 ceiling) | 10 pages |

Rows are de-duplicated by transaction id (pages can overlap) and the whole batch
is **sorted newest-first** before being written, so row 2 of the sheet is always
the most recent transaction.

**The loop cannot run away** — it stops on any of:

| # | Guard |
|---|---|
| 1 | `MAX_PAGES_PER_WALLET` hard cap (default 20) |
| 2 | A page comes back empty |
| 3 | A page is shorter than `PAGE_SIZE` (last page) |
| 4 | A page contains no new transaction ids (API ignored the cursor) |
| 5 | The cursor stops moving backwards in time |
| 6 | `PAGE_COUNT` rows collected |
| 7 | The global deadline — checked inside every page request |

Pages of the same wallet are spaced `PAGE_DELAY_MS` (500ms) apart, **but the
adaptive delay takes over the moment a 429/403 appears**, so pagination can never
out-run the throttle the server asked for. The per-wallet block budget is shared
across all of a wallet's pages, so a blocked wallet still costs at most ~2 minutes
in total — not 2 minutes per page.

### Rate Limiting Strategy

**Respectful, adaptive, and time-bounded.** A single shared throttle governs *all*
wallets in a run:

1. **Normal operation** — every request waits a **random** 5–12s. The randomness
   matters as much as the length: an exactly regular cadence is itself a bot
   signal. The floor **decays** back down after each success.
2. **Pending jobs** — the API answers `{ job: { status: "pending" } }` while it builds
   a wallet's history. Polling that every few seconds is what gets the IP soft-blocked,
   so waits step up **20s → 30s → 40s → 50s** (ceiling 60s), then the wallet is skipped.
3. **On 429 / 403** — treated identically as "server is pushing back":
   - **Honor the `Retry-After` header** in full. If the server asks for longer than the
     run can afford, the wallet is **skipped rather than retried early**.
   - Otherwise exponential backoff from a 60s base, capped at `MAX_COOLDOWN_MS`.
   - Open a **shared cooldown window** so the *next* wallet also waits — this stops the
     429 → 403 cascade where one rate-limit hit soft-blocks the IP for everything.
   - **Fail fast:** at most 2 retries and 2 minutes of cooldown per wallet, then move on.
   - **Circuit breaker:** after 2 wallets in a row are blocked, the IP itself is blocked,
     so the run stops fetching entirely and saves what it has.
4. **On timeout** — retry up to 5× with 5–10s backoff, then move on.
5. **One failing wallet never fails the whole run** — it's logged and skipped.

**No bypassing, no tricks — just polite, adaptive throttling that backs off harder the
more the server pushes back.**

### Global Safety Timeout Guard (no more `Canceled` runs)

GitHub cancels a job when it hits `timeout-minutes`, and **everything in memory is lost**
— which previously threw away thousands of successfully-fetched rows.

The script now enforces its own deadline *below* the workflow's:

```
0 ──────────── fetch phase ───────────► 18.5 min ── write ──► 20 min │ … │ 30 min
                                        ▲                    ▲            ▲
                    GLOBAL_TIMEOUT_MS − WRITE_RESERVE_MS   guard    workflow timeout
```

- Every wait (cooldown, pending poll, timeout retry) is checked against the deadline.
  If a wait wouldn't finish in time, the script **stops instead of sleeping into a
  cancellation**.
- When the budget runs out, remaining wallets are abandoned, the rows already fetched
  are written to Sheets, and the process exits **0** — the run finishes **green with
  partial data** instead of red/cancelled with nothing.
- Partial results are protected by `MIN_SUCCESS_RATIO`: if too few wallets succeeded,
  the destructive clear+write is skipped so a good previous snapshot survives.

### Manual retry mode

Re-fetch a single wallet that was skipped, **appending** without clearing the sheet:

```bash
node src/index.js 0x1234567890abcdef1234567890abcdef12345678
```

When batching is configured, the script works out which batch that wallet belongs to
and appends to **that batch's tab** — so a retry can't land in the wrong tab. Override
explicitly if needed:

```bash
node src/index.js 0x1234... --sheet Batch_03
```

### About 429 / 403 — "can I make it look like a real browser, or use another endpoint?"

Short answer: **don't try to disguise the request** — that's fragile and against the
spirit of the API's limits. Two honest options actually fix it:

1. **Slow down / spread out (recommended, already built in).** The 403s you saw were an
   IP-level *soft-block* triggered *after* a 429 — GitHub Actions runs on shared Azure
   IPs that get throttled more aggressively. Hammering with a 4s retry made it worse.
   The adaptive cooldown above is the fix. If it still happens: raise `JITTER_MIN_MS`,
   lower the cron frequency (e.g. `*/30` or hourly), or split wallets across more runs.

2. **Use the official DeBank Cloud API (the legitimate "other endpoint").** Rabby's
   history is powered by DeBank. Their supported product, **DeBank Cloud
   (`pro.openapi.debank.com`)**, gives you an `AccessKey`, documented rate limits, and no
   bot-blocking — it's built to be called from servers like CI. That's the right path if
   you need reliable, higher-volume access. It's a paid/credits API, so it's opt-in.

> ⚠️ Spoofing browser fingerprints, rotating proxies, or driving a headless browser to
> evade the block are **not** supported here by design — they break easily and abuse the
> service. Politeness + the official API are the durable answers.

---

## 🐛 Troubleshooting

### "429 Too Many Requests"

**Cause**: Requesting too frequently or too many wallets at once

**Solutions**:
- ✅ Increase `JITTER_MIN_MS` and `JITTER_MAX_MS` (e.g., 5000-10000)
- ✅ Reduce number of wallets in `WALLET_LIST`
- ✅ Increase workflow cron interval (e.g., every 30 min instead of 15)

### "403 Forbidden"

**Cause**: Request is being blocked (possible rate limit, user-agent detection)

**Solutions**:
- ✅ Check Rabby API status
- ✅ Add cookie if required (not currently supported in GitHub Actions)
- ✅ Increase backoff: increase `JITTER_MIN_MS`

### "Google authentication failed"

**Cause**: Invalid credentials or missing permissions

**Solutions**:
- ✅ Verify `GOOGLE_CREDENTIALS` is valid JSON
- ✅ Ensure service account has **Editor** access to the spreadsheet
- ✅ Check that Google Sheets API is enabled in Cloud Console

### "No data to write"

**Cause**: All wallets failed or no transactions found

**Solutions**:
- ✅ Check if wallets have transaction history
- ✅ Verify wallet addresses in `WALLET_LIST`
- ✅ Check workflow logs for detailed errors

### Workflow fails silently

**Debug**:
1. Go to **Actions** → **Rabby Transaction Sync** workflow
2. Click on the failed run
3. Expand **Run transaction sync** step
4. Look for error messages in logs

---

## 📈 Adding More Wallets

1. Go to GitHub **Settings → Secrets**
2. Edit `WALLET_LIST` and append the new addresses (comma-separated)
3. Save — the next run picks them up

**Keep batches balanced.** The list is split evenly, so adding wallets grows every
batch a little. Rough guide:

| Wallets | Batches | Wallets/batch | Approx. per job |
|---|---|---|---|
| ~50 | 3 | ~17 | 3–8 min |
| ~100 | 5 | 20 | 4–10 min |
| ~200 | 10 | 20 | 4–10 min |
| ~400 | 20 | 20 | 4–10 min |

Aim for **15–20 wallets per batch**. If jobs start hitting the 20-minute guard, add
more batches rather than raising the timeout.

⚠️ When you change the batch count, update **both** `BATCH_TOTAL` and the `matrix.batch`
list in `.github/workflows/sync.yml` — they must match. Note that changing the count
re-shuffles which wallets land in which tab, so old tabs beyond the new count
(e.g. `Batch_11`+ after going 20 → 10) are left behind and should be deleted manually.

---

## 🔐 Security

✅ **Credentials not in repo** — Uses GitHub Secrets  
✅ **No .env in Git** — Use `.gitignore`  
✅ **API-respecting** — Follows rate limits, doesn't overwhelm servers  
✅ **Service account only** — No user credentials needed  

**Best practices**:
- Keep `GOOGLE_CREDENTIALS` secret
- Don't commit `.env` file
- Rotate service account keys periodically
- Use restricted service account (Sheets editor only)

---

## 📝 Output Format

Each transaction becomes one row with 35 columns:

| Column | Field | Example |
|--------|-------|---------|
| A | cate_id | `"transfer"` |
| B | cex_id | `null` |
| C | chain | `"eth"` |
| D | id | `"0xabc123..."` |
| E | idx | `0` |
| F | is_scam | `false` |
| ... | ... | ... |
| AI | recorded_at | `"08/14/2026 15:30:45"` |

---

## 🎯 Next Steps

- [ ] Configure secrets in GitHub
- [ ] Test workflow with manual trigger
- [ ] Monitor first 3-4 runs
- [ ] Adjust `JITTER_MIN_MS`/`MAX_MS` if rate limited
- [ ] Share sheet with team members

---

## 📞 Support

**Issues?**
1. Check GitHub Actions logs
2. Review this README's **Troubleshooting** section
3. Open an issue in repository

**Rate limit concerns?**
- Review rate limit strategy above
- Adjust config vars
- Contact Rabby support if API is blocking requests

---

## 📄 License

MIT — Feel free to fork, modify, use in your projects

---

## 💡 Tips & Tricks

### Monitor in real-time
```bash
# Watch workflow runs
watch -n 5 'gh run list --workflow rabby-sync.yml | head -20'
```

### Test locally before committing
```bash
npm start
```

### Calculate ETA
```
# With 10 wallets, ~20s per wallet = ~200s total
# Plus jitter and retries = ~3-5 minutes per full sync
```

### Batch import existing data
If migrating from old system:
- Manually append old transactions to sheet first
- Ensure timestamps and format match
- Script will append new transactions without clearing old ones (if you modify)

---

Built with ❤️ for transparent, rate-limit-aware crypto tracking

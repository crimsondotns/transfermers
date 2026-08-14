# 🚀 Rabby Transaction Tracker — GitHub Actions Edition

Track cryptocurrency transaction history from [Rabby Wallet](https://rabby.io) and automatically sync to Google Sheets with **proper rate limit handling** and graceful error recovery.

Designed specifically for **GitHub Actions** — no local setup required, runs on schedule, respects API rate limits.

---

## ✨ Features

✅ **Batch Wallet Support** — Track multiple wallets simultaneously  
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

Create a new Google Sheet with headers in row 1:

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
- `LOG_LEVEL` — `INFO` (default) or `DEBUG` for verbose per-request logs
- `NO_COLOR` — set to disable ANSI colors in logs
- `JITTER_MIN_MS` — Min request spacing, ms (default: `3000`)
- `JITTER_MAX_MS` — Max request spacing, ms (default: `6000`)
- `MAX_DELAY_MS` — Ceiling for adaptive spacing, ms (default: `20000`)
- `RATE_LIMIT_WAIT_MS` — Base cooldown on 429/403 when no `Retry-After`, ms (default: `60000`)
- `MAX_COOLDOWN_MS` — Hard cap on a single cooldown, ms (default: `300000`)
- `MAX_RETRIES` — Max attempts per wallet (default: `10`)
- `MAX_BLOCK_RETRIES` — Max 429/403 cooldowns per wallet before skipping (default: `4`)
- `MAX_TIMEOUT_RETRIES` — Max retries for timeouts (default: `5`)
- `CHUNK_SIZE` — Rows per Google Sheets write (default: `500`)
- `HTTP_USER_AGENT` — Override the request User-Agent (optional)

See `config/example.env` for full template.

---

## 🚀 Usage

### GitHub Actions (Automated)

The workflow runs **every 15 minutes** automatically. Modify the cron in `.github/workflows/rabby-sync.yml`:

```yaml
schedule:
  - cron: '*/15 * * * *'  # Every 15 minutes
  # Other options:
  # - cron: '0 */6 * * *'   # Every 6 hours
  # - cron: '0 2 * * *'     # Daily at 2 AM UTC
```

Trigger manually:
1. Go to **Actions** tab
2. Select **Rabby Transaction Sync** workflow
3. Click **Run workflow**

### Local Testing

```bash
# Install dependencies
npm install

# Copy example config
cp config/example.env .env

# Edit .env with your values

# Run sync
npm start
```

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

### Rate Limiting Strategy

**Respectful and Adaptive.** A single shared throttle governs *all* wallets in a run:

1. **Normal operation** — 3–6s spacing between requests, which **decays** back toward
   the floor after each success.
2. **On 429 / 403** — treated identically as "server is pushing back":
   - **Honor the `Retry-After` header** if the API sends one.
   - Otherwise exponential backoff from a 60s base (capped at 5 min).
   - Open a **shared cooldown window** so the *next* wallet also waits — this stops the
     429 → 403 cascade where one rate-limit hit gets the IP soft-blocked for everything.
   - Widen request spacing for the rest of the run.
   - Give up a wallet after `MAX_BLOCK_RETRIES` cooldowns (the run keeps going).
3. **On timeout** — retry up to 5× with 5–10s backoff, then move on.
4. **One failing wallet never fails the whole run** — it's logged and skipped.

**No bypassing, no tricks — just polite, adaptive throttling that backs off harder the
more the server pushes back.**

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

1. Go to GitHub Settings → Secrets
2. Edit `WALLET_LIST` secret
3. Add comma-separated addresses:
   ```
   0x123...,0xabc...,0xdef...
   ```
4. Save — next run will include all wallets

**Performance Note**: Each wallet takes ~10-30 seconds to fetch. With 10 wallets and 15-minute intervals, you should be fine. With 50+ wallets, consider increasing interval to 30 minutes.

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

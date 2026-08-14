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
- `JITTER_MIN_MS` — Min delay between wallets (default: `2000`)
- `JITTER_MAX_MS` — Max delay between wallets (default: `5000`)
- `RATE_LIMIT_WAIT_MS` — Wait time for rate limits (default: `60000`)
- `MAX_RETRIES` — Max retries per wallet (default: `10`)
- `MAX_429_RETRIES` — Max retries for 429 errors (default: `3`)
- `MAX_TIMEOUT_RETRIES` — Max retries for timeouts (default: `5`)
- `CHUNK_SIZE` — Rows per Google Sheets write (default: `500`)

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

**Respectful and Adaptive:**

1. **Normal operation**: 2-5 second jitter between wallets
2. **On 403 Forbidden**: Double the wait time
3. **On 429 Too Many Requests**: 
   - Wait 60+ seconds (Rabby's request)
   - Retry up to 3 times
   - If persistent, skip wallet gracefully
4. **On Timeout**: 
   - Retry up to 5 times with 5-10s backoff
   - Continue with next wallet

**No bypassing, no tricks — just polite throttling.**

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

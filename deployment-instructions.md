# MOTO-XMR Coordinator Deployment Instructions

**Commit e3486b2 -- Security Hardening Release + MAX_TIMEOUT Contract**

**2026-03-16**

motonero.org

---

## 1. What Changed

Security hardening across 5 audit rounds. 340 tests passing. Encrypted secrets at rest (AES-256-GCM). Rate limiting on all sensitive endpoints. Mnemonic-based swap recovery. Cancel feature for OPEN swaps.

No dependency changes.

> **NEW CONTRACT DEPLOYED.** The SwapVault contract was redeployed with a MAX_TIMEOUT ceiling (1008 blocks / ~7 days). The new contract address is `opt1sqqydn70hapcfgckvq0wnspftu8v8g0z6n5x6v094`. You MUST update `SWAP_CONTRACT_ADDRESS` in the coordinator `.env` and rebuild the frontend with the new `VITE_SWAP_VAULT_ADDRESS`.

---

## 2. Deployment Steps

### Step 1: Back up the database

Before doing anything else, back up the existing database. This is your safety net.

```
cp coordinator/coordinator.db \
    coordinator/coordinator.db.backup-$(date +%Y%m%d-%H%M%S)
```

### Step 2: Stop the running coordinator

Kill the running node process. Press Ctrl+C in its terminal, or:

```
pgrep -f "node.*dist/index.js"
kill <pid>
```

### Step 3: Pull the latest code

```
cd /path/to/moto-xmr-swap
git pull origin master
```

### Step 4: Check ENCRYPTION_KEY in .env

> **CRITICAL**
> The coordinator will REFUSE TO START without ENCRYPTION_KEY. This is a new required variable.

Check if it exists:

```
grep ENCRYPTION_KEY coordinator/.env
```

If it is missing or empty, generate one and add it:

```
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" \
    >> coordinator/.env
```

> **WARNING**
> Once set, NEVER change or delete the ENCRYPTION_KEY. It encrypts all swap secrets in the database. Changing it will make existing encrypted data permanently unrecoverable.

### Step 5: Add TRUST_PROXY=true

Since you are behind Cloudflare Tunnel, this ensures rate limiting uses the real client IP instead of Cloudflare's IP.

```
grep TRUST_PROXY coordinator/.env
```

If missing, add it:

```
echo "TRUST_PROXY=true" >> coordinator/.env
```

### Step 6: Update SWAP_CONTRACT_ADDRESS

> **CRITICAL**
> The contract was redeployed. You MUST update this value.

Open `coordinator/.env` and change:

```
SWAP_CONTRACT_ADDRESS=opt1sqqydn70hapcfgckvq0wnspftu8v8g0z6n5x6v094
```

Verify all values:

```
PORT=3001
CORS_ORIGIN=https://motonero.org
MONERO_MOCK=false
MONERO_NETWORK=mainnet
SWAP_CONTRACT_ADDRESS=opt1sqqydn70hapcfgckvq0wnspftu8v8g0z6n5x6v094
```

> **WARNING**
> Do NOT change ADMIN_API_KEY or ENCRYPTION_KEY if they are already set. Changing them will break access to existing data.

### Step 7: Build the coordinator

```
cd coordinator
npm run build
```

Expected output: just "> tsc" with no errors. Takes about 3 seconds.

> Do NOT run "npm install" - dependencies have not changed. Only run it if the build fails with missing module errors.

### Step 8: Start the coordinator

> **CRITICAL**
> You MUST be in the coordinator/ directory when running this command. Running from the repo root will execute the frontend's dist/index.js instead, which is a completely different program.

```
node -r dotenv/config dist/index.js
```

Verify these lines appear in the startup output:

```
HTTP server listening on port 3001
[OPNet Watcher] Watching contract opt1sqqydn70...
[Monero] Wallet opened: motoxmr-mainnet
```

**Troubleshooting**

- "ENCRYPTION_KEY missing" --> Go back to Step 4
- "Cannot find module" --> Make sure you are in the coordinator/ directory
- "EADDRINUSE" --> Old process still running. Kill it first (Step 2)

### Step 9: Verify it works

From any machine:

```
curl https://coordinator.motonero.org/api/health
```

Expected response:

```
{"success":true,"data":{"status":"ok","walletHealthy":true}}
```

---

## 3. Frontend (Navicosoft)

The frontend zip (frontend-dist-latest.zip) must be **rebuilt** with the new contract address baked in. The coordinator URL, WebSocket URL, and contract addresses are compiled into the JavaScript at build time.

Verify `frontend/.env` has:

```
VITE_SWAP_VAULT_ADDRESS=opt1sqqydn70hapcfgckvq0wnspftu8v8g0z6n5x6v094
```

Then build and deploy:

```
cd frontend
npm run build
```

1. Log into Navicosoft cPanel
2. Navigate to File Manager -> public_html/
3. Upload the new frontend-dist-latest.zip (from `frontend/dist/`)
4. Extract the zip, overwriting existing files

> Users may need to hard-refresh (Ctrl+Shift+R) or clear site data to pick up the new JavaScript files.

---

## 4. Rollback

If something goes wrong, revert to the previous version:

```
# 1. Stop the coordinator (Ctrl+C)

# 2. Restore the database backup
cp coordinator/coordinator.db.backup-YYYYMMDD-HHMMSS \
    coordinator/coordinator.db

# 3. Check out the previous commit
git checkout e3486b2

# 4. Rebuild and restart
cd coordinator
npm run build
node -r dotenv/config dist/index.js
```

> **WARNING**
> Replace YYYYMMDD-HHMMSS with the actual timestamp from your backup in Step 1. You MUST restore the DB backup when rolling back - encrypted fields written by the new code will not work with the old code.

> **NOTE**
> Rolling back the coordinator does NOT roll back the contract. The new SwapVault at `opt1sqqydn70hapcfgckvq0wnspftu8v8g0z6n5x6v094` remains on-chain. To use the old contract, change `SWAP_CONTRACT_ADDRESS` back to the old address in `.env` and rebuild the frontend with the old `VITE_SWAP_VAULT_ADDRESS`. Any swaps created on the new contract will remain on the new contract.

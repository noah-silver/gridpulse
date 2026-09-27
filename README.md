# ⚡ GridPulse

Pay-per-call U.S. energy market data for AI agents. Agents pay per call in **USDC on Algorand or Base** using the [x402](https://www.x402.org) protocol. No signup and no API keys for buyers.

| Endpoint | Price | Returns |
|---|---|---|
| `GET /v1/grid-mix?region=ERCO` | $0.02 | Latest hourly generation mix for a grid region (MWh by fuel, renewable and carbon-free share) |
| `GET /v1/retail-price?state=CT&sector=RES` | $0.01 | Retail electricity price by state and sector, year-over-year change, 12-month history |
| `GET /v1/henry-hub` | $0.01 | Henry Hub natural gas spot price, 30-day stats and history |
| `GET /v1/seller-check?url=…` | $0.01 | **x402 Seller Check:** 0–100 reliability score for any x402 seller (uptime probes, settlement history, age, buyer diversity) |
| `GET /v1/sellers/search?q=weather&maxPrice=0.05` | $0.02 | Find reliable x402 sellers for a task, ranked by Seller Check score |

**Live on Algorand MainNet:** https://noahs-mac-mini.tail571e99.ts.net

Free: `/` (landing page), `/llms.txt` (docs for agents), `/health`.
Data source: U.S. Energy Information Administration (public domain).

Entry for the [Algorand Global x402 Challenge](https://algorand.co/global-x402-challenge) (Composite: three endpoints, one payout address).

## Use it from your agent

Any [x402](https://www.x402.org) client works: call the endpoint, get `402 Payment Required`, pay, retry. The `@x402/fetch` wrapper does all of this automatically.

- OpenAPI spec: https://noahs-mac-mini.tail571e99.ts.net/openapi.json
- Agent docs: https://noahs-mac-mini.tail571e99.ts.net/llms.txt

**Pay with USDC on Base** (`npm i @x402/fetch @x402/evm viem`):
```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const signer = toClientEvmSigner(account, createPublicClient({ chain: base, transport: http() }));
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(signer));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPay("https://noahs-mac-mini.tail571e99.ts.net/v1/grid-mix?region=CISO");
console.log(await res.json());
```

**Pay with USDC on Algorand:** see [`src/pay.ts`](src/pay.ts) (uses `@x402/avm`).

### MCP server (Claude Desktop, Claude Code, Cursor, …)

**One-click (Claude Desktop):** download [`gridpulse-mcp.mcpb`](https://github.com/noah-silver/gridpulse/releases/latest/download/gridpulse-mcp.mcpb), open it, and optionally enter a small spending wallet. Also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.noah-silver/gridpulse) as `io.github.noah-silver/gridpulse`.

Or configure it manually:

Add GridPulse as tools (`grid_mix`, `retail_electricity_price`, `henry_hub_gas_price`). Each tool call pays from **your own** wallet via x402. Use a small, dedicated spending wallet, never your main one.

```json
{
  "mcpServers": {
    "gridpulse": {
      "command": "npx",
      "args": ["-y", "github:noah-silver/gridpulse"],
      "env": { "EVM_PRIVATE_KEY": "0x… (Base wallet holding a little USDC)" }
    }
  }
}
```
Use `ALGORAND_MNEMONIC` instead of (or as well as) `EVM_PRIVATE_KEY` to pay with USDC on Algorand.

---

## Setup guide (Mac mini)

Run each command in **Terminal** on the Mac mini, one at a time.

### 1. Install Node.js
```bash
brew install node
```
If `brew` isn't found, install Homebrew first from https://brew.sh.

### 2. Get the code and install
Copy this `gridpulse` folder onto the Mac mini (AirDrop works), then:
```bash
cd ~/gridpulse
npm install
cp .env.template .env
open -e .env
```

### 3. Fill in `.env`
- **PAY_TO_ADDRESS**: create a **new account** in Pera for receiving payments. Fund it with about 1 ALGO and opt it in to **USDC** (in Pera: Add Asset, then search USDC, asset ID 31566704). Paste its address here.
- **EIA_API_KEY**: free, instant, at https://www.eia.gov/opendata/register.php
- Leave `NETWORK=testnet` for now.

### 4. Run it
```bash
npm start
```
Open http://localhost:4021 to see the landing page. http://localhost:4021/v1/henry-hub should return **402 Payment Required**, which means the paywall is working. Press `Ctrl+C` to stop.

### 5. Give it a public HTTPS address
Pick one:

**Option A: Tailscale Funnel (free, easiest).** You get a permanent URL like `https://mac-mini.tail1234.ts.net`.
```bash
brew install tailscale
```
Sign in, then run:
```bash
tailscale funnel --bg 4021
```

**Option B: Cloudflare Tunnel with your own domain (about $10/yr, looks more professional).** Buy a domain such as `gridpulse.xyz` in Cloudflare, then:
```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create gridpulse
cloudflared tunnel route dns gridpulse api.YOURDOMAIN.com
cloudflared tunnel run --url http://localhost:4021 gridpulse
```

Put the resulting URL in `.env` as `PUBLIC_URL`.

### 6. Switch to MainNet and keep it running 24/7
In `.env`, set `NETWORK=mainnet`. Then:
```bash
npm install -g pm2
pm2 start npm --name gridpulse -- start
pm2 save
pm2 startup
```
(`pm2 startup` prints one more command to copy and run.) In **System Settings → Energy**, turn on "Prevent automatic sleeping" and "Start up automatically after a power failure."

### 7. Make the first real payment (required by the contest)
Create **another new** Pera account as the "buyer." Put about $1 of USDC and 0.3 ALGO in it. Add its 25-word phrase to `.env` as `BUYER_MNEMONIC`.
**Never use the phrase of your main wallet.**
```bash
npm run pay -- "/v1/grid-mix?region=ISNE"
npm run pay -- "/v1/retail-price?state=CT"
npm run pay -- /v1/henry-hub
```
Each settled payment lists that endpoint in the [Bazaar](https://facilitator.goplausible.xyz/discovery/resources) and on the [leaderboard](https://facilitator.goplausible.xyz/dashboard).

### 8. Submit (by September 30)
1. Push this folder to a public GitHub repo. `.env` is git-ignored, so your secrets stay local.
2. Add the repo to [Electric Capital open-dev-data](https://github.com/electric-capital/open-dev-data).
3. Fill in the [submission form](https://fjtqz.share-eu1.hsforms.com/2VnFVCiF_Sg26XP85Jxz_bA).

---

## Technical notes
- `@x402/*` packages are pinned to **2.17.0**, and network IDs are hardcoded in the legacy format that the hosted GoPlausible facilitator currently expects ([x402-foundation/x402#3528](https://github.com/x402-foundation/x402/issues/3528)). Don't upgrade until the facilitator is updated.
- The facilitator pays Algorand network fees. Buyers need only USDC.
- EIA responses are cached for 10 minutes.
- Invalid inputs return 400 and upstream failures return 502. Neither response is settled, so buyers aren't charged.

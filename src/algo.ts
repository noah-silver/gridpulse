// Algorand Insights: network health, account and asset lookups, transaction explainer and a crypto
// market pulse for agents. All sources are free and keyless: Algonode (algod + indexer), Pera's public
// asset verification list, and Coinbase/Kraken public tickers.

const ALGOD = "https://mainnet-api.algonode.cloud";
const INDEXER = "https://mainnet-idx.algonode.cloud";
const PERA = "https://mainnet.api.perawallet.app/v1/public";
const USDC_ASA = 31566704;

const cache = new Map<string, { at: number; data: unknown }>();
async function getJson<T>(url: string, ttlMs: number): Promise<T> {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) throw Object.assign(new Error("not found"), { status: 404 });
    if (!res.ok) throw new Error(`upstream ${new URL(url).host} returned ${res.status}`);
    const data = (await res.json()) as T;
    cache.set(url, { at: Date.now(), data });
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    return data;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const micro = (v: number) => v / 1e6;
export const isAddress = (a: string) => /^[A-Z2-7]{58}$/.test(a);
export const isTxId = (t: string) => /^[A-Z2-7]{52}$/.test(t);

// ---------------------------------------------------------------------------
// Network health
// ---------------------------------------------------------------------------

export async function networkHealth() {
    const status = await getJson<any>(`${ALGOD}/v2/status`, 5_000);
    const last = status["last-round"] as number;
    const [head, past, supply] = await Promise.all([
        getJson<any>(`${INDEXER}/v2/blocks/${last}?header-only=true`, 60_000).catch(() => null),
        getJson<any>(`${INDEXER}/v2/blocks/${last - 100}?header-only=true`, 3_600_000).catch(() => null),
        getJson<any>(`${ALGOD}/v2/ledger/supply`, 60_000),
    ]);
    const secs = head && past ? head.timestamp - past.timestamp : null;
    const txns = head && past ? head["txn-counter"] - past["txn-counter"] : null;
    const online = micro(supply["online-money"]);
    const total = micro(supply["total-money"]);
    return {
        network: "algorand-mainnet",
        lastRound: last,
        secondsSinceLastRound: round(status["time-since-last-round"] / 1e9, 2),
        avgBlockTimeSec: secs ? round(secs / 100, 2) : null,
        tpsLast100Rounds: secs && txns !== null ? round(txns / secs, 1) : null,
        onlineStakeAlgo: Math.round(online),
        totalSupplyAlgo: Math.round(total),
        onlineStakeSharePct: round((100 * online) / total, 1),
        healthy: status["time-since-last-round"] / 1e9 < 15,
        protocolVersion: String(status["last-version"]).split("/").pop(),
        source: "Algonode public algod + indexer",
    };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

async function assetParams(id: number) {
    return (await getJson<any>(`${ALGOD}/v2/assets/${id}`, 3_600_000)).params;
}
async function peraInfo(id: number) {
    return getJson<any>(`${PERA}/assets/${id}/`, 3_600_000).catch(() => null);
}

export async function assetInfo(id: number) {
    const [p, pera] = await Promise.all([assetParams(id), peraInfo(id)]);
    const decimals = p.decimals ?? 0;
    const total = Number(p.total) / 10 ** decimals;
    let reserveHeld: number | null = null;
    if (p.reserve) {
        const bal = await getJson<any>(`${ALGOD}/v2/accounts/${p.reserve}/assets/${id}`, 300_000).catch(() => null);
        reserveHeld = bal ? Number(bal["asset-holding"].amount) / 10 ** decimals : null;
    }
    const flags: string[] = [];
    if (p.clawback) flags.push("clawback_enabled: issuer can take tokens back from holders");
    if (p.freeze) flags.push("freeze_enabled: issuer can freeze holders");
    if (p.manager) flags.push("mutable: manager can change asset roles");
    const tier = pera?.verification_tier ?? "unknown";
    if (tier === "suspicious") flags.push("pera_marked_suspicious");
    return {
        assetId: id,
        name: p.name ?? null,
        unitName: p["unit-name"] ?? null,
        decimals,
        totalSupply: total,
        circulatingSupply: reserveHeld === null ? null : round(total - reserveHeld, decimals),
        creator: p.creator,
        url: p.url ?? null,
        peraVerification: tier,
        usdValue: pera?.usd_value ? Number(pera.usd_value) : null,
        roles: { manager: p.manager ?? null, reserve: p.reserve ?? null, freeze: p.freeze ?? null, clawback: p.clawback ?? null },
        flags,
        source: "Algonode algod; verification tier from Pera Wallet",
    };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function accountSummary(address: string) {
    const a = await getJson<any>(`${ALGOD}/v2/accounts/${address}`, 15_000);
    const holdings = (a.assets ?? []) as { "asset-id": number; amount: number; "is-frozen": boolean }[];
    // Name the first 25 holdings.
    const named = await Promise.all(
        holdings.slice(0, 25).map(async (h) => {
            const p = await assetParams(h["asset-id"]).catch(() => null);
            const d = p?.decimals ?? 0;
            return { assetId: h["asset-id"], name: p?.name ?? null, unitName: p?.["unit-name"] ?? null, amount: h.amount / 10 ** d, frozen: h["is-frozen"] };
        }),
    );
    const usdc = holdings.find((h) => h["asset-id"] === USDC_ASA);
    const balance = micro(a.amount);
    const minBalance = micro(a["min-balance"] ?? 0);
    return {
        address,
        algoBalance: balance,
        minBalanceAlgo: minBalance,
        spendableAlgo: round(Math.max(0, balance - minBalance), 6),
        canPayFees: balance - minBalance >= 0.001,
        usdc: { optedIn: !!usdc, balance: usdc ? usdc.amount / 1e6 : 0, canReceive: !!usdc && !usdc["is-frozen"] },
        consensus: { online: a.status === "Online", incentiveEligible: !!a["incentive-eligible"] },
        rekeyedTo: a["auth-addr"] ?? null,
        assetsOptedIn: holdings.length,
        appsOptedIn: a["total-apps-opted-in"] ?? a["apps-local-state"]?.length ?? 0,
        assets: named,
        assetsTruncated: holdings.length > 25,
        round: a.round,
        source: "Algonode public algod",
    };
}

// ---------------------------------------------------------------------------
// Transaction explainer
// ---------------------------------------------------------------------------

function decodeNote(b64?: string) {
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    const text = buf.toString("utf8");
    return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(text) && !text.includes("�") ? text.slice(0, 1000) : `0x${buf.toString("hex").slice(0, 200)}`;
}

async function describe(t: any): Promise<Record<string, unknown>> {
    const base = { type: t["tx-type"], sender: t.sender, feeAlgo: micro(t.fee ?? 0) };
    switch (t["tx-type"]) {
        case "pay": {
            const p = t["payment-transaction"];
            return { ...base, summary: `${t.sender.slice(0, 6)}… paid ${micro(p.amount)} ALGO to ${p.receiver.slice(0, 6)}…`, receiver: p.receiver, amountAlgo: micro(p.amount), closeTo: p["close-remainder-to"] ?? null };
        }
        case "axfer": {
            const x = t["asset-transfer-transaction"];
            const p = await assetParams(x["asset-id"]).catch(() => null);
            const amount = x.amount / 10 ** (p?.decimals ?? 0);
            const unit = p?.["unit-name"] ?? `ASA ${x["asset-id"]}`;
            const optIn = x.amount === 0 && x.receiver === t.sender;
            return {
                ...base,
                summary: optIn ? `${t.sender.slice(0, 6)}… opted in to ${unit}` : `${t.sender.slice(0, 6)}… sent ${amount} ${unit} to ${x.receiver.slice(0, 6)}…`,
                assetId: x["asset-id"], assetName: p?.name ?? null, unitName: unit, amount, receiver: x.receiver, optIn,
            };
        }
        case "appl": {
            const a = t["application-transaction"];
            return { ...base, summary: `${t.sender.slice(0, 6)}… called app ${a["application-id"] || "(create)"} (${a["on-completion"]})`, appId: a["application-id"], onCompletion: a["on-completion"], innerTransactions: (t["inner-txns"] ?? []).length };
        }
        case "acfg":
            return { ...base, summary: `${t.sender.slice(0, 6)}… configured asset ${t["asset-config-transaction"]["asset-id"] || t["created-asset-index"]}` };
        case "keyreg": {
            const k = t["keyreg-transaction"];
            return { ...base, summary: `${t.sender.slice(0, 6)}… went ${k["vote-participation-key"] ? "online (staking)" : "offline"}` };
        }
        default:
            return { ...base, summary: `${t["tx-type"]} transaction from ${t.sender.slice(0, 6)}…` };
    }
}

export async function explainTx(txId: string) {
    const t = (await getJson<any>(`${INDEXER}/v2/transactions/${txId}`, 3_600_000)).transaction;
    const d = await describe(t);
    const inner = await Promise.all((t["inner-txns"] ?? []).slice(0, 10).map(describe));
    return {
        txId,
        confirmedRound: t["confirmed-round"],
        timeUtc: new Date(t["round-time"] * 1000).toISOString(),
        ...d,
        group: t.group ?? null,
        note: decodeNote(t.note),
        rekeyTo: t["rekey-to"] ?? null,
        innerTransactions: inner,
        source: "Algonode public indexer",
    };
}

// ---------------------------------------------------------------------------
// Market pulse: two independent exchanges, cross-checked
// ---------------------------------------------------------------------------

const PULSE = [
    { symbol: "ALGO", coinbase: "ALGO-USD", kraken: "ALGOUSD" },
    { symbol: "BTC", coinbase: "BTC-USD", kraken: "XBTUSD" },
    { symbol: "ETH", coinbase: "ETH-USD", kraken: "ETHUSD" },
    { symbol: "SOL", coinbase: "SOL-USD", kraken: "SOLUSD" },
    { symbol: "USDC", coinbase: "USDC-USD", kraken: "USDCUSD" },
];

export async function marketPulse() {
    const kraken = await getJson<any>(`https://api.kraken.com/0/public/Ticker?pair=${PULSE.map((p) => p.kraken).join(",")}`, 20_000).catch(() => null);
    const kr = (pair: string) => {
        const r = kraken?.result ?? {};
        const k = Object.keys(r).find((x) => x.replace(/^X|Z(?=USD$)/g, "").replace("XBT", "BTC") === pair.replace("XBT", "BTC") || x === pair || x.endsWith(pair.slice(-6)));
        return k ? Number(r[k].c[0]) : null;
    };
    const assets = await Promise.all(
        PULSE.map(async (p) => {
            const cb = await getJson<any>(`https://api.exchange.coinbase.com/products/${p.coinbase}/stats`, 20_000).catch(() => null);
            const cbLast = cb ? Number(cb.last) : null;
            const krLast = kr(p.kraken);
            const prices = [cbLast, krLast].filter((x): x is number => x !== null && isFinite(x) && x > 0);
            const price = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
            const open = cb ? Number(cb.open) : null;
            return {
                symbol: p.symbol,
                priceUsd: price === null ? null : round(price, price < 10 ? 6 : 2),
                change24hPct: price && open ? round((100 * (price - open)) / open, 2) : null,
                high24h: cb ? Number(cb.high) : null,
                low24h: cb ? Number(cb.low) : null,
                volume24h: cb ? Number(cb.volume) : null,
                sourceSpreadPct: prices.length === 2 ? round((100 * Math.abs(prices[0] - prices[1])) / price!, 3) : null,
                sources: [cbLast !== null && "coinbase", krLast !== null && "kraken"].filter(Boolean),
            };
        }),
    );
    const usdc = assets.find((a) => a.symbol === "USDC");
    return {
        asOf: new Date().toISOString(),
        assets,
        usdcPegDeviationPct: usdc?.priceUsd ? round(100 * (usdc.priceUsd - 1), 3) : null,
        source: "Coinbase Exchange and Kraken public tickers (averaged when both respond)",
    };
}

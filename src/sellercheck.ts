// x402 Seller Check: reliability scores for x402 sellers, so agents can check a seller before paying it.
//
// Signals (all from free public sources):
//  - Catalog: GoPlausible Bazaar discovery (price, networks, settlements, first/last seen), synced hourly.
//  - Uptime: our own unpaid probes. GET endpoints are probed directly (a healthy x402 GET returns 402 with
//    payment requirements and costs nothing). Non-GET endpoints are never called, since a POST could trigger
//    a real action; they get a host-level check instead (any GET resource on the same host, or its origin).
//  - Buyer diversity (Algorand payTo only): unique payers and top-payer share of recent USDC receipts,
//    from the public Algorand indexer. Heavy concentration suggests self-generated volume.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

const FACILITATOR = "https://facilitator.goplausible.xyz";
const INDEXER = "https://mainnet-idx.algonode.cloud";
const UA = `GridPulse-SellerCheck/1.0 (+${process.env.PUBLIC_URL ?? "https://github.com/noah-silver/gridpulse"})`;
const USDC: Record<string, string> = {
    "31566704": "USDC (Algorand)",
    "10458941": "USDC (Algorand TestNet)",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "USDC (Base)",
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e": "USDC (Base Sepolia)",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC (Solana)",
};
const MAINNETS = new Set(["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);

mkdirSync("data", { recursive: true });
const db = new DatabaseSync(process.env.SELLERS_DB_PATH ?? "data/sellers.db");
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS resources (
    url TEXT PRIMARY KEY, method TEXT, host TEXT, description TEXT, accepts TEXT,
    settle_count INTEGER, first_seen TEXT, last_seen TEXT, synced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS probes (
    target TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL, status INTEGER, latency_ms INTEGER, note TEXT
  );
  CREATE INDEX IF NOT EXISTS probes_target_at ON probes (target, at);
`);

type Accept = { scheme: string; network: string; amount?: string; maxAmountRequired?: string; asset: string; payTo: string; extra?: { decimals?: number } };
type Resource = { url: string; method: string; host: string; description: string; accepts: Accept[]; settle_count: number; first_seen: string; last_seen: string };

const now = () => new Date().toISOString();
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

// ---------------------------------------------------------------------------
// Catalog sync
// ---------------------------------------------------------------------------

export async function syncCatalog() {
    const upsert = db.prepare(`INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET method=excluded.method, host=excluded.host, description=excluded.description,
      accepts=excluded.accepts, settle_count=excluded.settle_count, first_seen=excluded.first_seen,
      last_seen=excluded.last_seen, synced_at=excluded.synced_at`);
    const stamp = now();
    let n = 0;
    for (let offset = 0; ; offset += 1000) {
        const res = await fetch(`${FACILITATOR}/discovery/resources?limit=1000&offset=${offset}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`catalog sync failed (${res.status})`);
        const page = (await res.json()) as { items: any[]; pagination: { total: number } };
        for (const x of page.items) {
            upsert.run(x.resourceUrl, x.method, hostOf(x.resourceUrl), x.description ?? "", JSON.stringify(x.accepts ?? []),
                x.settleCount ?? 0, x.firstSeen ?? null, x.lastSeen ?? null, stamp);
            n++;
        }
        if (offset + 1000 >= page.pagination.total || !page.items.length) break;
    }
    // Drop resources that vanished from the catalog more than a day ago.
    db.prepare(`DELETE FROM resources WHERE synced_at < datetime('now','-1 day')`).run();
    return n;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

async function probe(url: string) {
    const t0 = Date.now();
    try {
        const res = await fetch(url, { method: "GET", headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        const latency = Date.now() - t0;
        await res.body?.cancel();
        const has402Header = !!(res.headers.get("payment-required") || res.headers.get("x-payment-required"));
        // A live x402 endpoint answers 402; plain 2xx means it's up but not paywalled (e.g. a host origin).
        const ok = res.status === 402 || (res.status >= 200 && res.status < 400);
        return { ok, status: res.status, latency, note: res.status === 402 ? (has402Header ? "x402" : "402") : "" };
    } catch (e) {
        return { ok: false, status: 0, latency: Date.now() - t0, note: (e as Error).name === "TimeoutError" ? "timeout" : "unreachable" };
    }
}

// Probe targets: every GET resource, plus one target per host that has no GET resource.
function probeTargets() {
    const rows = db.prepare(`SELECT url, method, host FROM resources`).all() as { url: string; method: string; host: string }[];
    const targets = new Map<string, string>(); // target url -> host
    const hostsWithGet = new Set<string>();
    for (const r of rows) if (r.method === "GET") { targets.set(r.url, r.host); hostsWithGet.add(r.host); }
    for (const r of rows) if (!hostsWithGet.has(r.host) && r.host) targets.set(`https://${r.host}/`, r.host);
    return [...targets.entries()];
}

// One request at a time per host, a few hosts in parallel, so no seller sees a burst from us.
export async function probeAll() {
    const byHost = new Map<string, string[]>();
    for (const [url, host] of probeTargets()) byHost.set(host, [...(byHost.get(host) ?? []), url]);
    const insert = db.prepare(`INSERT INTO probes VALUES (?,?,?,?,?,?)`);
    const hosts = [...byHost.values()];
    let done = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
        for (let urls = hosts.shift(); urls; urls = hosts.shift()) {
            let failStreak = 0;
            let last: Awaited<ReturnType<typeof probe>> | undefined;
            for (const url of urls) {
                // After 3 straight failures the host is down: record the rest without contacting it again.
                const p = failStreak >= 3 ? { ...last!, latency: 0, note: `host_down:${last!.note || last!.status}` } : await probe(url);
                insert.run(url, now(), p.ok ? 1 : 0, p.status, p.latency, p.note);
                failStreak = p.ok ? 0 : failStreak + 1;
                last = p;
                done++;
                if (failStreak <= 3) await new Promise((r) => setTimeout(r, 250));
            }
        }
    }));
    db.prepare(`DELETE FROM probes WHERE at < datetime('now','-8 days')`).run();
    return done;
}

// ---------------------------------------------------------------------------
// Buyer diversity (Algorand)
// ---------------------------------------------------------------------------

const diversityCache = new Map<string, { at: number; value: unknown }>();
async function algorandBuyerDiversity(payTo: string, asset: string) {
    const k = `${payTo}:${asset}`;
    const hit = diversityCache.get(k);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.value as ReturnType<typeof summarize>;
    const res = await fetch(`${INDEXER}/v2/accounts/${payTo}/transactions?asset-id=${asset}&tx-type=axfer&limit=1000`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const txns = ((await res.json()) as { transactions?: any[] }).transactions ?? [];
    const value = summarize(txns.filter((t) => t["asset-transfer-transaction"]?.receiver === payTo && t["asset-transfer-transaction"].amount > 0).map((t) => t.sender as string));
    diversityCache.set(k, { at: Date.now(), value });
    return value;
}
function summarize(payers: string[]) {
    const counts = new Map<string, number>();
    for (const p of payers) counts.set(p, (counts.get(p) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    return {
        recentPayments: payers.length,
        uniquePayers: counts.size,
        topPayerSharePct: payers.length ? Math.round((1000 * top) / payers.length) / 10 : null,
    };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function uptime(target: string, hours: number) {
    const r = db.prepare(`SELECT COUNT(*) n, SUM(ok) up, CAST(AVG(CASE WHEN ok=1 THEN latency_ms END) AS INTEGER) lat
      FROM probes WHERE target = ? AND at >= ?`).get(target, new Date(Date.now() - hours * 3_600_000).toISOString()) as { n: number; up: number | null; lat: number | null };
    return { probes: r.n, uptimePct: r.n ? Math.round((1000 * (r.up ?? 0)) / r.n) / 10 : null, avgLatencyMs: r.lat };
}
function lastProbe(target: string) {
    return db.prepare(`SELECT at, ok, status, latency_ms, note FROM probes WHERE target = ? ORDER BY at DESC LIMIT 1`).get(target) as
        { at: string; ok: number; status: number; latency_ms: number; note: string } | undefined;
}
const priceOf = (a: Accept) => {
    const atomic = Number(a.amount ?? a.maxAmountRequired ?? NaN);
    const decimals = a.extra?.decimals ?? (USDC[a.asset] ? 6 : undefined);
    return {
        network: a.network,
        mainnet: MAINNETS.has(a.network),
        asset: USDC[a.asset] ?? a.asset,
        priceUsd: USDC[a.asset] && decimals !== undefined && isFinite(atomic) ? atomic / 10 ** decimals : null,
        payTo: a.payTo,
    };
};

function resourceByUrl(url: string) {
    const clean = url.split("?")[0].replace(/\/$/, "");
    const r = (db.prepare(`SELECT * FROM resources WHERE url = ? OR url = ?`).get(clean, clean + "/") ??
        db.prepare(`SELECT * FROM resources WHERE url = ?`).get(url)) as any;
    return r ? ({ ...r, accepts: JSON.parse(r.accepts) } as Resource) : undefined;
}

export async function checkSeller(url: string) {
    const r = resourceByUrl(url);
    const host = hostOf(url);
    if (!host) return { error: "url must be a full https URL of an x402 resource" };
    // Same target choice as probeTargets(): the resource itself if GET, else a GET resource on its host, else the origin.
    const probeTarget = r?.method === "GET" ? r.url
        : (db.prepare(`SELECT url FROM resources WHERE host = ? AND method = 'GET' LIMIT 1`).get(host) as { url: string } | undefined)?.url ?? `https://${host}/`;
    const d1 = uptime(probeTarget, 24), d7 = uptime(probeTarget, 24 * 7);
    const last = lastProbe(probeTarget);
    const prices = (r?.accepts ?? []).map(priceOf);
    const algo = prices.find((p) => p.network.startsWith("algorand:") && p.mainnet);
    const algoAsset = r?.accepts.find((a) => a.network === algo?.network)?.asset;
    const diversity = algo && algoAsset && /^\d+$/.test(algoAsset) ? await algorandBuyerDiversity(algo.payTo, algoAsset).catch(() => null) : null;
    const ageDays = r?.first_seen ? Math.floor((Date.now() - Date.parse(r.first_seen)) / 86_400_000) : null;

    const flags: string[] = [];
    if (!r) flags.push("not_in_bazaar");
    if (r && r.method !== "GET") flags.push("host_level_uptime_only");
    if (last && !last.ok) flags.push("down_at_last_check");
    if (d7.uptimePct !== null && d7.uptimePct < 95) flags.push("uptime_below_95pct");
    if (r && r.settle_count < 5) flags.push("few_settlements");
    if (ageDays !== null && ageDays < 7) flags.push("new_seller");
    if (prices.length && !prices.some((p) => p.mainnet)) flags.push("testnet_only");
    if (diversity && diversity.recentPayments >= 20 && (diversity.topPayerSharePct ?? 0) >= 80) flags.push("buyer_concentration_high");
    if (!d7.probes) flags.push("not_yet_monitored");

    // 0-100: uptime 40, currently up 15, settlement history 15, buyer diversity 15, age 10, latency 5.
    let score = 0;
    score += d7.uptimePct === null ? 20 : (40 * d7.uptimePct) / 100;
    score += last ? (last.ok ? 15 : 0) : 7;
    score += r ? Math.min(15, (15 * Math.log10(1 + r.settle_count)) / 3) : 0;
    score += diversity ? (diversity.topPayerSharePct === null ? 7 : 15 * (1 - diversity.topPayerSharePct / 100) + (diversity.uniquePayers >= 10 ? 0 : -3)) : 7;
    score += ageDays === null ? 0 : Math.min(10, ageDays / 9);
    score += d7.avgLatencyMs === null ? 2 : d7.avgLatencyMs < 800 ? 5 : d7.avgLatencyMs < 2500 ? 3 : 0;
    score = Math.max(0, Math.min(100, Math.round(score)));

    return {
        url,
        host,
        score,
        verdict: score >= 75 && !flags.includes("down_at_last_check") ? "looks_reliable" : score >= 50 ? "use_with_caution" : "avoid",
        flags,
        listing: r ? { method: r.method, description: r.description.slice(0, 300), settlements: r.settle_count, firstSeen: r.first_seen, lastSettled: r.last_seen, ageDays } : null,
        paymentOptions: prices,
        uptime: { last24h: d1, last7d: d7, lastCheck: last ? { at: last.at, ok: !!last.ok, httpStatus: last.status, latencyMs: last.latency_ms } : null, target: probeTarget },
        buyerDiversity: diversity ? { network: "algorand", ...diversity } : null,
        method: "Score 0-100: uptime 40, up at last check 15, settlement history 15, buyer diversity 15, age 10, latency 5. Unpaid probes only; we never call non-GET endpoints.",
        checkedAt: now(),
    };
}

// Search the catalog for sellers matching a task, ranked by score.
export async function searchSellers(q: string, opts: { network?: string; maxPriceUsd?: number; limit?: number }) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
    if (!words.length) return { error: "q is required" };
    const rows = (db.prepare(`SELECT url FROM resources`).all() as { url: string }[]).map((x) => resourceByUrl(x.url)!);
    const matches = rows
        .map((r) => ({ r, hits: words.filter((w) => `${r.url} ${r.description}`.toLowerCase().includes(w)).length }))
        .filter((m) => m.hits > 0)
        .filter(({ r }) => r.accepts.map(priceOf).some((p) => p.mainnet
            && (!opts.network || p.network.startsWith(opts.network))
            && (opts.maxPriceUsd === undefined || (p.priceUsd !== null && p.priceUsd <= opts.maxPriceUsd))))
        .sort((a, b) => b.hits - a.hits || b.r.settle_count - a.r.settle_count)
        .slice(0, 25);
    const scored = [];
    for (const { r } of matches) {
        const c = await checkSeller(r.url);
        if ("score" in c && typeof c.score === "number") scored.push({ url: r.url, method: r.method, score: c.score, verdict: c.verdict, flags: c.flags, paymentOptions: c.paymentOptions, description: r.description.slice(0, 200) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { query: q, results: scored.slice(0, Math.min(20, opts.limit ?? 10)), catalogSize: rows.length, checkedAt: now() };
}

export function catalogStats() {
    const r = db.prepare(`SELECT COUNT(*) resources, COUNT(DISTINCT host) hosts FROM resources`).get() as { resources: number; hosts: number };
    const p = db.prepare(`SELECT COUNT(*) n, MAX(at) last FROM probes`).get() as { n: number; last: string | null };
    return { ...r, probes: p.n, lastProbeAt: p.last };
}

// Background jobs: catalog hourly, probes every 3 hours.
export function startSellerJobs(log = console.log) {
    const run = async (name: string, fn: () => Promise<number>) => {
        try { log(`[seller-check] ${name}: ${await fn()}`); } catch (e) { log(`[seller-check] ${name} failed: ${(e as Error).message}`); }
    };
    (async () => { await run("catalog synced", syncCatalog); await run("probes run", probeAll); })();
    setInterval(() => run("catalog synced", syncCatalog), 3_600_000).unref();
    setInterval(() => run("probes run", probeAll), 3 * 3_600_000).unref();
}

// GridPulse — pay-per-call U.S. energy market data for AI agents.
// Payments: USDC on Algorand (and optionally Base) via x402, settled by the GoPlausible facilitator.

import "dotenv/config"; // first, so every module sees .env at import time
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import { pro } from "./pro.js";
import { checkSeller, searchSellers, startSellerJobs } from "./sellercheck.js";
import { gridMix, retailPrice, henryHub, GRID_REGIONS, SECTORS, STATES } from "./eia.js";


// Network IDs are hardcoded in the legacy format the hosted GoPlausible facilitator
// still expects (see x402-foundation/x402#3528). Keep @x402/* pinned at 2.17.0.
const NETWORKS = {
    mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
} as const;
const BASE_NETWORKS = { mainnet: "eip155:8453", testnet: "eip155:84532" } as const;

const payTo = process.env.PAY_TO_ADDRESS;
const networkName = (process.env.NETWORK ?? "testnet") as keyof typeof NETWORKS;
const basePayTo = process.env.BASE_PAY_TO_ADDRESS || undefined; // optional: also accept USDC on Base
const PAYMENT_NOTE = `Accepts USDC on Algorand${basePayTo ? " or Base" : ""} (${process.env.NETWORK ?? "testnet"}).`;
const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const port = Number(process.env.PORT ?? 4021);

if (!payTo) {
    console.error("❌ PAY_TO_ADDRESS is missing. Copy .env.template to .env and fill it in.");
    process.exit(1);
}
if (!(networkName in NETWORKS)) {
    console.error('❌ NETWORK must be "testnet" or "mainnet".');
    process.exit(1);
}
const network = NETWORKS[networkName];
const baseNetwork = BASE_NETWORKS[networkName];

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
    .register(network, new ExactAvmScheme());
if (basePayTo) server.register(baseNetwork, new ExactEvmScheme());
server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

// ---------------------------------------------------------------------------
// Paid endpoints: price, description (shown to agents in the Bazaar), discovery schema
// ---------------------------------------------------------------------------

const ENDPOINTS = [
    {
        route: "GET /v1/grid-mix",
        price: "$0.01",
        description:
            "Latest hourly U.S. power grid generation mix for a balancing authority (ISO New England, PJM, ERCOT, CAISO, MISO, NYISO, SPP and more): MWh by fuel, % share, renewable and carbon-free share. Source: U.S. EIA.",
        discovery: declareDiscoveryExtension({
            input: { region: "ERCO" },
            inputSchema: {
                properties: {
                    region: { type: "string", enum: Object.keys(GRID_REGIONS), description: "Balancing authority code" },
                },
                required: ["region"],
            },
            output: {
                example: {
                    region: "ERCO",
                    regionName: "ERCOT (Texas)",
                    hourUtc: "2026-09-26T03:00Z",
                    totalGenerationMwh: 52110,
                    renewableSharePct: 38.4,
                    carbonFreeSharePct: 48.2,
                    fuels: [{ code: "NG", fuel: "Natural Gas", mwh: 24100, sharePct: 46.2 }],
                    source: "U.S. EIA Hourly Electric Grid Monitor",
                },
            },
        }),
    },
    {
        route: "GET /v1/retail-price",
        price: "$0.005",
        description:
            "Latest average retail electricity price for any U.S. state (cents/kWh) by sector (residential, commercial, industrial), with year-over-year change and 12-month history. Source: U.S. EIA.",
        discovery: declareDiscoveryExtension({
            input: { state: "CT", sector: "RES" },
            inputSchema: {
                properties: {
                    state: { type: "string", description: "Two-letter U.S. state code, or US for national average" },
                    sector: { type: "string", enum: Object.keys(SECTORS), description: "Defaults to RES" },
                },
                required: ["state"],
            },
            output: {
                example: {
                    state: "CT",
                    stateName: "Connecticut",
                    sector: "residential",
                    month: "2026-07",
                    priceCentsPerKwh: 24.16,
                    yearAgoCentsPerKwh: 23.5,
                    yoyChangePct: 2.8,
                    source: "U.S. EIA Electric Power Monthly (retail sales)",
                },
            },
        }),
    },
    {
        route: "GET /v1/henry-hub",
        price: "$0.005",
        description:
            "Henry Hub natural gas spot price ($/MMBtu): latest daily price plus 30-trading-day average, min, max, % change and full history. Source: U.S. EIA.",
        discovery: declareDiscoveryExtension({
            output: {
                example: {
                    hub: "Henry Hub (Louisiana)",
                    date: "2026-09-22",
                    spotUsdPerMmbtu: 2.9,
                    avgLast30TradingDays: 2.87,
                    changeOverPeriodPct: 4.1,
                    source: "U.S. EIA Natural Gas Spot Prices",
                },
            },
        }),
    },
    {
        route: "GET /v1/seller-check",
        price: "$0.002",
        description:
            "Check an x402 seller before you pay it: 0-100 reliability score and verdict from independent uptime probes (24h/7d), Bazaar settlement history, seller age, latency and buyer diversity (share of volume from the top payer, to spot self-generated volume). Returns price and payTo per network.",
        discovery: declareDiscoveryExtension({
            input: { url: "https://agent402.tools/api/weather-forecast" },
            inputSchema: {
                properties: { url: { type: "string", description: "Full URL of the x402 resource you plan to pay" } },
                required: ["url"],
            },
            output: {
                example: {
                    url: "https://agent402.tools/api/weather-forecast",
                    score: 82,
                    verdict: "looks_reliable",
                    flags: [],
                    uptime: { last7d: { probes: 56, uptimePct: 100, avgLatencyMs: 310 } },
                    buyerDiversity: { network: "algorand", recentPayments: 400, uniquePayers: 37, topPayerSharePct: 22.5 },
                },
            },
        }),
    },
    {
        route: "GET /v1/sellers/search",
        price: "$0.005",
        description:
            "Find reliable x402 sellers for a task: keyword search across the Bazaar (2,000+ paid endpoints), filtered by network and max price, ranked by the GridPulse Seller Check reliability score.",
        discovery: declareDiscoveryExtension({
            input: { q: "weather forecast", network: "algorand", maxPrice: "0.05" },
            inputSchema: {
                properties: {
                    q: { type: "string", description: "What you need, e.g. 'weather forecast' or 'token price'" },
                    network: { type: "string", enum: ["algorand", "eip155", "solana"], description: "Optional payment network family" },
                    maxPrice: { type: "string", description: "Optional max price per call in USD, e.g. 0.01" },
                    limit: { type: "string", description: "Optional, 1-20 (default 10)" },
                },
                required: ["q"],
            },
            output: { example: { query: "weather forecast", results: [{ url: "https://example.com/weather", score: 82, verdict: "looks_reliable", flags: [] }] } },
        }),
    },
];

const app = new Hono();
app.route("/", pro); // API-key subscriptions (pricing, checkout, /api/v2)

app.use(
    paymentMiddleware(
        Object.fromEntries(
            ENDPOINTS.map((e) => [
                e.route,
                {
                    accepts: [
                        {
                            scheme: "exact",
                            price: e.price,
                            network,
                            payTo,
                            extra: { tag: "x402-global-challenge" },
                        },
                        ...(basePayTo
                            ? [{ scheme: "exact", price: e.price, network: baseNetwork, payTo: basePayTo }]
                            : []),
                    ],
                    // Behind a proxy (Tailscale/Cloudflare) the request URL is plain http, so advertise the public one
                    resource: publicUrl ? publicUrl + e.route.split(" ")[1] : undefined,
                    description: e.description,
                    mimeType: "application/json",
                    extensions: e.discovery,
                },
            ]),
        ),
        server,
    ),
);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

app.get("/v1/grid-mix", async (c) => {
    const region = (c.req.query("region") ?? "").toUpperCase();
    if (!GRID_REGIONS[region]) {
        return c.json({ error: "Unknown region", validRegions: GRID_REGIONS }, 400);
    }
    return c.json(await gridMix(region));
});

app.get("/v1/retail-price", async (c) => {
    const state = (c.req.query("state") ?? "").toUpperCase();
    const sector = (c.req.query("sector") ?? "RES").toUpperCase();
    if (!STATES.has(state)) return c.json({ error: "state must be a two-letter U.S. state code or US" }, 400);
    if (!SECTORS[sector]) return c.json({ error: "Unknown sector", validSectors: SECTORS }, 400);
    return c.json(await retailPrice(state, sector));
});

app.get("/v1/henry-hub", async (c) => c.json(await henryHub()));

app.get("/v1/seller-check", async (c) => {
    const url = c.req.query("url") ?? "";
    if (!/^https?:\/\/[^\s/]+/.test(url) || url.length > 2000) return c.json({ error: "url must be a full http(s) URL" }, 400);
    return c.json(await checkSeller(url));
});

app.get("/v1/sellers/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    const network = c.req.query("network");
    const maxPrice = c.req.query("maxPrice");
    const limit = Number(c.req.query("limit") ?? 10);
    if (!q) return c.json({ error: "q is required" }, 400);
    if (network && !["algorand", "eip155", "solana"].includes(network)) return c.json({ error: "network must be algorand, eip155 or solana" }, 400);
    if (maxPrice !== undefined && !(Number(maxPrice) > 0)) return c.json({ error: "maxPrice must be a positive number" }, 400);
    return c.json(await searchSellers(q, { network, maxPriceUsd: maxPrice ? Number(maxPrice) : undefined, limit: Math.max(1, Math.min(20, limit || 10)) }));
});

app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Upstream data source unavailable, please retry shortly" }, 502);
});

// ---------------------------------------------------------------------------
// Free pages: health check, landing page (OpenGraph metadata), agent-readable docs
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ status: "ok", network: networkName }));

const TITLE = "GridPulse — U.S. energy market data for AI agents";
const SUMMARY =
    "Pay-per-call U.S. power grid mix, retail electricity prices and Henry Hub natural gas prices. No signup or API key: agents pay per call in USDC via x402.";

// OpenAPI 3.1 spec built from ENDPOINTS so agent frameworks can generate tools automatically
app.get("/openapi.json", (c) => {
    const paths: Record<string, unknown> = {};
    for (const e of ENDPOINTS) {
        const [method, path] = e.route.split(" ");
        const bazaar = (e.discovery as any).bazaar;
        const qp = bazaar.schema.properties.input.properties.queryParams ?? { properties: {}, required: [] };
        paths[path] = {
            [method.toLowerCase()]: {
                summary: e.description.split(":")[0],
                description: `${e.description}\n\nPrice: ${e.price} USDC per call, paid via x402 (HTTP 402).`,
                parameters: Object.entries(qp.properties as Record<string, any>).map(([name, schema]) => ({
                    name,
                    in: "query",
                    required: (qp.required ?? []).includes(name),
                    description: schema.description,
                    schema: { type: schema.type, ...(schema.enum ? { enum: schema.enum } : {}) },
                    ...(bazaar.info.input.queryParams?.[name] ? { example: bazaar.info.input.queryParams[name] } : {}),
                })),
                responses: {
                    "200": { description: "Data", content: { "application/json": { example: bazaar.info.output.example } } },
                    "400": { description: "Invalid input (not charged)" },
                    "402": { description: "Payment required: x402 payment requirements in the PAYMENT-REQUIRED header" },
                    "502": { description: "Upstream data source unavailable (not charged)" },
                },
                "x-price-usd": e.price,
            },
        };
    }
    return c.json({
        openapi: "3.1.0",
        info: { title: "GridPulse", version: "1.0.0", description: `${SUMMARY} ${PAYMENT_NOTE}` },
        servers: [{ url: publicUrl || `http://localhost:${port}` }],
        paths,
    });
});

app.get("/llms.txt", (c) =>
    c.text(
        [
            `# GridPulse`,
            ``,
            `> ${SUMMARY}`,
            ``,
            `All paid endpoints return HTTP 402 with x402 payment requirements. ${PAYMENT_NOTE} Use any x402 client to pay and retry automatically. OpenAPI spec: ${publicUrl}/openapi.json`,
            ``,
            `## Endpoints`,
            ...ENDPOINTS.map((e) => {
                const [method, path] = e.route.split(" ");
                return `- ${method} ${publicUrl}${path} (${e.price} USDC): ${e.description}`;
            }),
            ``,
            `Grid regions: ${Object.entries(GRID_REGIONS).map(([k, v]) => `${k} (${v})`).join(", ")}`,
            `Sectors: ${Object.entries(SECTORS).map(([k, v]) => `${k} (${v})`).join(", ")}`,
        ].join("\n"),
    ),
);

app.get("/", (c) =>
    c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${SUMMARY}">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${SUMMARY}">
<meta property="og:type" content="website">
${publicUrl ? `<meta property="og:url" content="${publicUrl}/">` : ""}
<meta name="twitter:card" content="summary">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
<style>
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; color: #1b1f24; }
  h1 { font-size: 30px; margin-bottom: 4px; } .sub { color: #57606a; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 20px 0; }
  td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid #d8dee4; vertical-align: top; }
  code { background: #f3f4f6; padding: 2px 5px; border-radius: 4px; font-size: 14px; }
  .price { white-space: nowrap; font-weight: 600; }
</style>
</head>
<body>
<h1>⚡ GridPulse</h1>
<p class="sub">${SUMMARY}</p>
<p><b>Need hourly grid carbon intensity or Scope 2 factors for your team?</b> <a href="/pricing">See API plans (free tier available) →</a></p>
<h2 style="font-size:20px">Pay-per-call for AI agents (x402)</h2>
<table>
<tr><th>Endpoint</th><th>Price</th><th>Returns</th></tr>
${ENDPOINTS.map((e) => `<tr><td><code>${e.route}</code></td><td class="price">${e.price}</td><td>${e.description}</td></tr>`).join("\n")}
</table>
<p>Example: <code>GET /v1/grid-mix?region=ISNE</code> · <code>GET /v1/retail-price?state=TX&amp;sector=COM</code></p>
<p>Payments are USDC on Algorand${basePayTo ? " or Base" : ""} (${networkName}) using the <a href="https://www.x402.org">x402</a> protocol. Machine-readable docs: <a href="/llms.txt">/llms.txt</a> · <a href="/openapi.json">/openapi.json</a>.</p>
<p>Data: U.S. Energy Information Administration (public domain). Not investment advice.</p>
</body>
</html>`),
);

startSellerJobs();
serve({ fetch: app.fetch, port }, () => {
    console.log(`⚡ GridPulse listening on http://localhost:${port}  (network: ${networkName})`);
    console.log(`   Payments go to ${payTo}${basePayTo ? ` (Algorand) and ${basePayTo} (Base)` : ""}`);
    for (const e of ENDPOINTS) console.log(`   ${e.route.padEnd(22)} ${e.price}`);
});

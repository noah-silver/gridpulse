// GridPulse — pay-per-call U.S. energy market data for AI agents.
// Payments: USDC on Algorand via x402, settled by the GoPlausible facilitator.

import { config } from "dotenv";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import { gridMix, retailPrice, henryHub, GRID_REGIONS, SECTORS, STATES } from "./eia.js";

config();

// Network IDs are hardcoded in the legacy format the hosted GoPlausible facilitator
// still expects (see x402-foundation/x402#3528). Keep @x402/* pinned at 2.17.0.
const NETWORKS = {
    mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
} as const;

const payTo = process.env.PAY_TO_ADDRESS;
const networkName = (process.env.NETWORK ?? "testnet") as keyof typeof NETWORKS;
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

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
    .register(network, new ExactAvmScheme());
server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

// ---------------------------------------------------------------------------
// Paid endpoints: price, description (shown to agents in the Bazaar), discovery schema
// ---------------------------------------------------------------------------

const ENDPOINTS = [
    {
        route: "GET /v1/grid-mix",
        price: "$0.002",
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
        price: "$0.001",
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
        price: "$0.001",
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
];

const app = new Hono();

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
    "Pay-per-call U.S. power grid mix, retail electricity prices and Henry Hub natural gas prices. No signup: agents pay fractions of a cent in USDC on Algorand via x402.";

app.get("/llms.txt", (c) =>
    c.text(
        [
            `# GridPulse`,
            ``,
            `> ${SUMMARY}`,
            ``,
            `All paid endpoints return HTTP 402 with x402 payment requirements (USDC on Algorand ${networkName}). Use any x402 client to pay and retry automatically.`,
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
<table>
<tr><th>Endpoint</th><th>Price</th><th>Returns</th></tr>
${ENDPOINTS.map((e) => `<tr><td><code>${e.route}</code></td><td class="price">${e.price}</td><td>${e.description}</td></tr>`).join("\n")}
</table>
<p>Example: <code>GET /v1/grid-mix?region=ISNE</code> · <code>GET /v1/retail-price?state=TX&amp;sector=COM</code></p>
<p>Payments are USDC on Algorand (${networkName}) using the <a href="https://www.x402.org">x402</a> protocol. Machine-readable docs: <a href="/llms.txt">/llms.txt</a>.</p>
<p>Data: U.S. Energy Information Administration (public domain). Not investment advice.</p>
</body>
</html>`),
);

serve({ fetch: app.fetch, port }, () => {
    console.log(`⚡ GridPulse listening on http://localhost:${port}  (network: ${networkName})`);
    console.log(`   Payments go to ${payTo}`);
    for (const e of ENDPOINTS) console.log(`   ${e.route.padEnd(22)} ${e.price}`);
});

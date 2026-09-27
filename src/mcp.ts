// GridPulse MCP server (stdio): exposes the paid endpoints as tools for Claude and other MCP clients.
// Each tool call pays GridPulse via x402 from the user's own wallet:
//   ALGORAND_MNEMONIC (USDC on Algorand) and/or EVM_PRIVATE_KEY (USDC on Base).
// Use a small, dedicated spending wallet. Never your main wallet.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { buyerClient } from "./wallet.js";
import { GRID_REGIONS, SECTORS } from "./eia.js";

const baseUrl = (process.env.GRIDPULSE_URL || "https://noahs-mac-mini.tail571e99.ts.net").replace(/\/$/, "");

// The wallet is optional at startup so the server can always list its tools; calls need one.
const buyer = process.env.ALGORAND_MNEMONIC || process.env.EVM_PRIVATE_KEY
    ? await buyerClient({ algorandMnemonic: process.env.ALGORAND_MNEMONIC, evmPrivateKey: process.env.EVM_PRIVATE_KEY })
    : undefined;
const fetchWithPay = buyer && wrapFetchWithPayment(fetch, buyer.client);
// stderr: stdout is the MCP channel
console.error(buyer ? `GridPulse MCP: paying from ${buyer.wallets.join(", ")}` : "GridPulse MCP: no wallet set, tool calls will fail");

async function paidCall(path: string) {
    if (!buyer || !fetchWithPay) {
        const text = "No wallet configured. Set EVM_PRIVATE_KEY (USDC on Base) or ALGORAND_MNEMONIC (USDC on Algorand) in this MCP server's env.";
        return { isError: true, content: [{ type: "text" as const, text }] };
    }
    const client = buyer.client;
    const res = await fetchWithPay(`${baseUrl}${path}`);
    const body = await res.json();
    if (!res.ok) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
    const receipt = new x402HTTPClient(client).getPaymentSettleResponse((h) => res.headers.get(h));
    const payment = receipt ? { paid: true, network: receipt.network, transaction: receipt.transaction } : undefined;
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...body, payment }, null, 2) }] };
}

const server = new McpServer({ name: "gridpulse", version: "1.0.1" });

server.registerTool(
    "grid_mix",
    {
        title: "U.S. grid generation mix",
        description:
            "Latest hourly electricity generation mix for a U.S. grid region (balancing authority): MWh by fuel, % share, renewable and carbon-free share. Costs $0.02 USDC per call.",
        inputSchema: { region: z.enum(Object.keys(GRID_REGIONS) as [string, ...string[]]).describe("Balancing authority code") },
    },
    async ({ region }) => paidCall(`/v1/grid-mix?region=${region}`),
);

server.registerTool(
    "retail_electricity_price",
    {
        title: "U.S. retail electricity price",
        description:
            "Latest average retail electricity price (cents/kWh) for a U.S. state and sector, with year-over-year change and 12-month history. Costs $0.01 USDC per call.",
        inputSchema: {
            state: z.string().length(2).describe("Two-letter U.S. state code, or US for the national average"),
            sector: z.enum(Object.keys(SECTORS) as [string, ...string[]]).optional().describe("Defaults to RES (residential)"),
        },
    },
    async ({ state, sector }) =>
        paidCall(`/v1/retail-price?state=${encodeURIComponent(state.toUpperCase())}&sector=${sector ?? "RES"}`),
);

server.registerTool(
    "henry_hub_gas_price",
    {
        title: "Henry Hub natural gas price",
        description:
            "Henry Hub natural gas spot price ($/MMBtu): latest daily price plus 30-trading-day average, min, max, % change and history. Costs $0.01 USDC per call.",
        inputSchema: {},
    },
    async () => paidCall("/v1/henry-hub"),
);

await server.connect(new StdioServerTransport());

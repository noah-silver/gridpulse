// Acts as a paying "agent": calls a GridPulse endpoint and pays for it automatically.
// Usage: npm run pay -- /v1/grid-mix?region=ISNE
//
// Uses BUYER_MNEMONIC from .env. This must be a SEPARATE, small test wallet,
// never the wallet holding your main ALGO.

import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { ed25519SigningKeyFromWrappedSecret, type WrappedEd25519Seed } from "@algorandfoundation/algokit-utils/crypto";
import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";

config();

const mnemonic = process.env.BUYER_MNEMONIC;
const baseUrl = (process.env.TARGET_URL || process.env.PUBLIC_URL || "http://localhost:4021").replace(/\/$/, "");
const path = process.argv[2] ?? "/v1/henry-hub";

async function secretKeyFromMnemonic(words: string): Promise<string> {
    const seed = seedFromMnemonic(words);
    const seedCopy = new Uint8Array(seed);
    const wrapped: WrappedEd25519Seed = { unwrapEd25519Seed: async () => seed, wrapEd25519Seed: async () => {} };
    const key = await ed25519SigningKeyFromWrappedSecret(wrapped);
    return Buffer.concat([Buffer.from(seedCopy), Buffer.from(key.ed25519Pubkey)]).toString("base64");
}

async function main() {
    if (!mnemonic) throw new Error("BUYER_MNEMONIC is missing from .env");

    const signer = toClientAvmSigner(await secretKeyFromMnemonic(mnemonic));
    const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    console.log(`Buyer wallet: ${signer.address}`);
    console.log(`Calling ${baseUrl}${path}\n`);

    const res = await fetchWithPayment(`${baseUrl}${path}`, { method: "GET" });
    console.log(`Status: ${res.status}`);
    console.log(JSON.stringify(await res.json(), null, 2));

    if (res.ok) {
        const receipt = new x402HTTPClient(client).getPaymentSettleResponse((h) => res.headers.get(h));
        console.log("\n✅ Payment settled:", JSON.stringify(receipt, null, 2));
    }
}

main().catch((err) => {
    console.error("❌", err?.response?.data?.error ?? err?.message ?? err);
    process.exit(1);
});

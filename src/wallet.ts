// Buyer-side x402 client: pays GridPulse from the caller's own wallet (Algorand and/or Base).

import { x402Client } from "@x402/fetch";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519SigningKeyFromWrappedSecret, type WrappedEd25519Seed } from "@algorandfoundation/algokit-utils/crypto";
import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";

// 25-word algo25 phrase -> base64 64-byte secret key (seed + public key) expected by @x402/avm
export async function algoSecretKeyFromMnemonic(words: string): Promise<string> {
    const seed = seedFromMnemonic(words.trim());
    const seedCopy = new Uint8Array(seed);
    const wrapped: WrappedEd25519Seed = { unwrapEd25519Seed: async () => seed, wrapEd25519Seed: async () => {} };
    const key = await ed25519SigningKeyFromWrappedSecret(wrapped);
    return Buffer.concat([Buffer.from(seedCopy), Buffer.from(key.ed25519Pubkey)]).toString("base64");
}

export async function buyerClient(opts: { algorandMnemonic?: string; evmPrivateKey?: string }) {
    const client = new x402Client();
    const wallets: string[] = [];
    if (opts.algorandMnemonic) {
        const signer = toClientAvmSigner(await algoSecretKeyFromMnemonic(opts.algorandMnemonic));
        client.register("algorand:*", new ExactAvmScheme(signer));
        wallets.push(`Algorand ${signer.address}`);
    }
    if (opts.evmPrivateKey) {
        const account = privateKeyToAccount(opts.evmPrivateKey as `0x${string}`);
        const signer = toClientEvmSigner(account, createPublicClient({ chain: base, transport: http() }));
        client.register("eip155:8453", new ExactEvmScheme(signer));
        wallets.push(`Base ${account.address}`);
    }
    if (!wallets.length) throw new Error("Set ALGORAND_MNEMONIC and/or EVM_PRIVATE_KEY to pay for GridPulse calls");
    return { client, wallets };
}

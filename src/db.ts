// Accounts for the subscription API: API keys (stored hashed), plans and daily usage.

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

export const PLANS = {
    free: { name: "Free", priceUsd: 0, dailyLimit: 100, historyDays: 0, scope2: false },
    pro: { name: "Pro", priceUsd: 49, dailyLimit: 10_000, historyDays: 31, scope2: false },
    business: { name: "Business", priceUsd: 199, dailyLimit: 100_000, historyDays: 366, scope2: true },
} as const;
export type Plan = keyof typeof PLANS;

mkdirSync("data", { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH ?? "data/gridpulse.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    key_hash TEXT PRIMARY KEY,
    key_prefix TEXT NOT NULL,
    email TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    stripe_customer TEXT,
    stripe_subscription TEXT UNIQUE,
    checkout_session TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS usage (
    key_hash TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_hash, day)
  );
`);

export type KeyRow = {
    key_hash: string;
    key_prefix: string;
    email: string | null;
    plan: Plan;
    status: string;
    stripe_customer: string | null;
    stripe_subscription: string | null;
};

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

export function createKey(opts: { email?: string; plan?: Plan; customer?: string; subscription?: string; session?: string }) {
    const key = `gp_${opts.plan && opts.plan !== "free" ? "live" : "free"}_${randomBytes(24).toString("base64url")}`;
    db.prepare(
        `INSERT INTO api_keys (key_hash, key_prefix, email, plan, stripe_customer, stripe_subscription, checkout_session)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(hash(key), key.slice(0, 12), opts.email ?? null, opts.plan ?? "free", opts.customer ?? null, opts.subscription ?? null, opts.session ?? null);
    return key;
}

export function findKey(key: string) {
    return db.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).get(hash(key)) as KeyRow | undefined;
}

export function keyForSession(session: string) {
    return db.prepare(`SELECT * FROM api_keys WHERE checkout_session = ?`).get(session) as KeyRow | undefined;
}

export function countFreeKeysForEmail(email: string) {
    return (db.prepare(`SELECT COUNT(*) n FROM api_keys WHERE email = ? AND plan = 'free'`).get(email) as { n: number }).n;
}

// Called from Stripe webhooks when a subscription changes.
export function updateSubscription(subscription: string, fields: { plan?: Plan; status?: string }) {
    if (fields.plan) db.prepare(`UPDATE api_keys SET plan = ? WHERE stripe_subscription = ?`).run(fields.plan, subscription);
    if (fields.status) db.prepare(`UPDATE api_keys SET status = ? WHERE stripe_subscription = ?`).run(fields.status, subscription);
}

// Replace a key (e.g. if it leaked); the old one stops working immediately.
export function rotateKey(oldKey: string) {
    const row = findKey(oldKey);
    if (!row) return undefined;
    const key = `gp_${row.plan === "free" ? "free" : "live"}_${randomBytes(24).toString("base64url")}`;
    db.prepare(`UPDATE api_keys SET key_hash = ?, key_prefix = ? WHERE key_hash = ?`).run(hash(key), key.slice(0, 12), row.key_hash);
    db.prepare(`UPDATE usage SET key_hash = ? WHERE key_hash = ?`).run(hash(key), row.key_hash);
    return key;
}

// Counts one call and returns today's total, or undefined if the key is over its daily limit.
export function recordCall(row: KeyRow) {
    const limit = PLANS[row.plan].dailyLimit;
    const r = db
        .prepare(
            `INSERT INTO usage (key_hash, day, calls) VALUES (?, ?, 1)
             ON CONFLICT (key_hash, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?
             RETURNING calls`,
        )
        .get(row.key_hash, today(), limit) as { calls: number } | undefined;
    return r ? { calls: r.calls, limit } : undefined;
}

export function usageToday(row: KeyRow) {
    const r = db.prepare(`SELECT calls FROM usage WHERE key_hash = ? AND day = ?`).get(row.key_hash, today()) as { calls: number } | undefined;
    return { calls: r?.calls ?? 0, limit: PLANS[row.plan].dailyLimit };
}

// Nightly snapshot of the accounts DB (e.g. to iCloud); keeps the last 14.
export function startBackups(dir: string | undefined) {
    if (!dir) return;
    const run = () => {
        try {
            mkdirSync(dir, { recursive: true });
            const file = `${dir}/gridpulse-${new Date().toISOString().slice(0, 10)}.db`;
            rmSync(file, { force: true });
            db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
            for (const old of readdirSync(dir).filter((f) => /^gridpulse-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14)) rmSync(`${dir}/${old}`);
            console.log(`[backup] saved ${file}`);
        } catch (e) {
            console.error(`[backup] failed: ${(e as Error).message}`);
        }
    };
    run();
    setInterval(run, 24 * 3_600_000).unref();
}

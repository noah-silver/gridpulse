// One-time Stripe setup: creates the Pro and Business plans and the webhook endpoint,
// then writes their IDs into .env. Safe to re-run: existing objects are reused.
// Usage: npm run stripe:setup   (needs STRIPE_SECRET_KEY and PUBLIC_URL in .env)

import "dotenv/config";
import Stripe from "stripe";
import { readFileSync, writeFileSync } from "node:fs";
import { PLANS } from "./db.js";

const secret = process.env.STRIPE_SECRET_KEY;
const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
if (!secret) throw new Error("Add STRIPE_SECRET_KEY to .env first");
if (!publicUrl.startsWith("https://")) throw new Error("PUBLIC_URL must be your public https address");
const stripe = new Stripe(secret);
const mode = secret.startsWith("sk_live_") ? "LIVE" : "TEST";

function setEnv(name: string, value: string) {
    let env = readFileSync(".env", "utf8");
    env = new RegExp(`^${name}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`) : env.trimEnd() + `\n${name}=${value}\n`;
    writeFileSync(".env", env);
}

for (const plan of ["pro", "business"] as const) {
    const lookup = `gridpulse_${plan}_monthly`;
    let price = (await stripe.prices.list({ lookup_keys: [lookup], active: true })).data[0];
    if (!price) {
        const product = await stripe.products.create({
            name: `GridPulse ${PLANS[plan].name}`,
            description: plan === "pro"
                ? "Hourly U.S. grid carbon intensity history, CSV export, 10,000 API calls/day"
                : "Everything in Pro plus monthly Scope 2 location-based factors, 366-day history, 100,000 API calls/day",
        });
        price = await stripe.prices.create({
            product: product.id,
            currency: "usd",
            unit_amount: PLANS[plan].priceUsd * 100,
            recurring: { interval: "month" },
            lookup_key: lookup,
        });
    }
    setEnv(`STRIPE_PRICE_${plan.toUpperCase()}`, price.id);
    console.log(`${PLANS[plan].name}: $${PLANS[plan].priceUsd}/month (${price.id})`);
}

const url = `${publicUrl}/webhooks/stripe`;
const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === url);
if (existing) {
    console.log(`Webhook already exists: ${url} (keeping current signing secret in .env)`);
} else {
    const hook = await stripe.webhookEndpoints.create({
        url,
        enabled_events: ["customer.subscription.updated", "customer.subscription.deleted"],
        description: "GridPulse plan sync",
    });
    setEnv("STRIPE_WEBHOOK_SECRET", hook.secret!); // written to .env only, never printed
    console.log(`Webhook created: ${url}`);
}
console.log(`\nDone (${mode} mode). Restart the server: pm2 restart gridpulse`);

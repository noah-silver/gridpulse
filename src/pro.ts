// GridPulse Pro: API-key access with Stripe subscriptions (Free / Pro / Business).
// Fully self-serve: pricing page -> Stripe Checkout -> key issued on the success page;
// renewals, cancellations and plan changes arrive via the Stripe webhook.

import { Hono, type Context } from "hono";
import Stripe from "stripe";
import { carbonNow, carbonHistory, scope2Report, METHODOLOGY } from "./carbon.js";
import { gridMix, retailPrice, henryHub, GRID_REGIONS, SECTORS, STATES } from "./eia.js";
import {
    PLANS, type Plan, type KeyRow, createKey, findKey, keyForSession, countFreeKeysForEmail,
    updateSubscription, rotateKey, recordCall, usageToday,
} from "./db.js";

const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : undefined;
const PRICE_IDS: Record<string, Plan> = Object.fromEntries(
    [[process.env.STRIPE_PRICE_PRO, "pro"], [process.env.STRIPE_PRICE_BUSINESS, "business"]].filter(([id]) => id),
);
const support = process.env.SUPPORT_EMAIL;
const priceFor = (plan: Plan) => Object.entries(PRICE_IDS).find(([, p]) => p === plan)?.[0];

export const pro = new Hono<{ Variables: { account: KeyRow } }>();

// ---------------------------------------------------------------------------
// API (v2): authenticated with an API key
// ---------------------------------------------------------------------------

pro.use("/api/v2/*", async (c, next) => {
    const key =
        c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("api_key");
    const account = key ? findKey(key) : undefined;
    if (!account || account.status === "disabled") {
        return c.json({ error: "Missing or invalid API key. Get one free at " + `${publicUrl}/pricing` }, 401);
    }
    const usage = recordCall(account);
    if (!usage) {
        return c.json({ error: `Daily limit of ${PLANS[account.plan].dailyLimit} calls reached. Upgrade at ${publicUrl}/pricing` }, 429);
    }
    c.header("X-RateLimit-Limit", String(usage.limit));
    c.header("X-RateLimit-Remaining", String(usage.limit - usage.calls));
    c.set("account", account);
    await next();
});

const needRegion = (c: Context) => {
    const region = (c.req.query("region") ?? "").toUpperCase();
    return GRID_REGIONS[region] ? region : undefined;
};
const badRegion = (c: Context) => c.json({ error: "Unknown region", validRegions: GRID_REGIONS }, 400);
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

function csv(rows: Record<string, unknown>[]) {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    const cell = (v: unknown) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
    return [cols.join(","), ...rows.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\n") + "\n";
}

pro.get("/api/v2/carbon-intensity", async (c) => {
    const region = needRegion(c);
    return region ? c.json(await carbonNow(region)) : badRegion(c);
});

pro.get("/api/v2/carbon-intensity/history", async (c) => {
    const plan = PLANS[c.get("account").plan];
    if (!plan.historyDays) return c.json({ error: `History requires Pro or Business: ${publicUrl}/pricing` }, 403);
    const region = needRegion(c);
    if (!region) return badRegion(c);
    const { start, end } = c.req.query();
    if (!isDate(start) || !isDate(end) || start > end) return c.json({ error: "start and end must be YYYY-MM-DD, start <= end" }, 400);
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
    if (days > plan.historyDays) return c.json({ error: `Your plan allows up to ${plan.historyDays} days per request` }, 400);
    const h = await carbonHistory(region, start, end);
    if (c.req.query("format") === "csv") {
        c.header("Content-Disposition", `attachment; filename="gridpulse-${region}-${start}-${end}.csv"`);
        return c.body(csv(h.hours.map((x) => ({ region, ...x }))), 200, { "Content-Type": "text/csv" });
    }
    return c.json(h);
});

pro.get("/api/v2/reports/scope2", async (c) => {
    if (!PLANS[c.get("account").plan].scope2) return c.json({ error: `Scope 2 reports require Business: ${publicUrl}/pricing` }, 403);
    const region = needRegion(c);
    if (!region) return badRegion(c);
    const month = c.req.query("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month >= new Date().toISOString().slice(0, 7)) {
        return c.json({ error: "month must be a completed month, YYYY-MM" }, 400);
    }
    return c.json(await scope2Report(region, month));
});

pro.get("/api/v2/grid-mix", async (c) => {
    const region = needRegion(c);
    return region ? c.json(await gridMix(region)) : badRegion(c);
});

pro.get("/api/v2/retail-price", async (c) => {
    const state = (c.req.query("state") ?? "").toUpperCase();
    const sector = (c.req.query("sector") ?? "RES").toUpperCase();
    if (!STATES.has(state)) return c.json({ error: "state must be a two-letter U.S. state code or US" }, 400);
    if (!SECTORS[sector]) return c.json({ error: "Unknown sector", validSectors: SECTORS }, 400);
    return c.json(await retailPrice(state, sector));
});

pro.get("/api/v2/henry-hub", async (c) => c.json(await henryHub()));

pro.get("/api/v2/account", (c) => {
    const a = c.get("account");
    return c.json({ plan: a.plan, keyPrefix: a.key_prefix, usageToday: usageToday(a), limits: PLANS[a.plan] });
});

// ---------------------------------------------------------------------------
// Web pages: pricing, free signup, checkout, account
// ---------------------------------------------------------------------------

const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · GridPulse</title>
<meta name="description" content="Hourly U.S. grid carbon intensity, Scope 2 location-based factors and electricity price data by API and CSV.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
<style>
 body{font:16px/1.55 system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 20px;color:#1b1f24}
 a{color:#0969da} h1{font-size:32px;margin:0 0 6px} .sub{color:#57606a;margin:0 0 28px}
 nav{margin-bottom:32px;display:flex;gap:18px;font-size:15px} nav b{margin-right:auto}
 .plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:24px 0}
 .plan{border:1px solid #d0d7de;border-radius:10px;padding:20px;display:flex;flex-direction:column}
 .plan.hi{border:2px solid #0969da} .price{font-size:30px;font-weight:700;margin:6px 0} .price small{font-size:15px;color:#57606a;font-weight:400}
 .plan ul{padding-left:18px;margin:10px 0 18px;flex:1} .plan li{margin:4px 0}
 button,.btn{background:#0969da;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block;text-align:center}
 .ghost{background:#f6f8fa;color:#1b1f24;border:1px solid #d0d7de}
 input{font-size:15px;padding:9px 10px;border:1px solid #d0d7de;border-radius:8px;width:100%;box-sizing:border-box;margin-bottom:8px}
 code,pre{background:#f6f8fa;border-radius:6px;padding:2px 6px;font-size:14px} pre{padding:14px;overflow-x:auto}
 .key{font-size:17px;padding:12px;border:2px dashed #0969da;border-radius:8px;word-break:break-all;background:#f6f8fa}
 .note{color:#57606a;font-size:14px} table{border-collapse:collapse;width:100%} td,th{text-align:left;padding:8px;border-bottom:1px solid #d8dee4}
</style></head><body>
<nav><b>⚡ GridPulse</b><a href="/pricing">Pricing</a><a href="/docs">API docs</a><a href="/account">Account</a></nav>
${body}
<p class="note" style="margin-top:48px">Data: U.S. Energy Information Administration (public domain). Carbon estimates use EIA emission factors; see <a href="/docs#methodology">methodology</a>. Payments by Stripe.</p>
</body></html>`;

const planCard = (id: Plan, blurb: string, features: string[], highlight = false) => `
<div class="plan${highlight ? " hi" : ""}"><b>${PLANS[id].name}</b>
<div class="price">$${PLANS[id].priceUsd}<small>${PLANS[id].priceUsd ? " / month" : ""}</small></div>
<div class="note">${blurb}</div><ul>${features.map((f) => `<li>${f}</li>`).join("")}</ul>
${id === "free"
    ? `<form method="post" action="/signup/free"><input name="email" type="email" required placeholder="you@company.com"><button class="ghost" style="width:100%">Get a free key</button></form>`
    : `<form method="post" action="/billing/checkout"><input type="hidden" name="plan" value="${id}"><button style="width:100%">Subscribe</button></form>`}
</div>`;

pro.get("/pricing", (c) =>
    c.html(page("Pricing", `
<h1>Grid carbon intensity &amp; electricity price data</h1>
<p class="sub">Hourly CO₂ intensity for 12 U.S. grid regions, monthly location-based Scope 2 factors, grid fuel mix, retail power prices and Henry Hub gas. JSON API and CSV. Cancel anytime.</p>
<div class="plans">
${planCard("free", "Try it out", ["Current carbon intensity, grid mix, prices", `${PLANS.free.dailyLimit} calls / day`, "JSON API"])}
${planCard("pro", "For analysts and apps", ["Everything in Free", "Hourly carbon history (up to 31 days per request)", "CSV export", `${PLANS.pro.dailyLimit.toLocaleString()} calls / day`], true)}
${planCard("business", "For sustainability reporting", ["Everything in Pro", "Monthly Scope 2 location-based factors (gCO₂/kWh, lb/MWh) with hourly distribution", "Up to 366 days of history per request", `${PLANS.business.dailyLimit.toLocaleString()} calls / day`])}
</div>
<p class="note">Regions: ${Object.values(GRID_REGIONS).join(", ")}.</p>`)),
);

// Very small in-memory throttle for free signups (per IP, per hour).
const signupsByIp = new Map<string, number[]>();
pro.post("/signup/free", async (c) => {
    const email = String((await c.req.parseBody()).email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return c.html(page("Sign up", `<p>Please enter a valid email. <a href="/pricing">Back</a></p>`), 400);
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    const recent = (signupsByIp.get(ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (recent.length >= 3 || countFreeKeysForEmail(email) >= 1) {
        return c.html(page("Sign up", `<p>A free key was already issued for this email or network. <a href="/pricing">Back to pricing</a></p>`), 429);
    }
    signupsByIp.set(ip, [...recent, Date.now()]);
    return c.html(page("Your API key", keyPage(createKey({ email, plan: "free" }), "free")));
});

const keyPage = (key: string, plan: Plan) => `
<h1>You're in: ${PLANS[plan].name} plan</h1>
<p><b>Your API key</b> (shown once, so copy and save it now):</p>
<div class="key">${esc(key)}</div>
<p>Try it:</p>
<pre>curl -H "X-API-Key: ${esc(key)}" "${publicUrl}/api/v2/carbon-intensity?region=ERCO"</pre>
<p><a href="/docs">API docs</a> · Manage your plan anytime at <a href="/account">/account</a> with this key.</p>`;

pro.post("/billing/checkout", async (c) => {
    const plan = String((await c.req.parseBody()).plan ?? "") as Plan;
    const price = plan !== "free" && plan in PLANS ? priceFor(plan) : undefined;
    if (!stripe || !price) return c.html(page("Checkout", `<p>Checkout is temporarily unavailable. Please try again later.</p>`), 503);
    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        success_url: `${publicUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${publicUrl}/pricing`,
        allow_promotion_codes: true,
        metadata: { plan },
        subscription_data: { metadata: { plan } },
    });
    return c.redirect(session.url!, 303);
});

pro.get("/billing/success", async (c) => {
    const id = c.req.query("session_id") ?? "";
    if (!stripe || !/^cs_[A-Za-z0-9_]+$/.test(id)) return c.redirect("/pricing");
    const existing = keyForSession(id);
    if (existing) {
        return c.html(page("Already issued", `<p>The key for this purchase was already shown (it starts with <code>${esc(existing.key_prefix)}…</code>). Lost it? ${support ? `Email <a href="mailto:${esc(support)}">${esc(support)}</a> and we'll reissue it.` : "Contact support and we'll reissue it."}</p>`));
    }
    const s = await stripe.checkout.sessions.retrieve(id);
    const plan = s.metadata?.plan as Plan;
    if (s.status !== "complete" || !(plan in PLANS) || !s.subscription) return c.html(page("Checkout", `<p>Payment not completed. <a href="/pricing">Back to pricing</a></p>`), 402);
    const key = createKey({
        email: s.customer_details?.email ?? undefined,
        plan,
        customer: typeof s.customer === "string" ? s.customer : s.customer?.id,
        subscription: typeof s.subscription === "string" ? s.subscription : s.subscription.id,
        session: id,
    });
    return c.html(page("Your API key", keyPage(key, plan)));
});

pro.get("/account", (c) =>
    c.html(page("Account", `
<h1>Your account</h1>
<form method="post" action="/account"><input name="key" required placeholder="Your API key (gp_…)" autocomplete="off"><button>Show my plan &amp; usage</button></form>`)),
);

pro.post("/account", async (c) => {
    const body = await c.req.parseBody();
    const key = String(body.key ?? "").trim();
    let a = findKey(key);
    if (!a) return c.html(page("Account", `<p>Key not found. <a href="/account">Try again</a></p>`), 404);
    if (body.action === "portal" && stripe && a.stripe_customer) {
        const portal = await stripe.billingPortal.sessions.create({ customer: a.stripe_customer, return_url: `${publicUrl}/account` });
        return c.redirect(portal.url, 303);
    }
    if (body.action === "rotate") {
        const fresh = rotateKey(key)!;
        return c.html(page("New key", `<p>Your old key no longer works.</p>${keyPage(fresh, a.plan)}`));
    }
    const u = usageToday(a);
    const hidden = `<input type="hidden" name="key" value="${esc(key)}">`;
    return c.html(page("Account", `
<h1>${PLANS[a.plan].name} plan</h1>
<table><tr><td>Key</td><td><code>${esc(a.key_prefix)}…</code></td></tr>
<tr><td>Status</td><td>${esc(a.status)}</td></tr>
<tr><td>Calls today</td><td>${u.calls.toLocaleString()} / ${u.limit.toLocaleString()}</td></tr></table>
<p style="display:flex;gap:10px;margin-top:20px">
${a.stripe_customer ? `<form method="post">${hidden}<input type="hidden" name="action" value="portal"><button>Manage billing / cancel</button></form>` : `<a class="btn" href="/pricing">Upgrade</a>`}
<form method="post">${hidden}<input type="hidden" name="action" value="rotate"><button class="ghost">Replace key</button></form></p>`));
});

pro.get("/docs", (c) =>
    c.html(page("API docs", `
<h1>API docs</h1>
<p>Send your key in the <code>X-API-Key</code> header. Base URL: <code>${esc(publicUrl)}/api/v2</code></p>
<table>
<tr><th>Endpoint</th><th>Plan</th><th>Returns</th></tr>
<tr><td><code>GET /carbon-intensity?region=ERCO</code></td><td>All</td><td>Latest hourly gCO₂/kWh for a grid region</td></tr>
<tr><td><code>GET /carbon-intensity/history?region=PJM&amp;start=2026-09-01&amp;end=2026-09-07</code></td><td>Pro+</td><td>Hourly series; add <code>&amp;format=csv</code> for CSV</td></tr>
<tr><td><code>GET /reports/scope2?region=CISO&amp;month=2026-08</code></td><td>Business</td><td>Monthly location-based factor and hourly distribution</td></tr>
<tr><td><code>GET /grid-mix?region=ISNE</code></td><td>All</td><td>Generation by fuel, renewable and carbon-free share</td></tr>
<tr><td><code>GET /retail-price?state=CT&amp;sector=COM</code></td><td>All</td><td>Retail electricity price, YoY, 12-month history</td></tr>
<tr><td><code>GET /henry-hub</code></td><td>All</td><td>Henry Hub natural gas spot price and 30-day stats</td></tr>
<tr><td><code>GET /account</code></td><td>All</td><td>Your plan and today's usage</td></tr>
</table>
<p>Regions: ${Object.entries(GRID_REGIONS).map(([k, v]) => `<code>${k}</code> ${esc(v)}`).join(", ")}.</p>
<pre>curl -H "X-API-Key: YOUR_KEY" "${esc(publicUrl)}/api/v2/carbon-intensity?region=ERCO"</pre>
<h2 id="methodology">Methodology</h2><p>${esc(METHODOLOGY)}</p>
<p class="note">EIA hourly data is typically published with a lag of several hours; "latest" means the most recent complete hour EIA has released.</p>`)),
);

// ---------------------------------------------------------------------------
// Stripe webhook: keeps plans in sync with subscriptions (renewals, cancellations, upgrades)
// ---------------------------------------------------------------------------

pro.post("/webhooks/stripe", async (c) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return c.text("billing not configured", 503);
    let event: Stripe.Event;
    try {
        event = await stripe.webhooks.constructEventAsync(await c.req.text(), c.req.header("stripe-signature") ?? "", process.env.STRIPE_WEBHOOK_SECRET);
    } catch {
        return c.text("bad signature", 400);
    }
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const plan = PRICE_IDS[sub.items.data[0]?.price.id ?? ""];
        const live = ["active", "trialing", "past_due"].includes(sub.status);
        // Ended or unpaid subscriptions fall back to Free so the key keeps working at free limits.
        updateSubscription(sub.id, { plan: live && plan ? plan : "free", status: sub.status });
    }
    return c.json({ received: true });
});

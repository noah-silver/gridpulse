// Thin client for the U.S. Energy Information Administration (EIA) API v2.
// Free API key: https://www.eia.gov/opendata/register.php

const EIA_BASE = "https://api.eia.gov/v2";
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { at: number; data: unknown }>();

export type EiaRow = Record<string, string | number | null>;

export async function eia(path: string, params: Record<string, string>): Promise<EiaRow[]> {
    const qs = new URLSearchParams({ api_key: process.env.EIA_API_KEY || "DEMO_KEY", ...params });
    const url = `${EIA_BASE}/${path}/data/?${qs}`;

    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as EiaRow[];

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`EIA request failed (${res.status})`);
    const json = (await res.json()) as { response?: { data?: EiaRow[] } };
    const data = json.response?.data ?? [];
    cache.set(url, { at: Date.now(), data });
    return data;
}

export const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
export const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------
// Grid generation mix (hourly, by balancing authority)
// ---------------------------------------------------------------------------

export const GRID_REGIONS: Record<string, string> = {
    ISNE: "ISO New England",
    NYIS: "New York ISO",
    PJM: "PJM Interconnection",
    MISO: "Midcontinent ISO",
    ERCO: "ERCOT (Texas)",
    CISO: "California ISO",
    SWPP: "Southwest Power Pool",
    SOCO: "Southern Company",
    TVA: "Tennessee Valley Authority",
    BPAT: "Bonneville Power Administration",
    FPL: "Florida Power & Light",
    DUK: "Duke Energy Carolinas",
};

const RENEWABLE = new Set(["SUN", "WND", "WAT", "GEO"]);
const CARBON_FREE = new Set([...RENEWABLE, "NUC"]);

export async function gridMix(region: string) {
    const rows = await eia("electricity/rto/fuel-type-data", {
        frequency: "hourly",
        "data[0]": "value",
        "facets[respondent][]": region,
        "sort[0][column]": "period",
        "sort[0][direction]": "desc",
        length: "200",
    });
    if (rows.length === 0) throw new Error(`No data for region ${region}`);

    // EIA publishes fuels for an hour at slightly different times; use the latest
    // hour that has the most fuel types reported.
    const byHour = new Map<string, EiaRow[]>();
    for (const r of rows) {
        const p = String(r.period);
        byHour.set(p, [...(byHour.get(p) ?? []), r]);
    }
    const maxFuels = Math.max(...[...byHour.values()].map((v) => v.length));
    const [period, hourRows] = [...byHour.entries()].find(([, v]) => v.length === maxFuels)!;

    const fuels = hourRows
        .map((r) => ({ code: String(r.fueltype), fuel: String(r["type-name"]), mwh: num(r.value) ?? 0 }))
        .filter((f) => f.mwh > 0)
        .sort((a, b) => b.mwh - a.mwh);
    const total = fuels.reduce((s, f) => s + f.mwh, 0);
    const share = (set: Set<string>) =>
        total ? round((100 * fuels.filter((f) => set.has(f.code)).reduce((s, f) => s + f.mwh, 0)) / total) : null;

    return {
        region,
        regionName: GRID_REGIONS[region],
        hourUtc: `${period}:00Z`,
        totalGenerationMwh: total,
        renewableSharePct: share(RENEWABLE),
        carbonFreeSharePct: share(CARBON_FREE),
        fuels: fuels.map((f) => ({ ...f, sharePct: total ? round((100 * f.mwh) / total) : null })),
        source: "U.S. EIA Hourly Electric Grid Monitor",
    };
}

// ---------------------------------------------------------------------------
// Retail electricity price (monthly, by state and sector)
// ---------------------------------------------------------------------------

export const SECTORS: Record<string, string> = {
    RES: "residential",
    COM: "commercial",
    IND: "industrial",
    ALL: "all sectors",
};

export const STATES = new Set(
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY US".split(" "),
);

export async function retailPrice(state: string, sector: string) {
    const rows = await eia("electricity/retail-sales", {
        frequency: "monthly",
        "data[0]": "price",
        "facets[stateid][]": state,
        "facets[sectorid][]": sector,
        "sort[0][column]": "period",
        "sort[0][direction]": "desc",
        length: "13",
    });
    const latest = rows[0];
    if (!latest) throw new Error(`No data for ${state}/${sector}`);
    const price = num(latest.price);
    const yearAgo = rows.find((r) => String(r.period) === shiftMonth(String(latest.period), -12));
    const priorPrice = num(yearAgo?.price);

    return {
        state,
        stateName: String(latest.stateDescription),
        sector: SECTORS[sector],
        month: String(latest.period),
        priceCentsPerKwh: price,
        yearAgoCentsPerKwh: priorPrice,
        yoyChangePct: price !== null && priorPrice ? round((100 * (price - priorPrice)) / priorPrice) : null,
        last12Months: rows.slice(0, 12).map((r) => ({ month: String(r.period), priceCentsPerKwh: num(r.price) })),
        source: "U.S. EIA Electric Power Monthly (retail sales)",
    };
}

function shiftMonth(yyyyMm: string, delta: number) {
    const [y, m] = yyyyMm.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Henry Hub natural gas spot price (daily)
// ---------------------------------------------------------------------------

export async function henryHub() {
    const rows = await eia("natural-gas/pri/fut", {
        frequency: "daily",
        "data[0]": "value",
        "facets[series][]": "RNGWHHD",
        "sort[0][column]": "period",
        "sort[0][direction]": "desc",
        length: "30",
    });
    const series = rows
        .map((r) => ({ date: String(r.period), usdPerMmbtu: num(r.value) }))
        .filter((r): r is { date: string; usdPerMmbtu: number } => r.usdPerMmbtu !== null);
    if (series.length === 0) throw new Error("No Henry Hub data");

    const latest = series[0];
    const values = series.map((s) => s.usdPerMmbtu);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const oldest = series[series.length - 1];

    return {
        hub: "Henry Hub (Louisiana)",
        date: latest.date,
        spotUsdPerMmbtu: latest.usdPerMmbtu,
        avgLast30TradingDays: round(avg, 3),
        minLast30TradingDays: Math.min(...values),
        maxLast30TradingDays: Math.max(...values),
        changeOverPeriodPct: round((100 * (latest.usdPerMmbtu - oldest.usdPerMmbtu)) / oldest.usdPerMmbtu),
        history: series,
        source: "U.S. EIA Natural Gas Spot Prices",
    };
}

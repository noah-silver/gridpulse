// Hourly grid carbon intensity (gCO2/kWh) estimated from the EIA hourly fuel mix.
//
// Method (location-based, generation-weighted, direct combustion emissions):
//   intensity = Σ(generation_fuel × factor_fuel) / Σ(generation_fuel)
// Factors are EIA's 2023 U.S. averages for utility-scale generation
// (https://www.eia.gov/tools/faqs/faq.php?id=74&t=11): coal 2.31, natural gas 0.96,
// petroleum 2.46 lb CO2/kWh. Nuclear, wind, solar, hydro and geothermal count as zero.
// "Other"/"Unknown" use the natural gas factor. Storage discharge is excluded from both
// sides, since its emissions belong to whatever charged it. Imports are not included.

import { eia, num, round, GRID_REGIONS, type EiaRow } from "./eia.js";

const LB_TO_G = 453.592;
export const EMISSION_FACTORS_G_PER_KWH: Record<string, number> = {
    COL: round(2.31 * LB_TO_G, 0),
    NG: round(0.96 * LB_TO_G, 0),
    OIL: round(2.46 * LB_TO_G, 0),
    OTH: round(0.96 * LB_TO_G, 0),
    UNK: round(0.96 * LB_TO_G, 0),
    NUC: 0, SUN: 0, WND: 0, WAT: 0, GEO: 0, SNB: 0, WNB: 0,
};
const STORAGE = new Set(["BAT", "PS", "UES", "OES"]);

export const METHODOLOGY =
    "Location-based estimate: generation-weighted average of EIA 2023 CO2 factors (coal 1048, natural gas 435, " +
    "petroleum 1116 gCO2/kWh; nuclear and renewables 0; other/unknown at the gas factor), applied to the EIA " +
    "hourly fuel mix for the balancing authority. Excludes storage discharge and imports. For internal analysis and " +
    "screening; not a certified emissions factor.";

type Hour = { hourUtc: string; generationMwh: number; gCo2PerKwh: number | null; tonnesCo2: number };

function summarizeHour(period: string, rows: EiaRow[]): Hour {
    let mwh = 0;
    let grams = 0;
    for (const r of rows) {
        const code = String(r.fueltype);
        const v = num(r.value) ?? 0;
        if (v <= 0 || STORAGE.has(code)) continue;
        mwh += v;
        grams += v * 1000 * (EMISSION_FACTORS_G_PER_KWH[code] ?? EMISSION_FACTORS_G_PER_KWH.OTH);
    }
    return {
        hourUtc: `${period}:00Z`,
        generationMwh: round(mwh, 0),
        gCo2PerKwh: mwh ? round(grams / (mwh * 1000), 1) : null,
        tonnesCo2: round(grams / 1e6, 1),
    };
}

// EIA returns at most 5000 rows per request, so page through longer ranges.
async function fuelRows(region: string, params: Record<string, string>) {
    const out: EiaRow[] = [];
    for (let offset = 0; ; offset += 5000) {
        const rows = await eia("electricity/rto/fuel-type-data", {
            frequency: "hourly",
            "data[0]": "value",
            "facets[respondent][]": region,
            "sort[0][column]": "period",
            "sort[0][direction]": "desc",
            length: "5000",
            offset: String(offset),
            ...params,
        });
        out.push(...rows);
        if (rows.length < 5000) return out;
    }
}

function byHour(rows: EiaRow[]) {
    const m = new Map<string, EiaRow[]>();
    for (const r of rows) m.set(String(r.period), [...(m.get(String(r.period)) ?? []), r]);
    return m;
}

export async function carbonNow(region: string) {
    const hours = byHour(await fuelRows(region, { length: "300" }));
    if (!hours.size) throw new Error(`No data for region ${region}`);
    // Fuels for an hour are published at slightly different times; use the latest complete hour.
    const maxFuels = Math.max(...[...hours.values()].map((v) => v.length));
    const [period, rows] = [...hours.entries()].find(([, v]) => v.length === maxFuels)!;
    return { region, regionName: GRID_REGIONS[region], ...summarizeHour(period, rows), methodology: METHODOLOGY };
}

// start/end are YYYY-MM-DD (UTC, inclusive).
export async function carbonHistory(region: string, start: string, end: string) {
    const rows = await fuelRows(region, { start: `${start}T00`, end: `${end}T23` });
    const hours = [...byHour(rows).entries()]
        .map(([p, r]) => summarizeHour(p, r))
        .filter((h) => h.gCo2PerKwh !== null)
        .sort((a, b) => a.hourUtc.localeCompare(b.hourUtc));
    const mwh = hours.reduce((s, h) => s + h.generationMwh, 0);
    const tonnes = hours.reduce((s, h) => s + h.tonnesCo2, 0);
    return {
        region,
        regionName: GRID_REGIONS[region],
        start,
        end,
        hoursCount: hours.length,
        averageGCo2PerKwh: mwh ? round((tonnes * 1e6) / (mwh * 1000), 1) : null,
        hours,
        methodology: METHODOLOGY,
    };
}

// Monthly location-based factor for Scope 2 screening: generation-weighted average over the month.
export async function scope2Report(region: string, month: string) {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const h = await carbonHistory(region, `${month}-01`, `${month}-${String(last).padStart(2, "0")}`);
    const vals = h.hours.map((x) => x.gCo2PerKwh!).sort((a, b) => a - b);
    const pct = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : null);
    return {
        region,
        regionName: GRID_REGIONS[region],
        month,
        hoursCovered: h.hoursCount,
        hoursInMonth: last * 24,
        locationBasedFactor: {
            gCo2PerKwh: h.averageGCo2PerKwh,
            kgCo2PerMwh: h.averageGCo2PerKwh,
            lbCo2PerMwh: h.averageGCo2PerKwh === null ? null : round(h.averageGCo2PerKwh * 2.20462, 1),
        },
        hourlyDistribution: { minimum: vals[0] ?? null, p10: pct(0.1), median: pct(0.5), p90: pct(0.9), maximum: vals.at(-1) ?? null },
        cleanestHourUtc: h.hours.reduce((a, b) => (b.gCo2PerKwh! < a.gCo2PerKwh! ? b : a), h.hours[0])?.hourUtc ?? null,
        dirtiestHourUtc: h.hours.reduce((a, b) => (b.gCo2PerKwh! > a.gCo2PerKwh! ? b : a), h.hours[0])?.hourUtc ?? null,
        methodology: METHODOLOGY,
    };
}

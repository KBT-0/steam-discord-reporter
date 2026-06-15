interface Env {
  PROJECT_DISPLAY_NAME?: string;
  STEAM_APP_ID: string;
  STEAM_FINANCIAL_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  MANUAL_RUN_TOKEN?: string;
  ENABLE_WISHLIST_REPORTING?: string;
  ENABLE_SALES_REPORTING?: string;
  ENABLE_PLAYER_COUNT_REPORTING?: string;
  ENABLE_DAILY_DIGEST?: string;
  DAILY_DIGEST_LOCAL_HOUR?: string;
  SEND_EMPTY_REPORTS?: string;
  BASELINE_SALES_ON_FIRST_RUN?: string;
  TOP_COUNTRY_LIMIT?: string;
  REPORT_TIMEZONE?: string;
  REPORT_INTERVAL_HOURS?: string;
  FIRST_LOCAL_REPORT_HOUR?: string;
  STEAM_REPORTER_STATE: KVNamespace;
  STEAM_PROJECT_NAME?: string;
  REPORT_ON_ZERO_ACTIVITY?: string;
  REPORT_TIME_ZONE?: string;
  FIRST_REPORT_LOCAL_HOUR?: string;
}

type SteamWishlistSummary = {
  wishlist_adds?: number;
  wishlist_deletes?: number;
  wishlist_purchases?: number;
  wishlist_gifts?: number;
  wishlist_adds_windows?: number;
  wishlist_adds_mac?: number;
  wishlist_adds_linux?: number;
};

type SteamWishlistCountry = {
  country_code?: string;
  country_name?: string;
  region?: string;
  summary_actions?: SteamWishlistSummary;
};

type SteamWishlistResponse = {
  response?: {
    appid?: number;
    date?: string;
    wishlist_summary?: SteamWishlistSummary;
    country_summary?: SteamWishlistCountry[];
    app_min_date?: string;
  };
};

type SteamChangedDatesResponse = {
  response?: {
    dates?: string[];
    result_highwatermark?: string;
  };
};

type SteamCurrentPlayersResponse = {
  response?: {
    player_count?: number;
    result?: number;
  };
};

type SteamDetailedSalesRow = {
  date?: string;
  line_item_type?: string;
  packageid?: number | string;
  appid?: number | string;
  primary_appid?: number | string;
  package_sale_type?: string;
  platform?: string;
  country_code?: string;
  gross_units_sold?: number;
  gross_units_returned?: number;
  gross_units_activated?: number;
};

type SteamCountryInfo = {
  country_code?: string;
  country_name?: string;
  region?: string;
};

type SteamDetailedSalesResponse = {
  response?: {
    results?: SteamDetailedSalesRow[];
    country_info?: SteamCountryInfo[];
    max_id?: string;
  };
};

type CountryTotals = {
  countryCode: string;
  countryName?: string;
  wishlistAdds: number;
  wishlistDeletes: number;
  wishlistPurchases: number;
  unitsSold: number;
  refunds: number;
  keyActivations: number;
};

type WishlistSnapshot = {
  adds: number;
  deletes: number;
  purchases: number;
  gifts: number;
  windowsAdds: number;
  macAdds: number;
  linuxAdds: number;
  countries: Record<string, CountryTotals>;
};

type FetchedWishlistSnapshot = {
  date: string;
  appMinDate?: string;
  snapshot: WishlistSnapshot;
};

type SalesSnapshot = {
  unitsSold: number;
  refunds: number;
  keyActivations: number;
  countries: Record<string, CountryTotals>;
};

// Persisted in KV so the all-time concurrent-player peak survives across runs.
type PlayerCountState = {
  peak: number;
  peakAt?: string;
};

type PlayerCountSnapshot = {
  available: boolean;
  current: number;
  peak: number;
  peakAt?: string;
  newPeak: boolean;
};

type ReportTotals = {
  wishlistBalance: number;
  wishlistAdds: number;
  wishlistDeletes: number;
  wishlistPurchases: number;
  wishlistGifts: number;
  wishlistKnownDays: number;
  wishlistBackfillComplete: boolean;
  unitsSold: number;
  refunds: number;
  keyActivations: number;
  salesKnownDays: number;
};

type WishlistTotalsState = Pick<
  ReportTotals,
  | "wishlistBalance"
  | "wishlistAdds"
  | "wishlistDeletes"
  | "wishlistPurchases"
  | "wishlistGifts"
  | "wishlistKnownDays"
  | "wishlistBackfillComplete"
> & {
  backfillCursor: string;
};

type WishlistSnapshotWithPrevious = {
  current: WishlistSnapshot;
  previous: WishlistSnapshot | null;
};

type SalesTotalsState = Pick<ReportTotals, "unitsSold" | "refunds" | "keyActivations" | "salesKnownDays"> & {
  countries: Record<string, CountryTotals>;
};

// Lifetime owner count = units sold - refunds + key activations, with a per-country breakdown.
type OwnersSummary = {
  total: number;
  countries: Record<string, CountryTotals>;
};

type PendingSalesDates = {
  dates: string[];
  resultHighwatermark: string;
  firstRun: boolean;
};

type RunOptions = {
  commitState: boolean;
};

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type RunReport = {
  projectName: string;
  appId: string;
  generatedAt: string;
  wishlist: WishlistSnapshot;
  sales: SalesSnapshot;
  players: PlayerCountSnapshot;
  owners: OwnersSummary;
  totals: ReportTotals;
  wishlistBaselineInitialized: boolean;
  salesBaselineInitialized: boolean;
  notes: string[];
  // Present when this report is the daily end-of-day digest for a finalized Steam (UTC) day.
  digest?: { date: string };
};

const STEAM_FINANCIAL_BASE_URL = "https://partner.steam-api.com/IPartnerFinancialsService";
const STEAM_WEB_API_BASE_URL = "https://api.steampowered.com";
const MAX_WISHLIST_TOTAL_BACKFILL_DAYS_PER_RUN = 10;
const MAX_SALES_CHANGED_DATES_PER_RUN = 4;

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "steam-discord-reporter" });
    }

    if (url.pathname !== "/run") {
      return new Response("Use /run?token=YOUR_MANUAL_RUN_TOKEN or /health", { status: 404 });
    }

    if (!(await isAuthorizedManualRun(url.searchParams.get("token"), env.MANUAL_RUN_TOKEN))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const shouldPost = url.searchParams.get("post") !== "false";
    const commitState = shouldPost || url.searchParams.get("commit") === "true";
    const isDigest = url.searchParams.get("mode") === "digest";

    try {
      const report = isDigest ? await buildDailyDigest(env) : await buildReport(env, { commitState });
      if (shouldPost) {
        await postDiscordReport(env, report);
      }
      return jsonResponse({ ok: true, posted: shouldPost, stateCommitted: commitState && !isDigest, report });
    } catch (error) {
      return jsonResponse({ ok: false, error: errorToMessage(error) }, 500);
    }
  },
};

async function runScheduled(env: Env): Promise<void> {
  const timeZone = resolveReportTimeZone(env);
  const local = getLocalDateTimeParts(new Date(), timeZone);

  // Cron fires every 15 minutes; only the top of the hour is a candidate report slot.
  if (local.minute !== 0) {
    return;
  }

  if (await shouldRunIncrementalReport(env, timeZone, local)) {
    await runAndPost(env);
  }

  if (await shouldRunDailyDigest(env, timeZone, local)) {
    await runDailyDigest(env);
  }
}

async function runDailyDigest(env: Env): Promise<void> {
  const report = await buildDailyDigest(env);
  await postDiscordReport(env, report);
}

async function runAndPost(env: Env): Promise<void> {
  const report = await buildReport(env, { commitState: true });
  const shouldPost =
    parseBool(configValue(env, "SEND_EMPTY_REPORTS", "REPORT_ON_ZERO_ACTIVITY"), true) ||
    hasActivity(report) ||
    report.wishlistBaselineInitialized ||
    report.salesBaselineInitialized;

  if (!shouldPost) {
    return;
  }

  await postDiscordReport(env, report);
}

async function buildReport(env: Env, options: RunOptions): Promise<RunReport> {
  const appId = requireEnv(env.STEAM_APP_ID, "STEAM_APP_ID");
  const projectName = requireEnv(configValue(env, "PROJECT_DISPLAY_NAME", "STEAM_PROJECT_NAME"), "PROJECT_DISPLAY_NAME");
  requireEnv(env.STEAM_FINANCIAL_API_KEY, "STEAM_FINANCIAL_API_KEY");

  const report: RunReport = {
    projectName,
    appId,
    generatedAt: new Date().toISOString(),
    wishlist: emptyWishlistSnapshot(),
    sales: emptySalesSnapshot(),
    players: emptyPlayerCountSnapshot(),
    owners: emptyOwnersSummary(),
    totals: emptyReportTotals(),
    wishlistBaselineInitialized: false,
    salesBaselineInitialized: false,
    notes: [],
  };

  if (parseBool(env.ENABLE_WISHLIST_REPORTING, true)) {
    const wishlistResult = await buildWishlistDelta(env, appId, options);
    report.wishlist = wishlistResult.delta;
    report.totals = {
      ...report.totals,
      wishlistBalance: wishlistResult.totals.wishlistBalance,
      wishlistAdds: wishlistResult.totals.wishlistAdds,
      wishlistDeletes: wishlistResult.totals.wishlistDeletes,
      wishlistPurchases: wishlistResult.totals.wishlistPurchases,
      wishlistGifts: wishlistResult.totals.wishlistGifts,
      wishlistKnownDays: wishlistResult.totals.wishlistKnownDays,
      wishlistBackfillComplete: wishlistResult.totals.wishlistBackfillComplete,
    };
    report.wishlistBaselineInitialized = wishlistResult.baselineInitialized;
    report.notes.push(...wishlistResult.notes);
  }

  if (parseBool(env.ENABLE_SALES_REPORTING, true)) {
    const salesResult = await buildSalesDelta(env, appId, options);
    report.sales = salesResult.delta;
    report.owners = salesResult.owners;
    report.totals = {
      ...report.totals,
      unitsSold: salesResult.totals.unitsSold,
      refunds: salesResult.totals.refunds,
      keyActivations: salesResult.totals.keyActivations,
      salesKnownDays: salesResult.totals.salesKnownDays,
    };
    report.salesBaselineInitialized = salesResult.baselineInitialized;
    report.notes.push(...salesResult.notes);
  }

  if (parseBool(env.ENABLE_PLAYER_COUNT_REPORTING, true)) {
    const playerResult = await buildPlayerCount(env, appId, options);
    report.players = playerResult.snapshot;
    report.notes.push(...playerResult.notes);
  }

  return report;
}

// End-of-day digest: reports a finalized Steam (UTC) reporting day in full, with country breakdowns.
// It reads lifetime totals from cached KV state and never commits, so it can run alongside the hourly report.
async function buildDailyDigest(env: Env): Promise<RunReport> {
  const appId = requireEnv(env.STEAM_APP_ID, "STEAM_APP_ID");
  const projectName = requireEnv(configValue(env, "PROJECT_DISPLAY_NAME", "STEAM_PROJECT_NAME"), "PROJECT_DISPLAY_NAME");
  requireEnv(env.STEAM_FINANCIAL_API_KEY, "STEAM_FINANCIAL_API_KEY");

  const digestDate = getUtcDateString(-1);

  const report: RunReport = {
    projectName,
    appId,
    generatedAt: new Date().toISOString(),
    wishlist: emptyWishlistSnapshot(),
    sales: emptySalesSnapshot(),
    players: emptyPlayerCountSnapshot(),
    owners: emptyOwnersSummary(),
    totals: emptyReportTotals(),
    wishlistBaselineInitialized: false,
    salesBaselineInitialized: false,
    notes: [],
    digest: { date: digestDate },
  };

  if (parseBool(env.ENABLE_WISHLIST_REPORTING, true)) {
    const fetched = await fetchWishlistSnapshot(env, appId, digestDate);
    report.wishlist = fetched.snapshot;
  }

  if (parseBool(env.ENABLE_SALES_REPORTING, true)) {
    report.sales = await fetchSalesSnapshotForDate(env, appId, digestDate);
  }

  const wishlistState = await getWishlistTotalsState(env, appId, getUtcDateString(0));
  const salesState = await getSalesTotalsState(env, appId);
  report.totals = {
    ...reportTotalsFromWishlistState(wishlistState),
    unitsSold: salesState.unitsSold,
    refunds: salesState.refunds,
    keyActivations: salesState.keyActivations,
    salesKnownDays: salesState.salesKnownDays,
  };
  report.owners = ownersFromSalesState(salesState);

  if (parseBool(env.ENABLE_PLAYER_COUNT_REPORTING, true)) {
    const playerResult = await buildPlayerCount(env, appId, { commitState: false });
    report.players = playerResult.snapshot;
    report.notes.push(...playerResult.notes);
  }

  return report;
}

async function buildWishlistDelta(
  env: Env,
  appId: string,
  options: RunOptions,
): Promise<{ delta: WishlistSnapshot; totals: ReportTotals; baselineInitialized: boolean; notes: string[] }> {
  const dates = uniqueStrings([getUtcDateString(0), getUtcDateString(-1)]);
  const totalDelta = emptyWishlistSnapshot();
  const notes: string[] = [];
  let baselineInitialized = false;
  let appMinDate = "";
  const fetchedSnapshots = new Map<string, WishlistSnapshotWithPrevious>();

  for (const date of dates) {
    const fetched = await fetchWishlistSnapshot(env, appId, date);
    const current = fetched.snapshot;
    appMinDate ||= fetched.appMinDate ?? "";
    const stateKey = `wishlist:${appId}:${date}`;
    const previous = await getJson<WishlistSnapshot>(env, stateKey);
    fetchedSnapshots.set(fetched.date, { current, previous });
    baselineInitialized ||= options.commitState && previous == null;

    const baseline = previous ?? current;
    const delta = diffWishlistSnapshots(current, baseline);
    mergeWishlistSnapshot(totalDelta, delta);

    if (options.commitState) {
      await putJson(env, stateKey, current);
    }
  }

  const totals = await buildWishlistTotals(env, appId, appMinDate, fetchedSnapshots, options);

  if (baselineInitialized) {
    notes.push("Wishlist baseline initialized. Existing wishlist reporting totals were not posted.");
  }

  if (!options.commitState) {
    notes.push("Dry run only. KV state was not changed; totals are a preview.");
  }

  if (!totals.wishlistBackfillComplete) {
    const prefix = options.commitState ? "Wishlist total backfill in progress." : "Wishlist total backfill preview.";
    notes.push(`${prefix} Totals currently include ${totals.wishlistKnownDays} known reporting day${totals.wishlistKnownDays === 1 ? "" : "s"}.`);
  }

  return { delta: totalDelta, totals, baselineInitialized, notes };
}

async function fetchWishlistSnapshot(env: Env, appId: string, date: string): Promise<FetchedWishlistSnapshot> {
  const url = new URL(`${STEAM_FINANCIAL_BASE_URL}/GetAppWishlistReporting/v001/`);
  url.searchParams.set("key", env.STEAM_FINANCIAL_API_KEY);
  url.searchParams.set("appid", appId);
  url.searchParams.set("date", date);
  url.searchParams.set("format", "json");

  const data = await fetchJson<SteamWishlistResponse>(url);
  const response = data.response;
  const summary = response?.wishlist_summary ?? {};

  const snapshot: WishlistSnapshot = {
    adds: toNumber(summary.wishlist_adds),
    deletes: toNumber(summary.wishlist_deletes),
    purchases: toNumber(summary.wishlist_purchases),
    gifts: toNumber(summary.wishlist_gifts),
    windowsAdds: toNumber(summary.wishlist_adds_windows),
    macAdds: toNumber(summary.wishlist_adds_mac),
    linuxAdds: toNumber(summary.wishlist_adds_linux),
    countries: {},
  };

  for (const country of response?.country_summary ?? []) {
    const code = normalizeCountryCode(country.country_code);
    if (!code) {
      continue;
    }

    const actions = country.summary_actions ?? {};
    snapshot.countries[code] = {
      countryCode: code,
      countryName: country.country_name,
      wishlistAdds: toNumber(actions.wishlist_adds),
      wishlistDeletes: toNumber(actions.wishlist_deletes),
      wishlistPurchases: toNumber(actions.wishlist_purchases),
      unitsSold: 0,
      refunds: 0,
      keyActivations: 0,
    };
  }

  return {
    date: normalizeSteamDate(response?.date) ?? date,
    appMinDate: normalizeSteamDate(response?.app_min_date) ?? undefined,
    snapshot,
  };
}

async function buildSalesDelta(
  env: Env,
  appId: string,
  options: RunOptions,
): Promise<{ delta: SalesSnapshot; totals: ReportTotals; owners: OwnersSummary; baselineInitialized: boolean; notes: string[] }> {
  const highwatermarkKey = `sales:changed_dates_highwatermark:${appId}`;
  const pendingKey = `sales:pending_changed_dates:${appId}`;
  const storedHighwatermark = await env.STEAM_REPORTER_STATE.get(highwatermarkKey);
  const baselineOnFirstRun = parseBool(env.BASELINE_SALES_ON_FIRST_RUN, true);
  const pending = await getJson<PendingSalesDates>(env, pendingKey);
  const isFirstRun = pending?.firstRun ?? !storedHighwatermark;
  const totalDelta = emptySalesSnapshot();
  const notes: string[] = [];
  let dates: string[] = [];
  let newHighwatermark = storedHighwatermark ?? "0";

  if (pending && pending.dates.length > 0) {
    dates = pending.dates;
    newHighwatermark = pending.resultHighwatermark;
  } else {
    const highwatermark = storedHighwatermark ?? "0";
    const changedDates = await fetchChangedDates(env, highwatermark);
    dates = changedDates.dates;
    newHighwatermark = changedDates.resultHighwatermark ?? highwatermark;
  }

  if (dates.length === 0) {
    if (options.commitState) {
      await env.STEAM_REPORTER_STATE.put(highwatermarkKey, newHighwatermark);
    } else {
      notes.push("Dry run only. KV state was not changed; sales highwatermark was not updated.");
    }
    notes.push("No changed sales dates reported by Steam.");
    const idleState = await getSalesTotalsState(env, appId);
    return {
      delta: totalDelta,
      totals: reportTotalsFromSalesState(idleState),
      owners: ownersFromSalesState(idleState),
      baselineInitialized: false,
      notes,
    };
  }

  const datesToProcess = dates.slice(0, MAX_SALES_CHANGED_DATES_PER_RUN);
  const remainingDates = dates.slice(MAX_SALES_CHANGED_DATES_PER_RUN);
  const salesTotals = await getSalesTotalsState(env, appId);

  for (const date of datesToProcess) {
    const current = await fetchSalesSnapshotForDate(env, appId, date);
    const stateKey = `sales:${appId}:${date}`;
    const previous = await getJson<SalesSnapshot>(env, stateKey);
    applySalesSnapshotToTotals(salesTotals, current, previous);

    if (isFirstRun && baselineOnFirstRun) {
      if (options.commitState) {
        await putJson(env, stateKey, current);
      }
      continue;
    }

    const baseline = previous ?? emptySalesSnapshot();
    const delta = diffSalesSnapshots(current, baseline);
    mergeSalesSnapshot(totalDelta, delta);
    if (options.commitState) {
      await putJson(env, stateKey, current);
    }
  }

  if (options.commitState) {
    await putJson(env, `sales:totals:${appId}`, salesTotals);
  }

  if (remainingDates.length > 0) {
    if (options.commitState) {
      await putJson(env, pendingKey, {
        dates: remainingDates,
        resultHighwatermark: newHighwatermark,
        firstRun: isFirstRun,
      } satisfies PendingSalesDates);
    }
    notes.push(`Sales total backfill in progress. Processed ${datesToProcess.length} changed date${datesToProcess.length === 1 ? "" : "s"} this run; ${remainingDates.length} remaining.`);
  } else if (options.commitState) {
    await env.STEAM_REPORTER_STATE.delete(pendingKey);
    await env.STEAM_REPORTER_STATE.put(highwatermarkKey, newHighwatermark);
  }

  if (!options.commitState) {
    notes.push("Dry run only. KV state was not changed; sales totals are a preview.");
  }

  if (options.commitState && isFirstRun && baselineOnFirstRun) {
    notes.push("Sales baseline initialized. Historical sales were not posted.");
    return {
      delta: emptySalesSnapshot(),
      totals: reportTotalsFromSalesState(salesTotals),
      owners: ownersFromSalesState(salesTotals),
      baselineInitialized: true,
      notes,
    };
  }

  return {
    delta: totalDelta,
    totals: reportTotalsFromSalesState(salesTotals),
    owners: ownersFromSalesState(salesTotals),
    baselineInitialized: false,
    notes,
  };
}

async function fetchChangedDates(env: Env, highwatermark: string): Promise<{ dates: string[]; resultHighwatermark: string | undefined }> {
  const url = new URL(`${STEAM_FINANCIAL_BASE_URL}/GetChangedDatesForPartner/v001/`);
  url.searchParams.set("key", env.STEAM_FINANCIAL_API_KEY);
  url.searchParams.set("highwatermark", highwatermark);
  url.searchParams.set("format", "json");

  const data = await fetchJson<SteamChangedDatesResponse>(url);
  return {
    dates: data.response?.dates ?? [],
    resultHighwatermark: data.response?.result_highwatermark,
  };
}

async function fetchSalesSnapshotForDate(env: Env, appId: string, date: string): Promise<SalesSnapshot> {
  const snapshot = emptySalesSnapshot();
  let highwatermarkId = "0";
  let loopGuard = 0;

  while (loopGuard < 50) {
    loopGuard += 1;
    const data = await fetchDetailedSales(env, date, highwatermarkId);
    const response = data.response;
    const countryNames = buildCountryNameMap(response?.country_info ?? []);

    for (const row of response?.results ?? []) {
      if (!isRelevantSalesRow(row, appId)) {
        continue;
      }

      const unitsSold = toNumber(row.gross_units_sold);
      const refunds = toRefundCount(row.gross_units_returned);
      const keyActivations = toNumber(row.gross_units_activated);
      const countryCode = normalizeCountryCode(row.country_code) ?? "UNKNOWN";

      snapshot.unitsSold += unitsSold;
      snapshot.refunds += refunds;
      snapshot.keyActivations += keyActivations;

      const country = getOrCreateCountry(snapshot.countries, countryCode, countryNames[countryCode]);
      country.unitsSold += unitsSold;
      country.refunds += refunds;
      country.keyActivations += keyActivations;
    }

    const maxId = response?.max_id;
    if (!maxId || maxId === highwatermarkId) {
      break;
    }

    highwatermarkId = maxId;
  }

  if (loopGuard >= 50) {
    throw new Error(`GetDetailedSales pagination exceeded safe loop limit for date ${date}`);
  }

  return snapshot;
}

async function fetchDetailedSales(env: Env, date: string, highwatermarkId: string): Promise<SteamDetailedSalesResponse> {
  const url = new URL(`${STEAM_FINANCIAL_BASE_URL}/GetDetailedSales/v001/`);
  url.searchParams.set("key", env.STEAM_FINANCIAL_API_KEY);
  url.searchParams.set("date", date);
  url.searchParams.set("highwatermark_id", highwatermarkId);
  url.searchParams.set("format", "json");

  return fetchJson<SteamDetailedSalesResponse>(url);
}

async function buildPlayerCount(
  env: Env,
  appId: string,
  options: RunOptions,
): Promise<{ snapshot: PlayerCountSnapshot; notes: string[] }> {
  const notes: string[] = [];
  const stateKey = `players:peak:${appId}`;
  const stored = await getJson<PlayerCountState>(env, stateKey);
  const previousPeak = Math.max(0, toNumber(stored?.peak));

  let current: number | null = null;
  try {
    current = await fetchCurrentPlayers(env, appId);
  } catch (error) {
    notes.push(`Could not fetch current player count: ${errorToMessage(error)}`);
  }

  const available = current != null;
  const currentValue = current ?? 0;
  const peak = Math.max(previousPeak, currentValue);
  const improved = available && peak > previousPeak;
  // Only call it a record once a real baseline exists; the first observation just seeds the peak.
  const newPeak = improved && previousPeak > 0;
  const peakAt = improved ? new Date().toISOString() : stored?.peakAt;

  if (options.commitState && improved) {
    await putJson(env, stateKey, { peak, peakAt } satisfies PlayerCountState);
  }

  return {
    snapshot: { available, current: currentValue, peak, peakAt, newPeak },
    notes,
  };
}

async function fetchCurrentPlayers(env: Env, appId: string): Promise<number> {
  const url = new URL(`${STEAM_WEB_API_BASE_URL}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/`);
  url.searchParams.set("appid", appId);
  url.searchParams.set("format", "json");

  const data = await fetchJson<SteamCurrentPlayersResponse>(url);
  const response = data.response;
  if (response?.result !== 1 || response.player_count == null) {
    throw new Error("Steam did not return a current player count for this app.");
  }

  return toNumber(response.player_count);
}

async function buildWishlistTotals(
  env: Env,
  appId: string,
  appMinDate: string,
  fetchedSnapshots: Map<string, WishlistSnapshotWithPrevious>,
  options: RunOptions,
): Promise<ReportTotals> {
  const today = getUtcDateString(0);
  const totalsKey = `wishlist:totals:${appId}`;
  const state = await getWishlistTotalsState(env, appId, appMinDate || today);
  const startDate = state.backfillCursor;
  const backfillDates = enumerateDateStrings(startDate, today, MAX_WISHLIST_TOTAL_BACKFILL_DAYS_PER_RUN);

  for (const date of backfillDates) {
    const fetched = fetchedSnapshots.get(date);
    const snapshot = fetched?.current ?? (await fetchWishlistSnapshot(env, appId, date)).snapshot;
    applyWishlistSnapshotToTotals(state, snapshot, null);
    if (options.commitState) {
      await putJson(env, `wishlist:${appId}:${date}`, snapshot);
    }
  }

  const nextCursor = backfillDates.length > 0 ? addUtcDays(backfillDates[backfillDates.length - 1], 1) : startDate;
  state.backfillCursor = nextCursor;
  state.wishlistBackfillComplete = compareDateStrings(nextCursor, today) > 0;

  for (const [date, fetched] of fetchedSnapshots) {
    if (isWishlistDateCountedInTotals(state, date) && !backfillDates.includes(date)) {
      applyWishlistSnapshotToTotals(state, fetched.current, fetched.previous);
    }
  }

  if (options.commitState) {
    await putJson(env, totalsKey, state);
  }

  return reportTotalsFromWishlistState(state);
}

async function getWishlistTotalsState(env: Env, appId: string, fallbackStartDate: string): Promise<WishlistTotalsState> {
  const stored = await getJson<WishlistTotalsState>(env, `wishlist:totals:${appId}`);
  if (stored) {
    return {
      ...stored,
      backfillCursor: normalizeSteamDate(stored.backfillCursor) ?? fallbackStartDate,
    };
  }

  return {
    wishlistBalance: 0,
    wishlistAdds: 0,
    wishlistDeletes: 0,
    wishlistPurchases: 0,
    wishlistGifts: 0,
    wishlistKnownDays: 0,
    wishlistBackfillComplete: false,
    backfillCursor: normalizeSteamDate(fallbackStartDate) ?? getUtcDateString(0),
  };
}

async function getSalesTotalsState(env: Env, appId: string): Promise<SalesTotalsState> {
  const stored = await getJson<SalesTotalsState>(env, `sales:totals:${appId}`);
  if (stored) {
    // Older state predates per-country owner tracking; default it so accumulation can start.
    return { ...stored, countries: stored.countries ?? {} };
  }

  return {
    unitsSold: 0,
    refunds: 0,
    keyActivations: 0,
    salesKnownDays: 0,
    countries: {},
  };
}

function ownersFromSalesState(state: SalesTotalsState): OwnersSummary {
  const countries: Record<string, CountryTotals> = {};
  for (const country of Object.values(state.countries ?? {})) {
    countries[country.countryCode] = { ...country };
  }

  return {
    total: ownerCount(state.unitsSold, state.refunds, state.keyActivations),
    countries,
  };
}

function ownerCount(unitsSold: number, refunds: number, keyActivations: number): number {
  return Math.max(0, unitsSold - refunds + keyActivations);
}

function emptyOwnersSummary(): OwnersSummary {
  return { total: 0, countries: {} };
}

function applyWishlistSnapshotToTotals(state: WishlistTotalsState, current: WishlistSnapshot, previous: WishlistSnapshot | null): void {
  const previousSnapshot = previous ?? emptyWishlistSnapshot();
  state.wishlistAdds += current.adds - previousSnapshot.adds;
  state.wishlistDeletes += current.deletes - previousSnapshot.deletes;
  state.wishlistPurchases += current.purchases - previousSnapshot.purchases;
  state.wishlistGifts += current.gifts - previousSnapshot.gifts;
  state.wishlistBalance = Math.max(0, state.wishlistAdds - state.wishlistDeletes - state.wishlistPurchases - state.wishlistGifts);

  if (!previous) {
    state.wishlistKnownDays += 1;
  }
}

function applySalesSnapshotToTotals(state: SalesTotalsState, current: SalesSnapshot, previous: SalesSnapshot | null): void {
  const previousSnapshot = previous ?? emptySalesSnapshot();
  state.unitsSold += current.unitsSold - previousSnapshot.unitsSold;
  state.refunds += current.refunds - previousSnapshot.refunds;
  state.keyActivations += current.keyActivations - previousSnapshot.keyActivations;

  const countryCodes = uniqueStrings([...Object.keys(current.countries), ...Object.keys(previousSnapshot.countries)]);
  for (const code of countryCodes) {
    const currentCountry = current.countries[code] ?? emptyCountryTotals(code);
    const previousCountry = previousSnapshot.countries[code] ?? emptyCountryTotals(code);
    const target = getOrCreateCountry(state.countries, code, currentCountry.countryName ?? previousCountry.countryName);
    target.unitsSold += currentCountry.unitsSold - previousCountry.unitsSold;
    target.refunds += currentCountry.refunds - previousCountry.refunds;
    target.keyActivations += currentCountry.keyActivations - previousCountry.keyActivations;
  }

  if (!previous) {
    state.salesKnownDays += 1;
  }
}

function isWishlistDateCountedInTotals(state: WishlistTotalsState, date: string): boolean {
  if (state.wishlistBackfillComplete) {
    return true;
  }
  return compareDateStrings(date, state.backfillCursor) < 0;
}

function reportTotalsFromWishlistState(state: WishlistTotalsState): ReportTotals {
  return {
    ...emptyReportTotals(),
    wishlistBalance: state.wishlistBalance,
    wishlistAdds: state.wishlistAdds,
    wishlistDeletes: state.wishlistDeletes,
    wishlistPurchases: state.wishlistPurchases,
    wishlistGifts: state.wishlistGifts,
    wishlistKnownDays: state.wishlistKnownDays,
    wishlistBackfillComplete: state.wishlistBackfillComplete,
  };
}

function reportTotalsFromSalesState(state: SalesTotalsState): ReportTotals {
  return {
    ...emptyReportTotals(),
    unitsSold: state.unitsSold,
    refunds: state.refunds,
    keyActivations: state.keyActivations,
    salesKnownDays: state.salesKnownDays,
  };
}

async function postDiscordReport(env: Env, report: RunReport): Promise<void> {
  const webhookUrl = requireEnv(env.DISCORD_WEBHOOK_URL, "DISCORD_WEBHOOK_URL");
  const topCountryLimit = parseIntSafe(env.TOP_COUNTRY_LIMIT, 5);
  const active = hasActivity(report);
  const timeZone = resolveReportTimeZone(env);
  const isDigest = report.digest != null;
  const daySuffix = isDigest ? ` (${report.digest!.date} UTC)` : "";

  const fields = [
    {
      name: report.totals.wishlistBackfillComplete ? "Totals" : "Known Totals",
      value: formatTotals(report.totals, report.owners),
      inline: false,
    },
    {
      name: `Wishlist${daySuffix}`,
      value: formatWishlist(report.wishlist),
      inline: false,
    },
    {
      name: `Sales${daySuffix}`,
      value: formatSales(report.sales),
      inline: false,
    },
  ];

  if (report.players.available || report.players.peak > 0) {
    fields.push({
      name: "Players",
      value: formatPlayers(report.players, timeZone),
      inline: false,
    });
  }

  const ownerCountries = formatTopOwnerCountries(report.owners.countries, topCountryLimit);
  if (ownerCountries) {
    fields.push({ name: "Top Owner Countries", value: ownerCountries, inline: false });
  }

  const wishlistCountries = formatTopCountries(report.wishlist.countries, "wishlistAdds", "wishlist", topCountryLimit);
  if (wishlistCountries) {
    fields.push({ name: `Top Wishlist Countries${daySuffix}`, value: wishlistCountries, inline: false });
  }

  const salesCountries = formatTopCountries(report.sales.countries, "unitsSold", "sold", topCountryLimit);
  if (salesCountries) {
    fields.push({ name: `Top Sales Countries${daySuffix}`, value: salesCountries, inline: false });
  }

  if (report.notes.length > 0) {
    fields.push({ name: "Notes", value: report.notes.join("\n"), inline: false });
  }

  fields.push({
    name: "Report Time",
    value: `${formatDateTime(report.generatedAt, timeZone)} (${timeZone})`,
    inline: false,
  });

  const title = isDigest
    ? `📅 ${report.projectName} — Daily Summary`
    : `🎮 ${report.projectName} — Steam Report`;
  const description = isDigest
    ? `End-of-day summary for Steam reporting day ${report.digest!.date} (UTC).`
    : active
      ? "Latest Steam activity counts."
      : "No new Steam activity.";

  const body = {
    username: "Steam Reporter",
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title,
        description,
        fields,
        timestamp: report.generatedAt,
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
  }
}

function formatWishlist(wishlist: WishlistSnapshot): string {
  return [
    `${formatSigned(wishlist.adds)} new wishlists`,
    `${formatSigned(-wishlist.deletes)} removed wishlists`,
    `${formatPlain(wishlist.purchases)} wishlist purchases`,
    `${formatPlain(wishlist.gifts)} wishlist gifts`,
  ].join("\n");
}

function formatSales(sales: SalesSnapshot): string {
  return [
    `${formatSigned(sales.unitsSold)} units sold`,
    `${formatPlain(sales.refunds)} refunds`,
    `${formatPlain(sales.keyActivations)} key activations`,
  ].join("\n");
}

function formatPlayers(players: PlayerCountSnapshot, timeZone: string): string {
  const lines: string[] = [];

  if (players.available) {
    lines.push(`${formatPlain(players.current)} players online now`);
  } else {
    lines.push("Current player count unavailable");
  }

  if (players.peak > 0) {
    const peakSuffix = players.peakAt ? ` (set ${formatDateTime(players.peakAt, timeZone)})` : "";
    const recordTag = players.newPeak ? " 🏆 new record" : "";
    lines.push(`${formatPlain(players.peak)} peak players online${peakSuffix}${recordTag}`);
  }

  return lines.join("\n");
}

function formatTotals(totals: ReportTotals, owners: OwnersSummary): string {
  return [
    `${formatPlain(owners.total)} total owners (lifetime downloads)`,
    `${formatPlain(totals.wishlistBalance)} current wishlist balance`,
    `${formatPlain(totals.wishlistAdds)} lifetime wishlist adds`,
    `${formatPlain(totals.unitsSold)} lifetime units sold`,
    `${formatPlain(totals.refunds)} lifetime refunds`,
    `${formatPlain(totals.keyActivations)} lifetime key activations`,
  ].join("\n");
}

function formatTopOwnerCountries(countries: Record<string, CountryTotals>, limit: number): string | null {
  const entries = Object.values(countries)
    .map((country) => ({ country, owners: ownerCount(country.unitsSold, country.refunds, country.keyActivations) }))
    .filter((entry) => entry.owners > 0)
    .sort((a, b) => b.owners - a.owners)
    .slice(0, limit);

  if (entries.length === 0) {
    return null;
  }

  return entries
    .map(({ country, owners }) => {
      const name = country.countryName || country.countryCode;
      return `${countryCodeToFlag(country.countryCode)} ${name}: ${owners} owners`;
    })
    .join("\n");
}

function formatTopCountries(
  countries: Record<string, CountryTotals>,
  metric: keyof Pick<CountryTotals, "wishlistAdds" | "unitsSold" | "keyActivations">,
  label: string,
  limit: number,
): string | null {
  const entries = Object.values(countries)
    .filter((country) => toNumber(country[metric]) > 0)
    .sort((a, b) => toNumber(b[metric]) - toNumber(a[metric]))
    .slice(0, limit);

  if (entries.length === 0) {
    return null;
  }

  return entries
    .map((country) => {
      const name = country.countryName || country.countryCode;
      return `${countryCodeToFlag(country.countryCode)} ${name}: +${toNumber(country[metric])} ${label}`;
    })
    .join("\n");
}

function hasActivity(report: RunReport): boolean {
  return (
    report.wishlist.adds !== 0 ||
    report.wishlist.deletes !== 0 ||
    report.wishlist.purchases !== 0 ||
    report.wishlist.gifts !== 0 ||
    report.sales.unitsSold !== 0 ||
    report.sales.refunds !== 0 ||
    report.sales.keyActivations !== 0
  );
}


function parseScheduleIntervalHours(env: Env): number {
  return parseIntSafe(env.REPORT_INTERVAL_HOURS, 1);
}

function parseFirstReportLocalHour(env: Env): number {
  const hour = Number.parseInt(configValue(env, "FIRST_LOCAL_REPORT_HOUR", "FIRST_REPORT_LOCAL_HOUR") ?? "0", 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0;
}

function parseDigestLocalHour(env: Env): number {
  const hour = Number.parseInt(env.DAILY_DIGEST_LOCAL_HOUR ?? "0", 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0;
}

// Hourly (or REPORT_INTERVAL_HOURS) incremental report. Posts only when activity changed.
async function shouldRunIncrementalReport(env: Env, timeZone: string, local: LocalDateTimeParts): Promise<boolean> {
  const intervalHours = parseScheduleIntervalHours(env);
  const firstHour = parseFirstReportLocalHour(env);

  if (positiveModulo(local.hour - firstHour, intervalHours) !== 0) {
    return false;
  }

  const slotKey = `schedule:last_slot:${timeZone}:${intervalHours}:${firstHour}`;
  const slotValue = `${local.year}-${pad2(local.month)}-${pad2(local.day)}-${pad2(local.hour)}`;
  if ((await env.STEAM_REPORTER_STATE.get(slotKey)) === slotValue) {
    return false;
  }

  await env.STEAM_REPORTER_STATE.put(slotKey, slotValue);
  return true;
}

// Once-per-day end-of-day digest, posted even when nothing changed.
async function shouldRunDailyDigest(env: Env, timeZone: string, local: LocalDateTimeParts): Promise<boolean> {
  if (!parseBool(env.ENABLE_DAILY_DIGEST, true)) {
    return false;
  }

  if (local.hour !== parseDigestLocalHour(env)) {
    return false;
  }

  const slotKey = `digest:last_day:${timeZone}:${parseDigestLocalHour(env)}`;
  const slotValue = `${local.year}-${pad2(local.month)}-${pad2(local.day)}`;
  if ((await env.STEAM_REPORTER_STATE.get(slotKey)) === slotValue) {
    return false;
  }

  await env.STEAM_REPORTER_STATE.put(slotKey, slotValue);
  return true;
}

function getLocalDateTimeParts(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return {
    year: Number.parseInt(map.year, 10),
    month: Number.parseInt(map.month, 10),
    day: Number.parseInt(map.day, 10),
    hour: Number.parseInt(map.hour, 10),
    minute: Number.parseInt(map.minute, 10),
  };
}

function diffWishlistSnapshots(current: WishlistSnapshot, previous: WishlistSnapshot): WishlistSnapshot {
  const result = emptyWishlistSnapshot();
  result.adds = current.adds - previous.adds;
  result.deletes = current.deletes - previous.deletes;
  result.purchases = current.purchases - previous.purchases;
  result.gifts = current.gifts - previous.gifts;
  result.windowsAdds = current.windowsAdds - previous.windowsAdds;
  result.macAdds = current.macAdds - previous.macAdds;
  result.linuxAdds = current.linuxAdds - previous.linuxAdds;

  const countryCodes = uniqueStrings([...Object.keys(current.countries), ...Object.keys(previous.countries)]);
  for (const code of countryCodes) {
    const currentCountry = current.countries[code] ?? emptyCountryTotals(code);
    const previousCountry = previous.countries[code] ?? emptyCountryTotals(code);
    result.countries[code] = {
      countryCode: code,
      countryName: currentCountry.countryName ?? previousCountry.countryName,
      wishlistAdds: currentCountry.wishlistAdds - previousCountry.wishlistAdds,
      wishlistDeletes: currentCountry.wishlistDeletes - previousCountry.wishlistDeletes,
      wishlistPurchases: currentCountry.wishlistPurchases - previousCountry.wishlistPurchases,
      unitsSold: 0,
      refunds: 0,
      keyActivations: 0,
    };
  }

  return result;
}

function diffSalesSnapshots(current: SalesSnapshot, previous: SalesSnapshot): SalesSnapshot {
  const result = emptySalesSnapshot();
  result.unitsSold = current.unitsSold - previous.unitsSold;
  result.refunds = current.refunds - previous.refunds;
  result.keyActivations = current.keyActivations - previous.keyActivations;

  const countryCodes = uniqueStrings([...Object.keys(current.countries), ...Object.keys(previous.countries)]);
  for (const code of countryCodes) {
    const currentCountry = current.countries[code] ?? emptyCountryTotals(code);
    const previousCountry = previous.countries[code] ?? emptyCountryTotals(code);
    result.countries[code] = {
      countryCode: code,
      countryName: currentCountry.countryName ?? previousCountry.countryName,
      wishlistAdds: 0,
      wishlistDeletes: 0,
      wishlistPurchases: 0,
      unitsSold: currentCountry.unitsSold - previousCountry.unitsSold,
      refunds: currentCountry.refunds - previousCountry.refunds,
      keyActivations: currentCountry.keyActivations - previousCountry.keyActivations,
    };
  }

  return result;
}

function mergeWishlistSnapshot(target: WishlistSnapshot, source: WishlistSnapshot): void {
  target.adds += source.adds;
  target.deletes += source.deletes;
  target.purchases += source.purchases;
  target.gifts += source.gifts;
  target.windowsAdds += source.windowsAdds;
  target.macAdds += source.macAdds;
  target.linuxAdds += source.linuxAdds;

  for (const country of Object.values(source.countries)) {
    const targetCountry = getOrCreateCountry(target.countries, country.countryCode, country.countryName);
    targetCountry.wishlistAdds += country.wishlistAdds;
    targetCountry.wishlistDeletes += country.wishlistDeletes;
    targetCountry.wishlistPurchases += country.wishlistPurchases;
  }
}

function mergeSalesSnapshot(target: SalesSnapshot, source: SalesSnapshot): void {
  target.unitsSold += source.unitsSold;
  target.refunds += source.refunds;
  target.keyActivations += source.keyActivations;

  for (const country of Object.values(source.countries)) {
    const targetCountry = getOrCreateCountry(target.countries, country.countryCode, country.countryName);
    targetCountry.unitsSold += country.unitsSold;
    targetCountry.refunds += country.refunds;
    targetCountry.keyActivations += country.keyActivations;
  }
}

function emptyWishlistSnapshot(): WishlistSnapshot {
  return {
    adds: 0,
    deletes: 0,
    purchases: 0,
    gifts: 0,
    windowsAdds: 0,
    macAdds: 0,
    linuxAdds: 0,
    countries: {},
  };
}

function emptySalesSnapshot(): SalesSnapshot {
  return {
    unitsSold: 0,
    refunds: 0,
    keyActivations: 0,
    countries: {},
  };
}

function emptyPlayerCountSnapshot(): PlayerCountSnapshot {
  return {
    available: false,
    current: 0,
    peak: 0,
    peakAt: undefined,
    newPeak: false,
  };
}

function emptyReportTotals(): ReportTotals {
  return {
    wishlistBalance: 0,
    wishlistAdds: 0,
    wishlistDeletes: 0,
    wishlistPurchases: 0,
    wishlistGifts: 0,
    wishlistKnownDays: 0,
    wishlistBackfillComplete: true,
    unitsSold: 0,
    refunds: 0,
    keyActivations: 0,
    salesKnownDays: 0,
  };
}

function emptyCountryTotals(countryCode: string, countryName?: string): CountryTotals {
  return {
    countryCode,
    countryName,
    wishlistAdds: 0,
    wishlistDeletes: 0,
    wishlistPurchases: 0,
    unitsSold: 0,
    refunds: 0,
    keyActivations: 0,
  };
}

function getOrCreateCountry(countries: Record<string, CountryTotals>, countryCode: string, countryName?: string): CountryTotals {
  const existing = countries[countryCode];
  if (existing) {
    if (!existing.countryName && countryName) {
      existing.countryName = countryName;
    }
    return existing;
  }

  const created = emptyCountryTotals(countryCode, countryName);
  countries[countryCode] = created;
  return created;
}

function isRelevantSalesRow(row: SteamDetailedSalesRow, appId: string): boolean {
  const targetAppId = String(appId);
  const rowAppId = row.appid == null ? "" : String(row.appid);
  const rowPrimaryAppId = row.primary_appid == null ? "" : String(row.primary_appid);

  return rowAppId === targetAppId || rowPrimaryAppId === targetAppId;
}

function buildCountryNameMap(countryInfo: SteamCountryInfo[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const country of countryInfo) {
    const code = normalizeCountryCode(country.country_code);
    if (code && country.country_name) {
      map[code] = country.country_name;
    }
  }
  return map;
}

async function fetchJson<T>(url: URL): Promise<T> {
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Steam API failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.STEAM_REPORTER_STATE.get(key);
  if (!value) {
    return null;
  }
  return JSON.parse(value) as T;
}

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.STEAM_REPORTER_STATE.put(key, JSON.stringify(value));
}

function configValue(env: Env, primary: keyof Env, legacy?: keyof Env): string | undefined {
  const primaryValue = env[primary];
  if (typeof primaryValue === "string" && primaryValue.trim() !== "") {
    return primaryValue;
  }

  const legacyValue = legacy ? env[legacy] : undefined;
  return typeof legacyValue === "string" && legacyValue.trim() !== "" ? legacyValue : undefined;
}

function resolveReportTimeZone(env: Env): string {
  const configured = configValue(env, "REPORT_TIMEZONE", "REPORT_TIME_ZONE") || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configured }).format(new Date());
    return configured;
  } catch {
    return "UTC";
  }
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toRefundCount(value: unknown): number {
  const numberValue = toNumber(value);
  return Math.abs(numberValue);
}

function normalizeCountryCode(value: string | undefined): string | null {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function countryCodeToFlag(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return "🏳️";
  }

  return [...countryCode]
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");
}

function getUtcDateString(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeSteamDate(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  const separated = trimmed.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (separated) {
    return `${separated[1]}-${separated[2]}-${separated[3]}`;
  }

  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }

  return null;
}

function enumerateDateStrings(startDate: string, endDate: string, limit: number): string[] {
  const dates: string[] = [];
  let current = normalizeSteamDate(startDate);
  const end = normalizeSteamDate(endDate);

  while (current && end && compareDateStrings(current, end) <= 0 && dates.length < limit) {
    dates.push(current);
    current = addUtcDays(current, 1);
  }

  return dates;
}

function addUtcDays(dateString: string, days: number): string {
  const date = parseDateOnly(dateString) ?? new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

function compareDateStrings(a: string, b: string): number {
  const dateA = parseDateOnly(a);
  const dateB = parseDateOnly(b);
  if (!dateA || !dateB) {
    return 0;
  }
  return dateA.getTime() - dateB.getTime();
}

function parseDateOnly(value: string): Date | null {
  const normalized = normalizeSteamDate(value);
  if (!normalized) {
    return null;
  }

  const timestamp = Date.parse(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function formatDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

function formatSigned(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  return String(value);
}

function formatPlain(value: number): string {
  return String(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function isAuthorizedManualRun(token: string | null, expectedToken: string | undefined): Promise<boolean> {
  if (!token || !expectedToken) {
    return false;
  }

  const encoder = new TextEncoder();
  const [tokenDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);

  return token.length === expectedToken.length && equalBytes(new Uint8Array(tokenDigest), new Uint8Array(expectedDigest));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

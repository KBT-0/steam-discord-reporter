#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildLocalReportTimes,
  intervalDividesDay,
  isValidDiscordWebhookUrl,
  isValidSteamAppId,
  isValidSteamFinancialApiKey,
  isValidTimeZone,
  isValidWorkerName,
  normalizeRawInput,
  parsePositiveInteger,
  slugify,
} from "./setup-utils.mjs";

const rl = createInterface({ input, output });

const PROJECT_ROOT = new URL("../", import.meta.url);
const PROJECT_ROOT_PATH = fileURLToPath(PROJECT_ROOT);
const WRANGLER_EXAMPLE_PATH = new URL("wrangler.example.toml", PROJECT_ROOT);
const WRANGLER_PATH = new URL("wrangler.toml", PROJECT_ROOT);
const SECRET_BULK_PATH = new URL(".steam-discord-reporter.secrets.tmp.json", PROJECT_ROOT);
const SETUP_STATE_PATH = new URL(".setup-state.tmp.json", PROJECT_ROOT);
const WRANGLER_BIN_PATH = new URL("node_modules/wrangler/bin/wrangler.js", PROJECT_ROOT);
const KV_NAMESPACE_BINDING = "STEAM_REPORTER_STATE";

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  if (process.argv.includes("--check-wrangler")) {
    checkWranglerLoginStatus();
    return;
  }

  printHeader();

  const setupState = await readSetupState();
  if (Object.keys(setupState).length > 0) {
    console.log("Loaded previous non-secret setup answers from .setup-state.tmp.json.");
    console.log("Press Enter at a prompt to reuse a saved default, or type a new value.\n");
  }

  const detectedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const projectName = await askAndSave(setupState, "projectDisplayName", () =>
    askRequired("Steam project display name", setupState.projectDisplayName ?? "My Steam Game"),
  );
  const appId = await askAndSave(setupState, "steamAppId", () =>
    askSteamAppId("Steam AppID", setupState.steamAppId),
  );
  const reportTimeZone = await askAndSave(setupState, "reportTimezone", () =>
    askTimeZone("Report timezone", setupState.reportTimezone ?? detectedTimeZone),
  );
  const reportIntervalHours = await askAndSave(setupState, "reportIntervalHours", () =>
    askIntervalHours("Report interval in hours", setupState.reportIntervalHours ?? "1"),
  );
  const firstReportHour = await askAndSave(setupState, "firstLocalReportHour", () =>
    askHour("First local report hour, 0-23", setupState.firstLocalReportHour ?? "0"),
  );
  printSchedulePreview(reportTimeZone, Number(reportIntervalHours), Number(firstReportHour));

  const topCountryLimit = await askAndSave(setupState, "topCountryLimit", () =>
    askPositiveInteger("Top country limit", setupState.topCountryLimit ?? "5"),
  );
  const sendEmptyReports = await askAndSave(setupState, "sendEmptyReports", () =>
    confirm("Send reports even when there is no new activity?", savedBoolean(setupState.sendEmptyReports, false)),
  );
  const enableWishlist = await askAndSave(setupState, "enableWishlistReporting", () =>
    confirm("Enable wishlist reporting?", savedBoolean(setupState.enableWishlistReporting, true)),
  );
  const enableSales = await askAndSave(setupState, "enableSalesReporting", () =>
    confirm("Enable sales/refund/key activation reporting?", savedBoolean(setupState.enableSalesReporting, true)),
  );
  const enablePlayerCount = await askAndSave(setupState, "enablePlayerCountReporting", () =>
    confirm("Enable current/peak player count and total owners reporting?", savedBoolean(setupState.enablePlayerCountReporting, true)),
  );
  const enableDailyDigest = await askAndSave(setupState, "enableDailyDigest", () =>
    confirm("Also send a separate end-of-day digest once a day?", savedBoolean(setupState.enableDailyDigest, true)),
  );
  const dailyDigestHour = await askAndSave(setupState, "dailyDigestLocalHour", () =>
    askHour("Daily digest local hour, 0-23", setupState.dailyDigestLocalHour ?? "0"),
  );
  if (enableDailyDigest) {
    console.log(`The end-of-day digest will post once a day around ${String(dailyDigestHour).padStart(2, "0")}:00 ${reportTimeZone},`);
    console.log("summarizing the most recent finalized Steam (UTC) reporting day with country breakdowns.\n");
  }

  printDiscordWebhookHelp();
  const discordWebhookUrl = await askDiscordWebhookUrl("Discord webhook URL");

  printSteamApiKeyHelp();
  const steamApiKey = await askSteamFinancialApiKey("Steam Financial API key");

  const workerNameDefault = `${slugify(projectName)}-steam-reporter`;
  const workerName = await askAndSave(setupState, "workerName", () =>
    askWorkerName("Cloudflare Worker name", setupState.workerName ?? workerNameDefault),
  );
  const manualRunToken = await ask("Manual run token", randomBytes(24).toString("hex"));

  printCloudflareHelp();
  await ensureCloudflareLogin();

  const kvNamespaceId = await resolveKvNamespaceId(KV_NAMESPACE_BINDING, setupState.kvNamespaceId);
  await saveSetupState({ ...setupState, kvNamespaceId });

  await writeWranglerToml({
    workerName,
    kvNamespaceBinding: KV_NAMESPACE_BINDING,
    kvNamespaceId,
    projectName,
    appId,
    reportTimeZone,
    reportIntervalHours,
    firstReportHour,
    topCountryLimit,
    sendEmptyReports,
    enableWishlist,
    enableSales,
    enablePlayerCount,
    enableDailyDigest,
    dailyDigestHour,
  });

  await putSecretsBulk({
    DISCORD_WEBHOOK_URL: discordWebhookUrl,
    STEAM_FINANCIAL_API_KEY: steamApiKey,
    MANUAL_RUN_TOKEN: manualRunToken,
  });

  const shouldDeploy = await confirm("Deploy to Cloudflare now?", true);
  let workerUrl = "";
  if (shouldDeploy) {
    const deploy = runWrangler(["deploy"], { capture: true });
    printCommandOutput(deploy);
    workerUrl = parseWorkersDevUrl(`${deploy.stdout}\n${deploy.stderr}`);
    if (workerUrl) {
      await initializeWorkerTotals(workerUrl, manualRunToken);
    } else {
      console.log("\nCould not detect a workers.dev URL from Wrangler output.");
      console.log("After deployment, initialize totals yourself without posting to Discord:");
      console.log("https://YOUR_WORKER_URL/run?token=" + manualRunToken + "&post=false&commit=true");
    }
  }

  console.log("\nDone.");
  console.log("Manual run token:", manualRunToken);
  const manualBaseUrl = workerUrl || "https://YOUR_WORKER_URL";
  console.log("Manual test URL:", manualBaseUrl + "/run?token=" + manualRunToken);
  console.log("Dry run URL:", manualBaseUrl + "/run?token=" + manualRunToken + "&post=false");
  console.log("Initialize totals URL:", manualBaseUrl + "/run?token=" + manualRunToken + "&post=false&commit=true");
}

function printHeader() {
  console.log("\nSteam Discord Reporter Setup");
  console.log("--------------------------------");
  console.log("This setup creates Cloudflare Worker config, KV state, secrets, and deployment.");
  console.log("The Discord report intentionally excludes revenue, gross, net, tax, price, currency, and Steam cut fields.");
  console.log("This setup does not create or push a GitHub repository. Users should clone this repo and deploy their own Worker.\n");
}

function printHelp() {
  console.log(`
Steam Discord Reporter Setup

Usage:
  npm run setup
  npm run setup -- --help
  npm run setup -- --check-wrangler

This interactive setup asks for:
- Steam project display name and Steam AppID
- Local report schedule and top country limit
- Discord webhook URL
- Steamworks Financial API key
- Cloudflare Worker name and manual run token

It then checks Wrangler login, creates or reuses the STEAM_REPORTER_STATE KV namespace, writes wrangler.toml, uploads secrets with wrangler secret bulk, and optionally deploys the Worker.

After deploy, setup initializes all-time count totals with:
  /run?token=YOUR_MANUAL_RUN_TOKEN&post=false&commit=true

That initializes KV state without posting to Discord. Plain post=false is a true dry run and does not change KV state.
`.trim());
}

function checkWranglerLoginStatus() {
  console.log("Checking Cloudflare Wrangler login with the same command runner used by setup...");
  const result = runWrangler(["whoami"], { capture: true, allowFailure: true });
  printCommandOutput(result);
  if (!result.ok) {
    console.log("\nCloudflare login was not detected. Run `npx wrangler login`, then try `npm run setup -- --check-wrangler` again.");
    process.exitCode = 1;
    return;
  }
  console.log("\nCloudflare login detected.");
}

function printSchedulePreview(timeZone, intervalHours, firstHour) {
  const times = buildLocalReportTimes(intervalHours, firstHour);

  console.log("\nSchedule preview");
  console.log(`Timezone: ${timeZone}`);
  console.log(`Interval: every ${intervalHours} hour${intervalHours === 1 ? "" : "s"}`);
  console.log(`Local report times: ${times.join(", ")}`);
  console.log("Cloudflare Cron itself runs every 15 minutes in UTC; the Worker posts only when these local times are due.\n");
}

function printDiscordWebhookHelp() {
  console.log("\nWhere to get the Discord webhook URL:");
  console.log("1. Open the Discord channel that should receive Steam reports.");
  console.log("2. Open Channel Settings > Integrations > Webhooks.");
  console.log("3. Create a new webhook and copy its Webhook URL.");
  console.log("4. Paste the raw URL below. Do not add quotes, Markdown, spaces, or asterisks.");
  console.log("5. It will be stored as a Cloudflare secret, not written to wrangler.toml.\n");
}

function printSteamApiKeyHelp() {
  console.log("\nWhere to get the Steam Financial API key:");
  console.log("Important: this is NOT the normal Steam Web API key and it is NOT created from Manage Users.");
  console.log("You need a separate Financial API Group in Steamworks.");
  console.log("");
  console.log("Path in Steamworks:");
  console.log("1. Open Steamworks Partner site.");
  console.log("2. Go to Users & Permissions > Manage Groups.");
  console.log("   Turkish UI: Kullanıcılar ve İzinler > Grupları Yönet.");
  console.log("3. Create a new Financial API Group, or open an existing Financial API Group.");
  console.log("4. Open that Financial API Group page.");
  console.log("5. Copy the Financial Web API key shown on that group page.");
  console.log("");
  console.log("If you cannot see Financial API Group options, your Steamworks account probably lacks owner/admin/financial permissions.");
  console.log("Ask the partner account owner to create the group or grant the required permissions.");
  console.log("");
  console.log("Required Steamworks endpoints used by this project:");
  console.log("- IPartnerFinancialsService/GetAppWishlistReporting");
  console.log("- IPartnerFinancialsService/GetChangedDatesForPartner");
  console.log("- IPartnerFinancialsService/GetDetailedSales");
  console.log("");
  console.log("Paste the raw 32-character hex key below. Do not add quotes, Markdown, spaces, or asterisks.");
  console.log("Keep this key private. It is stored as a Cloudflare secret and is not written to Git.\n");
}

function printCloudflareHelp() {
  console.log("\nCloudflare setup");
  console.log("The setup script will use Wrangler to:");
  console.log("- Check your Cloudflare login state.");
  console.log("- Create or reuse a KV namespace to store previous Steam snapshots.");
  console.log("- Store Steam and Discord credentials as Cloudflare secrets.");
  console.log("- Deploy the Worker.");
  console.log("The Worker wakes up every 15 minutes, but it posts only when your selected local report interval is due.\n");
}

async function ask(question, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return normalizeRawInput(answer || fallback);
}

async function askAndSave(state, key, askFn) {
  const value = await askFn();
  state[key] = value;
  await saveSetupState(state);
  return value;
}

async function askRequired(question, fallback = "") {
  while (true) {
    const answer = await ask(question, fallback);
    if (answer.trim()) {
      return answer.trim();
    }
    console.log("This value is required.");
  }
}

async function askSteamAppId(question, fallback = "") {
  while (true) {
    const answer = await askRequired(question, fallback);
    if (isValidSteamAppId(answer)) {
      return answer;
    }
    console.log("Steam AppID must be numeric, for example: 123456.");
  }
}

async function askTimeZone(question, fallback) {
  while (true) {
    const answer = await askRequired(question, fallback);
    if (isValidTimeZone(answer)) {
      return answer;
    }
    console.log("That does not look like a valid IANA timezone, for example: Europe/Istanbul or America/New_York.");
  }
}

async function askDiscordWebhookUrl(question) {
  while (true) {
    const answer = await askRequired(question);
    if (answer.includes("*")) {
      console.log("The URL contains '*'. Paste the raw Discord webhook URL, not a masked or Markdown-formatted value.");
      continue;
    }
    if (isValidDiscordWebhookUrl(answer)) {
      return answer;
    }
    console.log("That does not look like a valid Discord webhook URL.");
    console.log("Expected format: https://discord.com/api/webhooks/<id>/<token>");
  }
}

async function askSteamFinancialApiKey(question) {
  while (true) {
    const answer = await askRequired(question);
    if (answer.includes("*")) {
      console.log("The key contains '*'. Paste the raw Steam Financial API key, not a masked value.");
      continue;
    }
    if (isValidSteamFinancialApiKey(answer)) {
      return answer.toUpperCase();
    }
    console.log("That does not look like a Steam Financial API key. Expected a 32-character hexadecimal key.");
  }
}

async function askWorkerName(question, fallback) {
  while (true) {
    const answer = await askRequired(question, fallback);
    if (["y", "yes", "n", "no"].includes(answer.toLowerCase())) {
      console.log("That looks like a yes/no answer, not a Worker name. Use a name like my-game-steam-reporter.");
      continue;
    }
    if (isValidWorkerName(answer)) {
      return answer;
    }
    console.log("Worker name must use lowercase letters, numbers, and hyphens only, without starting or ending with a hyphen.");
  }
}

async function askIntervalHours(question, fallback) {
  while (true) {
    const raw = await ask(question, fallback);
    const value = parsePositiveInteger(raw);
    if (value) {
      if (!intervalDividesDay(value)) {
        console.log("Warning: this interval does not divide 24 cleanly.");
        console.log("Cloudflare still wakes the Worker every 15 minutes, but local report times will repeat daily rather than staying evenly spaced across midnight.");
        if (!(await confirm("Use this interval anyway?", false))) {
          continue;
        }
      }
      return String(value);
    }
    console.log("Please enter a positive integer, for example: 12.");
  }
}

async function askHour(question, fallback) {
  while (true) {
    const raw = await ask(question, fallback);
    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value >= 0 && value <= 23) {
      return String(value);
    }
    console.log("Please enter an hour between 0 and 23.");
  }
}

async function askPositiveInteger(question, fallback) {
  while (true) {
    const raw = await ask(question, fallback);
    const value = parsePositiveInteger(raw);
    if (value) {
      return String(value);
    }
    console.log("Please enter a positive integer.");
  }
}

async function confirm(question, fallback) {
  const fallbackText = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${fallbackText}]: `)).trim().toLowerCase();
  if (!answer) {
    return fallback;
  }
  return ["y", "yes", "1", "true"].includes(answer);
}

async function readSetupState() {
  if (!existsSync(SETUP_STATE_PATH)) {
    return {};
  }

  try {
    const state = JSON.parse(await readFile(SETUP_STATE_PATH, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    console.log("Could not read .setup-state.tmp.json. Starting with fresh defaults.");
    return {};
  }
}

async function saveSetupState(state) {
  const safeState = {
    projectDisplayName: state.projectDisplayName,
    steamAppId: state.steamAppId,
    reportTimezone: state.reportTimezone,
    reportIntervalHours: state.reportIntervalHours,
    firstLocalReportHour: state.firstLocalReportHour,
    topCountryLimit: state.topCountryLimit,
    sendEmptyReports: state.sendEmptyReports,
    enableWishlistReporting: state.enableWishlistReporting,
    enableSalesReporting: state.enableSalesReporting,
    enablePlayerCountReporting: state.enablePlayerCountReporting,
    enableDailyDigest: state.enableDailyDigest,
    dailyDigestLocalHour: state.dailyDigestLocalHour,
    workerName: state.workerName,
    kvNamespaceId: state.kvNamespaceId,
  };

  await writeFile(SETUP_STATE_PATH, JSON.stringify(safeState, null, 2), "utf8");
}

function savedBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

async function ensureCloudflareLogin() {
  const whoami = runWrangler(["whoami"], { capture: true, allowFailure: true });
  if (whoami.ok) {
    console.log("Cloudflare login detected.");
    return;
  }

  console.log("Cloudflare login was not detected.");
  printCommandOutput(whoami);
  console.log("\nOpen a second terminal in this project folder and run:");
  console.log("npx wrangler login");
  console.log("After Wrangler reports a successful login, return here.");
  await rl.question("Press Enter to re-check Cloudflare login: ");

  const retry = runWrangler(["whoami"], { capture: true, allowFailure: true });
  if (retry.ok) {
    console.log("Cloudflare login detected.");
    return;
  }

  printCommandOutput(retry);
  throw new Error("Cloudflare login is still not detected. Run `npx wrangler login`, confirm it succeeds, then run `npm run setup` again. Your non-secret answers were saved locally.");
}

async function resolveKvNamespaceId(binding, savedNamespaceId = "") {
  if (savedNamespaceId) {
    console.log(`Using saved KV namespace id for ${binding}: ${savedNamespaceId}`);
    return savedNamespaceId;
  }

  const existingId = findExistingKvNamespaceId(binding);
  if (existingId) {
    console.log(`Reusing existing KV namespace ${binding}: ${existingId}`);
    return existingId;
  }

  console.log(`\nCreating Cloudflare KV namespace: ${binding}`);
  const createdId = createKvNamespace(binding);
  if (createdId) {
    return createdId;
  }

  console.log("\nPaste an existing Cloudflare KV namespace id, or create one manually with:");
  console.log(`npx wrangler kv namespace list`);
  console.log(`npx wrangler kv namespace create ${binding}`);
  return askKvNamespaceId("KV namespace id");
}

function findExistingKvNamespaceId(binding) {
  const result = runWrangler(["kv", "namespace", "list"], { capture: true, allowFailure: true });
  if (!result.ok) {
    console.log("Could not list existing KV namespaces automatically.");
    printCommandOutput(result);
    return "";
  }

  const output = result.stdout.trim();
  try {
    const namespaces = JSON.parse(output);
    const found = namespaces.find((item) => item.title === binding || item.title?.endsWith(`-${binding}`));
    return found?.id || "";
  } catch {
    const regex = new RegExp(`"id"\\s*:\\s*"([^"]+)"[\\s\\S]*?"title"\\s*:\\s*"${escapeRegExp(binding)}"`);
    const match = output.match(regex);
    return match?.[1] || "";
  }
}

function createKvNamespace(binding) {
  const result = runWrangler(["kv", "namespace", "create", binding], { capture: true, allowFailure: true });
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
  if (combinedOutput) {
    console.log(combinedOutput);
  }

  if (!result.ok) {
    console.log("\nCould not create the KV namespace automatically.");
    console.log("Common causes:");
    console.log("- A KV namespace with this name already exists.");
    console.log("- Wrangler is logged into the wrong Cloudflare account.");
    console.log("- Your Cloudflare account/token does not have Workers KV write permission.");
    console.log("- Cloudflare returned an account selection or billing/permission error.");

    const existingId = findExistingKvNamespaceId(binding);
    if (existingId) {
      console.log(`Found an existing namespace after create failed: ${existingId}`);
      return existingId;
    }
    return "";
  }

  const match = combinedOutput.match(/id\s*=\s*"([^"]+)"/) || combinedOutput.match(/"id"\s*:\s*"([^"]+)"/);
  if (!match) {
    console.log("Could not parse KV namespace id automatically.");
    return "";
  }

  return match[1];
}

async function askKvNamespaceId(question) {
  while (true) {
    const id = await askRequired(question);
    if (/^[a-fA-F0-9]{32}$/.test(id)) {
      return id;
    }
    console.log("KV namespace id should be a 32-character hex id. Paste only the id value, not the full TOML block.");
  }
}

async function writeWranglerToml(config) {
  let template = await readFile(WRANGLER_EXAMPLE_PATH, "utf8");
  template = template
    .replaceAll("{{WORKER_NAME}}", config.workerName)
    .replaceAll("{{KV_NAMESPACE_BINDING}}", config.kvNamespaceBinding)
    .replaceAll("{{KV_NAMESPACE_ID}}", config.kvNamespaceId)
    .replaceAll("{{PROJECT_DISPLAY_NAME}}", tomlString(config.projectName))
    .replaceAll("{{STEAM_APP_ID}}", tomlString(config.appId))
    .replaceAll("{{REPORT_TIMEZONE}}", tomlString(config.reportTimeZone))
    .replaceAll("{{REPORT_INTERVAL_HOURS}}", tomlString(config.reportIntervalHours))
    .replaceAll("{{FIRST_LOCAL_REPORT_HOUR}}", tomlString(config.firstReportHour))
    .replaceAll("{{TOP_COUNTRY_LIMIT}}", tomlString(config.topCountryLimit))
    .replaceAll("{{SEND_EMPTY_REPORTS}}", tomlString(String(config.sendEmptyReports)))
    .replaceAll("{{ENABLE_WISHLIST_REPORTING}}", tomlString(String(config.enableWishlist)))
    .replaceAll("{{ENABLE_SALES_REPORTING}}", tomlString(String(config.enableSales)))
    .replaceAll("{{ENABLE_PLAYER_COUNT_REPORTING}}", tomlString(String(config.enablePlayerCount)))
    .replaceAll("{{ENABLE_DAILY_DIGEST}}", tomlString(String(config.enableDailyDigest)))
    .replaceAll("{{DAILY_DIGEST_LOCAL_HOUR}}", tomlString(config.dailyDigestHour));

  await writeFile(WRANGLER_PATH, template, "utf8");
  console.log("Created wrangler.toml");
}

async function putSecretsBulk(secrets) {
  console.log("\nSetting Cloudflare secrets");
  console.log("Using `wrangler secret bulk` to avoid Windows/PowerShell stdin issues with interactive secret prompts.");

  await writeFile(SECRET_BULK_PATH, JSON.stringify(secrets, null, 2), "utf8");
  try {
    const result = runWrangler(["secret", "bulk", filePathFromUrl(SECRET_BULK_PATH)], { capture: true, allowFailure: true });
    if (!result.ok) {
      printCommandOutput(result);
      printManualSecretFallback();
      throw new Error("wrangler secret bulk failed. Set the three secrets manually with the commands above, then run `npx wrangler deploy`.");
    }
    printCommandOutput(result);
  } finally {
    if (existsSync(SECRET_BULK_PATH)) {
      await unlink(SECRET_BULK_PATH).catch(() => {});
    }
  }
}

function printManualSecretFallback() {
  console.log("\nAutomatic secret upload failed. Set them manually from this project folder:");
  console.log("npx wrangler secret put DISCORD_WEBHOOK_URL");
  console.log("npx wrangler secret put STEAM_FINANCIAL_API_KEY");
  console.log("npx wrangler secret put MANUAL_RUN_TOKEN");
  console.log("Paste the raw value only when Wrangler asks for it.");
  console.log("After that, deploy with:");
  console.log("npx wrangler deploy\n");
}

function runWrangler(args, options = {}) {
  if (!existsSync(WRANGLER_BIN_PATH)) {
    throw new Error("Wrangler is not installed. Run `npm install`, then run `npm run setup` again.");
  }

  return runCommand(process.execPath, [filePathFromUrl(WRANGLER_BIN_PATH), ...args], {
    ...options,
    displayCommand: `wrangler ${args.join(" ")}`,
  });
}

function runCommand(command, args, options = {}) {
  const displayCommand = options.displayCommand ?? `${command} ${args.join(" ")}`;
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT_PATH,
    encoding: "utf8",
    shell: false,
    stdio: options.inherit ? "inherit" : "pipe",
  });

  if (result.error || result.status !== 0) {
    const error = result.error ? `${result.error.name}: ${result.error.message}` : "";
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";

    if (!options.inherit) {
      printCommandOutput({ stdout, stderr, error });
    }

    const response = {
      ok: false,
      status: result.status,
      signal: result.signal,
      stdout,
      stderr,
      error,
    };

    if (options.allowFailure) {
      return response;
    }

    throw new Error(`${displayCommand} failed with exit code ${result.status ?? "null"}${result.signal ? ` and signal ${result.signal}` : ""}.`);
  }

  return {
    ok: true,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function filePathFromUrl(url) {
  return fileURLToPath(url);
}

function printCommandOutput(result) {
  if (result.stdout?.trim()) {
    console.log(result.stdout.trim());
  }
  if (result.stderr?.trim()) {
    console.error(result.stderr.trim());
  }
  if (result.error) {
    console.error(result.error);
  }
}

function parseWorkersDevUrl(output) {
  const match = output.match(/https:\/\/[a-z0-9-]+[^\s]*\.workers\.dev/i);
  return match?.[0] ?? "";
}

async function initializeWorkerTotals(workerUrl, manualRunToken) {
  console.log("\nInitializing report totals");
  console.log("The setup script will call the deployed Worker with post=false&commit=true, so totals are saved but nothing is posted to Discord.");

  const maxAttempts = 60;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const url = `${workerUrl}/run?token=${encodeURIComponent(manualRunToken)}&post=false&commit=true`;
    const response = await fetch(url);
    const body = await response.json().catch(() => null);

    if (!response.ok || !body?.ok) {
      console.log("Totals initialization could not complete automatically.");
      console.log("Worker response:", JSON.stringify(body ?? { status: response.status }, null, 2));
      console.log("You can continue it later with the dry run URL printed below.");
      return;
    }

    const totals = body.report?.totals;
    if (!totals) {
      console.log("The Worker did not return totals yet. You can verify manually with the dry run URL printed below.");
      return;
    }

    const knownDays = Number(totals.wishlistKnownDays ?? 0);
    const complete = Boolean(totals.wishlistBackfillComplete);
    console.log(`Wishlist totals: ${knownDays} known day${knownDays === 1 ? "" : "s"}${complete ? " (complete)" : ""}.`);

    if (complete) {
      return;
    }

    await sleep(1500);
  }

  console.log("Totals initialization is still in progress.");
  console.log("The Worker will continue from cached KV state on future committed initialization or scheduled report runs.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tomlString(value) {
  return JSON.stringify(value ?? "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main()
  .catch((error) => {
    console.error("\nSetup failed:", error.message);
    console.error("Nothing secret was written to Git. If Wrangler failed, fix that step and run npm run setup again.");
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });

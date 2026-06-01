import assert from "node:assert/strict";
import { test } from "node:test";
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
} from "../scripts/setup-utils.mjs";

test("validates setup input formats", () => {
  const discordWebhookPrefix = "https://discord.com/api/webhooks";
  const legacyDiscordWebhookPrefix = "https://discordapp.com/api/webhooks";
  const validSteamFinancialKey = `${"0123456789abcdef"}${"0123456789ABCDEF"}`;

  assert.equal(isValidSteamAppId("123456"), true);
  assert.equal(isValidSteamAppId("abc123"), false);

  assert.equal(isValidDiscordWebhookUrl(`${discordWebhookPrefix}/123/abc_DEF-ghi.jkl`), true);
  assert.equal(isValidDiscordWebhookUrl(`${legacyDiscordWebhookPrefix}/123/abc_DEF-ghi.jkl`), true);
  assert.equal(isValidDiscordWebhookUrl(`${discordWebhookPrefix}/123/***`), false);
  assert.equal(isValidDiscordWebhookUrl("https://example.com/api/webhooks/123/abc"), false);

  assert.equal(isValidSteamFinancialApiKey(validSteamFinancialKey), true);
  assert.equal(isValidSteamFinancialApiKey("0123456789abcdef0123456789*****"), false);
  assert.equal(isValidSteamFinancialApiKey("not-a-key"), false);

  assert.equal(isValidWorkerName("my-steam-reporter"), true);
  assert.equal(isValidWorkerName("My Steam Reporter"), false);
  assert.equal(isValidTimeZone("Europe/Istanbul"), true);
  assert.equal(isValidTimeZone("Not/A_Timezone"), false);
});

test("normalizes and derives setup defaults", () => {
  assert.equal(normalizeRawInput(' "hello" '), "hello");
  assert.equal(normalizeRawInput(" '*masked*' "), "*masked*");
  assert.equal(slugify("My Steam Project!"), "my-steam-project");
  assert.equal(slugify("!!!"), "steam-project");
  assert.equal(parsePositiveInteger("12"), 12);
  assert.equal(parsePositiveInteger("0"), null);
  assert.equal(parsePositiveInteger("12.5"), null);
});

test("builds local report schedule previews", () => {
  assert.deepEqual(buildLocalReportTimes(12, 0), ["00:00", "12:00"]);
  assert.deepEqual(buildLocalReportTimes(12, 23), ["11:00", "23:00"]);
  assert.deepEqual(buildLocalReportTimes(6, 3), ["03:00", "09:00", "15:00", "21:00"]);
  assert.deepEqual(buildLocalReportTimes(5, 0), ["00:00", "05:00", "10:00", "15:00", "20:00"]);
  assert.equal(intervalDividesDay(12), true);
  assert.equal(intervalDividesDay(5), false);
});

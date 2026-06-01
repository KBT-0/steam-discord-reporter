import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const forbiddenDiscordTerms = [
  "revenue",
  "gross",
  "net",
  "tax",
  "price",
  "currency",
  "steam cut",
  "earnings",
  "payout",
  "income",
];

test("Discord report formatter does not include money-related wording", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function postDiscordReport");
  const end = source.indexOf("function hasActivity");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const discordFormatterSource = source.slice(start, end).toLowerCase();
  for (const term of forbiddenDiscordTerms) {
    assert.equal(discordFormatterSource.includes(term), false, `Discord formatter contains forbidden term: ${term}`);
  }
});

test("normal setup script does not prompt for package IDs", async () => {
  const source = await readFile(new URL("../scripts/setup.mjs", import.meta.url), "utf8");
  assert.equal(/package\s+ids?/i.test(source), false);
});

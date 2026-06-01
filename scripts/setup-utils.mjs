export function normalizeRawInput(value) {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

export function isValidSteamAppId(value) {
  return /^\d+$/.test(value);
}

export function isValidDiscordWebhookUrl(value) {
  return (
    !value.includes("*") &&
    /^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(value)
  );
}

export function isValidSteamFinancialApiKey(value) {
  return !value.includes("*") && /^[a-fA-F0-9]{32}$/.test(value);
}

export function isValidWorkerName(value) {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value);
}

export function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parsePositiveInteger(value) {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function intervalDividesDay(intervalHours) {
  return 24 % intervalHours === 0;
}

export function buildLocalReportTimes(intervalHours, firstHour) {
  const times = [];
  for (let hour = 0; hour < 24; hour += 1) {
    if (positiveModulo(hour - firstHour, intervalHours) === 0) {
      times.push(`${String(hour).padStart(2, "0")}:00`);
    }
  }
  return times;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "steam-project";
}

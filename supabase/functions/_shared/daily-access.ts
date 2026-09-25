export const DEFAULT_MAX_DAILY_ACCESSES = 3;
export const MAX_CONFIGURABLE_DAILY_ACCESSES = 100;
export const DAILY_ACCESS_TIME_ZONE = "America/Sao_Paulo";

export function normalizeDailyAccessLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_CONFIGURABLE_DAILY_ACCESSES
    ? parsed
    : DEFAULT_MAX_DAILY_ACCESSES;
}

export function hasReachedDailyAccessLimit(authorizedCount: number, limit: number): boolean {
  return limit > 0 && authorizedCount >= limit;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return representedAsUtc - date.getTime();
}

export function startOfDayInTimeZoneIso(
  now = new Date(),
  timeZone = DAILY_ACCESS_TIME_ZONE,
): string {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const localMidnightAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
  );

  // Resolve the zone offset twice so the result also remains correct on dates
  // where the offset at UTC midnight differs from the offset at local midnight.
  let candidate = localMidnightAsUtc - timeZoneOffsetMs(new Date(localMidnightAsUtc), timeZone);
  candidate = localMidnightAsUtc - timeZoneOffsetMs(new Date(candidate), timeZone);
  return new Date(candidate).toISOString();
}

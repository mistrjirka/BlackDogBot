/**
 * Validates a timezone string. Returns the timezone if valid, or "UTC" if invalid.
 */
export function resolveTimezone(timezone: string | undefined): string {
  const tz = timezone || "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * Returns the current date and time formatted in the given timezone, e.g.:
 *   "2026-02-28 14:35:00 (Europe/Prague)"
 *
 * Falls back to the server's local timezone if none is provided.
 */
export function getCurrentDateTime(timezone?: string): string {
  const tz =
    timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // en-CA produces "YYYY-MM-DD, HH:MM:SS" — clean it up into "YYYY-MM-DD HH:MM:SS"
  const formatted = formatter.format(now).replace(", ", " ");
  return `${formatted} (${tz})`;
}

/**
 * Builds the request-scoped time context appended to the user message.
 * Keeping it out of system instructions preserves reusable prompt prefixes.
 */
export function getCurrentTimeContext(timezone?: string): string {
  return `<user_context>\nCurrent date and time: ${getCurrentDateTime(timezone)}\n</user_context>`;
}

/**
 * Converts wall-clock time components in a given timezone to a UTC ISO string.
 *
 * @param params - Wall-clock date/time components (year, month 1-12, day, hour, minute)
 * @param timezone - IANA timezone name (e.g., "America/New_York")
 * @returns UTC ISO string (e.g., "2026-07-15T19:00:00.000Z")
 */
export function wallClockToUtcIso(
  params: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): string {
  // Create a UTC date from the wall-clock components — this is intentionally
  // in UTC so we can compute the timezone offset without recursion.
  const utcGuess = new Date(Date.UTC(params.year, params.month - 1, params.day, params.hour, params.minute, 0, 0));

  // Format the UTC guess in the target timezone to find the offset.
  // e.g., if utcGuess is 2026-07-15T19:00:00Z and timezone is "America/New_York",
  // Intl will show "7/15/2026, 3:00:00 PM" (EDT, UTC-4).
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcGuess);

  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };

  // Reconstruct the timezone-local time from the formatted parts
  const tzLocal = new Date(Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"), // midnight edge case
    get("minute"),
    get("second"),
  ));

  // The difference between utcGuess and tzLocal is the timezone offset
  const offsetMs = utcGuess.getTime() - tzLocal.getTime();

  // Apply the offset to get the correct UTC time for the intended wall-clock
  const correctUtc = new Date(utcGuess.getTime() + offsetMs);
  return correctUtc.toISOString();
}

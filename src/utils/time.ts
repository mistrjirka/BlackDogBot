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

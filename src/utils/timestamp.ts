export function getSafeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

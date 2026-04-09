const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /^auth$/i,
  /cookie/i,
  /session/i,
  /bearer/i,
  /private[_-]?key/i,
  /client[_-]?secret/i,
];

function _isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern: RegExp): boolean => pattern.test(key));
}

export function redactSensitiveData(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown): unknown => redactSensitiveData(item));
  }

  if (typeof value === "object") {
    const source: Record<string, unknown> = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(source)) {
      if (_isSensitiveKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactSensitiveData(nestedValue);
      }
    }

    return out;
  }

  return value;
}

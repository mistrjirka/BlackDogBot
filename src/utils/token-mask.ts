/**
 * Utility functions for masking sensitive values in logs and error messages.
 */

/**
 * Sensitive field patterns that should be automatically masked.
 * Case-insensitive matching.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /token$/i,
  /key$/i,
  /secret$/i,
  /password$/i,
  /passwd$/i,
  /api_?key$/i,
  /auth_?token$/i,
  /access_?token$/i,
  /private_?key$/i,
];

/**
 * Mask a sensitive string value, showing only first and last 4 characters.
 * @param value - The sensitive value to mask
 * @param visibleChars - Number of characters to show at start and end (default: 4)
 * @returns Masked string like "abcd...wxyz"
 */
export function maskToken(value: string, visibleChars: number = 4): string {
  if (!value || typeof value !== "string") {
    return "***";
  }

  if (value.length <= visibleChars * 2) {
    return "*".repeat(value.length);
  }

  const start = value.slice(0, visibleChars);
  const end = value.slice(-visibleChars);
  const maskedLength = value.length - visibleChars * 2;

  return `${start}${"*".repeat(Math.min(maskedLength, 8))}${end}`;
}

/**
 * Check if a field name looks like it contains sensitive data.
 * @param fieldName - The name of the field to check
 * @returns true if the field should be masked
 */
export function isSensitiveField(fieldName: string): boolean {
  if (!fieldName || typeof fieldName !== "string") {
    return false;
  }

  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Deep-mask an object, replacing sensitive values with masked versions.
 * Useful for sanitizing config objects before logging.
 * @param obj - The object to mask
 * @returns A new object with sensitive values masked
 */
export function maskSensitiveData<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return obj as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => maskSensitiveData(item)) as T;
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveField(key) && typeof value === "string") {
        result[key] = maskToken(value);
      } else if (typeof value === "object" && value !== null) {
        result[key] = maskSensitiveData(value);
      } else {
        result[key] = value;
      }
    }

    return result as T;
  }

  return obj;
}

/**
 * Create a safe string representation of an object for logging,
 * with all sensitive values automatically masked.
 * @param obj - The object to stringify
 * @param space - JSON.stringify space parameter
 * @returns JSON string with sensitive values masked
 */
export function safeStringify(obj: unknown, space?: number): string {
  const masked = maskSensitiveData(obj);
  return JSON.stringify(masked, null, space);
}

import crypto from "node:crypto";

export interface IJwtPayload {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
}

interface IJwtHeader {
  alg: "HS256";
  typ: "JWT";
}

function base64UrlEncode(input: Buffer | string): string {
  const buffer: Buffer = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const base64: string = input
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padding: number = (4 - (base64.length % 4)) % 4;
  const normalized: string = base64 + "=".repeat(padding);
  return Buffer.from(normalized, "base64");
}

function signHs256(input: string, secret: string): string {
  return base64UrlEncode(crypto.createHmac("sha256", secret).update(input).digest());
}

function secureEquals(a: string, b: string): boolean {
  const aBuffer: Buffer = Buffer.from(a);
  const bBuffer: Buffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function generateJwtToken(payload: IJwtPayload, secret: string): string {
  const header: IJwtHeader = { alg: "HS256", typ: "JWT" };
  const headerEncoded: string = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded: string = base64UrlEncode(JSON.stringify(payload));
  const signingInput: string = `${headerEncoded}.${payloadEncoded}`;
  const signature: string = signHs256(signingInput, secret);
  return `${signingInput}.${signature}`;
}

export function verifyJwtToken(
  token: string,
  secret: string,
  expectedIssuer: string,
  expectedAudience: string,
): IJwtPayload {
  const parts: string[] = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }

  const [headerEncoded, payloadEncoded, signature] = parts;
  const signingInput: string = `${headerEncoded}.${payloadEncoded}`;
  const expectedSignature: string = signHs256(signingInput, secret);

  if (!secureEquals(signature, expectedSignature)) {
    throw new Error("Invalid JWT signature");
  }

  const headerRaw: string = base64UrlDecode(headerEncoded).toString("utf-8");
  const payloadRaw: string = base64UrlDecode(payloadEncoded).toString("utf-8");

  const header: unknown = JSON.parse(headerRaw);
  const payload: unknown = JSON.parse(payloadRaw);

  if (
    !header ||
    typeof header !== "object" ||
    !("alg" in header) ||
    (header as { alg: string }).alg !== "HS256"
  ) {
    throw new Error("Unsupported JWT algorithm");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JWT payload");
  }

  const parsedPayload: IJwtPayload = payload as IJwtPayload;
  const nowEpochSeconds: number = Math.floor(Date.now() / 1000);

  if (parsedPayload.iss !== expectedIssuer) {
    throw new Error("Invalid JWT issuer");
  }

  if (parsedPayload.aud !== expectedAudience) {
    throw new Error("Invalid JWT audience");
  }

  if (typeof parsedPayload.exp !== "number" || parsedPayload.exp <= nowEpochSeconds) {
    throw new Error("JWT expired");
  }

  if (typeof parsedPayload.iat !== "number" || parsedPayload.iat > nowEpochSeconds + 60) {
    throw new Error("Invalid JWT iat");
  }

  return parsedPayload;
}

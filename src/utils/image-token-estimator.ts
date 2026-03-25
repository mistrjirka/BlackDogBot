const BASE64_EXPANSION_RATIO: number = 4 / 3;
const BASE64_DATA_URL_OVERHEAD_CHARS: number = 64;
const CHARS_PER_TOKEN_ESTIMATE: number = 4;

export const MIN_IMAGE_TOKEN_ESTIMATE: number = 85;

export function isImageContentPart(part: unknown): boolean {
  if (typeof part !== "object" || part === null) {
    return false;
  }

  const candidate: Record<string, unknown> = part as Record<string, unknown>;
  const type: string = typeof candidate.type === "string" ? candidate.type : "";

  if (type === "image" || type === "image_url" || type === "input_image") {
    return true;
  }

  if ("image" in candidate || "image_url" in candidate) {
    return true;
  }

  if ("source" in candidate && typeof candidate.source === "object" && candidate.source !== null) {
    const source: Record<string, unknown> = candidate.source as Record<string, unknown>;
    return typeof source.data === "string" || typeof source.url === "string";
  }

  return false;
}

export function estimateImageTokensFromPart(part: Record<string, unknown>): number {
  const imageSource: unknown = _extractImageSource(part);
  if (imageSource === null) {
    return 0;
  }

  if (imageSource === undefined) {
    return MIN_IMAGE_TOKEN_ESTIMATE;
  }

  const sizeBytes: number = _getImageSourceSizeBytes(imageSource);
  if (sizeBytes <= 0) {
    return MIN_IMAGE_TOKEN_ESTIMATE;
  }

  const base64CharsApprox: number = Math.ceil(sizeBytes * BASE64_EXPANSION_RATIO) + BASE64_DATA_URL_OVERHEAD_CHARS;
  const tokenEstimate: number = Math.ceil(base64CharsApprox / CHARS_PER_TOKEN_ESTIMATE);
  return Math.max(MIN_IMAGE_TOKEN_ESTIMATE, tokenEstimate);
}

function _extractImageSource(part: Record<string, unknown>): unknown {
  const type: string = typeof part.type === "string" ? part.type : "";

  if (type === "image") {
    if ("image" in part) {
      return part.image;
    }

    if (typeof part.source === "object" && part.source !== null) {
      const source: Record<string, unknown> = part.source as Record<string, unknown>;
      if ("data" in source) {
        return source.data;
      }

      if ("url" in source) {
        return source.url;
      }
    }

    return undefined;
  }

  if (type === "image_url" || type === "input_image") {
    const imageUrlValue: unknown = part.image_url;
    if (typeof imageUrlValue === "string") {
      return imageUrlValue;
    }

    if (typeof imageUrlValue === "object" && imageUrlValue !== null) {
      const imageUrlObject: Record<string, unknown> = imageUrlValue as Record<string, unknown>;
      if (typeof imageUrlObject.url === "string") {
        return imageUrlObject.url;
      }
    }

    if (typeof part.url === "string") {
      return part.url;
    }

    return undefined;
  }

  if ("image" in part) {
    return part.image;
  }

  if ("image_url" in part) {
    const imageUrlValue: unknown = part.image_url;
    if (typeof imageUrlValue === "string") {
      return imageUrlValue;
    }

    if (typeof imageUrlValue === "object" && imageUrlValue !== null) {
      const imageUrlObject: Record<string, unknown> = imageUrlValue as Record<string, unknown>;
      if (typeof imageUrlObject.url === "string") {
        return imageUrlObject.url;
      }
    }
  }

  if ("source" in part && typeof part.source === "object" && part.source !== null) {
    const source: Record<string, unknown> = part.source as Record<string, unknown>;
    if (typeof source.data === "string") {
      return source.data;
    }

    if (typeof source.url === "string") {
      return source.url;
    }
  }

  return null;
}

function _getImageSourceSizeBytes(value: unknown): number {
  if (typeof value === "string") {
    const trimmed: string = value.trim();
    if (trimmed.length === 0) {
      return 0;
    }

    if (trimmed.startsWith("data:")) {
      const commaIndex: number = trimmed.indexOf(",");
      const base64Payload: string = commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed;
      return Math.floor((base64Payload.length * 3) / 4);
    }

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return MIN_IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN_ESTIMATE;
    }

    return Math.floor((trimmed.length * 3) / 4);
  }

  if (Buffer.isBuffer(value)) {
    return value.length;
  }

  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }

  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }

  return 0;
}

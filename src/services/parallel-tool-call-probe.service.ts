export interface IProbeParallelToolCallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/**
 * Probe whether the OpenAI-compatible server accepts the parallel_tool_calls parameter.
 * Sends a minimal request with parallel_tool_calls: true and checks for a non-error response.
 * Returns true if the server responds OK, false otherwise.
 */
export async function probeParallelToolCallSupportAsync(
  options: IProbeParallelToolCallOptions,
): Promise<boolean> {
  const { baseUrl, apiKey, model, timeoutMs = 10000 } = options;

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: "Say ok" }],
    max_tokens: 4,
    parallel_tool_calls: true,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

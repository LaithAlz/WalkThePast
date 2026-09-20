type RetryOptions = {
  attempts?: number;
  attemptTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    function done() { cleanup(); resolve(); }
    function abort() { cleanup(); reject(signal?.reason); }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(response: Response, fallback: number, maximum: number): number {
  const header = response.headers.get("retry-after");
  if (!header) return fallback;
  const seconds = Number(header);
  const requested = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
  return Number.isFinite(requested) ? Math.max(0, Math.min(requested, maximum)) : fallback;
}

/** Retry transient upstream failures without retrying permanent OpenAI 4xx responses. */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  { attempts = 3, attemptTimeoutMs = 15_000, baseDelayMs = 250, maxDelayMs = 2_000 }: RetryOptions = {},
): Promise<Response> {
  const parentSignal = init.signal;
  let delayMs = baseDelayMs;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (parentSignal?.aborted) throw parentSignal.reason;
    const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetchImpl(input, { ...init, signal });
      if (!retryableStatus(response.status) || attempt === attempts) return response;
      const nextDelay = retryDelay(response, delayMs, maxDelayMs);
      await response.body?.cancel().catch(() => undefined);
      await wait(nextDelay, parentSignal);
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (attempt === attempts) throw error;
      await wait(delayMs, parentSignal);
    }
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
  throw new Error("Retry attempts exhausted");
}

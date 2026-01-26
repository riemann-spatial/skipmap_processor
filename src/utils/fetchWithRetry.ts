const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10000;

interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Check if an error is retryable (network errors, server errors).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError) {
    // Network errors like "fetch failed", "Failed to fetch"
    return true;
  }
  return false;
}

/**
 * Check if an HTTP status code is retryable.
 * Only retry on transient errors, not persistent server errors.
 */
function isRetryableStatus(status: number): boolean {
  // 429: Too Many Requests (rate limiting)
  // 502: Bad Gateway (upstream server error, often transient)
  // 503: Service Unavailable (temporary overload)
  // 504: Gateway Timeout (upstream timeout, often transient)
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number {
  // Exponential backoff: initialDelay * 2^attempt
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
  // Add jitter (0-50% of the delay)
  const jitter = Math.random() * 0.5 * exponentialDelay;
  const delay = exponentialDelay + jitter;
  return Math.min(delay, maxDelayMs);
}

/**
 * Fetch with automatic retry on transient failures.
 * Retries on network errors and 5xx/429 status codes with exponential backoff.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      // If successful or non-retryable status, return immediately
      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }

      // Retryable status code - retry if we have attempts left
      if (attempt < maxRetries) {
        const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs);
        await sleep(delay);
        continue;
      }

      // No more retries, return the failed response
      return response;
    } catch (error) {
      lastError = error;

      // Only retry on retryable errors
      if (!isRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }

      const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs);
      await sleep(delay);
    }
  }

  // Should not reach here, but throw last error if we do
  throw lastError;
}

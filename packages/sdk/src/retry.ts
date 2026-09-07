import { AstraFlowError } from "./errors.js";

export interface RetryOptions {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  retryOn?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const TRANSIENT =
  /429|503|504|timeout|econnreset|enotfound|eai_again|temporar|rate limit|ledger.*lag|try again later/i;

export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof AstraFlowError) {
    return error.diagnostics.retryable || TRANSIENT.test(error.message);
  }
  if (error instanceof Error) return TRANSIENT.test(error.message);
  return TRANSIENT.test(String(error));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function delayForAttempt(attempt: number, options: Required<Pick<RetryOptions, "minDelayMs" | "maxDelayMs" | "factor" | "jitter">>): number {
  const exp = options.minDelayMs * options.factor ** attempt;
  const capped = Math.min(options.maxDelayMs, exp);
  if (!options.jitter) return capped;
  const spread = capped * 0.4;
  return Math.max(0, capped - spread + Math.random() * spread * 2);
}

export async function withExponentialBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 5;
  const minDelayMs = options.minDelayMs ?? 150;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;
  const retryOn = options.retryOn ?? isTransientError;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !retryOn(error)) {
        throw error;
      }
      await sleep(delayForAttempt(attempt, { minDelayMs, maxDelayMs, factor, jitter }));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AstraFlowError("RPC request failed after retries", { cause: lastError });
}

export type RpcTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class ResilientRpcClient {
  constructor(
    private readonly transport: RpcTransport,
    private readonly options: RetryOptions = {},
  ) {}

  async request<T>(url: string, init?: RequestInit): Promise<T> {
    return withExponentialBackoff(async () => {
      const response = await this.transport(url, init);
      if (response.status === 429 || response.status >= 500) {
        throw new AstraFlowError(`RPC ${response.status} ${response.statusText}`, {
          cause: { status: response.status },
        });
      }
      if (!response.ok) {
        throw new AstraFlowError(`RPC request failed: ${response.status}`, {
          cause: { status: response.status },
        });
      }
      return (await response.json()) as T;
    }, this.options);
  }
}

export function createResilientRpcClient(
  fetchImpl: RpcTransport = ((input, init) => globalThis.fetch(input, init)),
  options?: RetryOptions,
): ResilientRpcClient {
  return new ResilientRpcClient(fetchImpl, options);
}

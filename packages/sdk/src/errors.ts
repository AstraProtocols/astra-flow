const CONTRACT_ERROR_CODES: Record<number, string> = {
  1: "AlreadyInit",
  2: "NotInit",
  3: "Unauthorized",
  4: "BadState",
  5: "NotFound",
  6: "AlreadyPaid",
  7: "NoDeposit",
  8: "Locked",
  9: "BadAmount",
  10: "DupId",
  11: "BadToken",
  12: "BadRoles",
  13: "BadSequence",
  14: "AlreadySubmitted",
  15: "BadSplit",
  16: "TooEarly",
  17: "NotAuthorized",
  18: "MilestoneAlreadyCompleted",
  19: "InvalidMilestoneSequence",
  20: "DeadlineNotExceeded",
  21: "InsufficientAllowance",
  22: "ZeroAmountAllocated",
  23: "ArbitratorCollision",
  24: "DisputeLockActive",
  25: "Paused",
  26: "QuorumNotMet",
  27: "AmendmentPending",
  28: "VestingIncomplete",
  29: "PenaltyOverflow",
  30: "FeeOverflow",
  31: "Reentrancy",
};

export interface DiagnosticFrame {
  source: "contract" | "host" | "rpc" | "auth" | "unknown";
  code?: number;
  name?: string;
  message: string;
  raw?: string;
}

export interface TransactionFailureDiagnostics {
  summary: string;
  frames: DiagnosticFrame[];
  contractError?: string;
  contractErrorCode?: number;
  simulationFailed: boolean;
  authExpired: boolean;
  retryable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const CONTRACT_CODE_RE = /(?:Error\(Contract,\s*#?|#?Error\(Contract,\s*)(\d+)/i;
const HOST_ERROR_RE = /Error\((Host|WasmVm|Value|Context|Storage|Object|Crypto|Events),?\s*([^)]*)\)/i;
const AUTH_EXPIRED_RE = /auth(?:entication)? (?:expired|invalid)|signature expired|txbadseq|tx_bad_seq|invalid seq/i;
const RATE_LIMIT_RE = /429|rate limit|try again|timeout|temporar|econnreset|enotfound|eai_again/i;

export function decodeContractErrorCode(code: number): string | undefined {
  return CONTRACT_ERROR_CODES[code];
}

export function parseDiagnostics(input: unknown): TransactionFailureDiagnostics {
  const raw = asString(input);
  const record = asRecord(input);
  const nested =
    asString(record.error) ||
    asString(record.message) ||
    asString(record.detail) ||
    asString(record.resultXdr) ||
    raw;

  const frames: DiagnosticFrame[] = [];
  const contractMatch = nested.match(CONTRACT_CODE_RE);
  const contractErrorCode = contractMatch ? Number.parseInt(contractMatch[1] ?? "", 10) : undefined;
  const contractError =
    contractErrorCode !== undefined && Number.isFinite(contractErrorCode)
      ? decodeContractErrorCode(contractErrorCode)
      : undefined;

  if (contractErrorCode !== undefined && Number.isFinite(contractErrorCode)) {
    frames.push({
      source: "contract",
      code: contractErrorCode,
      name: contractError ?? `ContractError(${contractErrorCode})`,
      message: contractError
        ? `Escrow contract rejected the invocation (${contractError}, code ${contractErrorCode}).`
        : `Escrow contract rejected the invocation with code ${contractErrorCode}.`,
      raw: nested,
    });
  }

  const hostMatch = nested.match(HOST_ERROR_RE);
  if (hostMatch) {
    frames.push({
      source: "host",
      name: hostMatch[1],
      message: `Soroban host error ${hostMatch[1]}: ${hostMatch[2] || "unspecified"}`.trim(),
      raw: nested,
    });
  }

  const status = Number(record.status ?? record.statusCode ?? record.httpStatus);
  if (Number.isFinite(status) && status >= 400) {
    frames.push({
      source: "rpc",
      code: status,
      message: `RPC responded with HTTP ${status}.`,
      raw: nested,
    });
  }

  const authExpired = AUTH_EXPIRED_RE.test(nested);
  if (authExpired) {
    frames.push({
      source: "auth",
      name: "AuthExpired",
      message: "Transaction authorization expired or sequence became stale.",
      raw: nested,
    });
  }

  if (frames.length === 0) {
    frames.push({
      source: "unknown",
      message: nested || "Unknown transaction failure.",
      raw,
    });
  }

  const simulationFailed =
    /simul/i.test(nested) || record.simulation === true || record.errorType === "simulation";
  const retryable = RATE_LIMIT_RE.test(nested) || authExpired || status === 429;

  return {
    summary: frames[0]?.message ?? nested,
    frames,
    contractError,
    contractErrorCode,
    simulationFailed,
    authExpired,
    retryable,
  };
}

export class AstraFlowError extends Error {
  readonly code: string;
  readonly diagnostics: TransactionFailureDiagnostics;
  readonly cause?: unknown;

  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    const diagnostics = parseDiagnostics(options?.cause ?? message);
    super(message);
    this.name = "AstraFlowError";
    this.code = options?.code ?? diagnostics.contractError ?? "ASTRA_FLOW";
    this.diagnostics = diagnostics;
    this.cause = options?.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static fromUnknown(error: unknown, fallback = "Astra Flow request failed"): AstraFlowError {
    if (error instanceof AstraFlowError) return error;
    const diagnostics = parseDiagnostics(error);
    return new AstraFlowError(diagnostics.summary || fallback, {
      cause: error,
      code: diagnostics.contractError,
    });
  }
}

export class SimulationError extends AstraFlowError {
  readonly simulationError: string;

  constructor(message: string, cause?: unknown) {
    super(message, { code: "SIMULATION_FAILED", cause });
    this.name = "SimulationError";
    this.simulationError = message;
    this.diagnostics.simulationFailed = true;
  }
}

export class TransactionFailedError extends AstraFlowError {
  readonly hash?: string;
  readonly resultXdr?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; hash?: string; resultXdr?: string },
  ) {
    super(message, { code: "TX_FAILED", cause: options?.cause ?? options?.resultXdr ?? message });
    this.name = "TransactionFailedError";
    this.hash = options?.hash;
    this.resultXdr = options?.resultXdr;
  }
}

export class AuthExpiredError extends AstraFlowError {
  readonly account?: string;
  readonly sequence?: string;

  constructor(message: string, options?: { cause?: unknown; account?: string; sequence?: string }) {
    super(message, { code: "AUTH_EXPIRED", cause: options?.cause ?? message });
    this.name = "AuthExpiredError";
    this.account = options?.account;
    this.sequence = options?.sequence;
    this.diagnostics.authExpired = true;
  }
}

export function assertSimulationSuccess(result: unknown): void {
  const record = asRecord(result);
  const errorText = asString(record.error);
  if (errorText) {
    throw new SimulationError(errorText, result);
  }
  if (record.status === "ERROR" || record.errorType === "simulation") {
    throw new SimulationError("Soroban simulation returned ERROR", result);
  }
}

export function classifySendResult(result: unknown): never | void {
  const record = asRecord(result);
  const status = asString(record.status).toUpperCase();
  const hash = asString(record.hash) || undefined;
  const resultXdr = asString(record.resultXdr) || asString(record.errorResultXdr) || undefined;
  const error = asString(record.error);

  if (status === "ERROR" || status === "FAILED" || error) {
    const diagnostics = parseDiagnostics(resultXdr ?? error ?? result);
    if (diagnostics.authExpired) {
      throw new AuthExpiredError(diagnostics.summary, { cause: result });
    }
    throw new TransactionFailedError(diagnostics.summary, { cause: result, hash, resultXdr });
  }
}

import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  ESCROW_STATE_BY_VALUE,
  MILESTONE_STATUS_BY_VALUE,
  type BalanceBook,
  type DisputeRecord,
  type EscrowConfig,
  type EscrowState,
  type Milestone,
  type MilestoneInput,
  type MilestoneStatus,
} from "./types.js";

export type ScValHint =
  | "address"
  | "bytes"
  | "u32"
  | "u64"
  | "i128"
  | "bool"
  | "symbol"
  | "string";

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("Hex string must have even length");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array | Buffer | number[]): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function toI128String(amount: bigint | number | string): string {
  return BigInt(amount).toString();
}

function isScVal(value: unknown): value is xdr.ScVal {
  return Boolean(value) && typeof value === "object" && "toXDR" in (value as object);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asHex(value: unknown): string {
  if (typeof value === "string") return value.startsWith("0x") ? value.slice(2) : value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return bytesToHex(value);
  if (Array.isArray(value)) return bytesToHex(value as number[]);
  return "";
}

export function toScVal(value: unknown, hint?: ScValHint): xdr.ScVal {
  if (isScVal(value)) return value;
  if (hint === "address" && typeof value === "string") return new Address(value).toScVal();
  if (hint === "bytes") {
    const bytes = typeof value === "string" ? hexToBytes(value) : (value as Uint8Array);
    return nativeToScVal(Buffer.from(bytes), { type: "bytes" });
  }
  if (hint === "u32") return nativeToScVal(Number(value), { type: "u32" });
  if (hint === "u64") return nativeToScVal(BigInt(value as bigint | number | string), { type: "u64" });
  if (hint === "i128") return nativeToScVal(BigInt(value as bigint | number | string), { type: "i128" });
  if (hint === "bool") return nativeToScVal(Boolean(value), { type: "bool" });
  if (hint === "symbol") return nativeToScVal(String(value), { type: "symbol" });
  if (hint === "string") return nativeToScVal(String(value), { type: "string" });

  if (typeof value === "string" && (value.startsWith("G") || value.startsWith("C"))) {
    try {
      return new Address(value).toScVal();
    } catch {
      return nativeToScVal(value);
    }
  }
  if (value instanceof Uint8Array) {
    return nativeToScVal(Buffer.from(value), { type: "bytes" });
  }
  return nativeToScVal(value as Parameters<typeof nativeToScVal>[0]);
}

export function fromScVal(value: xdr.ScVal | string): unknown {
  const scVal = typeof value === "string" ? xdr.ScVal.fromXDR(value, "base64") : value;
  return scValToNative(scVal);
}

export function milestoneToScVal(milestone: MilestoneInput): xdr.ScVal {
  const description =
    typeof milestone.descriptionHash === "string"
      ? hexToBytes(milestone.descriptionHash)
      : milestone.descriptionHash;

  return nativeToScVal({
    milestone_id: milestone.milestoneId,
    payout_amount: milestone.payoutAmount,
    description_hash: Buffer.from(description),
    is_approved: false,
    completed_at: BigInt(0),
    status: 0,
    submitted_at: BigInt(0),
  });
}

export function parseEscrowState(value: unknown): EscrowState {
  if (typeof value === "string" && ESCROW_STATE_BY_VALUE.includes(value as EscrowState)) {
    return value as EscrowState;
  }
  if (typeof value === "number") return ESCROW_STATE_BY_VALUE[value] ?? "Pending";
  if (value && typeof value === "object" && "tag" in (value as object)) {
    const tag = String((value as { tag: string }).tag);
    return (ESCROW_STATE_BY_VALUE.find((item) => item === tag) ?? "Pending") as EscrowState;
  }
  return "Pending";
}

export function parseMilestoneStatus(value: unknown): MilestoneStatus {
  if (typeof value === "string") {
    if (value === "Under Review") return "UnderReview";
    if (MILESTONE_STATUS_BY_VALUE.includes(value as MilestoneStatus)) {
      return value as MilestoneStatus;
    }
  }
  if (typeof value === "number") return MILESTONE_STATUS_BY_VALUE[value] ?? "Pending";
  return "Pending";
}

export function parseMilestone(raw: unknown, proofHash?: string): Milestone {
  const record = asRecord(raw);
  const status = parseMilestoneStatus(record.status ?? (record.is_approved ? 2 : 0));
  return {
    milestoneId: Number(record.milestone_id ?? record.milestoneId ?? 0),
    payoutAmount: BigInt(String(record.payout_amount ?? record.payoutAmount ?? 0)),
    descriptionHash: asHex(record.description_hash ?? record.descriptionHash),
    isApproved: Boolean(record.is_approved ?? record.isApproved) || status === "Released",
    completedAt: BigInt(String(record.completed_at ?? record.completedAt ?? 0)),
    status: status === "UnderReview" ? "Under Review" : status,
    submittedAt: BigInt(String(record.submitted_at ?? record.submittedAt ?? 0)),
    proofHash,
  };
}

export function parseEscrowConfig(raw: unknown): EscrowConfig {
  const record = asRecord(raw);
  return {
    funder: String(record.funder ?? ""),
    recipient: String(record.recipient ?? ""),
    arbitrator: String(record.arbitrator ?? ""),
    asset: String(record.asset ?? ""),
    totalAmount: BigInt(String(record.total_amount ?? record.totalAmount ?? 0)),
    releaseThreshold: Number(record.release_threshold ?? record.releaseThreshold ?? 0),
    lockSecs: BigInt(String(record.lock_secs ?? record.lockSecs ?? 0)),
  };
}

export function parseBalanceBook(raw: unknown): BalanceBook {
  const record = asRecord(raw);
  return {
    deposited: BigInt(String(record.deposited ?? 0)),
    released: BigInt(String(record.released ?? 0)),
    refunded: BigInt(String(record.refunded ?? 0)),
  };
}

export function parseDisputeRecord(raw: unknown): DisputeRecord {
  const record = asRecord(raw);
  return {
    raisedBy: String(record.raised_by ?? record.raisedBy ?? ""),
    raisedAt: BigInt(String(record.raised_at ?? record.raisedAt ?? 0)),
    funderBps: Number(record.funder_bps ?? record.funderBps ?? 0),
    recipientBps: Number(record.recip_bps ?? record.recipientBps ?? 0),
    resolved: Boolean(record.resolved),
  };
}

/** @deprecated Prefer toScVal / fromScVal */
export const serializeScVal = toScVal;
/** @deprecated Prefer fromScVal */
export const deserializeScVal = fromScVal;

import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { bytesToHex } from "../converters.js";
import type { AstraFlowEvent } from "../types.js";

export interface RawContractEvent {
  contractId?: string | { toString(): string };
  topic?: xdr.ScVal[];
  topics?: xdr.ScVal[];
  value?: xdr.ScVal | string;
  ledger?: number;
  txHash?: string;
}

export type ScValPrimitive =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | ScValPrimitive[]
  | { [key: string]: ScValPrimitive };

const TOPIC_ALIASES: Record<string, string> = {
  init: "EscrowInitialized",
  EscrowInitialized: "EscrowInitialized",
  created: "MilestoneCreated",
  MilestoneCreated: "MilestoneCreated",
  proof: "MilestoneSubmitted",
  ProofSubmitted: "MilestoneSubmitted",
  MilestoneSubmitted: "MilestoneSubmitted",
  release: "MilestoneApproved",
  MilestoneReleased: "MilestoneApproved",
  MilestoneApproved: "MilestoneApproved",
  deposit: "FundsDeposited",
  FundsDeposited: "FundsDeposited",
  dispute: "DisputeRaised",
  DisputeRaised: "DisputeRaised",
  DisputeResolved: "DisputeSettled",
  DisputeSettled: "DisputeSettled",
  paused: "EmergencyPaused",
  EmergencyPaused: "EmergencyPaused",
  timeout: "TimeoutRefunded",
  TimeoutRefunded: "TimeoutRefunded",
};

export interface ParsedEventEnvelope {
  contractId: string;
  topic: string;
  topics: ScValPrimitive[];
  value: ScValPrimitive;
  ledger?: number;
  txHash?: string;
}

function scValFromUnknown(value: xdr.ScVal | string | undefined): xdr.ScVal | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    return xdr.ScVal.fromXDR(value, "base64");
  }
  return value;
}

function decodeScVal(value: xdr.ScVal): ScValPrimitive {
  const switchName = value.switch().name;
  switch (switchName) {
    case "scvVoid":
      return null;
    case "scvBool":
      return value.b();
    case "scvU32":
      return value.u32();
    case "scvI32":
      return value.i32();
    case "scvU64":
      return BigInt(value.u64().toString());
    case "scvI64":
      return BigInt(value.i64().toString());
    case "scvU128": {
      const parts = value.u128();
      return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
    }
    case "scvI128": {
      const parts = value.i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      const combined = (hi << 64n) + lo;
      return hi < 0n ? combined - (1n << 128n) : combined;
    }
    case "scvBytes":
      return Uint8Array.from(value.bytes());
    case "scvString":
      return value.str().toString();
    case "scvSymbol":
      return value.sym().toString();
    case "scvAddress":
      return Address.fromScVal(value).toString();
    case "scvVec": {
      const vec = value.vec();
      return vec ? vec.map(decodeScVal) : [];
    }
    case "scvMap": {
      const map = value.map() ?? [];
      const record: { [key: string]: ScValPrimitive } = {};
      for (const entry of map) {
        const key = decodeScVal(entry.key());
        record[typeof key === "string" ? key : JSON.stringify(key)] = decodeScVal(entry.val());
      }
      return record;
    }
    default:
      try {
        const native = scValToNative(value);
        if (native instanceof Uint8Array) return native;
        return native as ScValPrimitive;
      } catch {
        return value.toXDR("base64");
      }
  }
}

function asRecord(value: ScValPrimitive): Record<string, ScValPrimitive> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    return {};
  }
  return value as Record<string, ScValPrimitive>;
}

function asString(value: ScValPrimitive | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function asBig(value: ScValPrimitive | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value !== "") return BigInt(value);
  return 0n;
}

function asNumber(value: ScValPrimitive | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return 0;
}

export function deserializeTopics(topics: xdr.ScVal[]): ScValPrimitive[] {
  return topics.map(decodeScVal);
}

export function deserializeValue(value: xdr.ScVal | string): ScValPrimitive {
  const scVal = scValFromUnknown(value);
  return scVal ? decodeScVal(scVal) : null;
}

export function parseRawEvent(event: RawContractEvent): ParsedEventEnvelope {
  const topics = event.topics ?? event.topic ?? [];
  const decodedTopics = deserializeTopics(topics);
  const primary = asString(decodedTopics[0]);
  const topic = TOPIC_ALIASES[primary] ?? primary ?? "unknown";
  const rawValue = scValFromUnknown(event.value);
  return {
    contractId: event.contractId ? String(event.contractId) : "",
    topic,
    topics: decodedTopics,
    value: rawValue ? decodeScVal(rawValue) : null,
    ledger: event.ledger,
    txHash: event.txHash,
  };
}

export function toDomainEvent(envelope: ParsedEventEnvelope): AstraFlowEvent | null {
  const data = asRecord(envelope.value);
  const base = {
    contractId: envelope.contractId,
    ledger: envelope.ledger,
    txHash: envelope.txHash,
  };

  switch (envelope.topic) {
    case "EscrowInitialized":
      return {
        ...base,
        topic: "EscrowInitialized",
        funder: asString(data.funder) || asString(envelope.topics[1]),
        recipient: asString(data.recipient),
        arbitrator: asString(data.arbitrator),
        token: asString(data.token),
        total: asBig(data.total),
        count: asNumber(data.count),
      };
    case "FundsDeposited":
      return {
        ...base,
        topic: "FundsDeposited",
        funder: asString(data.funder) || asString(envelope.topics[1]),
        amount: asBig(data.amount),
      };
    case "MilestoneSubmitted":
      return {
        ...base,
        topic: "ProofSubmitted",
        milestoneId: asNumber(data.milestone ?? envelope.topics[1]),
        recipient: asString(data.recipient),
        proofHash: asString(data.proof ?? data.proof_hash),
        at: asBig(data.at),
      };
    case "MilestoneApproved":
      return {
        ...base,
        topic: "MilestoneReleased",
        milestoneId: asNumber(data.milestone ?? envelope.topics[1]),
        recipient: asString(data.recipient),
        amount: asBig(data.amount),
      };
    case "DisputeRaised":
      return {
        ...base,
        topic: "DisputeRaised",
        raisedBy: asString(data.raised_by ?? data.raisedBy) || asString(envelope.topics[1]),
        at: asBig(data.at),
      };
    case "DisputeSettled":
      return {
        ...base,
        topic: "DisputeResolved",
        arbitrator: asString(data.arbitrator) || asString(envelope.topics[1]),
        funderBps: asNumber(data.funder_bps ?? data.funderBps),
        recipientBps: asNumber(data.recip_bps ?? data.recipientBps),
        funderAmount: asBig(data.funder_amt ?? data.funderAmount),
        recipientAmount: asBig(data.recip_amt ?? data.recipientAmount),
      };
    case "TimeoutRefunded":
      return {
        ...base,
        topic: "TimeoutRefunded",
        funder: asString(data.funder) || asString(envelope.topics[1]),
        amount: asBig(data.amount),
        at: asBig(data.at),
      };
    default:
      return null;
  }
}

export function parseContractEvents(events: RawContractEvent[]): AstraFlowEvent[] {
  return events
    .map(parseRawEvent)
    .map(toDomainEvent)
    .filter((event): event is AstraFlowEvent => event !== null);
}

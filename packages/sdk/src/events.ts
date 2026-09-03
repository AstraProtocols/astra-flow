import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { DecodedContractEvent } from "./types.js";
import { bytesToHex } from "./scval.js";

const TOPIC_LABELS: Record<string, string> = {
  init: "initialized",
  deposit: "funds_deposited",
  proof: "milestone_proof_submitted",
  release: "milestone_released",
  dispute: "dispute_raised",
};

function readTopic(topic: xdr.ScVal): string {
  try {
    const native = scValToNative(topic);
    if (typeof native === "string") return native;
    if (typeof native === "number" || typeof native === "bigint") {
      return String(native);
    }
    return JSON.stringify(native);
  } catch {
    return topic.toXDR("base64");
  }
}

function readPayload(value: xdr.ScVal): unknown {
  try {
    const native = scValToNative(value);
    if (native instanceof Uint8Array) {
      return bytesToHex(native);
    }
    return native;
  } catch {
    return value.toXDR("base64");
  }
}

/**
 * Decode Soroban diagnostic / contract events into JSON-serializable objects.
 */
export function decodeContractEvents(
  events: Array<{
    contractId?: string | { toString(): string };
    topic?: xdr.ScVal[];
    topics?: xdr.ScVal[];
    value?: xdr.ScVal;
    ledger?: number;
    txHash?: string;
  }>,
): DecodedContractEvent[] {
  return events.map((event) => {
    const topics = event.topics ?? event.topic ?? [];
    const labels = topics.map(readTopic);
    const primary = TOPIC_LABELS[labels[0] ?? ""] ?? labels[0] ?? "unknown";

    return {
      contractId: event.contractId ? String(event.contractId) : "",
      topic: primary,
      payload: {
        topics: labels,
        data: event.value ? readPayload(event.value) : null,
      },
      ledger: event.ledger,
      txHash: event.txHash,
    };
  });
}

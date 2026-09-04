import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { bytesToHex } from "./converters.js";
import { NETWORKS } from "./types.js";
import type {
  AstraFlowEvent,
  DecodedContractEvent,
  DisputeRaisedEvent,
  DisputeResolvedEvent,
  MilestoneReleasedEvent,
  NetworkName,
  ProofSubmittedEvent,
} from "./types.js";

const TOPIC_LABELS: Record<string, string> = {
  init: "EscrowInitialized",
  EscrowInitialized: "EscrowInitialized",
  deposit: "FundsDeposited",
  FundsDeposited: "FundsDeposited",
  proof: "ProofSubmitted",
  ProofSubmitted: "ProofSubmitted",
  release: "MilestoneReleased",
  MilestoneReleased: "MilestoneReleased",
  dispute: "DisputeRaised",
  DisputeRaised: "DisputeRaised",
  DisputeResolved: "DisputeResolved",
};

function readTopic(topic: xdr.ScVal): string {
  try {
    const native = scValToNative(topic);
    if (typeof native === "string") return native;
    if (typeof native === "number" || typeof native === "bigint") return String(native);
    return JSON.stringify(native);
  } catch {
    return topic.toXDR("base64");
  }
}

function readPayload(value: xdr.ScVal): unknown {
  try {
    const native = scValToNative(value);
    if (native instanceof Uint8Array) return bytesToHex(native);
    return native;
  } catch {
    return value.toXDR("base64");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value !== "") return BigInt(value);
  return 0n;
}

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

export function parseAstraFlowEvent(decoded: DecodedContractEvent): AstraFlowEvent | null {
  const data = asRecord(asRecord(decoded.payload).data);
  const contractId = decoded.contractId;
  const ledger = decoded.ledger;
  const txHash = decoded.txHash;

  switch (decoded.topic) {
    case "ProofSubmitted":
      return {
        topic: "ProofSubmitted",
        contractId,
        ledger,
        txHash,
        milestoneId: Number(data.milestone ?? data.milestoneId ?? 0),
        recipient: String(data.recipient ?? ""),
        proofHash: String(data.proof ?? data.proofHash ?? ""),
        at: big(data.at),
      } satisfies ProofSubmittedEvent;
    case "MilestoneReleased":
      return {
        topic: "MilestoneReleased",
        contractId,
        ledger,
        txHash,
        milestoneId: Number(data.milestone ?? data.milestoneId ?? 0),
        recipient: String(data.recipient ?? ""),
        amount: big(data.amount),
      } satisfies MilestoneReleasedEvent;
    case "DisputeRaised":
      return {
        topic: "DisputeRaised",
        contractId,
        ledger,
        txHash,
        raisedBy: String(data.raised_by ?? data.raisedBy ?? ""),
        at: big(data.at),
      } satisfies DisputeRaisedEvent;
    case "DisputeResolved":
      return {
        topic: "DisputeResolved",
        contractId,
        ledger,
        txHash,
        arbitrator: String(data.arbitrator ?? ""),
        funderBps: Number(data.funder_bps ?? data.funderBps ?? 0),
        recipientBps: Number(data.recip_bps ?? data.recipientBps ?? 0),
        funderAmount: big(data.funder_amt ?? data.funderAmount),
        recipientAmount: big(data.recip_amt ?? data.recipientAmount),
      } satisfies DisputeResolvedEvent;
    default:
      return null;
  }
}

export interface EventWatcherOptions {
  contractId: string;
  network?: NetworkName;
  rpcUrl?: string;
  pollIntervalMs?: number;
  startLedger?: number;
}

export type EventHandler = (event: AstraFlowEvent) => void;

/**
 * Polls Soroban RPC `getEvents` and emits typed milestone / dispute events.
 */
export class ContractEventWatcher {
  private readonly server: rpc.Server;
  private readonly contractId: string;
  private readonly pollIntervalMs: number;
  private cursor: string | undefined;
  private startLedger: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly handlers = new Set<EventHandler>();

  constructor(options: EventWatcherOptions) {
    const network = options.network ?? "testnet";
    this.contractId = options.contractId;
    this.server = new rpc.Server(options.rpcUrl ?? NETWORKS[network].rpcUrl, {
      allowHttp: false,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? 4_000;
    this.startLedger = options.startLedger;
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    if (!this.startLedger) {
      const latest = await this.server.getLatestLedger();
      this.startLedger = Math.max(1, latest.sequence - 1);
    }
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async poll(): Promise<AstraFlowEvent[]> {
    const page = this.cursor
      ? await this.server.getEvents({
          cursor: this.cursor,
          limit: 100,
          filters: [{ type: "contract", contractIds: [this.contractId] }],
        })
      : await this.server.getEvents({
          startLedger: this.startLedger ?? 1,
          limit: 100,
          filters: [{ type: "contract", contractIds: [this.contractId] }],
        });
    this.cursor = page.cursor;
    if (typeof page.latestLedger === "number") {
      this.startLedger = page.latestLedger;
    }

    const decoded = decodeContractEvents(
      page.events.map((event) => ({
        contractId: event.contractId ?? this.contractId,
        topics: event.topic,
        value: event.value,
        ledger: event.ledger,
        txHash: event.txHash,
      })),
    );

    const typed = decoded
      .map(parseAstraFlowEvent)
      .filter((event): event is AstraFlowEvent => event !== null);

    for (const event of typed) {
      if (
        event.topic === "MilestoneReleased" ||
        event.topic === "DisputeRaised" ||
        event.topic === "DisputeResolved" ||
        event.topic === "ProofSubmitted"
      ) {
        for (const handler of this.handlers) handler(event);
      }
    }
    return typed;
  }
}

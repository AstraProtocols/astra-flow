import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  parseContractEvents,
  parseRawEvent,
  deserializeTopics,
  toDomainEvent,
} from "../src/parsers/events";
import { decodeContractEvents, parseAstraFlowEvent } from "../src/events";

function gAddress(): string {
  return Keypair.random().publicKey();
}

function topic(label: string, extra?: xdr.ScVal): xdr.ScVal[] {
  const topics = [nativeToScVal(label, { type: "symbol" })];
  if (extra) topics.push(extra);
  return topics;
}

describe("XDR event topic deserializer", () => {
  const contractId = Address.contract(Buffer.alloc(32, 9)).toString();
  const funder = gAddress();
  const recipient = gAddress();
  const arbitrator = gAddress();

  it("deserializes symbol topics and map values into domain events", () => {
    const proof = Buffer.alloc(32, 0xab);
    const envelope = parseRawEvent({
      contractId,
      topics: topic("MilestoneSubmitted", nativeToScVal(1, { type: "u32" })),
      value: nativeToScVal({
        milestone: 1,
        recipient,
        proof,
        at: 1_700_000_000n,
      }),
      ledger: 12_345,
      txHash: "abc123",
    });

    expect(envelope.topic).toBe("MilestoneSubmitted");
    expect(envelope.topics[0]).toBe("MilestoneSubmitted");
    const domain = toDomainEvent(envelope);
    expect(domain?.topic).toBe("ProofSubmitted");
    if (domain?.topic === "ProofSubmitted") {
      expect(domain.milestoneId).toBe(1);
      expect(domain.recipient).toBe(recipient);
      expect(domain.proofHash).toMatch(/^[0-9a-f]+$/);
      expect(domain.at).toBe(1_700_000_000n);
      expect(domain.ledger).toBe(12_345);
      expect(domain.txHash).toBe("abc123");
    }
  });

  it("maps aliases for created, approved, settled, and paused topics", () => {
    const created = parseRawEvent({
      contractId,
      topics: topic("MilestoneCreated", nativeToScVal(2, { type: "u32" })),
      value: nativeToScVal({ milestone: 2, amount: 500n, desc: Buffer.alloc(32, 1) }),
    });
    expect(created.topic).toBe("MilestoneCreated");

    const approved = parseRawEvent({
      contractId,
      topics: topic("MilestoneApproved", nativeToScVal(2, { type: "u32" })),
      value: nativeToScVal({ milestone: 2, recipient, amount: 500n }),
    });
    const approvedDomain = toDomainEvent(approved);
    expect(approvedDomain?.topic).toBe("MilestoneReleased");

    const settled = parseRawEvent({
      contractId,
      topics: topic("DisputeSettled", nativeToScVal(arbitrator, { type: "address" })),
      value: nativeToScVal({
        arbitrator,
        funder_bps: 2500,
        recip_bps: 7500,
        funder_amt: 25n,
        recip_amt: 75n,
      }),
    });
    const settledDomain = toDomainEvent(settled);
    expect(settledDomain?.topic).toBe("DisputeResolved");
    if (settledDomain?.topic === "DisputeResolved") {
      expect(settledDomain.funderBps).toBe(2500);
      expect(settledDomain.recipientBps).toBe(7500);
      expect(settledDomain.funderAmount).toBe(25n);
      expect(settledDomain.recipientAmount).toBe(75n);
    }
  });

  it("parses a batch of raw events deterministically", () => {
    const events = parseContractEvents([
      {
        contractId,
        topics: topic("DisputeRaised", nativeToScVal(funder, { type: "address" })),
        value: nativeToScVal({ raised_by: funder, at: 99n }),
      },
      {
        contractId,
        topics: topic("FundsDeposited", nativeToScVal(funder, { type: "address" })),
        value: nativeToScVal({ funder, amount: 1_000n }),
      },
      {
        contractId,
        topics: topic("unknown_topic"),
        value: nativeToScVal("noop"),
      },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]?.topic).toBe("DisputeRaised");
    expect(events[1]?.topic).toBe("FundsDeposited");
  });

  it("round-trips XDR base64 values through deserializeTopics", () => {
    const topics = topic("EscrowInitialized");
    const decoded = deserializeTopics(topics);
    expect(decoded[0]).toBe("EscrowInitialized");
    const xdrB64 = topics[0]!.toXDR("base64");
    expect(xdr.ScVal.fromXDR(xdrB64, "base64").switch().name).toBe("scvSymbol");
  });
});

describe("legacy decodeContractEvents mapping", () => {
  it("keeps parseAstraFlowEvent compatible with decoded payloads", () => {
    const recipient = gAddress();
    const decoded = decodeContractEvents([
      {
        contractId: "CTEST",
        topics: [
          nativeToScVal("ProofSubmitted", { type: "symbol" }),
          nativeToScVal(3, { type: "u32" }),
        ],
        value: nativeToScVal({
          milestone: 3,
          recipient,
          proof: "aa".repeat(32),
          at: 50n,
        }),
        ledger: 7,
        txHash: "hash",
      },
    ]);
    expect(decoded[0]?.topic).toBe("ProofSubmitted");
    const typed = parseAstraFlowEvent(decoded[0]!);
    expect(typed?.topic).toBe("ProofSubmitted");
    if (typed?.topic === "ProofSubmitted") {
      expect(typed.milestoneId).toBe(3);
      expect(typed.recipient).toBe(recipient);
    }
  });
});

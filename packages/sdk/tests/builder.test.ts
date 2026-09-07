import { Address, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { EscrowBuilder } from "../src/builders/escrow";
import { DisputeBuilder } from "../src/builders/dispute";
import { toScVal, fromScVal, hexToBytes, milestoneToScVal } from "../src/converters";
import { AstraFlowError } from "../src/errors";

function gAddress(): string {
  return Keypair.random().publicKey();
}

function cAddress(seed = 1): string {
  return Address.contract(Buffer.alloc(32, seed)).toString();
}

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);

describe("EscrowBuilder", () => {
  const funder = gAddress();
  const recipient = gAddress();
  const arbitrator = gAddress();
  const token = cAddress(2);
  const contractId = cAddress(3);

  function builder() {
    return EscrowBuilder.create({ contractId, network: "testnet" })
      .setFunder(funder)
      .setRecipient(recipient)
      .setArbitrator(arbitrator)
      .setToken(token)
      .addMilestone({ payoutAmount: 1000, descriptionHash: HASH_A })
      .addMilestone({ payoutAmount: 2500n, descriptionHash: HASH_B });
  }

  it("compiles initialize ScVal arguments with sequential ids", () => {
    const invocation = builder().compile();
    expect(invocation.method).toBe("initialize");
    expect(invocation.contractId).toBe(contractId);
    expect(invocation.args).toHaveLength(5);

    const native = invocation.args.map((arg) => scValToNative(arg));
    expect(native[0]).toBe(funder);
    expect(native[1]).toBe(recipient);
    expect(native[2]).toBe(arbitrator);
    expect(Array.isArray(native[4])).toBe(true);
    const milestones = native[4] as Array<Record<string, unknown>>;
    expect(milestones).toHaveLength(2);
    expect(Number(milestones[0]?.milestone_id)).toBe(1);
    expect(Number(milestones[1]?.milestone_id)).toBe(2);
    expect(BigInt(String(milestones[0]?.payout_amount))).toBe(1000n);
  });

  it("rejects zero payouts, colliding roles, and non-sequential ids", () => {
    expect(() => builder().addMilestone({ payoutAmount: 0, descriptionHash: HASH_A })).toThrow(
      AstraFlowError,
    );
    expect(() =>
      EscrowBuilder.create({ contractId })
        .setFunder(funder)
        .setRecipient(funder)
        .setArbitrator(arbitrator)
        .setToken(token)
        .addMilestone({ payoutAmount: 1, descriptionHash: HASH_A })
        .compile(),
    ).toThrow(/distinct/);
    expect(() =>
      builder().addMilestone({ milestoneId: 9, payoutAmount: 1, descriptionHash: HASH_A }).compile(),
    ).toThrow(/sequential/);
  });

  it("rejects malformed hashes and addresses", () => {
    expect(() => builder().addMilestone({ payoutAmount: 1, descriptionHash: "aa" })).toThrow(
      /32 bytes/,
    );
    expect(() => EscrowBuilder.create({ contractId: "not-an-address" })).toThrow(AstraFlowError);
  });

  it("reports total allocation", () => {
    expect(builder().totalAllocated()).toBe(3500n);
  });
});

describe("DisputeBuilder", () => {
  const contractId = cAddress(4);
  const actor = gAddress();
  const arbA = gAddress();
  const arbB = gAddress();

  it("compiles raise, evidence, resolve, and quorum payloads", () => {
    const raise = new DisputeBuilder({ contractId }).raiseDispute().compile();
    expect(raise.method).toBe("raise_dispute");
    expect(raise.args).toHaveLength(0);

    const evidence = new DisputeBuilder({ contractId })
      .appendEvidence(actor, HASH_A)
      .compile();
    expect(evidence.method).toBe("append_dispute_evidence");
    expect(evidence.args).toHaveLength(2);

    const resolve = new DisputeBuilder({ contractId }).settle(2500, 7500).compile();
    expect(resolve.method).toBe("resolve_dispute");
    expect(scValToNative(resolve.args[0]!)).toBe(2500);
    expect(scValToNative(resolve.args[1]!)).toBe(7500);

    const quorum = new DisputeBuilder({ contractId })
      .settleWithQuorum(4000, 6000, [arbA, arbB])
      .compile();
    expect(quorum.method).toBe("settle_dispute_quorum");
    expect(scValToNative(quorum.args[2]!)).toHaveLength(2);
  });

  it("rejects incomplete splits, duplicate signers, and zero hashes", () => {
    expect(() => new DisputeBuilder({ contractId }).settle(5000, 4000)).toThrow(/10000/);
    expect(() =>
      new DisputeBuilder({ contractId }).settleWithQuorum(5000, 5000, [arbA, arbA]),
    ).toThrow(/Duplicate/);
    expect(() =>
      new DisputeBuilder({ contractId }).appendEvidence(actor, "00".repeat(32)),
    ).toThrow(/zeroes/);
  });
});

describe("ScVal converters", () => {
  it("round-trips addresses, u32, i128, and bytes", () => {
    const account = gAddress();
    expect(scValToNative(toScVal(account, "address"))).toBe(account);
    expect(scValToNative(toScVal(42, "u32"))).toBe(42);
    expect(BigInt(String(scValToNative(toScVal(99n, "i128"))))).toBe(99n);

    const bytes = hexToBytes(HASH_A);
    const back = scValToNative(toScVal(bytes, "bytes"));
    const asBytes = back instanceof Uint8Array ? back : Uint8Array.from(back as number[]);
    expect(Buffer.from(asBytes).toString("hex")).toBe(HASH_A);
  });

  it("rejects odd-length hex and serializes milestone structs", () => {
    expect(() => hexToBytes("abc")).toThrow(/even length/);
    const scVal = milestoneToScVal({
      milestoneId: 1,
      payoutAmount: 50n,
      descriptionHash: HASH_A,
    });
    expect(scVal).toBeInstanceOf(xdr.ScVal);
    const native = fromScVal(scVal) as Record<string, unknown>;
    expect(Number(native.milestone_id)).toBe(1);
    expect(BigInt(String(native.payout_amount))).toBe(50n);
  });

  it("clamps boundary numeric hints", () => {
    expect(scValToNative(toScVal(0, "u32"))).toBe(0);
    expect(scValToNative(toScVal(4_294_967_295, "u32"))).toBe(4_294_967_295);
    expect(BigInt(String(scValToNative(toScVal(-7n, "i128"))))).toBe(-7n);
  });
});

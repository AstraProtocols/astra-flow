import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { BuiltInvocation } from "../client.js";
import { hexToBytes } from "../converters.js";
import { AstraFlowError } from "../errors.js";
import { NETWORKS, type InitializeEscrowParams, type NetworkName } from "../types.js";

const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

export interface EscrowMilestoneDraft {
  milestoneId?: number;
  payoutAmount: bigint | number | string;
  descriptionHash: string | Uint8Array;
  vestingSecs?: number;
  deadline?: number | bigint;
}

export interface EscrowBuilderOptions {
  contractId: string;
  network?: NetworkName;
  networkPassphrase?: string;
}

function assertAddress(value: string, label: string, allowContract = false): string {
  const trimmed = value.trim();
  if (!STELLAR_ADDRESS_RE.test(trimmed) && !(allowContract && CONTRACT_ADDRESS_RE.test(trimmed))) {
    throw new AstraFlowError(`Invalid ${label} address`, { code: "BAD_ADDRESS" });
  }
  return trimmed;
}

function toAmount(value: bigint | number | string, label: string): bigint {
  let amount: bigint;
  try {
    amount = BigInt(value);
  } catch {
    throw new AstraFlowError(`${label} is not a valid integer amount`, { code: "BAD_AMOUNT" });
  }
  if (amount <= 0n) {
    throw new AstraFlowError(`${label} must be greater than zero`, { code: "ZERO_AMOUNT" });
  }
  return amount;
}

function hashBytes(value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  if (bytes.length !== 32) {
    throw new AstraFlowError("Milestone description hash must be 32 bytes", { code: "BAD_HASH" });
  }
  return Buffer.from(bytes);
}

/**
 * Fluent assembler for `initialize` invocations. Validates party uniqueness,
 * sequential milestone ids, and strictly positive allocations before compiling
 * ScVal arguments.
 */
export class EscrowBuilder {
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private funder?: string;
  private recipient?: string;
  private arbitrator?: string;
  private token?: string;
  private lockSecs = 2_592_000n;
  private readonly drafts: EscrowMilestoneDraft[] = [];

  constructor(options: EscrowBuilderOptions) {
    this.contractId = assertAddress(options.contractId, "contract", true);
    this.networkPassphrase =
      options.networkPassphrase ??
      NETWORKS[options.network ?? "testnet"].networkPassphrase;
  }

  static create(options: EscrowBuilderOptions): EscrowBuilder {
    return new EscrowBuilder(options);
  }

  setFunder(address: string): this {
    this.funder = assertAddress(address, "funder");
    return this;
  }

  setRecipient(address: string): this {
    this.recipient = assertAddress(address, "recipient");
    return this;
  }

  setArbitrator(address: string): this {
    this.arbitrator = assertAddress(address, "arbitrator");
    return this;
  }

  setToken(address: string): this {
    this.token = assertAddress(address, "token", true);
    return this;
  }

  setLockWindow(seconds: number | bigint): this {
    const value = BigInt(seconds);
    if (value <= 0n) {
      throw new AstraFlowError("Lock window must be positive", { code: "BAD_LOCK" });
    }
    this.lockSecs = value;
    return this;
  }

  addMilestone(draft: EscrowMilestoneDraft): this {
    toAmount(draft.payoutAmount, "Milestone payout");
    hashBytes(draft.descriptionHash);
    this.drafts.push({ ...draft });
    return this;
  }

  addMilestones(drafts: EscrowMilestoneDraft[]): this {
    for (const draft of drafts) this.addMilestone(draft);
    return this;
  }

  getLockWindow(): bigint {
    return this.lockSecs;
  }

  clearMilestones(): this {
    this.drafts.length = 0;
    return this;
  }

  totalAllocated(): bigint {
    return this.drafts.reduce((sum, draft) => sum + toAmount(draft.payoutAmount, "Milestone payout"), 0n);
  }

  toParams(): InitializeEscrowParams {
    const snapshot = this.validate();
    return {
      funder: snapshot.funder,
      recipient: snapshot.recipient,
      arbitrator: snapshot.arbitrator,
      token: snapshot.token,
      milestones: snapshot.milestones.map((item) => ({
        milestoneId: item.id,
        payoutAmount: item.amount,
        descriptionHash: item.hash.toString("hex"),
      })),
    };
  }

  compile(): BuiltInvocation {
    const snapshot = this.validate();
    const milestones = snapshot.milestones.map((item) =>
      nativeToScVal({
        milestone_id: item.id,
        payout_amount: item.amount,
        description_hash: item.hash,
        is_approved: false,
        completed_at: 0n,
        status: 0,
        submitted_at: 0n,
        vesting_secs: item.vestingSecs,
        streamed: 0n,
        deadline: item.deadline,
        late_penalty_applied: false,
      }),
    );

    return {
      method: "initialize",
      args: [
        new Address(snapshot.funder).toScVal(),
        new Address(snapshot.recipient).toScVal(),
        new Address(snapshot.arbitrator).toScVal(),
        new Address(snapshot.token).toScVal(),
        nativeToScVal(milestones, { type: "vec" }),
      ],
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
    };
  }

  private validate(): {
    funder: string;
    recipient: string;
    arbitrator: string;
    token: string;
    milestones: Array<{
      id: number;
      amount: bigint;
      hash: Buffer;
      vestingSecs: number;
      deadline: bigint;
    }>;
  } {
    if (!this.funder || !this.recipient || !this.arbitrator || !this.token) {
      throw new AstraFlowError("Funder, recipient, arbitrator, and token are required", {
        code: "INCOMPLETE_ESCROW",
      });
    }
    if (this.funder === this.recipient) {
      throw new AstraFlowError("Funder and recipient must be distinct", { code: "BAD_ROLES" });
    }
    if (this.arbitrator === this.funder || this.arbitrator === this.recipient) {
      throw new AstraFlowError("Arbitrator cannot collide with funder or recipient", {
        code: "ARBITRATOR_COLLISION",
      });
    }
    if (this.drafts.length === 0) {
      throw new AstraFlowError("At least one milestone is required", { code: "ZERO_AMOUNT" });
    }

    const milestones = this.drafts.map((draft, index) => {
      const id = draft.milestoneId ?? index + 1;
      if (id !== index + 1) {
        throw new AstraFlowError("Milestone ids must be 1-based and sequential", {
          code: "BAD_SEQUENCE",
        });
      }
      if ((draft.vestingSecs ?? 0) < 0) {
        throw new AstraFlowError("Vesting duration cannot be negative", { code: "BAD_VESTING" });
      }
      return {
        id,
        amount: toAmount(draft.payoutAmount, `Milestone ${id} payout`),
        hash: hashBytes(draft.descriptionHash),
        vestingSecs: draft.vestingSecs ?? 0,
        deadline: BigInt(draft.deadline ?? 0),
      };
    });

    return {
      funder: this.funder,
      recipient: this.recipient,
      arbitrator: this.arbitrator,
      token: this.token,
      milestones,
    };
  }
}

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { BuiltInvocation } from "../client.js";
import { hexToBytes } from "../converters.js";
import { AstraFlowError } from "../errors.js";
import { NETWORKS, type NetworkName } from "../types.js";

const ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;
const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const BPS_SCALE = 10_000;

export type DisputeAction = "raise" | "evidence" | "resolve" | "quorum";

export interface DisputeBuilderOptions {
  contractId: string;
  network?: NetworkName;
  networkPassphrase?: string;
}

function requireAddress(value: string, label: string, allowContract = false): string {
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed) && !(allowContract && CONTRACT_RE.test(trimmed))) {
    throw new AstraFlowError(`Invalid ${label} address`, { code: "BAD_ADDRESS" });
  }
  return trimmed;
}

function requireHash(value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  if (bytes.length !== 32) {
    throw new AstraFlowError("Evidence hash must be a 32-byte SHA-256 digest", { code: "BAD_HASH" });
  }
  if (bytes.every((byte) => byte === 0)) {
    throw new AstraFlowError("Evidence hash cannot be all zeroes", { code: "BAD_HASH" });
  }
  return Buffer.from(bytes);
}

function requireSplit(funderBps: number, recipientBps: number): void {
  if (!Number.isInteger(funderBps) || !Number.isInteger(recipientBps)) {
    throw new AstraFlowError("Split ratios must be integers", { code: "BAD_SPLIT" });
  }
  if (funderBps < 0 || recipientBps < 0 || funderBps + recipientBps !== BPS_SCALE) {
    throw new AstraFlowError("Funder and recipient basis points must sum to 10000", {
      code: "BAD_SPLIT",
    });
  }
}

/**
 * Builds raise / evidence / settlement payloads for the escrow dispute protocol.
 */
export class DisputeBuilder {
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private action: DisputeAction | null = null;
  private actor?: string;
  private evidenceHash?: Buffer;
  private funderBps = 0;
  private recipientBps = 0;
  private signers: string[] = [];

  constructor(options: DisputeBuilderOptions) {
    this.contractId = requireAddress(options.contractId, "contract", true);
    this.networkPassphrase =
      options.networkPassphrase ?? NETWORKS[options.network ?? "testnet"].networkPassphrase;
  }

  raiseDispute(): this {
    this.action = "raise";
    return this;
  }

  appendEvidence(actor: string, contentHash: string | Uint8Array): this {
    this.action = "evidence";
    this.actor = requireAddress(actor, "evidence submitter");
    this.evidenceHash = requireHash(contentHash);
    return this;
  }

  settle(funderBps: number, recipientBps: number): this {
    requireSplit(funderBps, recipientBps);
    this.action = "resolve";
    this.funderBps = funderBps;
    this.recipientBps = recipientBps;
    return this;
  }

  settleWithQuorum(
    funderBps: number,
    recipientBps: number,
    signers: string[],
  ): this {
    requireSplit(funderBps, recipientBps);
    if (signers.length === 0) {
      throw new AstraFlowError("Quorum settlement requires at least one signer", {
        code: "QUORUM_NOT_MET",
      });
    }
    const unique = new Set<string>();
    this.signers = signers.map((signer) => {
      const address = requireAddress(signer, "arbitrator");
      if (unique.has(address)) {
        throw new AstraFlowError("Duplicate arbitrator signer", { code: "DUP_SIGNER" });
      }
      unique.add(address);
      return address;
    });
    this.action = "quorum";
    this.funderBps = funderBps;
    this.recipientBps = recipientBps;
    return this;
  }

  compile(): BuiltInvocation {
    if (!this.action) {
      throw new AstraFlowError("No dispute action selected", { code: "INCOMPLETE_DISPUTE" });
    }
    return {
      method: this.method(),
      args: this.args(),
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
    };
  }

  private method(): string {
    switch (this.action) {
      case "raise":
        return "raise_dispute";
      case "evidence":
        return "append_dispute_evidence";
      case "resolve":
        return "resolve_dispute";
      case "quorum":
        return "settle_dispute_quorum";
      default:
        throw new AstraFlowError("No dispute action selected", { code: "INCOMPLETE_DISPUTE" });
    }
  }

  private args(): xdr.ScVal[] {
    switch (this.action) {
      case "raise":
        return [];
      case "evidence":
        return [
          new Address(this.actor!).toScVal(),
          nativeToScVal(this.evidenceHash, { type: "bytes" }),
        ];
      case "resolve":
        return [
          nativeToScVal(this.funderBps, { type: "u32" }),
          nativeToScVal(this.recipientBps, { type: "u32" }),
        ];
      case "quorum": {
        const signers = this.signers.map((signer) => new Address(signer).toScVal());
        return [
          nativeToScVal(this.funderBps, { type: "u32" }),
          nativeToScVal(this.recipientBps, { type: "u32" }),
          nativeToScVal(signers, { type: "vec" }),
        ];
      }
      default:
        return [];
    }
  }
}

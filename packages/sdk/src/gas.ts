import { Contract, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { BuiltInvocation } from "./client.js";
import { AstraFlowError, SimulationError } from "./errors.js";
import { NETWORKS, type NetworkName } from "./types.js";

export interface ResourceEstimate {
  cpuInstructions: bigint;
  memoryBytes: bigint;
  minResourceFee: bigint;
  inclusionFee: bigint;
  refundableFee: bigint;
  totalFee: bigint;
  ledgerReads: number;
  ledgerWrites: number;
  raw: Record<string, unknown>;
}

export interface FeeEstimatorOptions {
  rpcUrl?: string;
  network?: NetworkName;
  networkPassphrase?: string;
  inclusionFee?: string;
}

function asBig(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value !== "") return BigInt(value);
  return 0n;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function extractResources(simulated: unknown, inclusionFee = 100_000n): ResourceEstimate {
  const record = asRecord(simulated);
  const resources = asRecord(record.transactionData ?? record.resources ?? record);
  const soroban =
    asRecord(resources.resources) ||
    asRecord(asRecord(resources.resourceFee)) ||
    resources;

  const cpuInstructions = asBig(
    soroban.instructions ?? soroban.cpuInsns ?? record.cpuInsns ?? record.minResourceFee,
  );
  const memoryBytes = asBig(soroban.readBytes ?? soroban.memBytes ?? soroban.footprintBytes);
  const minResourceFee = asBig(
    record.minResourceFee ?? resources.resourceFee ?? record.resourceFee,
  );
  const refundableFee = asBig(
    soroban.refundableFee ?? record.refundableFee ?? resources.refundableFee,
  );
  const ledgerReads = asNumber(soroban.readLedgerEntries ?? soroban.diskReadEntries);
  const ledgerWrites = asNumber(soroban.writeLedgerEntries ?? soroban.writeEntries);

  return {
    cpuInstructions,
    memoryBytes,
    minResourceFee,
    inclusionFee,
    refundableFee,
    totalFee: minResourceFee + inclusionFee,
    ledgerReads,
    ledgerWrites,
    raw: record,
  };
}

/**
 * Profiles a built contract invocation against Soroban RPC and returns CPU,
 * memory, and fee dimensions used by wallet fee bumpers.
 */
export class FeeEstimator {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly inclusionFee: string;

  constructor(options: FeeEstimatorOptions = {}) {
    const network = options.network ?? "testnet";
    this.server = new rpc.Server(options.rpcUrl ?? NETWORKS[network].rpcUrl, { allowHttp: false });
    this.networkPassphrase = options.networkPassphrase ?? NETWORKS[network].networkPassphrase;
    this.inclusionFee = options.inclusionFee ?? "100000";
  }

  async estimate(source: string, invocation: BuiltInvocation): Promise<ResourceEstimate> {
    if (!source) {
      throw new AstraFlowError("Source account is required for fee estimation", {
        code: "BAD_SOURCE",
      });
    }
    const account = await this.server.getAccount(source);
    const contract = new Contract(invocation.contractId);
    const tx = new TransactionBuilder(account, {
      fee: this.inclusionFee,
      networkPassphrase: invocation.networkPassphrase || this.networkPassphrase,
    })
      .addOperation(contract.call(invocation.method, ...invocation.args))
      .setTimeout(60)
      .build();

    const simulated = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulated)) {
      throw new SimulationError(simulated.error, simulated);
    }
    return extractResources(simulated, BigInt(this.inclusionFee));
  }
}

export function createFeeEstimator(options?: FeeEstimatorOptions): FeeEstimator {
  return new FeeEstimator(options);
}

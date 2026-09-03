import {
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { decodeContractEvents } from "./events.js";
import { bytesToHex, hexToBytes, serializeScVal } from "./scval.js";
import {
  NETWORKS,
  type DecodedContractEvent,
  type EscrowConfig,
  type EscrowState,
  type InitializeEscrowParams,
  type Milestone,
  type MilestoneInput,
  type MilestoneStatus,
  type NetworkName,
} from "./types.js";

export interface EscrowClientOptions {
  contractId: string;
  network?: NetworkName;
  rpcUrl?: string;
  networkPassphrase?: string;
}

export interface BuiltInvocation {
  method: string;
  args: xdr.ScVal[];
  contractId: string;
  networkPassphrase: string;
}

const STATE_BY_VALUE: EscrowState[] = [
  "Pending",
  "Active",
  "Completed",
  "Disputed",
  "Cancelled",
];

function milestoneToScVal(milestone: MilestoneInput): xdr.ScVal {
  const description =
    typeof milestone.descriptionHash === "string"
      ? hexToBytes(milestone.descriptionHash)
      : milestone.descriptionHash;

  return nativeToScVal(
    {
      milestone_id: milestone.milestoneId,
      payout_amount: milestone.payoutAmount,
      description_hash: Buffer.from(description),
      is_approved: false,
      completed_at: BigInt(0),
    },
    {
      type: "object",
    } as never,
  );
}

function mapMilestoneStatus(milestone: {
  isApproved: boolean;
  proofHash?: string;
}): MilestoneStatus {
  if (milestone.isApproved) return "Released";
  if (milestone.proofHash) return "Under Review";
  return "Pending";
}

/**
 * High-level helper around the Astra Flow escrow contract.
 * Builds initialize / deposit / proof / approve invocations and
 * decodes read-only contract state from RPC.
 */
export class EscrowClient {
  readonly contractId: string;
  readonly network: NetworkName;
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly contract: Contract;
  readonly server: rpc.Server;

  constructor(options: EscrowClientOptions) {
    this.contractId = options.contractId;
    this.network = options.network ?? "testnet";
    const preset = NETWORKS[this.network];
    this.rpcUrl = options.rpcUrl ?? preset.rpcUrl;
    this.networkPassphrase =
      options.networkPassphrase ??
      preset.networkPassphrase ??
      (this.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET);
    this.contract = new Contract(this.contractId);
    this.server = new rpc.Server(this.rpcUrl, { allowHttp: false });
  }

  initialize(params: InitializeEscrowParams): BuiltInvocation {
    const milestones = params.milestones.map((item) => milestoneToScVal(item));
    return this.build("initialize", [
      serializeScVal(params.funder, "address"),
      serializeScVal(params.recipient, "address"),
      serializeScVal(params.arbitrator, "address"),
      serializeScVal(params.token, "address"),
      nativeToScVal(milestones, { type: "vec" }),
    ]);
  }

  depositFunds(): BuiltInvocation {
    return this.build("deposit_funds", []);
  }

  submitMilestoneProof(milestoneId: number, proofHash: string | Uint8Array): BuiltInvocation {
    const bytes = typeof proofHash === "string" ? hexToBytes(proofHash) : proofHash;
    return this.build("submit_milestone_proof", [
      serializeScVal(milestoneId, "u32"),
      serializeScVal(bytes, "bytes"),
    ]);
  }

  approveMilestone(milestoneId: number): BuiltInvocation {
    return this.build("approve_milestone", [serializeScVal(milestoneId, "u32")]);
  }

  raiseDispute(): BuiltInvocation {
    return this.build("raise_dispute", []);
  }

  async getConfig(): Promise<EscrowConfig> {
    const result = await this.simulate("get_config", []);
    const raw = result as Record<string, unknown>;
    return {
      funder: String(raw.funder),
      recipient: String(raw.recipient),
      arbitrator: String(raw.arbitrator),
      asset: String(raw.asset),
      totalAmount: BigInt(String(raw.total_amount ?? raw.totalAmount ?? 0)),
      releaseThreshold: Number(raw.release_threshold ?? raw.releaseThreshold ?? 0),
    };
  }

  async getState(): Promise<EscrowState> {
    const result = await this.simulate("get_state", []);
    if (typeof result === "string" && STATE_BY_VALUE.includes(result as EscrowState)) {
      return result as EscrowState;
    }
    if (typeof result === "number") {
      return STATE_BY_VALUE[result] ?? "Pending";
    }
    return "Pending";
  }

  async getMilestone(milestoneId: number, proofHash?: string): Promise<Milestone> {
    const result = (await this.simulate("get_milestone", [
      serializeScVal(milestoneId, "u32"),
    ])) as Record<string, unknown>;

    const description = result.description_hash ?? result.descriptionHash;
    const milestone: Milestone = {
      milestoneId: Number(result.milestone_id ?? result.milestoneId ?? milestoneId),
      payoutAmount: BigInt(String(result.payout_amount ?? result.payoutAmount ?? 0)),
      descriptionHash:
        description instanceof Uint8Array ? bytesToHex(description) : String(description ?? ""),
      isApproved: Boolean(result.is_approved ?? result.isApproved),
      completedAt: BigInt(String(result.completed_at ?? result.completedAt ?? 0)),
      proofHash,
      status: "Pending",
    };
    milestone.status = mapMilestoneStatus(milestone);
    return milestone;
  }

  decodeEvents(
    events: Parameters<typeof decodeContractEvents>[0],
  ): DecodedContractEvent[] {
    return decodeContractEvents(events);
  }

  async assembleTransaction(
    source: string,
    invocation: BuiltInvocation,
    fee = "100000",
  ): Promise<string> {
    const account = await this.server.getAccount(source);
    const tx = new TransactionBuilder(account, {
      fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(invocation.method, ...invocation.args))
      .setTimeout(60)
      .build();

    const simulated = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulated)) {
      throw new Error(simulated.error);
    }
    const assembled = rpc.assembleTransaction(tx, simulated).build();
    return assembled.toXDR();
  }

  private build(method: string, args: xdr.ScVal[]): BuiltInvocation {
    return {
      method,
      args,
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
    };
  }

  private async simulate(method: string, args: xdr.ScVal[]): Promise<unknown> {
    const account = new Address(this.contractId);
    const tx = new TransactionBuilder(
      {
        accountId: account.toString(),
        sequence: "0",
      } as never,
      { fee: "0", networkPassphrase: this.networkPassphrase },
    )
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simulated = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulated)) {
      throw new Error(simulated.error);
    }
    if (rpc.Api.isSimulationSuccess(simulated) && simulated.result?.retval) {
      const { scValToNative } = await import("@stellar/stellar-sdk");
      return scValToNative(simulated.result.retval);
    }
    return null;
  }
}

export function createEscrowClient(options: EscrowClientOptions): EscrowClient {
  return new EscrowClient(options);
}

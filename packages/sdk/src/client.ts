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
import {
  hexToBytes,
  milestoneToScVal,
  parseEscrowConfig,
  parseEscrowState,
  parseMilestone,
  toScVal,
} from "./converters.js";
import {
  NETWORKS,
  type DecodedContractEvent,
  type EscrowConfig,
  type EscrowState,
  type InitializeEscrowParams,
  type Milestone,
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
      toScVal(params.funder, "address"),
      toScVal(params.recipient, "address"),
      toScVal(params.arbitrator, "address"),
      toScVal(params.token, "address"),
      nativeToScVal(milestones, { type: "vec" }),
    ]);
  }

  depositFunds(): BuiltInvocation {
    return this.build("deposit_funds", []);
  }

  submitMilestoneProof(milestoneId: number, proofHash: string | Uint8Array): BuiltInvocation {
    const bytes = typeof proofHash === "string" ? hexToBytes(proofHash) : proofHash;
    return this.build("submit_milestone_proof", [
      toScVal(milestoneId, "u32"),
      toScVal(bytes, "bytes"),
    ]);
  }

  approveMilestone(milestoneId: number): BuiltInvocation {
    return this.build("approve_milestone", [toScVal(milestoneId, "u32")]);
  }

  raiseDispute(): BuiltInvocation {
    return this.build("raise_dispute", []);
  }

  async getConfig(): Promise<EscrowConfig> {
    return parseEscrowConfig(await this.simulate("get_config", []));
  }

  async getState(): Promise<EscrowState> {
    return parseEscrowState(await this.simulate("get_state", []));
  }

  async getMilestone(milestoneId: number, proofHash?: string): Promise<Milestone> {
    const result = await this.simulate("get_milestone", [toScVal(milestoneId, "u32")]);
    return parseMilestone(result, proofHash);
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

  protected build(method: string, args: xdr.ScVal[]): BuiltInvocation {
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

/**
 * Primary RPC client. Each mutating helper simulates the invocation against
 * Soroban RPC and returns an assembled, unsigned transaction XDR.
 */
export class AstraFlowClient extends EscrowClient {
  async initializeEscrow(source: string, params: InitializeEscrowParams): Promise<string> {
    return this.assembleTransaction(source, this.initialize(params));
  }

  async deposit(source: string): Promise<string> {
    return this.assembleTransaction(source, this.depositFunds());
  }

  async submitProof(
    source: string,
    milestoneId: number,
    proofHash: string | Uint8Array,
  ): Promise<string> {
    return this.assembleTransaction(source, this.submitMilestoneProof(milestoneId, proofHash));
  }

  async releaseMilestone(source: string, milestoneId: number): Promise<string> {
    return this.assembleTransaction(source, this.approveMilestone(milestoneId));
  }

  async dispute(source: string): Promise<string> {
    return this.assembleTransaction(source, this.raiseDispute());
  }

  async resolveDispute(source: string, funderBps: number, recipientBps: number): Promise<string> {
    return this.assembleTransaction(
      source,
      this.build("resolve_dispute", [toScVal(funderBps, "u32"), toScVal(recipientBps, "u32")]),
    );
  }

  async claimTimeoutRefund(source: string): Promise<string> {
    return this.assembleTransaction(source, this.build("claim_timeout_refund", []));
  }
}

export function createAstraFlowClient(options: EscrowClientOptions): AstraFlowClient {
  return new AstraFlowClient(options);
}

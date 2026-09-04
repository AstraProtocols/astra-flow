export type NetworkName = "testnet" | "mainnet";

export type EscrowState =
  | "Pending"
  | "Active"
  | "Completed"
  | "Disputed"
  | "Cancelled";

export type MilestoneStatus =
  | "Pending"
  | "UnderReview"
  | "Under Review"
  | "Released"
  | "Disputed";

export const ESCROW_STATE_BY_VALUE: EscrowState[] = [
  "Pending",
  "Active",
  "Completed",
  "Disputed",
  "Cancelled",
];

export const MILESTONE_STATUS_BY_VALUE: MilestoneStatus[] = [
  "Pending",
  "UnderReview",
  "Released",
  "Disputed",
];

export interface MilestoneInput {
  milestoneId: number;
  payoutAmount: bigint;
  descriptionHash: string | Uint8Array;
}

export interface Milestone {
  milestoneId: number;
  payoutAmount: bigint;
  descriptionHash: string;
  isApproved: boolean;
  completedAt: bigint;
  status: MilestoneStatus;
  submittedAt?: bigint;
  proofHash?: string;
}

export interface EscrowConfig {
  funder: string;
  recipient: string;
  arbitrator: string;
  asset: string;
  totalAmount: bigint;
  releaseThreshold: number;
  lockSecs?: bigint;
}

export interface BalanceBook {
  deposited: bigint;
  released: bigint;
  refunded: bigint;
}

export interface DisputeRecord {
  raisedBy: string;
  raisedAt: bigint;
  funderBps: number;
  recipientBps: number;
  resolved: boolean;
}

export interface DisputePayload {
  escrowId: string;
  raisedBy: string;
  raisedAt: bigint;
  funderBps: number;
  recipientBps: number;
  funderAmount: bigint;
  recipientAmount: bigint;
  resolved: boolean;
}

export interface InitializeEscrowParams {
  funder: string;
  recipient: string;
  arbitrator: string;
  token: string;
  milestones: MilestoneInput[];
}

export interface ParsedContractEvent {
  contractId: string;
  topic: string;
  ledger?: number;
  txHash?: string;
}

export interface EscrowInitializedEvent extends ParsedContractEvent {
  topic: "EscrowInitialized";
  funder: string;
  recipient: string;
  arbitrator: string;
  token: string;
  total: bigint;
  count: number;
}

export interface FundsDepositedEvent extends ParsedContractEvent {
  topic: "FundsDeposited";
  funder: string;
  amount: bigint;
}

export interface ProofSubmittedEvent extends ParsedContractEvent {
  topic: "ProofSubmitted";
  milestoneId: number;
  recipient: string;
  proofHash: string;
  at: bigint;
}

export interface MilestoneReleasedEvent extends ParsedContractEvent {
  topic: "MilestoneReleased";
  milestoneId: number;
  recipient: string;
  amount: bigint;
}

export interface DisputeRaisedEvent extends ParsedContractEvent {
  topic: "DisputeRaised";
  raisedBy: string;
  at: bigint;
}

export interface DisputeResolvedEvent extends ParsedContractEvent {
  topic: "DisputeResolved";
  arbitrator: string;
  funderBps: number;
  recipientBps: number;
  funderAmount: bigint;
  recipientAmount: bigint;
}

export interface TimeoutRefundedEvent extends ParsedContractEvent {
  topic: "TimeoutRefunded";
  funder: string;
  amount: bigint;
  at: bigint;
}

export type AstraFlowEvent =
  | EscrowInitializedEvent
  | FundsDepositedEvent
  | ProofSubmittedEvent
  | MilestoneReleasedEvent
  | DisputeRaisedEvent
  | DisputeResolvedEvent
  | TimeoutRefundedEvent;

/** @deprecated Use ParsedContractEvent / AstraFlowEvent */
export interface DecodedContractEvent {
  contractId: string;
  topic: string;
  payload: unknown;
  ledger?: number;
  txHash?: string;
}

export interface NetworkConfig {
  name: NetworkName;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  usdcContractId?: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    name: "mainnet",
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://soroban-rpc.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
};

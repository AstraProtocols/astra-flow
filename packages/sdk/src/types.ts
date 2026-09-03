export type NetworkName = "testnet" | "mainnet";

export type EscrowState =
  | "Pending"
  | "Active"
  | "Completed"
  | "Disputed"
  | "Cancelled";

export type MilestoneStatus = "Pending" | "Under Review" | "Released";

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
  proofHash?: string;
  status: MilestoneStatus;
}

export interface EscrowConfig {
  funder: string;
  recipient: string;
  arbitrator: string;
  asset: string;
  totalAmount: bigint;
  releaseThreshold: number;
}

export interface InitializeEscrowParams {
  funder: string;
  recipient: string;
  arbitrator: string;
  token: string;
  milestones: MilestoneInput[];
}

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

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  EscrowClient,
  type EscrowState,
  type Milestone,
  type MilestoneInput,
} from "@astraprotocols/sdk";

/**
 * Local seed of a full escrow lifecycle.
 * Prints initialize → deposit → proof → approve → dispute shapes
 * so contributors can wire wallets or the indexer without Testnet.
 */
const funder = process.env.FUNDER_ADDRESS ?? Keypair.random().publicKey();
const recipient = process.env.RECIPIENT_ADDRESS ?? Keypair.random().publicKey();
const arbitrator = process.env.ARBITRATOR_ADDRESS ?? Keypair.random().publicKey();
const token =
  process.env.TOKEN_ADDRESS ?? StrKey.encodeContract(Buffer.alloc(32, 7));
const contractId =
  process.env.ESCROW_CONTRACT_ID ?? StrKey.encodeContract(Buffer.alloc(32, 9));

const milestones: MilestoneInput[] = [
  {
    milestoneId: 1,
    payoutAmount: 150_0000000n,
    descriptionHash: "11".repeat(32),
  },
  {
    milestoneId: 2,
    payoutAmount: 300_0000000n,
    descriptionHash: "22".repeat(32),
  },
];

const client = new EscrowClient({
  contractId,
  network: "testnet",
});

const initialize = client.initialize({
  funder,
  recipient,
  arbitrator,
  token,
  milestones,
});
const deposit = client.depositFunds();
const proof = client.submitMilestoneProof(1, "ab".repeat(32));
const approve = client.approveMilestone(1);
const dispute = client.raiseDispute();

const simulatedState: EscrowState[] = ["Pending", "Active", "Active", "Disputed"];
const simulatedMilestones: Milestone[] = milestones.map((item, index) => ({
  milestoneId: item.milestoneId,
  payoutAmount: item.payoutAmount,
  descriptionHash: String(item.descriptionHash),
  isApproved: index === 0,
  completedAt: index === 0 ? 1_700_000_000n : 0n,
  proofHash: index === 0 ? "ab".repeat(32) : undefined,
  status: index === 0 ? "Released" : "Pending",
}));

const decoded = client.decodeEvents([
  { contractId, topics: [], value: undefined },
]);

console.log(
  JSON.stringify(
    {
      contractId,
      lifecycle: [
        { step: "initialize", method: initialize.method, args: initialize.args.length },
        { step: "deposit_funds", method: deposit.method },
        { step: "submit_milestone_proof", method: proof.method, args: proof.args.length },
        { step: "approve_milestone", method: approve.method },
        { step: "raise_dispute", method: dispute.method },
      ],
      simulatedState,
      simulatedMilestones: simulatedMilestones.map((item) => ({
        ...item,
        payoutAmount: item.payoutAmount.toString(),
        completedAt: item.completedAt.toString(),
      })),
      decodedEvents: decoded,
    },
    null,
    2,
  ),
);

import type { EscrowConfig, EscrowState, Milestone, MilestoneStatus } from "@astraprotocols/sdk";

export interface IndexedEscrow {
  address: string;
  role: "funder" | "recipient" | "arbitrator";
  state: EscrowState;
  config: EscrowConfig;
  milestones: Milestone[];
  lockedBalance: bigint;
  updatedAt: string;
}

const now = () => new Date().toISOString();

function milestone(
  id: number,
  amount: bigint,
  status: MilestoneStatus,
  extras: Partial<Milestone> = {},
): Milestone {
  return {
    milestoneId: id,
    payoutAmount: amount,
    descriptionHash: extras.descriptionHash ?? `0${id}`.repeat(32).slice(0, 64),
    isApproved: status === "Released",
    completedAt: status === "Released" ? 1_700_000_000n : 0n,
    proofHash: extras.proofHash,
    status,
  };
}

const seed: IndexedEscrow[] = [
  {
    address: "GASCSEEDFUNDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    role: "funder",
    state: "Active",
    config: {
      funder: "GASCSEEDFUNDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      recipient: "GASCSEEDRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      arbitrator: "GASCSEEDARBITRATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      totalAmount: 450_0000000n,
      releaseThreshold: 3,
    },
    milestones: [
      milestone(1, 150_0000000n, "Released"),
      milestone(2, 150_0000000n, "Under Review", {
        proofHash: "ab".repeat(32),
      }),
      milestone(3, 150_0000000n, "Pending"),
    ],
    lockedBalance: 300_0000000n,
    updatedAt: now(),
  },
];

const byAddress = new Map<string, IndexedEscrow[]>();

function indexSeed() {
  for (const escrow of seed) {
    const parties = [escrow.config.funder, escrow.config.recipient, escrow.config.arbitrator];
    for (const party of parties) {
      const current = byAddress.get(party) ?? [];
      if (!current.includes(escrow)) {
        current.push(escrow);
        byAddress.set(party, current);
      }
    }
  }
}

indexSeed();

export function listEscrowsForAddress(address: string): IndexedEscrow[] {
  const exact = byAddress.get(address);
  if (exact?.length) return exact;
  // Dev convenience: unknown wallets still see the seeded demo escrow as funder.
  return seed.map((escrow) => ({
    ...escrow,
    address,
    role: "funder",
    config: { ...escrow.config, funder: address },
  }));
}

export function recordProof(address: string, milestoneId: number, proofHash: string): IndexedEscrow {
  const [escrow] = listEscrowsForAddress(address);
  const next: IndexedEscrow = {
    ...escrow,
    milestones: escrow.milestones.map((item) =>
      item.milestoneId === milestoneId
        ? { ...item, proofHash, status: item.isApproved ? item.status : "Under Review" }
        : item,
    ),
    updatedAt: now(),
  };
  byAddress.set(address, [next]);
  return next;
}

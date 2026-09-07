import type { BalanceBook, EscrowConfig, EscrowState, Milestone } from "../types.js";

export interface EscrowSnapshot {
  state: EscrowState;
  config: EscrowConfig;
  balances: BalanceBook;
  milestones: Milestone[];
  now: bigint;
  paused?: boolean;
}

export interface EscrowProjection {
  state: EscrowState;
  total: bigint;
  deposited: bigint;
  released: bigint;
  refunded: bigint;
  locked: bigint;
  completedMilestones: number;
  totalMilestones: number;
  percentComplete: number;
  secondsToDeadline: bigint;
  overdue: boolean;
  health: "healthy" | "at_risk" | "disputed" | "paused" | "completed" | "cancelled";
}

function lockedOf(book: BalanceBook): bigint {
  const remaining = book.deposited - book.released - book.refunded;
  return remaining > 0n ? remaining : 0n;
}

function deadlineOf(config: EscrowConfig, milestones: Milestone[]): bigint {
  const lock = config.lockSecs ?? 0n;
  const submitted = milestones.reduce((latest, item) => {
    const submittedAt = item.submittedAt ?? 0n;
    return submittedAt > latest ? submittedAt : latest;
  }, 0n);
  if (submitted > 0n && lock > 0n) return submitted + lock;
  return lock;
}

/**
 * Pure projection of escrow health metrics. Never mutates the input snapshot.
 */
export function projectEscrow(snapshot: EscrowSnapshot): EscrowProjection {
  const total = snapshot.config.totalAmount;
  const completedMilestones = snapshot.milestones.filter(
    (item) => item.isApproved || item.status === "Released",
  ).length;
  const totalMilestones = snapshot.milestones.length;
  const percentComplete =
    totalMilestones === 0 ? 0 : Math.floor((completedMilestones * 10000) / totalMilestones) / 100;
  const deadline = deadlineOf(snapshot.config, snapshot.milestones);
  const secondsToDeadline = deadline > snapshot.now ? deadline - snapshot.now : 0n;
  const overdue = deadline > 0n && snapshot.now >= deadline && snapshot.state === "Active";

  let health: EscrowProjection["health"] = "healthy";
  if (snapshot.paused) health = "paused";
  else if (snapshot.state === "Disputed") health = "disputed";
  else if (snapshot.state === "Completed") health = "completed";
  else if (snapshot.state === "Cancelled") health = "cancelled";
  else if (overdue || percentComplete === 0) health = "at_risk";

  return {
    state: snapshot.state,
    total,
    deposited: snapshot.balances.deposited,
    released: snapshot.balances.released,
    refunded: snapshot.balances.refunded,
    locked: lockedOf(snapshot.balances),
    completedMilestones,
    totalMilestones,
    percentComplete,
    secondsToDeadline,
    overdue,
    health,
  };
}

export function percentComplete(milestones: readonly Milestone[]): number {
  return projectEscrow({
    state: "Active",
    config: {
      funder: "",
      recipient: "",
      arbitrator: "",
      asset: "",
      totalAmount: 0n,
      releaseThreshold: milestones.length,
    },
    balances: { deposited: 0n, released: 0n, refunded: 0n },
    milestones: [...milestones],
    now: 0n,
  }).percentComplete;
}

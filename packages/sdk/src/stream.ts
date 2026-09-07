import { AstraFlowError } from "./errors.js";

export interface StreamSchedule {
  total: bigint;
  start: bigint;
  end: bigint;
}

export interface AccruedBalance {
  vested: bigint;
  remaining: bigint;
  elapsedRatioBps: number;
  completed: boolean;
}

function requireNonNegative(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new AstraFlowError(`${label} cannot be negative`, { code: "BAD_AMOUNT" });
  }
  return value;
}

/**
 * Floor(total * elapsed / duration) matching the on-chain `vested_amount` helper.
 */
export function vestedAmount(total: bigint, start: bigint, end: bigint, now: bigint): bigint {
  requireNonNegative(total, "Stream total");
  if (end <= start) {
    throw new AstraFlowError("Stream end must be after start", { code: "BAD_VESTING" });
  }
  if (now <= start) return 0n;
  if (now >= end) return total;
  const elapsed = now - start;
  const duration = end - start;
  return (total * elapsed) / duration;
}

export function remainingAmount(total: bigint, start: bigint, end: bigint, now: bigint): bigint {
  return total - vestedAmount(total, start, end, now);
}

export function elapsedRatioBps(start: bigint, end: bigint, now: bigint): number {
  if (end <= start) {
    throw new AstraFlowError("Stream end must be after start", { code: "BAD_VESTING" });
  }
  if (now <= start) return 0;
  if (now >= end) return 10_000;
  const elapsed = now - start;
  const duration = end - start;
  return Number((elapsed * 10_000n) / duration);
}

/**
 * Linear unlock interpolator. Optional `decayBps` reduces the remaining unvested
 * tail (for clawback / late-penalty visualizations) without increasing vested.
 */
export function interpolateStream(
  schedule: StreamSchedule,
  now: bigint,
  alreadyClaimed = 0n,
  decayBps = 0,
): AccruedBalance {
  if (decayBps < 0 || decayBps > 10_000) {
    throw new AstraFlowError("Decay must be 0-10000 bps", { code: "BAD_PENALTY" });
  }
  const vestedRaw = vestedAmount(schedule.total, schedule.start, schedule.end, now);
  const decay = (vestedRaw * BigInt(decayBps)) / 10_000n;
  const vested = vestedRaw - decay;
  const claimed = requireNonNegative(alreadyClaimed, "Claimed amount");
  const unlocked = vested > claimed ? vested - claimed : 0n;
  const remaining = schedule.total > claimed ? schedule.total - claimed - unlocked : 0n;
  return {
    vested: unlocked,
    remaining,
    elapsedRatioBps: elapsedRatioBps(schedule.start, schedule.end, now),
    completed: now >= schedule.end,
  };
}

export function projectStream(
  schedule: StreamSchedule,
  samples: bigint[],
  alreadyClaimed = 0n,
): AccruedBalance[] {
  return samples.map((now) => interpolateStream(schedule, now, alreadyClaimed));
}

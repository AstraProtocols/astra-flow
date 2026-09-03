"use client";

import { motion } from "framer-motion";
import { Check, Clock, Lock, Unlock } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@astraprotocols/sdk";
import { cn, formatStroops } from "@/lib/utils";

const statusStyles: Record<MilestoneStatus, string> = {
  Pending: "border-white/10 text-slate-300",
  "Under Review": "border-cyan/40 text-cyan",
  Released: "border-emerald/50 text-emerald",
};

const statusIcon: Record<MilestoneStatus, typeof Clock> = {
  Pending: Clock,
  "Under Review": Lock,
  Released: Check,
};

interface MilestoneTimelineProps {
  milestones: Milestone[];
  onUnlock?: (milestoneId: number) => void;
  unlockingId?: number | null;
}

export function MilestoneTimeline({
  milestones,
  onUnlock,
  unlockingId,
}: MilestoneTimelineProps) {
  return (
    <ol className="space-y-4">
      {milestones.map((milestone, index) => {
        const Icon = statusIcon[milestone.status];
        const canUnlock = milestone.status === "Under Review" && Boolean(onUnlock);
        return (
          <motion.li
            key={milestone.milestoneId}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.06 }}
            className="relative flex gap-4"
          >
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full border bg-slatecard",
                  statusStyles[milestone.status],
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              {index < milestones.length - 1 && (
                <div className="mt-1 w-px flex-1 bg-white/10" />
              )}
            </div>
            <div className="mb-2 flex-1 rounded-2xl border border-white/8 bg-slatecard p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    Milestone {milestone.milestoneId}
                  </p>
                  <p className="mt-1 font-mono text-lg text-white">
                    {formatStroops(milestone.payoutAmount)} USDC
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs",
                    statusStyles[milestone.status],
                  )}
                >
                  {milestone.status}
                </span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
                <div>
                  <dt className="uppercase tracking-wider">Description hash</dt>
                  <dd className="mt-1 break-all font-mono text-slate-200">
                    {milestone.descriptionHash}
                  </dd>
                </div>
                <div>
                  <dt className="uppercase tracking-wider">Proof hash</dt>
                  <dd className="mt-1 break-all font-mono text-slate-200">
                    {milestone.proofHash ?? "Awaiting recipient proof"}
                  </dd>
                </div>
              </dl>
              {canUnlock && (
                <button
                  type="button"
                  onClick={() => onUnlock?.(milestone.milestoneId)}
                  disabled={unlockingId === milestone.milestoneId}
                  className="mt-4 inline-flex items-center gap-2 rounded-full bg-cyan px-4 py-2 text-sm font-medium text-midnight transition hover:opacity-90 disabled:opacity-50"
                >
                  <Unlock className="h-4 w-4" />
                  {unlockingId === milestone.milestoneId ? "Unlocking…" : "Unlock payout"}
                </button>
              )}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

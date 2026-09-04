"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Check, Clock, Eye, FileUp, Lock, Unlock, X } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@astraprotocols/sdk";
import { cn, formatStroops } from "@/lib/utils";

export type EscrowRole = "funder" | "recipient" | "arbitrator";

const statusStyles: Record<MilestoneStatus, string> = {
  Pending: "border-white/10 text-slate-300",
  UnderReview: "border-cyan/40 text-cyan",
  "Under Review": "border-cyan/40 text-cyan",
  Released: "border-emerald/50 text-emerald",
  Disputed: "border-amber-400/50 text-amber-300",
};

const statusIcon: Record<MilestoneStatus, typeof Clock> = {
  Pending: Clock,
  UnderReview: Lock,
  "Under Review": Lock,
  Released: Check,
  Disputed: AlertTriangle,
};

function isUnderReview(status: MilestoneStatus): boolean {
  return status === "Under Review" || status === "UnderReview";
}

interface MilestoneTimelineProps {
  milestones: Milestone[];
  role?: EscrowRole;
  busyId?: number | null;
  onSubmitProof?: (milestoneId: number, proofHash: string) => Promise<void> | void;
  onApprove?: (milestoneId: number) => Promise<void> | void;
  onDispute?: (milestoneId: number) => Promise<void> | void;
}

export function MilestoneTimeline({
  milestones,
  role = "funder",
  busyId,
  onSubmitProof,
  onApprove,
  onDispute,
}: MilestoneTimelineProps) {
  const [inspecting, setInspecting] = useState<Milestone | null>(null);
  const [draftProof, setDraftProof] = useState("");
  const [proofError, setProofError] = useState<string | null>(null);

  const canSubmit = role === "recipient" && Boolean(onSubmitProof);
  const canApprove = (role === "funder" || role === "arbitrator") && Boolean(onApprove);
  const canDispute = (role === "funder" || role === "arbitrator") && Boolean(onDispute);

  const sorted = useMemo(
    () => [...milestones].sort((a, b) => a.milestoneId - b.milestoneId),
    [milestones],
  );

  async function submitProof() {
    if (!inspecting || !onSubmitProof) return;
    const hash = draftProof.replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      setProofError("Proof must be a 32-byte hex hash.");
      return;
    }
    setProofError(null);
    await onSubmitProof(inspecting.milestoneId, hash);
    setInspecting(null);
    setDraftProof("");
  }

  return (
    <>
      <ol className="space-y-4">
        {sorted.map((milestone, index) => {
          const Icon = statusIcon[milestone.status];
          const review = isUnderReview(milestone.status);
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
                {index < sorted.length - 1 && <div className="mt-1 w-px flex-1 bg-white/10" />}
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
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setInspecting(milestone);
                      setDraftProof(milestone.proofHash ?? "");
                      setProofError(null);
                    }}
                    className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-sm"
                  >
                    <Eye className="h-4 w-4" />
                    Verify proof
                  </button>
                  {canSubmit && milestone.status === "Pending" && (
                    <button
                      type="button"
                      onClick={() => {
                        setInspecting(milestone);
                        setDraftProof("");
                      }}
                      className="inline-flex items-center gap-2 rounded-full bg-cyan px-3 py-2 text-sm font-medium text-midnight"
                    >
                      <FileUp className="h-4 w-4" />
                      Submit
                    </button>
                  )}
                  {canApprove && review && (
                    <button
                      type="button"
                      onClick={() => onApprove?.(milestone.milestoneId)}
                      disabled={busyId === milestone.milestoneId}
                      className="inline-flex items-center gap-2 rounded-full bg-cyan px-3 py-2 text-sm font-medium text-midnight disabled:opacity-50"
                    >
                      <Unlock className="h-4 w-4" />
                      {busyId === milestone.milestoneId ? "Approving…" : "Approve"}
                    </button>
                  )}
                  {canDispute && milestone.status !== "Released" && milestone.status !== "Disputed" && (
                    <button
                      type="button"
                      onClick={() => onDispute?.(milestone.milestoneId)}
                      className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 px-3 py-2 text-sm text-amber-200"
                    >
                      <AlertTriangle className="h-4 w-4" />
                      Dispute
                    </button>
                  )}
                </div>
              </div>
            </motion.li>
          );
        })}
      </ol>

      <AnimatePresence>
        {inspecting && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              initial={{ y: 12, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="w-full max-w-lg rounded-3xl border border-white/10 bg-midnight p-6"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-cyan">Proof verification</p>
                  <h3 className="mt-1 text-xl font-semibold">Milestone {inspecting.milestoneId}</h3>
                </div>
                <button type="button" onClick={() => setInspecting(null)} className="rounded-full p-2 hover:bg-white/5">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="mt-4 break-all font-mono text-xs text-slate-400">
                Description {inspecting.descriptionHash}
              </p>
              {canSubmit && inspecting.status === "Pending" ? (
                <label className="mt-4 block text-sm text-slate-300">
                  SHA-256 proof hash
                  <input
                    value={draftProof}
                    onChange={(event) => setDraftProof(event.target.value)}
                    placeholder="64 hex characters"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 font-mono text-sm outline-none focus:border-cyan"
                  />
                </label>
              ) : (
                <p className="mt-4 break-all font-mono text-sm text-slate-200">
                  {inspecting.proofHash ?? "No proof submitted."}
                </p>
              )}
              {proofError && <p className="mt-2 text-xs text-rose-400">{proofError}</p>}
              <div className="mt-6 flex justify-end gap-2">
                {canSubmit && inspecting.status === "Pending" && (
                  <button
                    type="button"
                    onClick={() => void submitProof()}
                    className="rounded-full bg-cyan px-4 py-2 text-sm font-medium text-midnight"
                  >
                    Submit proof
                  </button>
                )}
                {canApprove && isUnderReview(inspecting.status) && (
                  <button
                    type="button"
                    onClick={() => {
                      void onApprove?.(inspecting.milestoneId);
                      setInspecting(null);
                    }}
                    className="rounded-full bg-cyan px-4 py-2 text-sm font-medium text-midnight"
                  >
                    Approve & release
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

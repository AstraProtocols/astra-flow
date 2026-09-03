"use client";

import { useMemo, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Trash2, X } from "lucide-react";
import { useWallet } from "@/components/providers/WalletProvider";
import { cn } from "@/lib/utils";

interface MilestoneDraft {
  id: number;
  description: string;
  amount: string;
}

interface CreateEscrowModalProps {
  open: boolean;
  onClose: () => void;
}

const assets = ["USDC", "XLM"] as const;

export function CreateEscrowModal({ open, onClose }: CreateEscrowModalProps) {
  const { publicKey, network } = useWallet();
  const [recipient, setRecipient] = useState("");
  const [arbitrator, setArbitrator] = useState("");
  const [asset, setAsset] = useState<(typeof assets)[number]>("USDC");
  const [threshold, setThreshold] = useState<1 | 2>(1);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([
    { id: 1, description: "Specification freeze", amount: "150" },
    { id: 2, description: "Implementation complete", amount: "200" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const total = useMemo(
    () =>
      milestones.reduce((sum, item) => sum + Number.parseFloat(item.amount || "0"), 0),
    [milestones],
  );

  function addMilestone() {
    setMilestones((current) => [
      ...current,
      { id: current.length + 1, description: "", amount: "" },
    ]);
  }

  function removeMilestone(id: number) {
    setMilestones((current) => current.filter((item) => item.id !== id));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!publicKey) {
      setMessage("Connect a wallet before creating an escrow.");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    await new Promise((resolve) => setTimeout(resolve, 600));
    setSubmitting(false);
    setMessage(
      `Draft assembled on ${network}: ${milestones.length} milestones, ${total} ${asset}, ${threshold}-of-2 approval. Sign the initialize + allowance transactions in your wallet to deposit.`,
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.form
            onSubmit={onSubmit}
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            className="w-full max-w-2xl rounded-3xl border border-white/10 bg-midnight p-6 shadow-glow"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-cyan">New escrow</p>
                <h2 className="mt-1 text-2xl font-semibold text-white">Configure milestone settlement</h2>
              </div>
              <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-white/5">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-slate-300">
                Recipient
                <input
                  required
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                  placeholder="G..."
                  className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 font-mono text-white outline-none focus:border-cyan"
                />
              </label>
              <label className="text-sm text-slate-300">
                Arbitrator
                <input
                  required
                  value={arbitrator}
                  onChange={(event) => setArbitrator(event.target.value)}
                  placeholder="G..."
                  className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 font-mono text-white outline-none focus:border-cyan"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              {assets.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setAsset(option)}
                  className={cn(
                    "rounded-full border px-4 py-2 text-sm",
                    asset === option
                      ? "border-cyan bg-cyan/10 text-cyan"
                      : "border-white/10 text-slate-300",
                  )}
                >
                  Deposit {option}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setThreshold(threshold === 1 ? 2 : 1)}
                className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-200"
              >
                Multi-sig: {threshold}-of-2 approvals
              </button>
            </div>

            <div className="mt-6 space-y-3">
              {milestones.map((milestone, index) => (
                <div key={milestone.id} className="grid gap-3 rounded-2xl border border-white/8 bg-slatecard p-3 sm:grid-cols-[1fr_140px_auto]">
                  <input
                    required
                    value={milestone.description}
                    onChange={(event) =>
                      setMilestones((current) =>
                        current.map((item) =>
                          item.id === milestone.id
                            ? { ...item, description: event.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder={`Milestone ${index + 1} description`}
                    className="rounded-xl border border-white/10 bg-midnight px-3 py-2 text-sm outline-none focus:border-cyan"
                  />
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.0000001"
                    value={milestone.amount}
                    onChange={(event) =>
                      setMilestones((current) =>
                        current.map((item) =>
                          item.id === milestone.id ? { ...item, amount: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder="Amount"
                    className="rounded-xl border border-white/10 bg-midnight px-3 py-2 font-mono text-sm outline-none focus:border-cyan"
                  />
                  <button
                    type="button"
                    onClick={() => removeMilestone(milestone.id)}
                    disabled={milestones.length === 1}
                    className="inline-flex items-center justify-center rounded-xl border border-white/10 px-3 text-slate-400 hover:text-white disabled:opacity-30"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addMilestone}
                className="inline-flex items-center gap-2 text-sm text-cyan"
              >
                <Plus className="h-4 w-4" />
                Add milestone
              </button>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="font-mono text-sm text-slate-300">
                Total lock: {total.toFixed(2)} {asset}
              </p>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-full bg-cyan px-5 py-2 text-sm font-medium text-midnight disabled:opacity-60"
              >
                {submitting ? "Assembling…" : "Create & deposit"}
              </button>
            </div>
            {message && <p className="mt-4 text-sm text-emerald">{message}</p>}
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

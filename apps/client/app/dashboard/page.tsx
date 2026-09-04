"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Shield, Wallet, Waves } from "lucide-react";
import type { Milestone } from "@astraprotocols/sdk";
import { CreateEscrowModal } from "@/components/escrow/CreateEscrowModal";
import { MilestoneTimeline } from "@/components/escrow/MilestoneTimeline";
import { useWallet } from "@/components/providers/WalletProvider";
import { cn, formatStroops, shortenAddress } from "@/lib/utils";

const demoMilestones: Milestone[] = [
  {
    milestoneId: 1,
    payoutAmount: 150_0000000n,
    descriptionHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    isApproved: true,
    completedAt: 1_700_000_000n,
    proofHash: "c6a1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1",
    status: "Released",
  },
  {
    milestoneId: 2,
    payoutAmount: 150_0000000n,
    descriptionHash: "2c624232cdd221771294dfbb310aca000a0df6ac8b66b696d90ef06fdefb64a3",
    isApproved: false,
    completedAt: 0n,
    proofHash: "ab".repeat(32),
    status: "Under Review",
  },
  {
    milestoneId: 3,
    payoutAmount: 150_0000000n,
    descriptionHash: "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
    isApproved: false,
    completedAt: 0n,
    status: "Pending",
  },
];

const treasurySeries = [
  { label: "Mon", locked: 420 },
  { label: "Tue", locked: 390 },
  { label: "Wed", locked: 455 },
  { label: "Thu", locked: 410 },
  { label: "Fri", locked: 300 },
];

export default function DashboardPage() {
  const { publicKey, network, connector, connecting, error, connect, disconnect, setNetwork } =
    useWallet();
  const [modalOpen, setModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [milestones, setMilestones] = useState(demoMilestones);
  const [role, setRole] = useState<"funder" | "recipient" | "arbitrator">("funder");

  const locked = useMemo(
    () =>
      milestones
        .filter((item) => item.status !== "Released")
        .reduce((sum, item) => sum + item.payoutAmount, 0n),
    [milestones],
  );
  const pendingApprovals = milestones.filter(
    (item) => item.status === "Under Review" || item.status === "UnderReview",
  ).length;

  async function withBusy(milestoneId: number, work: () => void) {
    setBusyId(milestoneId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    work();
    setBusyId(null);
  }

  async function approve(milestoneId: number) {
    await withBusy(milestoneId, () => {
      setMilestones((current) =>
        current.map((item) =>
          item.milestoneId === milestoneId
            ? { ...item, isApproved: true, status: "Released", completedAt: BigInt(Date.now()) }
            : item,
        ),
      );
    });
  }

  async function submitProof(milestoneId: number, proofHash: string) {
    await withBusy(milestoneId, () => {
      setMilestones((current) =>
        current.map((item) =>
          item.milestoneId === milestoneId
            ? { ...item, proofHash, status: "Under Review", submittedAt: BigInt(Date.now()) }
            : item,
        ),
      );
    });
  }

  async function dispute(milestoneId: number) {
    await withBusy(milestoneId, () => {
      setMilestones((current) =>
        current.map((item) =>
          item.status === "Released" || item.milestoneId !== milestoneId
            ? item
            : { ...item, status: "Disputed" },
        ),
      );
    });
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 text-cyan">
          <Waves className="h-5 w-5" />
          <span className="font-semibold tracking-wide">Astra Flow</span>
        </Link>
        <Link href="/analytics" className="text-sm text-slate-400 hover:text-cyan">
          Analytics
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={network}
            onChange={(event) => setNetwork(event.target.value as "testnet" | "mainnet")}
            className="rounded-full border border-white/10 bg-slatecard px-3 py-2 text-sm"
          >
            <option value="testnet">Testnet</option>
            <option value="mainnet">Mainnet</option>
          </select>
          {publicKey ? (
            <button
              type="button"
              onClick={disconnect}
              className="rounded-full border border-white/10 px-4 py-2 font-mono text-sm"
            >
              {shortenAddress(publicKey)} · {connector}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => connect("freighter")}
                disabled={connecting}
                className="rounded-full bg-cyan px-4 py-2 text-sm font-medium text-midnight"
              >
                {connecting ? "Connecting…" : "Freighter"}
              </button>
              <button
                type="button"
                onClick={() => connect("xbull")}
                disabled={connecting}
                className="rounded-full border border-white/15 px-4 py-2 text-sm"
              >
                xBull
              </button>
            </>
          )}
        </div>
      </header>

      {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}

      <section className="mt-10 grid gap-4 md:grid-cols-3">
        {[
          { label: "Active escrows", value: "1", icon: Shield },
          { label: "Pending approvals", value: String(pendingApprovals), icon: Wallet },
          { label: "Locked treasury", value: `${formatStroops(locked)} USDC`, icon: Waves },
        ].map((card) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl border border-white/8 bg-slatecard p-5 shadow-glow"
          >
            <card.icon className="h-4 w-4 text-cyan" />
            <p className="mt-4 text-xs uppercase tracking-[0.18em] text-slate-400">{card.label}</p>
            <p className="mt-2 font-mono text-2xl text-white">{card.value}</p>
          </motion.div>
        ))}
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-3xl border border-white/8 bg-slatecard p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-cyan">Protocol 01</p>
              <h2 className="mt-1 text-xl font-semibold">Design systems escrow</h2>
            </div>
          <div className="flex items-center gap-2">
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as typeof role)}
              className="rounded-full border border-white/10 bg-midnight px-3 py-2 text-sm"
            >
              <option value="funder">Funder</option>
              <option value="recipient">Recipient</option>
              <option value="arbitrator">Arbitrator</option>
            </select>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded-full bg-cyan px-4 py-2 text-sm font-medium text-midnight"
            >
              Create escrow
            </button>
          </div>
          </div>
          <div className="mt-6">
            <MilestoneTimeline
              milestones={milestones}
              role={role}
              busyId={busyId}
              onSubmitProof={submitProof}
              onApprove={approve}
              onDispute={dispute}
            />
          </div>
        </div>

        <div className="rounded-3xl border border-white/8 bg-slatecard p-6">
          <h3 className="text-sm uppercase tracking-[0.18em] text-slate-400">Locked balance</h3>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={treasurySeries}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="label" stroke="#64748b" fontSize={12} />
                <YAxis stroke="#64748b" fontSize={12} />
                <Tooltip
                  contentStyle={{ background: "#0F1622", border: "1px solid rgba(255,255,255,0.1)" }}
                />
                <Area type="monotone" dataKey="locked" stroke="#00F5FF" fill="#00F5FF33" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className={cn("mt-4 text-sm", publicKey ? "text-emerald" : "text-slate-400")}>
            {publicKey
              ? `Indexer bound to ${shortenAddress(publicKey)} on ${network}.`
              : "Connect Freighter or xBull to bind live escrow state."}
          </p>
        </div>
      </section>

      <CreateEscrowModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </main>
  );
}

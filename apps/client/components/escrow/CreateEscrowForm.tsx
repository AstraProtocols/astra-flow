"use client";

import { useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { createAstraFlowClient } from "@astraprotocols/sdk";
import { useWallet } from "@/components/providers/WalletProvider";
import { cn } from "@/lib/utils";

const stellarAccount = z
  .string()
  .regex(/^G[A-Z0-9]{55}$/, "Must be a valid Stellar account (G…)");

const milestoneSchema = z.object({
  description: z.string().min(4, "Describe the deliverable"),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, "Use a decimal amount with up to 7 places"),
});

const escrowSchema = z
  .object({
    recipient: stellarAccount,
    arbitrator: stellarAccount,
    token: z.enum(["USDC", "XLM"]),
    tokenContract: z
      .string()
      .regex(/^C[A-Z0-9]{55}$/, "Must be a Soroban contract id (C…)")
      .or(z.literal("")),
    lockDays: z.coerce.number().int().min(1).max(180),
    threshold: z.coerce.number().int().min(1).max(2),
    milestones: z.array(milestoneSchema).min(1).max(12),
  })
  .superRefine((value, ctx) => {
    if (value.recipient === value.arbitrator) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arbitrator"],
        message: "Arbitrator must be distinct from the recipient",
      });
    }
    const total = value.milestones.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    if (!(total > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["milestones"],
        message: "Total payout must be greater than zero",
      });
    }
  });

export type CreateEscrowValues = z.output<typeof escrowSchema>;
type CreateEscrowInput = z.input<typeof escrowSchema>;

const STEPS = ["Parties", "Asset", "Milestones", "Review"] as const;

interface CreateEscrowFormProps {
  onCreated?: (values: CreateEscrowValues) => void;
}

function toStroops(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const padded = (fraction + "0000000").slice(0, 7);
  return BigInt(whole || "0") * 10_0000000n + BigInt(padded);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function CreateEscrowForm({ onCreated }: CreateEscrowFormProps) {
  const { publicKey, network, networkPassphrase } = useWallet();
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const form = useForm<CreateEscrowInput, unknown, CreateEscrowValues>({
    resolver: zodResolver(escrowSchema),
    defaultValues: {
      recipient: "",
      arbitrator: "",
      token: "USDC",
      tokenContract: "",
      lockDays: 30,
      threshold: 1,
      milestones: [
        { description: "Specification freeze", amount: "150" },
        { description: "Implementation complete", amount: "200" },
      ],
    },
    mode: "onBlur",
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "milestones",
  });

  const values = form.watch();
  const total = useMemo(
    () => values.milestones.reduce((sum, item) => sum + Number.parseFloat(item.amount || "0"), 0),
    [values.milestones],
  );

  async function validateStep(): Promise<boolean> {
    const fieldsByStep: Array<Array<keyof CreateEscrowInput>> = [
      ["recipient", "arbitrator"],
      ["token", "tokenContract", "lockDays", "threshold"],
      ["milestones"],
      [],
    ];
    return form.trigger(fieldsByStep[step]);
  }

  async function onSubmit(data: CreateEscrowValues) {
    if (!publicKey) {
      setMessage("Connect a wallet before creating an escrow.");
      return;
    }
    if (data.recipient === publicKey || data.arbitrator === publicKey) {
      setMessage("Funder must be distinct from recipient and arbitrator.");
      return;
    }

    const tokenAddress =
      data.tokenContract ||
      (network === "testnet"
        ? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
        : data.tokenContract);
    if (!tokenAddress) {
      setMessage("Provide the asset contract id for this network.");
      return;
    }

    const contractId = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID;
    const milestones = await Promise.all(
      data.milestones.map(async (item, index) => ({
        milestoneId: index + 1,
        payoutAmount: toStroops(item.amount),
        descriptionHash: await sha256Hex(`${index + 1}:${item.description}`),
      })),
    );

    if (contractId) {
      const client = createAstraFlowClient({ contractId, network });
      const xdr = await client.initializeEscrow(publicKey, {
        funder: publicKey,
        recipient: data.recipient,
        arbitrator: data.arbitrator,
        token: tokenAddress,
        milestones,
      });
      setMessage(
        `Initialize assembled (${xdr.slice(0, 24)}…) on ${networkPassphrase.split(";")[0]?.trim()}. Sign it in your wallet to lock ${total.toFixed(2)} ${data.token}.`,
      );
    } else {
      setMessage(
        `Draft ready: ${milestones.length} milestones, ${total.toFixed(2)} ${data.token}, ${data.threshold}-of-2, ${data.lockDays}-day lock. Set NEXT_PUBLIC_ESCROW_CONTRACT_ID to submit on-chain.`,
      );
    }
    onCreated?.(data);
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      <ol className="flex gap-2 text-xs uppercase tracking-[0.16em] text-slate-400">
        {STEPS.map((label, index) => (
          <li
            key={label}
            className={cn(
              "rounded-full px-3 py-1",
              index === step ? "bg-cyan/15 text-cyan" : "bg-white/5",
            )}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm text-slate-300">
            Recipient
            <input
              {...form.register("recipient")}
              placeholder="G..."
              className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 font-mono text-white outline-none focus:border-cyan"
            />
            {form.formState.errors.recipient && (
              <p className="mt-1 text-xs text-rose-400">{form.formState.errors.recipient.message}</p>
            )}
          </label>
          <label className="text-sm text-slate-300">
            Arbitrator
            <input
              {...form.register("arbitrator")}
              placeholder="G..."
              className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 font-mono text-white outline-none focus:border-cyan"
            />
            {form.formState.errors.arbitrator && (
              <p className="mt-1 text-xs text-rose-400">{form.formState.errors.arbitrator.message}</p>
            )}
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(["USDC", "XLM"] as const).map((token) => (
              <button
                key={token}
                type="button"
                onClick={() => form.setValue("token", token)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm",
                  values.token === token
                    ? "border-cyan bg-cyan/10 text-cyan"
                    : "border-white/10 text-slate-300",
                )}
              >
                {token}
              </button>
            ))}
          </div>
          <label className="block text-sm text-slate-300">
            Token contract (required on mainnet)
            <input
              {...form.register("tokenContract")}
              placeholder="C..."
              className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 font-mono text-white outline-none focus:border-cyan"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-slate-300">
              Proof lock window (days)
              <input
                type="number"
                min={1}
                max={180}
                {...form.register("lockDays")}
                className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 outline-none focus:border-cyan"
              />
            </label>
            <label className="text-sm text-slate-300">
              Approval threshold
              <select
                {...form.register("threshold")}
                className="mt-2 w-full rounded-xl border border-white/10 bg-slatecard px-3 py-2 outline-none focus:border-cyan"
              >
                <option value={1}>1-of-2 (funder or arbitrator)</option>
                <option value={2}>2-of-2 multi-sig</option>
              </select>
            </label>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div
              key={field.id}
              className="grid gap-3 rounded-2xl border border-white/8 bg-slatecard p-3 sm:grid-cols-[1fr_140px_auto]"
            >
              <input
                {...form.register(`milestones.${index}.description`)}
                placeholder={`Milestone ${index + 1} description`}
                className="rounded-xl border border-white/10 bg-midnight px-3 py-2 text-sm outline-none focus:border-cyan"
              />
              <input
                {...form.register(`milestones.${index}.amount`)}
                placeholder="Amount"
                className="rounded-xl border border-white/10 bg-midnight px-3 py-2 font-mono text-sm outline-none focus:border-cyan"
              />
              <button
                type="button"
                onClick={() => remove(index)}
                disabled={fields.length === 1}
                className="inline-flex items-center justify-center rounded-xl border border-white/10 px-3 text-slate-400 hover:text-white disabled:opacity-30"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {form.formState.errors.milestones && (
            <p className="text-xs text-rose-400">
              {form.formState.errors.milestones.message ?? "Check milestone amounts."}
            </p>
          )}
          <button
            type="button"
            onClick={() => append({ description: "", amount: "" })}
            className="inline-flex items-center gap-2 text-sm text-cyan"
          >
            <Plus className="h-4 w-4" />
            Add milestone
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3 rounded-2xl border border-white/8 bg-slatecard p-4 text-sm text-slate-300">
          <p>Recipient: <span className="font-mono text-white">{values.recipient}</span></p>
          <p>Arbitrator: <span className="font-mono text-white">{values.arbitrator}</span></p>
          <p>
            Asset: {values.token} · {String(values.threshold)}-of-2 · {String(values.lockDays)} day lock
          </p>
          <ul className="space-y-1">
            {values.milestones.map((item, index) => (
              <li key={`${item.description}-${index}`}>
                M{index + 1}: {item.description} — {item.amount} {values.token}
              </li>
            ))}
          </ul>
          <p className="font-mono text-cyan">Total lock {total.toFixed(2)} {values.token}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          disabled={step === 0}
          className="inline-flex items-center gap-1 rounded-full border border-white/10 px-4 py-2 text-sm disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            onClick={async () => {
              if (await validateStep()) setStep((current) => current + 1);
            }}
            className="inline-flex items-center gap-1 rounded-full bg-cyan px-4 py-2 text-sm font-medium text-midnight"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={form.formState.isSubmitting}
            className="rounded-full bg-cyan px-5 py-2 text-sm font-medium text-midnight disabled:opacity-60"
          >
            {form.formState.isSubmitting ? "Assembling…" : "Create & deposit"}
          </button>
        )}
      </div>
      {message && <p className="text-sm text-emerald">{message}</p>}
    </form>
  );
}

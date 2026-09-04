import { Router } from "express";
import { createEscrowClient } from "@astraprotocols/sdk";
import { loadEnv } from "../lib/env.js";
import { extractMergedPullRequest } from "../services/github.js";
import { recordProof } from "../services/escrow-indexer.js";

export const githubWebhookRouter = Router();

githubWebhookRouter.post("/github", (req, res) => {
  const env = loadEnv();
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));

  const eventName = req.header("x-github-event") ?? "unknown";
  const payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody.toString("utf8")) : req.body;
  const merged = eventName === "pull_request" ? extractMergedPullRequest(payload) : null;

  if (!merged) {
    res.status(202).json({ accepted: true, handled: false, eventName });
    return;
  }

  const proofHash = (merged.sha ?? "").padEnd(64, "0").slice(0, 64);
  const escrow = recordProof(merged.author, 1, proofHash);

  let invocation = null;
  if (env.ESCROW_CONTRACT_ID) {
    const client = createEscrowClient({
      contractId: env.ESCROW_CONTRACT_ID,
      network: env.STELLAR_NETWORK,
      rpcUrl: env.SOROBAN_RPC_URL,
    });
    invocation = client.submitMilestoneProof(1, proofHash);
  }

  res.status(202).json({
    accepted: true,
    handled: true,
    eventName,
    merge: merged,
    proof: {
      milestoneId: 1,
      proofHash,
      escrowAddress: escrow.address,
    },
    contractInvocation: invocation
      ? { method: invocation.method, contractId: invocation.contractId }
      : null,
  });
});

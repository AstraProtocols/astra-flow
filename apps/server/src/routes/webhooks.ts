import { Router } from "express";
import { createEscrowClient } from "@astraprotocols/sdk";
import { loadEnv } from "../lib/env.js";
import {
  extractMergedPullRequest,
  mapMergedCommitToEscrowTask,
  type GitHubPullRequestEvent,
} from "../services/github.js";
import { recordProof } from "../services/escrow-indexer.js";

export const githubWebhookRouter = Router();

function parsePayload(req: { body: unknown }): GitHubPullRequestEvent {
  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8")) as GitHubPullRequestEvent;
  }
  if (typeof req.body === "string") {
    return JSON.parse(req.body) as GitHubPullRequestEvent;
  }
  return (req.body ?? {}) as GitHubPullRequestEvent;
}

githubWebhookRouter.post("/github", (req, res) => {
  const env = loadEnv();
  const eventName = req.header("x-github-event") ?? "unknown";
  const delivery = req.header("x-github-delivery");

  if (eventName === "ping") {
    res.status(202).json({ accepted: true, handled: false, eventName, delivery });
    return;
  }

  if (eventName !== "pull_request") {
    res.status(202).json({ accepted: true, handled: false, eventName, delivery });
    return;
  }

  let payload: GitHubPullRequestEvent;
  try {
    payload = parsePayload(req);
  } catch {
    res.status(400).json({ error: "malformed GitHub JSON payload" });
    return;
  }

  const merged = extractMergedPullRequest(payload);
  if (!merged) {
    res.status(202).json({
      accepted: true,
      handled: false,
      eventName,
      delivery,
      reason: payload.action === "closed" ? "pull request was not merged" : "ignored action",
      action: payload.action,
    });
    return;
  }

  const task = mapMergedCommitToEscrowTask(merged, env.ESCROW_CONTRACT_ID);
  if (!task) {
    res.status(202).json({
      accepted: true,
      handled: false,
      eventName,
      delivery,
      merge: merged,
      reason: "no escrow id in PR metadata and ESCROW_CONTRACT_ID is unset",
    });
    return;
  }

  const escrow = recordProof(task.escrowId, task.milestoneId, task.proofHash);

  let invocation: { method: string; contractId: string; milestoneId: number } | null = null;
  if (task.escrowId.startsWith("C")) {
    const client = createEscrowClient({
      contractId: task.escrowId,
      network: env.STELLAR_NETWORK,
      rpcUrl: env.SOROBAN_RPC_URL,
    });
    const built = client.submitMilestoneProof(task.milestoneId, task.proofHash);
    invocation = {
      method: built.method,
      contractId: built.contractId,
      milestoneId: task.milestoneId,
    };
  }

  res.status(202).json({
    accepted: true,
    handled: true,
    eventName,
    delivery,
    merge: merged,
    task,
    proof: {
      milestoneId: task.milestoneId,
      proofHash: task.proofHash,
      escrowAddress: escrow.address,
    },
    contractInvocation: invocation,
  });
});

import { Router } from "express";
import { createEscrowClient } from "@astraprotocols/sdk";
import { loadEnv } from "../lib/env.js";
import { attestationSchema, verifyAttestation } from "../services/attestation.js";

export const attestationRouter = Router();

attestationRouter.post("/verify", (req, res) => {
  const parsed = attestationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid attestation payload", details: parsed.error.flatten() });
    return;
  }

  const verification = verifyAttestation(parsed.data);
  if (!verification.valid || !verification.thresholdMet) {
    res.status(422).json({
      valid: false,
      verification,
    });
    return;
  }

  const env = loadEnv();
  let approvalTx = null;
  if (env.ESCROW_CONTRACT_ID) {
    const client = createEscrowClient({
      contractId: env.ESCROW_CONTRACT_ID,
      network: env.STELLAR_NETWORK,
      rpcUrl: env.SOROBAN_RPC_URL,
    });
    approvalTx = client.approveMilestone(parsed.data.milestoneId);
  }

  res.json({
    valid: true,
    verification,
    approval: approvalTx
      ? {
          method: approvalTx.method,
          contractId: approvalTx.contractId,
          milestoneId: parsed.data.milestoneId,
        }
      : {
          queued: true,
          reason: "ESCROW_CONTRACT_ID is not configured; attestation accepted without broadcast",
        },
  });
});

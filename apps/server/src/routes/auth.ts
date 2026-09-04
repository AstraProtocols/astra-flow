import { Router } from "express";
import { z } from "zod";
import {
  issueStellarChallenge,
  requireStellarChallengeBody,
} from "../middleware/auth.js";

const challengeQuery = z.object({
  publicKey: z.string().startsWith("G").min(56),
});

export const authRouter = Router();

authRouter.get("/challenge", (req, res) => {
  const parsed = challengeQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "valid Stellar publicKey query param is required" });
    return;
  }
  try {
    const challenge = issueStellarChallenge(parsed.data.publicKey);
    res.json({
      publicKey: challenge.publicKey,
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
    });
  } catch (cause) {
    res.status(400).json({
      error: cause instanceof Error ? cause.message : "unable to issue challenge",
    });
  }
});

authRouter.post("/verify", requireStellarChallengeBody, (req, res) => {
  res.json({
    ok: true,
    publicKey: req.stellarPublicKey,
  });
});

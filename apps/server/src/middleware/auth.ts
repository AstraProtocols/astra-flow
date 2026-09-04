import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { loadEnv } from "../lib/env.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 2_048;

export interface StellarChallenge {
  publicKey: string;
  nonce: string;
  message: string;
  expiresAt: number;
}

interface ChallengeRecord extends StellarChallenge {
  consumed: boolean;
}

const challenges = new Map<string, ChallengeRecord>();

function pruneChallenges(now = Date.now()): void {
  for (const [key, record] of challenges) {
    if (record.consumed || record.expiresAt <= now) {
      challenges.delete(key);
    }
  }
  if (challenges.size <= MAX_CHALLENGES) return;
  const overflow = [...challenges.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, challenges.size - MAX_CHALLENGES);
  for (const [key] of overflow) {
    challenges.delete(key);
  }
}

function asRawBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  return Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
}

/**
 * Constant-time HMAC-SHA256 check for GitHub's `X-Hub-Signature-256` header.
 */
export function verifyGitHubHmac(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const receivedHex = signatureHeader.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]+$/.test(receivedHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}

export function githubWebhookAuth(req: Request, res: Response, next: NextFunction): void {
  const env = loadEnv();
  const rawBody = asRawBody(req);
  const signature = req.header("x-hub-signature-256");
  if (!verifyGitHubHmac(rawBody, signature, env.GITHUB_WEBHOOK_SECRET)) {
    res.status(401).json({ error: "invalid GitHub signature" });
    return;
  }
  next();
}

export function issueStellarChallenge(publicKey: string): StellarChallenge {
  try {
    Keypair.fromPublicKey(publicKey);
  } catch {
    throw new Error("invalid Stellar public key");
  }

  pruneChallenges();
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const message = [
    "Astra Flow wallet challenge",
    `network=${loadEnv().STELLAR_NETWORK}`,
    `key=${publicKey}`,
    `nonce=${nonce}`,
    `exp=${expiresAt}`,
  ].join("\n");

  const record: ChallengeRecord = {
    publicKey,
    nonce,
    message,
    expiresAt,
    consumed: false,
  };
  challenges.set(`${publicKey}:${nonce}`, record);
  return { publicKey, nonce, message, expiresAt };
}

function decodeSignature(signature: string): Buffer {
  const compact = signature.trim();
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) {
    return Buffer.from(compact, "hex");
  }
  return Buffer.from(compact, "base64");
}

/**
 * Verify an ed25519 signature over a previously issued challenge message.
 * Accepts hex or standard base64 encodings used by Freighter and xBull.
 */
export function verifyStellarChallenge(
  publicKey: string,
  nonce: string,
  signature: string,
): { valid: boolean; error?: string } {
  pruneChallenges();
  const record = challenges.get(`${publicKey}:${nonce}`);
  if (!record || record.consumed) {
    return { valid: false, error: "unknown or consumed challenge" };
  }
  if (record.expiresAt <= Date.now()) {
    challenges.delete(`${publicKey}:${nonce}`);
    return { valid: false, error: "challenge expired" };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(publicKey);
  } catch {
    return { valid: false, error: "invalid Stellar public key" };
  }

  let sig: Buffer;
  try {
    sig = decodeSignature(signature);
  } catch {
    return { valid: false, error: "malformed signature encoding" };
  }
  if (sig.length !== 64) {
    return { valid: false, error: "signature must be 64 bytes" };
  }

  const message = Buffer.from(record.message, "utf8");
  const valid = keypair.verify(message, sig);
  if (!valid) {
    return { valid: false, error: "signature does not match challenge" };
  }

  record.consumed = true;
  challenges.delete(`${publicKey}:${nonce}`);
  return { valid: true };
}

declare global {
  namespace Express {
    interface Request {
      stellarPublicKey?: string;
    }
  }
}

/**
 * Bearer-style Stellar auth: `Authorization: Stellar <publicKey>.<nonce>.<signature>`.
 */
export function stellarAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Stellar\s+([^.\s]+)\.([^.\s]+)\.(\S+)$/.exec(header);
  if (!match) {
    res.status(401).json({ error: "missing Stellar authorization" });
    return;
  }
  const [, publicKey, nonce, signature] = match;
  const result = verifyStellarChallenge(publicKey, nonce, signature);
  if (!result.valid) {
    res.status(401).json({ error: result.error ?? "unauthorized" });
    return;
  }
  req.stellarPublicKey = publicKey;
  next();
}

export function requireStellarChallengeBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const publicKey = typeof req.body?.publicKey === "string" ? req.body.publicKey : "";
  const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
  const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
  if (!publicKey || !nonce || !signature) {
    res.status(400).json({ error: "publicKey, nonce, and signature are required" });
    return;
  }
  const result = verifyStellarChallenge(publicKey, nonce, signature);
  if (!result.valid) {
    res.status(401).json({ error: result.error ?? "unauthorized" });
    return;
  }
  req.stellarPublicKey = publicKey;
  next();
}

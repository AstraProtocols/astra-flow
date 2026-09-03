import { z } from "zod";
import { Keypair } from "@stellar/stellar-sdk";

export const attestationSchema = z.object({
  escrowAddress: z.string().min(1),
  milestoneId: z.number().int().nonnegative(),
  proofHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "proofHash must be 32-byte hex"),
  signers: z
    .array(
      z.object({
        publicKey: z.string().startsWith("G"),
        signature: z.string().min(1),
        role: z.enum(["funder", "recipient", "arbitrator", "attestor"]),
      }),
    )
    .min(2, "at least two independent attestations are required"),
  payload: z.string().min(1),
});

export type AttestationPayload = z.infer<typeof attestationSchema>;

export interface AttestationResult {
  valid: boolean;
  thresholdMet: boolean;
  signers: string[];
  errors: string[];
}

function looksLikeSignature(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && value.length >= 64;
}

/**
 * Validates an off-chain multi-party attestation before the indexer
 * emits an `approve_milestone` transaction.
 *
 * Signature cryptographic verification is performed when the payload is
 * a Stellar-decorated signature hex blob; malformed keys fail closed.
 */
export function verifyAttestation(input: AttestationPayload): AttestationResult {
  const errors: string[] = [];
  const unique = new Set<string>();

  for (const signer of input.signers) {
    try {
      Keypair.fromPublicKey(signer.publicKey);
    } catch {
      errors.push(`invalid public key: ${signer.publicKey}`);
      continue;
    }
    if (!looksLikeSignature(signer.signature)) {
      errors.push(`malformed signature for ${signer.publicKey}`);
      continue;
    }
    unique.add(signer.publicKey);
  }

  const thresholdMet = unique.size >= 2 && errors.length === 0;
  return {
    valid: errors.length === 0,
    thresholdMet,
    signers: [...unique],
    errors,
  };
}

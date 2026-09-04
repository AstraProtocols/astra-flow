import { createHash } from "node:crypto";
import { verifyGitHubHmac } from "../middleware/auth.js";

export interface GitHubLabel {
  name: string;
}

export interface GitHubPullRequestEvent {
  action: string;
  repository: { full_name: string; html_url?: string };
  pull_request?: {
    merged: boolean;
    merge_commit_sha: string | null;
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    labels?: GitHubLabel[];
    base?: { ref: string };
    head?: { sha: string; ref: string };
  };
}

export interface MergedPullRequest {
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  sha: string;
  author: string;
  url: string;
  labels: string[];
  baseRef?: string;
}

export interface EscrowMilestoneMeta {
  escrowId: string | null;
  milestoneId: number;
  recipientHint: string | null;
}

export interface PendingEscrowTask {
  escrowId: string;
  milestoneId: number;
  proofHash: string;
  repo: string;
  prNumber: number;
  mergeSha: string;
  author: string;
  title: string;
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  return verifyGitHubHmac(rawBody, signatureHeader, secret);
}

export function extractMergedPullRequest(event: GitHubPullRequestEvent): MergedPullRequest | null {
  if (event.action !== "closed" || !event.pull_request?.merged) {
    return null;
  }
  const pr = event.pull_request;
  const sha = pr.merge_commit_sha ?? pr.head?.sha ?? "";
  if (!sha) {
    return null;
  }
  return {
    repo: event.repository.full_name,
    prNumber: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    sha,
    author: pr.user.login,
    url: pr.html_url,
    labels: (pr.labels ?? []).map((label) => label.name),
    baseRef: pr.base?.ref,
  };
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseEscrowId(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^C[A-Z0-9]{55}$/.test(trimmed)) return trimmed;
  if (/^G[A-Z0-9]{55}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Extract escrow + milestone coordinates from PR labels, body, and title.
 * Supported forms:
 *   labels: `milestone:2`, `astra-milestone:2`, `escrow:C...`
 *   body:   `astra-escrow: C...` / `astra-milestone: 2` / YAML `escrow:` / `milestone:`
 *   title:  `[M2]`, `milestone-2`
 */
export function parsePrMilestoneMetadata(merged: MergedPullRequest): EscrowMilestoneMeta {
  let escrowId: string | null = null;
  let milestoneId: number | null = null;
  let recipientHint: string | null = null;

  for (const label of merged.labels) {
    const milestoneMatch = /^(?:astra-)?milestone[:/-](\d+)$/i.exec(label.trim());
    if (milestoneMatch) {
      milestoneId = parseNumber(milestoneMatch[1]) ?? milestoneId;
    }
    const escrowMatch = /^(?:astra-)?escrow[:/-](.+)$/i.exec(label.trim());
    if (escrowMatch) {
      escrowId = parseEscrowId(escrowMatch[1]) ?? escrowId;
    }
  }

  const body = merged.body;
  const yamlEscrow = /(?:^|\n)\s*(?:astra-)?escrow\s*[:=]\s*([A-Z0-9]+)/i.exec(body);
  const yamlMilestone = /(?:^|\n)\s*(?:astra-)?milestone\s*[:=]\s*(\d+)/i.exec(body);
  const yamlRecipient = /(?:^|\n)\s*(?:astra-)?recipient\s*[:=]\s*(G[A-Z0-9]{55})/i.exec(body);
  escrowId = parseEscrowId(yamlEscrow?.[1]) ?? escrowId;
  milestoneId = parseNumber(yamlMilestone?.[1]) ?? milestoneId;
  recipientHint = yamlRecipient?.[1] ?? recipientHint;

  const titleMilestone =
    /\[M(\d+)\]/i.exec(merged.title) ?? /milestone[-_ ](\d+)/i.exec(merged.title);
  milestoneId = parseNumber(titleMilestone?.[1]) ?? milestoneId;

  return {
    escrowId,
    milestoneId: milestoneId ?? 1,
    recipientHint,
  };
}

export function commitShaToProofHash(sha: string): string {
  const normalized = sha.replace(/^0x/, "").toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function mapMergedCommitToEscrowTask(
  merged: MergedPullRequest,
  fallbackEscrowId?: string,
): PendingEscrowTask | null {
  const meta = parsePrMilestoneMetadata(merged);
  const escrowId = meta.escrowId ?? fallbackEscrowId ?? null;
  if (!escrowId) {
    return null;
  }
  return {
    escrowId,
    milestoneId: meta.milestoneId,
    proofHash: commitShaToProofHash(merged.sha),
    repo: merged.repo,
    prNumber: merged.prNumber,
    mergeSha: merged.sha,
    author: merged.author,
    title: merged.title,
  };
}

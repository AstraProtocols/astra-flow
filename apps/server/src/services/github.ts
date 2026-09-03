import { createHmac, timingSafeEqual } from "node:crypto";

export interface GitHubPullRequestEvent {
  action: string;
  repository: { full_name: string };
  pull_request?: {
    merged: boolean;
    merge_commit_sha: string | null;
    number: number;
    title: string;
    html_url: string;
    user: { login: string };
  };
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function extractMergedPullRequest(event: GitHubPullRequestEvent) {
  if (event.action !== "closed" || !event.pull_request?.merged) {
    return null;
  }
  return {
    repo: event.repository.full_name,
    prNumber: event.pull_request.number,
    title: event.pull_request.title,
    sha: event.pull_request.merge_commit_sha,
    author: event.pull_request.user.login,
    url: event.pull_request.html_url,
  };
}

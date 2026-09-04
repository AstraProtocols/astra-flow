import { verifyGitHubHmac } from "../middleware/auth.js";

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
  return verifyGitHubHmac(rawBody, signatureHeader, secret);
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

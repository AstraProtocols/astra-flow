# Contributing to Astra Flow

Astra Flow is an open-source product of **AstraProtocols**. This document is the working contract for contributors: how to set up, how to change code, and how we review it.

## Code of conduct

Be precise, kind, and direct. Disagreement belongs in the review, not in the person. Do not submit secrets, mainnet keys, or production webhook credentials.

## First-time setup

1. Install Node 20+, Rust stable, and the Stellar CLI.
2. `rustup target add wasm32v1-none wasm32-unknown-unknown`
3. `npm install`
4. `cp .env.example .env`
5. `cargo test -p escrow` — confirms the Soroban toolchain.
6. `npm run dev` — client at http://localhost:3000, indexer at http://localhost:4000.

EditorConfig is already defined at the repo root (2-space JS/TS, 4-space Rust, LF, UTF-8).

## Branching and pull requests

- Branch from `main` as `feat/…`, `fix/…`, or `docs/…`.
- Keep PRs small enough to review in one sitting. Contract changes should not land in the same PR as unrelated dashboard chrome.
- Describe the *why*, the auth model if the contract ABI moved, and how you tested.
- Do not force-push shared branches.

Suggested commit style (imperative, scoped):

```
feat(escrow): lock unreleased funds on dispute
fix(indexer): reject GitHub webhooks with bad HMAC
docs(readme): add testnet deploy steps
```

## Workspace map

| Change in | Also check |
| --- | --- |
| `contracts/escrow` | `cargo test -p escrow`, `stellar contract build`, SDK types |
| `packages/sdk` | client + server still typecheck |
| `apps/server` | webhook signature tests / curl the three routes |
| `apps/client` | dashboard, modal, wallet connect, milestone stepper |

## Smart contracts

- `#![no_std]`, `panic = "abort"` in release, `overflow-checks = true`.
- Public functions keep the names in `contracts/escrow/src/lib.rs`. Do not silently rename on-chain methods.
- Auth is explicit: `Address::require_auth()` on the party named in the function docs.
- Token movement uses the SEP-41 `token::Client` (`transfer` / `transfer_from`). Never mint from the escrow crate.
- Add or extend tests in `contracts/escrow/src/test.rs` with `env.mock_all_auths()` and a registered Stellar Asset Contract.

Build:

```bash
stellar contract build
# or
cargo build --target wasm32v1-none --release
cargo build --target wasm32-unknown-unknown --release
```

## TypeScript

- Strict TypeScript. Prefer named exports from `@astraprotocols/sdk`.
- The SDK is the only place that should speak ScVal / XDR. Apps consume plain objects.
- Server routes validate with Zod and fail closed (401/422) on bad signatures or attestations.
- Client components that touch wallets or charts are `"use client"`.

```bash
npm run lint
npm run build
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Turbo parallel `dev` |
| `npm run dev:concurrent` | Concurrently SDK + server + client |
| `npm run build:contracts` | `stellar contract build` |
| `npm run deploy:testnet` | `tools/scripts/deploy-testnet.sh` |
| `npm run seed:milestone` | Local escrow lifecycle printout |

## Security

- Never commit `.env`, identities, or funded secret keys.
- GitHub webhooks must verify `X-Hub-Signature-256` whenever `GITHUB_WEBHOOK_SECRET` is not the dev default.
- Treat arbitrator keys as high-value. Document any auth-model change in the PR body.

## Review checklist

- [ ] Tests or a documented manual path for the change
- [ ] Contract ABI / SDK types stay aligned
- [ ] No secrets in the diff
- [ ] README / this file updated if the contributor workflow changed

Thank you for helping settle work on Stellar without trusting a custodian.

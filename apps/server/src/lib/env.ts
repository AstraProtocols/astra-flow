import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  CLIENT_ORIGIN: z.string().default("http://localhost:3000"),
  GITHUB_WEBHOOK_SECRET: z.string().default("dev-webhook-secret"),
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  ESCROW_CONTRACT_ID: z.string().optional(),
  SOROBAN_RPC_URL: z.string().optional(),
  INDEXER_DB_PATH: z.string().default(":memory:"),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(4_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

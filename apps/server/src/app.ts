import cors from "cors";
import express from "express";
import helmet from "helmet";
import { loadEnv } from "./lib/env.js";
import { githubWebhookAuth } from "./middleware/auth.js";
import { attestationRouter } from "./routes/attestation.js";
import { authRouter } from "./routes/auth.js";
import { escrowRouter } from "./routes/escrows.js";
import { githubWebhookRouter } from "./routes/webhooks.js";

export function createApp() {
  const env = loadEnv();
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      methods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.use(
    "/api/webhooks",
    express.raw({ type: "application/json" }),
    githubWebhookAuth,
    githubWebhookRouter,
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "astra-flow-indexer" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/escrows", escrowRouter);
  app.use("/api/attestation", attestationRouter);

  return app;
}

import "dotenv/config";
import { createApp } from "./app.js";
import { loadEnv } from "./lib/env.js";
import { startIndexer } from "./services/indexer.js";

const env = loadEnv();
const app = createApp();

app.listen(env.PORT, env.HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Astra Flow indexer listening on http://${env.HOST}:${env.PORT}`);
  void startIndexer().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("indexer failed to start", error);
  });
});

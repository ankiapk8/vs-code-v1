import app from "./app";
import { logger } from "./lib/logger";
import { ensureDatabaseSchema } from "@workspace/db";
import { autoConfigureFromEnv } from "./lib/apk-builder";

const rawPort = process.env["PORT"] || "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main(): Promise<void> {
  // Start listening immediately so Render/Railway see the app as "Healthy"
  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    
    // Run database and APK config in the background
    (async () => {
      try {
        await ensureDatabaseSchema();
        logger.info("Database schema verified");
        autoConfigureFromEnv();
      } catch (err) {
        logger.error({ err }, "Background initialization failed");
      }
    })();
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

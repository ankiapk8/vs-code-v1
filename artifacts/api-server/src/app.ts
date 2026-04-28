import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));

app.use("/api", router);

// Serve static files from the frontend build
const clientDist = path.join(__dirname, "../../../anki-generator/dist/public");
app.use(express.static(clientDist));

// Fallback for SPA routing
app.get("*", (req, res) => {
  if (req.url.startsWith("/api")) {
    res.status(404).json({ error: "API route not found" });
    return;
  }
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) {
      res.status(404).send("Frontend not built or index.html missing");
    }
  });
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error({ err, url: req.url, method: req.method }, "Unhandled error");
  if (!res.headersSent) {
    res.status(500).json({ error: message });
  }
});

export default app;

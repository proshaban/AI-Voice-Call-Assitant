import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { callsRouter } from "./routes/calls.routes.js";
import { leadsRouter } from "./routes/leads.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  // Vobiz/Twilio webhooks post form-urlencoded data
  app.use(express.urlencoded({ extended: true }));
  // Local browser test page (test.html)
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/calls", callsRouter);
  app.use("/api/leads", leadsRouter);

  return app;
}

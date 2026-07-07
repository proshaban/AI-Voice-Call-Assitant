import express from "express";
import cors from "cors";
import { callsRouter } from "./routes/calls.routes.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  // Twilio's status webhook posts form-urlencoded data
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/calls", callsRouter);

  return app;
}

import "dotenv/config";
import { createServer } from "http";
import { parse } from "url";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { handleMediaStream } from "./lib/callSession.js";
import { handleMonitorStream } from "./lib/monitorSession.js";
import { startDialer } from "./lib/dialer.js";

const port = parseInt(process.env.PORT || "3000", 10);

const app = createApp();
const server = createServer(app);

// Express handles all normal HTTP routes. Two paths need a persistent
// WebSocket, so we intercept the "upgrade" event ourselves:
//   /api/calls/stream  — Vobiz/Twilio media stream (real phone calls)
//   /api/calls/monitor — browser mic test sessions (local testing, ?leadId=)
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parse(req.url || "", true);

  if (pathname === "/api/calls/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("[server] Media stream connected");
      handleMediaStream(ws);
    });
  } else if (pathname === "/api/calls/monitor") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const leadId = typeof query.leadId === "string" ? query.leadId : "";
      if (!leadId) {
        ws.send(JSON.stringify({ type: "error", message: "leadId query param required" }));
        ws.close();
        return;
      }
      handleMonitorStream(ws, leadId);
    });
  } else {
    socket.destroy();
  }
});

server.listen(port, () => {
  console.log(`> Listening on http://localhost:${port}`);
  console.log(`> Local test page: http://localhost:${port}/test.html`);
  startDialer();
});

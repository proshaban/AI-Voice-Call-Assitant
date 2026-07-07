import "dotenv/config";
import { createServer } from "http";
import { parse } from "url";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { handleTwilioStream } from "./lib/callSession.js";

const port = parseInt(process.env.PORT || "3000", 10);

const app = createApp();
const server = createServer(app);

// Express handles all normal HTTP routes. Twilio's Media Stream needs a
// persistent WebSocket though, so we intercept the "upgrade" event
// ourselves for the one path that needs it: /api/calls/stream.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "", true);

  if (pathname === "/api/calls/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("[server] Twilio media stream connected");
      handleTwilioStream(ws);
    });
  } else {
    socket.destroy();
  }
});

server.listen(port, () => {
  console.log(`> Listening on http://localhost:${port}`);
});

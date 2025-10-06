import { WebSocketServer, WebSocket } from "ws";
import { supabase } from "./supabase.js"; // ✅ Add this import to listen to DB changes

interface ProgressMessage {
  userId: string;
  type:
    | "progress"
    | "status"
    | "complete"
    | "error"
    | "new_email"
    | "push_test_complete"
    | "event_created"
    | "event_updated"
    | "event_deleted";
  data: any;
}

// store clients per userId
const clients = new Map<string, Set<WebSocket>>();

export function setupWebSocket(wss: WebSocketServer) {
  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const userId = url.searchParams.get("userId") || "";

    if (!userId) {
      console.warn("⚠️ WS rejected: missing userId");
      ws.close(1008, "Missing userId");
      return;
    }

    if (!clients.has(userId)) {
      clients.set(userId, new Set());
    }
    clients.get(userId)!.add(ws);

    console.log(`✅ WS connected [user=${userId}] (clients=${clients.size})`);

    ws.on("close", (code) => {
      clients.get(userId)?.delete(ws);
      if (clients.get(userId)?.size === 0) {
        clients.delete(userId);
      }
      console.log(`❌ WS closed [user=${userId}, code=${code}]`);
    });

    ws.on("error", (err) => {
      console.error(`🔥 WS error [user=${userId}]:`, err.message || err);
    });
  });

  // ✅ Listen to Supabase realtime changes on "emails" table
  supabase
    .channel("emails_changes")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "emails" },
      (payload) => {
        const newEmail = payload.new;
        console.log("📩 Detected new email (Supabase realtime):", newEmail);

        // 🔔 Notify all connected WS clients for this user
        const userClients = clients.get(newEmail.user_id);
        if (userClients) {
          userClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  userId: newEmail.user_id,
                  type: "new_email",
                  data: newEmail,
                })
              );
            }
          });
        }
      }
    )
    .subscribe();

  console.log("📡 WebSocket + Supabase realtime listener ready ✅");
}

// ✅ Reusable manual sender (used by Gmail Push & others)
export function sendProgressUpdate(message: ProgressMessage) {
  const userClients = clients.get(message.userId);

  if (!userClients || userClients.size === 0) {
    console.log(`🚫 No WS clients [user=${message.userId}]`);
    return;
  }

  console.log(`📤 WS -> user=${message.userId}, type=${message.type}`);

  userClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(message));
      } catch (err) {
        console.error("❌ WS send failed:", err);
      }
    }
  });
}

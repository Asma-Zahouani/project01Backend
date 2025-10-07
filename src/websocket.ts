import { WebSocketServer, WebSocket } from "ws";
import { supabase } from "./supabase.js"; // ✅ Import Supabase client

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

// 🧠 Store connected clients per userId
const clients = new Map<string, Set<WebSocket>>();

/**
 * 📡 Setup WebSocket + Supabase realtime
 */
export function setupWebSocket(wss: WebSocketServer) {
  wss.on("connection", (ws: WebSocket, req) => {
    let userId = "";

    try {
      // ✅ Ensure a valid base for URL parsing (Render or localhost)
      const baseUrl = process.env.RENDER_EXTERNAL_URL || "http://localhost:3001";
      const url = new URL(req.url || "", baseUrl);
      userId = url.searchParams.get("userId") || "";
    } catch (err) {
      console.warn("⚠️ Failed to parse WS URL:", err);
    }

    if (!userId) {
      console.warn("⚠️ WS rejected: missing userId");
      ws.close(1008, "Missing userId");
      return;
    }

    // 🧩 Register client
    if (!clients.has(userId)) {
      clients.set(userId, new Set());
    }
    clients.get(userId)!.add(ws);

    console.log(`✅ WS connected [user=${userId}] (total clients=${clients.size})`);

    // 🧹 Handle disconnects
    ws.on("close", (code) => {
      clients.get(userId)?.delete(ws);
      if (clients.get(userId)?.size === 0) {
        clients.delete(userId);
      }
      console.log(`❌ WS closed [user=${userId}, code=${code}]`);
    });

    // 🚨 Handle errors
    ws.on("error", (err) => {
      console.error(`🔥 WS error [user=${userId}]:`, err.message || err);
    });
  });

  // ✅ Listen to Supabase realtime "emails" table inserts
  supabase
    .channel("emails_changes")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "emails" },
      (payload) => {
        const newEmail = payload.new;
        console.log("📩 Supabase Realtime → new email detected:", newEmail);

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
    .subscribe((status) => {
      console.log(`📡 Supabase Realtime subscription: ${status}`);
    });

  console.log("📡 WebSocket + Supabase realtime listener ready ✅");
}

/**
 * 🚀 Send WS message manually (used for AI progress updates, calendar events, etc.)
 */
export function sendProgressUpdate(message: ProgressMessage) {
  const userClients = clients.get(message.userId);

  if (!userClients || userClients.size === 0) {
    console.log(`🚫 No WS clients connected for user ${message.userId}`);
    return;
  }

  console.log(`📤 WS → user=${message.userId}, type=${message.type}`);

  userClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(message));
      } catch (err) {
        console.error("❌ Failed to send WS message:", err);
      }
    }
  });
}

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { authRouter } from "./routes/auth.js";
import { agentsRouter } from "./routes/agents.js";
import { promptsRouter } from "./routes/prompts.js";
import { emailsRouter } from "./routes/emails.js";
import { calendarRouter } from "./routes/calendar.js";
import { settingsRouter } from "./routes/settings.js";
import { setupWebSocket } from "./websocket.js";
import { supabase } from "./supabase.js";

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/progress" });
setupWebSocket(wss);

// 🌍 Detect environment
const isRender = !!process.env.RENDER_EXTERNAL_URL;
const PORT = Number(process.env.PORT) || 3001;

// 🌐 Define URLs safely
const PUBLIC_URL =
  process.env.BACKEND_URL ||
  (isRender
    ? process.env.RENDER_EXTERNAL_URL
    : `http://localhost:${PORT}`);

// ✅ Always fallback to localhost URL if undefined
const safePublicUrl = PUBLIC_URL || `http://localhost:${PORT}`;

// 🌐 Frontend origin
const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (isRender
    ? "https://gmailassistantfront.netlify.app"
    : "http://localhost:5173");

// ⚡ Compute WebSocket URL safely
let BACK_WS_URL: string;

if (process.env.BACK_WS_URL) {
  BACK_WS_URL = process.env.BACK_WS_URL;
} else if (isRender) {
  try {
    const host = new URL(safePublicUrl).hostname;
    BACK_WS_URL = `wss://${host}/ws/progress`;
  } catch {
    BACK_WS_URL = `wss://project01backend.onrender.com/ws/progress`;
  }
} else {
  BACK_WS_URL = `ws://localhost:${PORT}/ws/progress`;
}

// ⚙️ Middleware
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json());

// 🪵 Request logger
app.use((req, _res, next) => {
  console.log(`➡️ ${req.method} ${req.url}`);
  next();
});

// 📨 Pub/Sub Gmail notifications
app.post("/api/emails/notifications", (req, res, next) => {
  console.log("📨 Pub/Sub notification received:", JSON.stringify(req.body, null, 2));
  next();
});

// 🧭 Routes
app.use("/api/auth", authRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/emails", emailsRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/prompts", promptsRouter);

// 🩺 Health check
app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("users").select("id").limit(1);
    if (error) throw error;

    res.json({
      status: "OK",
      supabase: "connected",
      environment: isRender ? "Render" : "Local",
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ status: "ERROR", supabase: err.message });
  }
});

// 🤖 LLaMA test endpoint
app.get("/api/test-llama", async (_req, res) => {
  try {
    const { LlamaService } = await import("./services/llama.js");
    const llama = new LlamaService();
    const isAvailable = await llama.isAvailable();

    res.json({
      available: isAvailable,
      model: process.env.MODEL,
      apiUrl: process.env.LLAMA3_API_URL,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 🚀 Start server
server.listen(PORT, () => {
  console.log(isRender ? "🟢 Running on Render environment" : "💻 Running locally");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Public backend: ${safePublicUrl}`);
  console.log(`📡 WebSocket endpoint: ${BACK_WS_URL}`);
  console.log(`🤖 LLaMA API URL: ${process.env.LLAMA3_API_URL}`);
  console.log(`🧠 Model: ${process.env.MODEL}`);
  console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL}`);
});

import express, { Request, Response, NextFunction } from "express";
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

// ==========================
// 🌍 Express + WebSocket Setup
// ==========================
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/progress" });

// ==========================
// 🔐 Dynamic CORS Configuration
// ==========================
const isRender = !!process.env.RENDER_EXTERNAL_URL;
const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (isRender ? "https://gmailassistantfront.netlify.app" : "http://localhost:5173");

const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://gmailassistantfront.netlify.app",
  "https://project01backend.onrender.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`🚫 CORS blocked request from: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json());

// ==========================
// 🪵 Request Logger
// ==========================
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`➡️ ${req.method} ${req.url}`);
  next();
});

// ==========================
// 🔌 WebSocket Setup
// ==========================
setupWebSocket(wss);

// ==========================
// 🧩 API Routes
// ==========================
app.use("/api/auth", authRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/emails", emailsRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/prompts", promptsRouter);

// ✅ Gmail Pub/Sub notifications (debug)
app.post("/api/emails/notifications", (req: Request, res: Response, next: NextFunction) => {
  console.log("📨 Pub/Sub notification received:", JSON.stringify(req.body, null, 2));
  next();
});

// ==========================
// ❤️ Health Check
// ==========================
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const { error } = await supabase.from("users").select("id").limit(1);
    if (error) throw error;

    res.json({
      status: "OK",
      supabase: "connected",
      timestamp: new Date().toISOString(),
      environment: isRender ? "Render" : "Local",
    });
  } catch (err: any) {
    res.status(500).json({ status: "ERROR", supabase: err.message });
  }
});

// ==========================
// 🧠 Test LLaMA Endpoint
// ==========================
app.get("/api/test-llama", async (_req: Request, res: Response) => {
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

// ==========================
// 🚀 Start Server
// ==========================
const PORT = Number(process.env.PORT) || 3001;
const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws/progress";

server.listen(PORT, () => {
  console.log("\n✅ BACKEND READY");
  console.log(`🚀 HTTP Server: ${baseUrl}`);
  console.log(`📡 WebSocket: ${wsUrl}`);
  console.log(`🤖 LLaMA API URL: ${process.env.LLAMA3_API_URL}`);
  console.log(`🧠 Model: ${process.env.MODEL}`);
  console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log("🌍 Allowed Origins:", allowedOrigins);
});

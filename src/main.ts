import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { authRouter } from "./routes/auth.js";
import { agentsRouter } from "./routes/agents.js";
import { promptsRouter } from "./routes/prompts.js"; // 👈 add this
import { emailsRouter } from "./routes/emails.js";
import { calendarRouter } from "./routes/calendar.js";
import { settingsRouter } from "./routes/settings.js";
import { setupWebSocket } from "./websocket.js";
import { supabase } from "./supabase.js"; // ✅ Supabase client
dotenv.config();



const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/progress" });

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// 🔍 Simple request logger (helps debug Pub/Sub hits)
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.url}`);
  next();
});

// Setup WebSocket
setupWebSocket(wss);

// Routes
app.use("/api/auth", authRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/emails", emailsRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/prompts", promptsRouter); // 👈 and this line


// ✅ Explicit log for Pub/Sub Gmail notifications
app.post("/api/emails/notifications", (req, res, next) => {
  console.log("📨 Pub/Sub notification received:", JSON.stringify(req.body, null, 2));
  next(); // pass to emailsRouter handler
});

// Health check
app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase.from("users").select("id").limit(1);
    if (error) throw error;

    res.json({ status: "OK", supabase: "connected", timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ status: "ERROR", supabase: err.message });
  }
});

// Test LLaMA endpoint
app.get("/api/test-llama", async (req, res) => {
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

const PORT = process.env.PORT || 3001;

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws/progress`);
  console.log(`🤖 LLaMA API URL: ${process.env.LLAMA3_API_URL}`);
  console.log(`🧠 Model: ${process.env.MODEL}`);
  console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL}`);
});

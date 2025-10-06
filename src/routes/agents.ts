import express from "express";
import { RootAgent } from "../agent.js";
import { authenticateToken } from "./auth.js";

const router = express.Router();
const rootAgent = new RootAgent();

// Get agents status
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const status = rootAgent.getStatus();
    res.json(status);
  } catch (error: any) {
    console.error("Agent status error:", error);
    res.status(500).json({ error: "Failed to get agent status" });
  }
});

// Process agent request
router.post("/process", authenticateToken, async (req: any, res) => {
  try {
    const { request, context } = req.body;

    if (!request) {
      return res.status(400).json({ error: "Missing request field" });
    }

    const result = await rootAgent.processRequest(
      req.user.userId,
      request,
      context || {}
    );
    res.json(result);
  } catch (error: any) {
    console.error("Agent processing error:", error);
    res.status(500).json({ error: "Failed to process request" });
  }
});

export { router as agentsRouter };

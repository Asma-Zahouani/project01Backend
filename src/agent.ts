import { GmailAgent } from "./sub_agents/gmail_agent/agent.js";
import { GoogleCalendarAgent } from "./sub_agents/google_calendar_agent/agent.js";
import { LlamaService } from "./services/llama.js";
import { supabase } from "./supabase.js"; // ✅ Supabase client

export class RootAgent {
  private gmailAgent: GmailAgent;
  private calendarAgent: GoogleCalendarAgent;
  private llama: LlamaService;

  constructor() {
    this.llama = new LlamaService();
    this.gmailAgent = new GmailAgent(this.llama);
    this.calendarAgent = new GoogleCalendarAgent(this.llama);
  }

  async processRequest(userId: number, request: string, context: any = {}) {
    try {
      // ✅ Ensure user exists in Supabase
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("id")
        .eq("id", userId)
        .single();

      if (userError || !user) {
        throw new Error(`User with id ${userId} not found in Supabase`);
      }

      // Analyze the request to determine which agents to use
      const analysis = await this.analyzeRequest(request);

      const results = {
        gmail: null as any,
        calendar: null as any,
        analysis,
      };

      if (analysis.requiresGmail) {
        results.gmail = await this.gmailAgent.processRequest(String(userId), request, context);
      }

      if (analysis.requiresCalendar) {
        results.calendar = await this.calendarAgent.processRequest(
          userId,
          request,
          context
        );
      }

      return results;
    } catch (error) {
      console.error("RootAgent error:", error);
      throw error;
    }
  }

  private async analyzeRequest(request: string) {
    const prompt = `Analyze this request and determine what actions are needed:
"${request}"

Respond with JSON in this format:
{
  "requiresGmail": boolean,
  "requiresCalendar": boolean,
  "intent": "string describing the main intent",
  "actions": ["list of specific actions needed"]
}`;

    try {
      const response = await this.llama.generateResponse(prompt);
      return JSON.parse(response);
    } catch (error) {
      console.warn("Fallback analysis triggered:", error);
      // Fallback if JSON parsing fails
      return {
        requiresGmail:
          request.toLowerCase().includes("email") ||
          request.toLowerCase().includes("gmail"),
        requiresCalendar:
          request.toLowerCase().includes("calendar") ||
          request.toLowerCase().includes("appointment"),
        intent: "General request",
        actions: ["analyze_request"],
      };
    }
  }

  getStatus() {
    return {
      root: "active",
      gmail: this.gmailAgent.getStatus(),
      calendar: this.calendarAgent.getStatus(),
      llama: this.llama.isAvailable(),
    };
  }
}

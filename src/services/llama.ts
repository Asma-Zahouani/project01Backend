import axios from "axios";

export class LlamaService {
  private baseUrl: string;
  private model: string;

  constructor() {
    this.baseUrl = process.env.LLAMA3_API_URL || "http://localhost:11434/api";
    this.model = process.env.LLAMA3_MODEL || "llama3:latest";
  }

  /**
   * Generic response generator
   * Handles Ollama's streaming output
   */
  async generateResponse(prompt: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/generate`,
        {
          model: this.model,
          prompt,
          stream: true,
        },
        { responseType: "stream", timeout: 60000 }
      );

      return await new Promise((resolve, reject) => {
        let result = "";

        response.data.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n").filter(Boolean);

          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);

              // ✅ Only collect actual model text
              if (typeof parsed.response === "string") {
                result += parsed.response;
              }

              // ✅ Stop when Ollama signals "done"
              if (parsed.done) {
                return resolve(result.trim());
              }
            } catch {
              // Silently ignore malformed or control lines
            }
          }
        });

        response.data.on("error", reject);
        response.data.on("end", () => resolve(result.trim()));
      });
    } catch (error: any) {
      console.error(
        "❌ LLaMA 3 service error:",
        error?.response?.data || error.message
      );
      throw new Error(
        `LLaMA 3 service unavailable: ${
          error?.response?.data?.error || error.message
        }`
      );
    }
  }

  /**
   * Utility: Extracts & sanitizes JSON from AI text
   * Always returns a valid object (no throw)
   */
  public extractJson(rawOutput: string, fallback: any = {}) {
    try {
      if (!rawOutput || !rawOutput.trim()) {
        throw new Error("Empty AI output");
      }

      // 🧹 Clean garbage text
      const cleaned = rawOutput
        .replace(/\/\/.*$/gm, "") // remove JS-style comments
        .replace(/\(.*?\)/g, "") // remove (instructions)
        .replace(/,\s*}/g, "}") // remove trailing commas
        .replace(/,\s*]/g, "]") // remove trailing commas in arrays
        .trim();

      // Extract first JSON object if extra text exists
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      // 📧 normalize attendees
      const emailRegex =
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const detectedEmails = rawOutput.match(emailRegex) || [];

      const attendees = [
        ...(Array.isArray(parsed.attendees) ? parsed.attendees : []),
        ...detectedEmails,
        fallback.sender || "",
        process.env.GMAIL_ADDRESS || "",
      ].filter(Boolean);

      // 📅 normalize times
      const start = parsed.startTime
        ? new Date(parsed.startTime).toISOString()
        : new Date().toISOString();

      const end = parsed.endTime
        ? new Date(parsed.endTime).toISOString()
        : new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();

      return {
        title: parsed.title || fallback.title || "Untitled Event",
        description: parsed.description || fallback.description || "",
        startTime: start,
        endTime: end,
        location: parsed.location || fallback.location || "",
        attendees: [...new Set(attendees)], // dedupe
      };
    } catch (err) {
      console.error("❌ JSON extraction failed. Raw AI output:", rawOutput);

      // 🚑 safe fallback
      const now = new Date();
      return {
        title: fallback.title || "Untitled Event",
        description: fallback.description || "",
        startTime: fallback.startTime || now.toISOString(),
        endTime:
          fallback.endTime ||
          new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        location: fallback.location || "",
        attendees: [
          fallback.sender || "",
          process.env.GMAIL_ADDRESS || "",
        ].filter(Boolean),
      };
    }
  }

/**
 * Generate an email reply given subject + body and current calendar events.
 */
async generateEmailResponse(
  subject: string,
  body: string,
  calendarEvents: any[] = []
): Promise<string> {
  // Build contextual calendar summary
  let calendarContext = '';

  if (!calendarEvents || calendarEvents.length === 0) {
    calendarContext = `
The calendar is currently empty — there are no events scheduled.
You are free to accept new appointments at the requested time.
    `.trim();
  } else {
    const upcoming = calendarEvents
      .map(event => `• ${event.summary} (${event.start} → ${event.end})`)
      .join('\n');

    calendarContext = `
Here are the user's upcoming calendar events:
${upcoming}

If the requested time conflicts with these events, politely decline and suggest nearby alternatives.
    `.trim();
  }

  // Build the full AI prompt
  const prompt = `
You are an AI assistant that replies to emails professionally and contextually.
Analyze the following email and calendar information, then write a short, polite, ready-to-send reply.

Email Subject: ${subject}
Email Body:
${body}

${calendarContext}

Guidelines:
- If the calendar is empty → accept the requested appointment.
- If there's a conflict → politely propose alternative times.
- Always write naturally and professionally.
- Do NOT invent fake commitments or events.
- End the message with a warm and respectful closing.

Reply:
  `.trim();

  return this.generateResponse(prompt);
}


  /**
   * Extract calendar intent (create, update, delete) from an email
   */
  async generateCalendarAction(subject: string, body: string): Promise<any> {
    const prompt = `
You are an assistant that extracts calendar scheduling intents from emails.

Return ONLY a valid JSON object with the following fields:
- action: "create", "update", or "delete"
- title: short event title
- date: "YYYY-MM-DD" if mentioned
- time: "HH:MM" (24h) if mentioned
- newTime: "HH:MM" if this is a modification
- notes: additional context

❌ Do not include explanations, reasoning, or extra text.
✅ Output must be a JSON object only.

Subject: ${subject}
Body: ${body}
    `.trim();

    const raw = await this.generateResponse(prompt);
    return this.extractJson(raw);
  }

  /**
   * Health check
   */
  async isAvailable(): Promise<boolean> {
    try {
      const healthUrl = this.baseUrl.replace(/\/api$/, "") + "/api/tags";
      await axios.get(healthUrl, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

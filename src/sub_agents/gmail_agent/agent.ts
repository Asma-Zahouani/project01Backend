import { gmail_v1, google } from "googleapis";
import { LlamaService } from "../../services/llama.js";
import { supabase } from "../../supabase.js";
import { DEFAULT_PROMPTS } from "../../prompts.js";

export class GmailAgent {
  private llama: LlamaService;
  private pollIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(llama: LlamaService) {
    this.llama = llama;
  }

  async processRequest(userId: string, request: string, context: any = {}) {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("google_token, gmail_history_id")
      .eq("id", userId)
      .single();

    if (userError || !user?.google_token) {
      throw new Error("User not authenticated with Google");
    }

    const auth = this.createAuthClient(user.google_token);
    const gmail = google.gmail({ version: "v1", auth });

    if (request.includes("start-sync")) {
      this.startPolling(userId, gmail, user.gmail_history_id);
      return { success: true, message: "Started Gmail sync polling" };
    }
    if (request.includes("stop-sync")) {
      this.stopPolling(userId);
      return { success: true, message: "Stopped Gmail sync polling" };
    }

    if (request.includes("classify") || request.includes("process")) {
      return await this.classifyEmails(userId, gmail);
    } else if (request.includes("send")) {
      return await this.sendEmail(userId, gmail, context);
    } else if (request.includes("respond")) {
      return await this.generateReply(userId, context.emailId);
    } else if (request.includes("respond/send")) {
      return await this.sendReply(userId, context.emailId, context.body);
    } else if (request.includes("synchronize")) {
      return await this.synchronizeEmail(userId, context.emailId);
    } else if (request.includes("analyze")) {
      return await this.analyzeEmail(userId, gmail, context);
    }

    return await this.fetchRecentEmails(userId, gmail, user.gmail_history_id);
  }

  /**
   * 🔄 Starts polling Gmail every 10s for new emails
   */
  private startPolling(userId: string, gmail: gmail_v1.Gmail, lastHistoryId?: string) {
    if (this.pollIntervals.has(userId)) {
      console.log(`⏳ Polling already active for ${userId}`);
      return;
    }

    console.log(`▶️ Starting Gmail sync for ${userId}...`);
    const interval = setInterval(async () => {
      try {
        await this.fetchRecentEmails(userId, gmail, lastHistoryId);
      } catch (err) {
        console.error(`⚠️ Polling error for ${userId}:`, err);
      }
    }, 10000); // every 10 seconds

    this.pollIntervals.set(userId, interval);
  }

  private stopPolling(userId: string) {
    const interval = this.pollIntervals.get(userId);
    if (interval) {
      clearInterval(interval);
      this.pollIntervals.delete(userId);
      console.log(`⏹️ Stopped Gmail sync for ${userId}`);
    }
  }

  /**
   * 🔹 Classify unprocessed emails
   */
  async classifyEmails(userId: string, gmail: gmail_v1.Gmail) {
    const { data: categories } = await supabase
      .from("categories")
      .select("*")
      .eq("user_id", userId);

    const { data: unprocessedEmails } = await supabase
      .from("emails")
      .select("*")
      .eq("user_id", userId)
      .is("category", null);

    const results: any[] = [];
    for (const email of unprocessedEmails || []) {
      const category = await this.classifyEmail(email, categories || []);

      await supabase
        .from("emails")
        .update({
          category,
          processed_at: new Date().toISOString(),
        })
        .eq("id", email.id)
        .eq("user_id", userId);

      results.push({ ...email, category });
    }

    return { classified: results.length, results };
  }

  private async classifyEmail(email: any, categories: any[]) {
    const categoryNames = categories.map((c) => c.name).join(", ");
    const prompt = DEFAULT_PROMPTS.classifier
      .replace("{categories}", categoryNames)
      .replace("{subject}", email.subject || "")
      .replace("{body}", (email.body || "").substring(0, 1000));

    try {
      const response = await this.llama.generateResponse(prompt);
      return response.trim();
    } catch (error) {
      console.error("Classification error:", error);
      return "Other";
    }
  }

  /**
   * 🔹 Fetch emails and sync with Supabase
   * - Uses historyId for incremental sync
   */
  async fetchRecentEmails(
    userId: string,
    gmail: gmail_v1.Gmail,
    lastHistoryId?: string
  ) {
    try {
      let messages: gmail_v1.Schema$Message[] = [];
      let newHistoryId: string | undefined;

      if (lastHistoryId) {
        // Incremental sync
        const historyRes = await gmail.users.history.list({
          userId: "me",
          startHistoryId: lastHistoryId,
          historyTypes: ["messageAdded"],
        });

        const history = historyRes.data.history || [];
        messages = history.flatMap((h) => h.messages || []);
        newHistoryId = historyRes.data.historyId || lastHistoryId;
        } else {
          // full fetch (first time)
          const response = await gmail.users.messages.list({
            userId: "me",
            maxResults: 20,
            q: "is:unread OR newer_than:7d",
          });
          messages = response.data.messages || [];

          // ✅ fetch profile to get the current historyId
          const profile = await gmail.users.getProfile({ userId: "me" });
          newHistoryId = profile.data.historyId?.toString();
        }


      const newEmails: any[] = [];
      for (const message of messages) {
        try {
          const details = await gmail.users.messages.get({
            userId: "me",
            id: message.id!,
            format: "full",
          });

          const headers = details.data.payload?.headers || [];
          const subject = headers.find((h) => h.name === "Subject")?.value || "";
          const fromHeader = headers.find((h) => h.name === "From")?.value || "";
          const senderMatch = fromHeader.match(/<(.+?)>/);
          const sender = senderMatch ? senderMatch[1] : fromHeader;

          const body = this.extractBody(details.data.payload);

          newEmails.push({
            user_id: userId,
            gmail_id: message.id,
            subject,
            body,
            snippet: details.data.snippet || "",
            sender,
            updated_at: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`⚠️ Error processing Gmail message ${message.id}:`, err);
        }
      }

      if (newEmails.length > 0) {
        await supabase.from("emails").upsert(newEmails, { onConflict: "gmail_id" });
      }

      if (newHistoryId) {
        await supabase
          .from("users")
          .update({ gmail_history_id: newHistoryId })
          .eq("id", userId);
      }

      const { data: allEmails } = await supabase
        .from("emails")
        .select("*")
        .eq("user_id", userId)
        .order("id", { ascending: false })
        .limit(100);

      return { emails: allEmails || [], total: allEmails?.length || 0 };
    } catch (error) {
      console.error("Fetch emails error:", error);
      throw error;
    }
  }

  private extractBody(payload: any): string {
    if (!payload) return "";
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, "base64").toString("utf-8");
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        if (part.mimeType === "text/html" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        const nested = this.extractBody(part);
        if (nested) return nested;
      }
    }
    return "";
  }

  /**
   * 🔹 Send email
   */
  async sendEmail(userId: string, gmail: gmail_v1.Gmail, context: any) {
    const { data: email } = await supabase
      .from("emails")
      .select("*")
      .eq("id", context.emailId)
      .eq("user_id", userId)
      .maybeSingle();

    const to = context.to || email?.sender;
    const subject = context.subject || (email ? `Re: ${email.subject}` : "(no subject)");
    const body =
      context.body ||
      (context.response ? context.response : "Hello,\n\n(This is a test email.)");
    const inReplyTo = context.inReplyTo || email?.gmail_id;

    if (!to || !subject || !body) {
      throw new Error("Missing required fields: to, subject, body");
    }

    const rawMessage = [
      `To: ${to}`,
      `Subject: ${subject}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
      inReplyTo ? `References: ${inReplyTo}` : "",
      `Content-Type: text/plain; charset="UTF-8"`,
      "",
      body,
    ]
      .filter(Boolean)
      .join("\r\n");

    const encodedMessage = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage },
    });

    return { sent: true, messageId: response.data.id };
  }

  /**
   * 🤖 AI reply generation
   */
  async generateReply(userId: string, emailId: string) {
    const { data: email } = await supabase
      .from("emails")
      .select("*")
      .eq("id", emailId)
      .eq("user_id", userId)
      .single();

    if (!email) throw new Error("Email not found");

    const aiResponse = await this.llama.generateEmailResponse(
      email.subject,
      email.body
    );

    return { reply: aiResponse.trim() };
  }

  /**
   * 📤 Send AI-generated reply
   */
  async sendReply(userId: string, emailId: string, replyText: string) {
    const { data: email } = await supabase
      .from("emails")
      .select("*")
      .eq("id", emailId)
      .eq("user_id", userId)
      .single();

    if (!email) throw new Error("Email not found");

    const { data: user } = await supabase
      .from("users")
      .select("google_token")
      .eq("id", userId)
      .single();

    if (!user?.google_token) {
      throw new Error("User not authenticated with Google");
    }

    const auth = this.createAuthClient(user.google_token);
    const gmail = google.gmail({ version: "v1", auth });

    return this.sendEmail(userId, gmail, {
      to: email.sender,
      subject: `Re: ${email.subject}`,
      body: replyText,
      inReplyTo: email.gmail_id,
    });
  }

  async synchronizeEmail(userId: string, emailId: string) {
    const { data: email } = await supabase
      .from("emails")
      .select("*")
      .eq("id", emailId)
      .eq("user_id", userId)
      .single();

    if (!email) throw new Error("Email not found");

    const analysis = await this.llama.generateResponse(`
      Extract appointment intent (CREATE/UPDATE/DELETE), title, dateTime, duration, attendees.
      Subject: ${email.subject}
      Body: ${email.body.substring(0, 1000)}
      Return JSON only.
    `);

    return { success: true, action: analysis.trim() };
  }

  async analyzeEmail(userId: string, gmail: gmail_v1.Gmail, context: any) {
    return { analysis: "Email analysis results" };
  }

  private createAuthClient(token: string) {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    auth.setCredentials(JSON.parse(token));
    return auth;
  }

  getStatus() {
    return "active";
  }
}

// backend/src/routes/emails.ts
import express from 'express';
import { google, gmail_v1 } from 'googleapis';
import { supabase, Email } from '../supabase.js';
import { authenticateToken } from './auth.js';
import { LlamaService } from '../services/llama.js';
import { sendProgressUpdate } from "../websocket.js"; // adjust path if different
import crypto from "crypto";

const router = express.Router();
const llamaService = new LlamaService();

/**
 * Create an authenticated Google client for the given user
 */
async function createAuthenticatedClient(userId: string) {
  const { data: user, error } = await supabase
    .from('users')
    .select('google_token')
    .eq('id', userId)
    .single();

  if (error || !user?.google_token) {
    throw new Error('User not authenticated with Google');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const tokens = JSON.parse(user.google_token);
  oauth2Client.setCredentials(tokens);

  // Refresh tokens automatically
  oauth2Client.on('tokens', async (newTokens) => {
    try {
      const updatedTokens = { ...tokens, ...newTokens };
      await supabase
        .from('users')
        .update({ google_token: JSON.stringify(updatedTokens) })
        .eq('id', userId);
    } catch (err) {
      console.error('Failed to persist refreshed tokens:', err);
    }
  });

  return oauth2Client;
}

/**
 * Extract email body from Gmail payload
 */
function extractEmailBody(payload: any): string {
  if (!payload) return '';

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      const nested = extractEmailBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

/**
 * Start watching Gmail (creates a push subscription to Pub/Sub topic)
 */
router.post("/watch", authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    const { publicUrl } = req.body; // ✅ optional override

    const auth = await createAuthenticatedClient(userId);
    const gmail = google.gmail({ version: "v1", auth });

    const topicName = "projects/gmail-calendar-ai/topics/gmail-push";
    const pushEndpoint = publicUrl
      ? `${publicUrl}/api/emails/push`
      : process.env.PUSH_ENDPOINT; // fallback for production

    console.log("📡 Starting Gmail watch with endpoint:", pushEndpoint);

    const watchResponse = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"],
        labelFilterAction: "include",
      },
    });

    if (watchResponse.data.historyId) {
      await supabase
        .from("users")
        .update({ gmail_history_id: watchResponse.data.historyId })
        .eq("id", userId);
    }

    res.json({
      success: true,
      message: "Gmail watch started",
      pushEndpoint,
      watchResponse: watchResponse.data,
    });
  } catch (error: any) {
    console.error("Error starting Gmail watch:", error);
    res.status(500).json({ error: "Failed to start Gmail watch" });
  }
});



/**
 * Gmail Push Notification Webhook (Pub/Sub)
 */
router.post("/push", async (req, res) => {
  try {
    const body = req.body;
    let decodedPayload: any = null;

    if (body.message?.data) {
      try {
        decodedPayload = JSON.parse(
          Buffer.from(body.message.data, "base64").toString("utf-8")
        );
      } catch (err) {
        console.warn("Push: decode failed", err);
      }
    } else if (body.emailAddress && body.historyId) {
      decodedPayload = body;
    }

    if (!decodedPayload) {
      console.warn("Push: invalid body", body);
      return res.status(200).send("OK");
    }

    console.log("📩 Gmail Push decoded:", decodedPayload);

    const { emailAddress, historyId } = decodedPayload;
    if (!emailAddress) return res.status(200).send("OK");

    // ✅ Find user by email
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("id,gmail_history_id")
      .eq("email", emailAddress)
      .single();

    if (userErr || !user) {
      console.warn(`⚠️ No user found for ${emailAddress}`, userErr);
      return res.status(200).send("OK");
    }

    // Do sync in background (non-blocking)
    (async () => {
      try {
        let effectiveHistoryId = historyId;

        // 🛠 If invalid (UUID or empty), refresh with Gmail watch()
        if (!effectiveHistoryId || isNaN(Number(effectiveHistoryId))) {
          console.warn("⚠️ Invalid historyId received, refreshing with Gmail watch()");
          const auth = await createAuthenticatedClient(user.id);
          const gmail = google.gmail({ version: "v1", auth });
          const watchResp = await gmail.users.watch({
            userId: "me",
            requestBody: {
              topicName: "projects/gmail-calendar-ai/topics/gmail-push",
              labelIds: ["INBOX"],
              labelFilterAction: "include",
            },
          });
          effectiveHistoryId = watchResp.data.historyId!;
          console.log("🔄 Refreshed historyId:", effectiveHistoryId);
        }

        await syncHistory(user.id, user.gmail_history_id || effectiveHistoryId);

        await supabase
          .from("users")
          .update({ gmail_history_id: effectiveHistoryId })
          .eq("id", user.id);
      } catch (err) {
        console.error("Push: sync failed:", err);
      }
    })();

    return res.status(200).send("OK");
  } catch (err) {
    console.error("⚠️ Push handler error:", err);
    return res.status(500).send("Error");
  }
});

/**
 * Test endpoint (simulate Pub/Sub push)
 */
router.post("/push/test", async (req, res) => {
  try {
    const { emailAddress, historyId } = req.body;
    if (!emailAddress) {
      return res.status(400).json({ error: "emailAddress is required" });
    }

    // 1. Get user
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, gmail_history_id")
      .eq("email", emailAddress)
      .single();

    if (userError || !user) {
      console.warn("⚠️ No user found for", emailAddress, userError);
      return res.status(404).json({ error: "user not found" });
    }

    // 2. Choose historyId
    let effectiveHistoryId = historyId || user.gmail_history_id;

    // 3. Refresh if invalid
    if (!effectiveHistoryId || isNaN(Number(effectiveHistoryId))) {
      console.warn("⚠️ Invalid historyId, refreshing with Gmail watch()");
      const auth = await createAuthenticatedClient(user.id);
      const gmail = google.gmail({ version: "v1", auth });

      const watchResp = await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName: "projects/gmail-calendar-ai/topics/gmail-push",
          labelIds: ["INBOX"],
          labelFilterAction: "include",
        },
      });

      if (!watchResp.data.historyId) {
        throw new Error("Failed to refresh historyId from Gmail");
      }

      effectiveHistoryId = watchResp.data.historyId;
      console.log("🔄 Refreshed historyId:", effectiveHistoryId);
    }

    // 4. Sync emails
    await syncHistory(user.id, effectiveHistoryId);

    // 5. Update user
    await supabase
      .from("users")
      .update({ gmail_history_id: effectiveHistoryId })
      .eq("id", user.id);

    // 6. Respond
    res.json({
      success: true,
      message: "Test push processed",
      historyId: effectiveHistoryId,
    });

    // 7. 🔔 Notify frontend (optional "test complete" event)
    sendProgressUpdate({
      userId: user.id,
      type: "push_test_complete",
      data: { emailAddress, historyId: effectiveHistoryId },
    });

  } catch (err: any) {
    console.error("push/test error:", err.message || err);
    res.status(500).json({ error: "failed" });
  }
});



/**
 * Incremental Gmail sync using historyId
 */
async function syncHistory(userId: string, startHistoryId?: string) {
  try {
    const auth = await createAuthenticatedClient(userId);
    const gmail = google.gmail({ version: "v1", auth });

    let messages: gmail_v1.Schema$Message[] = [];
    let latestHistoryId: string | undefined;

    try {
      // ❗ Only try history API if numeric ID
      if (startHistoryId && !isNaN(Number(startHistoryId))) {
        const historyRes = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
        });
        latestHistoryId = historyRes.data.historyId || startHistoryId;
        if (historyRes.data.history?.length) {
          messages = historyRes.data.history.flatMap((h) => h.messages || []);
        }
      }
    } catch (err: any) {
      console.warn("syncHistory: history API failed → fallback to list", err?.message);
    }

    // 🛑 Fallback: fetch recent emails if no history
    if (!messages.length) {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        maxResults: 20,
        q: "newer_than:7d",
      });
      messages = listRes.data.messages || [];
      latestHistoryId = undefined; // force refresh later
    }

    if (!messages.length) {
      console.log("ℹ️ No new emails found");
      return;
    }

    const newEmails: any[] = [];

    for (const msg of messages) {
      try {
        const details = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "full",
        });

        const headers = details.data.payload?.headers || [];
        const subject = headers.find((h) => h.name === "Subject")?.value || "";
        const from = headers.find((h) => h.name === "From")?.value || "";
        const snippet = details.data.snippet || "";
        const body = extractEmailBody(details.data.payload);

        const { data: existing } = await supabase
          .from("emails")
          .select("id")
          .eq("gmail_id", msg.id!)
          .single();

        if (!existing) {
          newEmails.push({
            user_id: userId,
            gmail_id: msg.id,
            subject,
            body,
            snippet,
            sender: from,
            is_read: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),

          });
        }
      } catch (err) {
        console.error(`⚠️ Error fetching message ${msg.id}:`, err);
      }
    }

      if (newEmails.length) {
        const { data: inserted, error } = await supabase
          .from("emails")
          .insert(newEmails)
          .select();

        if (error) {
          console.error("❌ Failed to insert emails:", error);
        } else {
          console.log(`✅ Inserted ${inserted.length} new emails`);

          // 🔔 Notify frontend via WebSocket
          for (const email of inserted) {
            sendProgressUpdate({
              userId,
              type: "new_email",
              data: email,
            });
          }
        }
      }


    // 🔄 Refresh watch if no valid historyId
    if (!latestHistoryId) {
      console.log("🔄 Refreshing Gmail watch because historyId is missing/invalid");
      const watchResp = await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName: "projects/gmail-calendar-ai/topics/gmail-push",
          labelIds: ["INBOX"],
          labelFilterAction: "include",
        },
      });
      latestHistoryId = watchResp.data.historyId!;
    }

    if (latestHistoryId) {
      await supabase
        .from("users")
        .update({ gmail_history_id: latestHistoryId })
        .eq("id", userId);

      console.log(`📌 Updated gmail_history_id for user ${userId} → ${latestHistoryId}`);
    }
  } catch (err) {
    console.error("⚠️ Error in syncHistory:", err);
  }
}


/**
 * Get emails with pagination + summary
 */
router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20; // Fixed page size
    const offset = (page - 1) * limit;

    // 1. Fetch paginated emails
    let query = supabase
      .from('emails')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: emails, error, count } = await query;

    if (error) {
      console.error('Error fetching emails:', error);
      return res.status(500).json({ error: 'Failed to fetch emails' });
    }

    const totalPages = Math.ceil((count || 0) / limit);

    // 2. Fetch summary counts
    const { count: processedCount } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.userId)
      .not('processed_at', 'is', null);

    const { count: unreadCount } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.userId)
      .eq('is_read', false);

    res.json({
      emails: emails || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      summary: {
        total: count || 0,
        processed: processedCount || 0,
        unread: unreadCount || 0
      }
    });
  } catch (error: any) {
    console.error('List emails error:', error);
    res.status(500).json({ error: 'Failed to list emails' });
  }
});


/**
 * Search emails
 */
router.get('/search', authenticateToken, async (req: any, res) => {
  try {
    const query = req.query.q as string;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const { data: emails, error, count } = await supabase
      .from('emails')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.userId)
      .or(`subject.ilike.%${query}%,body.ilike.%${query}%`)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Error searching emails:', error);
      return res.status(500).json({ error: 'Failed to search emails' });
    }

    const totalPages = Math.ceil((count || 0) / limit);

    res.json({
      emails: emails || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error: any) {
    console.error('Search emails error:', error);
    res.status(500).json({ error: 'Failed to search emails' });
  }
});
/**
 * Filter emails (category / read / processed)
 */
router.get('/filter', authenticateToken, async (req: any, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const category = req.query.category as string | undefined;    // "Prise de RDV" | "Annulation" | ...
    const read = req.query.read as string | undefined;            // "read" | "unread"
    const processed = req.query.processed as string | undefined;  // "processed" | "unprocessed"

    let query = supabase
      .from('emails')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // 🗂 Category filter
    if (category && category !== "all") {
      const validCategories = [
        "Prise de RDV",
        "Annulation",
        "Modification",
        "Information",
        "Other"
      ];
      if (validCategories.includes(category)) {
        query = query.eq("category", category);
      }
    }

    // 📩 Read/unread filter
    if (read === "read") {
      query = query.eq("is_read", true);
    } else if (read === "unread") {
      query = query.eq("is_read", false);
    }

    // ⚡ Processed/unprocessed filter
    if (processed === "processed") {
      query = query.not("processed_at", "is", null);
    } else if (processed === "unprocessed") {
      query = query.is("processed_at", null);
    }

    const { data: emails, error, count } = await query;

    if (error) {
      console.error('Error filtering emails:', error);
      return res.status(500).json({ error: 'Failed to filter emails' });
    }

    const totalPages = Math.ceil((count || 0) / limit);

    res.json({
      emails: emails || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error: any) {
    console.error('Filter emails error:', error);
    res.status(500).json({ error: 'Failed to filter emails' });
  }
});

/**
 * Process & classify emails (all unprocessed ones) - Batched with LLaMA
 */
router.post('/process', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    sendProgressUpdate({
      userId,
      type: 'progress',
      data: { progress: 0, message: 'Starting email classification...' }
    });

    // 🔹 Fetch totals upfront
    const { count: totalRaw } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: processedRaw } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .not('processed_at', 'is', null);

    const total = totalRaw ?? 0;
    const processedBefore = processedRaw ?? 0;
    const unprocessedBefore = total - processedBefore;

    if (unprocessedBefore <= 0) {
      sendProgressUpdate({
        userId,
        type: 'complete',
        data: { progress: 100, message: 'No new emails to process!' }
      });

      return res.json({
        success: true,
        processed: processedBefore,
        total,
        unprocessed: 0,
        emails: []
      });
    }

    // 🔹 Fetch ALL unprocessed emails
    const { data: emails, error } = await supabase
      .from('emails')
      .select('*')
      .eq('user_id', userId)
      .is('processed_at', null);

    if (error) throw new Error('Failed to fetch unprocessed emails');
    if (!emails || emails.length === 0) {
      return res.json({
        success: true,
        processed: processedBefore,
        total,
        unprocessed: 0,
        emails: []
      });
    }

    // 🔹 Allowed categories
    const validCategories = [
      'Prise de RDV',
      'Annulation',
      'Modification',
      'Information',
      'Other'
    ];

    // 🔹 Batch classify emails with LLaMA
    const processedEmails: Email[] = [];
    let processedCount = 0;

    for (const email of emails) {
      const fullPrompt = `
You are an AI email classifier.
Classify the following email into exactly ONE of these categories:
- Prise de RDV
- Annulation
- Modification
- Information
- Other

Email Subject: "${email.subject}"
Email Body: "${email.body.substring(0, 1500)}"

Respond with ONLY the category name, nothing else.
`;

      let category = 'Other';
      try {
        const result = await llamaService.generateResponse(fullPrompt);
        const cleaned = result.trim().replace(/['"]/g, '');

        if (validCategories.includes(cleaned)) {
          category = cleaned;
        } else {
          console.warn(`⚠️ Unexpected LLaMA category: "${cleaned}", defaulting to Other`);
        }
      } catch (err) {
        console.error('Classification error:', err);
      }

      const now = new Date().toISOString();

      processedEmails.push({
        ...email,
        user_id: userId,
        category,
        processed_at: now,
        updated_at: now
      });

      processedCount++;
      const progress = Math.round((processedCount / unprocessedBefore) * 100);
      sendProgressUpdate({
        userId,
        type: 'progress',
        data: { progress, message: `Processing email ${processedCount}/${unprocessedBefore}...` }
      });
    }

    // 🔹 Write back in bulk
    for (const update of processedEmails) {
      const { error: updateError } = await supabase
        .from('emails')
        .update({
          category: update.category,
          processed_at: update.processed_at,
          updated_at: update.updated_at
        })
        .eq('id', update.id);

      if (updateError) {
        console.error(`Failed to update email ${update.id}:`, updateError);
      }
    }

    // 🔹 Re-fetch processed count
    const { count: processedAfterRaw } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .not('processed_at', 'is', null);

    const processedAfter = processedAfterRaw ?? processedBefore;
    const unprocessedAfter = total - processedAfter;

    sendProgressUpdate({
      userId,
      type: 'complete',
      data: { progress: 100, message: `Classified ${processedEmails.length} emails!` }
    });

    res.json({
      success: true,
      processed: processedAfter,
      total,
      unprocessed: unprocessedAfter,
      emails: processedEmails
    });
  } catch (error: any) {
    console.error('Process emails error:', error);
    sendProgressUpdate({
      userId,
      type: 'error',
      data: { message: 'Email processing failed: ' + error.message }
    });
    res.status(500).json({ error: 'Failed to process emails' });
  }
});


/**
 * Mark email as read
 */
router.patch('/:id/read', authenticateToken, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { is_read } = req.body;

    const { data: email, error } = await supabase
      .from('emails')
      .update({ is_read })
      .eq('id', id)
      .eq('user_id', req.user.userId)
      .select()
      .single();

    if (error) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json({ success: true, email });
  } catch (error: any) {
    console.error('Mark email as read error:', error);
    res.status(500).json({ error: 'Failed to update email' });
  }
});
/**
 * Delete email (only from Supabase, not Gmail)
 */
router.delete('/:id', authenticateToken, async (req: any, res) => {
  try {
    const { id } = req.params;

    // 1. Delete the email
    const { error: deleteError } = await supabase
      .from('emails')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.userId); // only delete your own emails

    if (deleteError) {
      console.error('❌ Delete email error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete email' });
    }

    // 2. Count remaining emails for this user
    const { count, error: countError } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.userId);

    if (countError) {
      console.error('❌ Count emails error:', countError);
      return res.status(500).json({ error: 'Failed to update pagination' });
    }

    // 3. Build pagination summary
    const limit = 20; // keep in sync with frontend
    const total = count || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      success: true,
      id,
      pagination: {
        total,
        totalPages,
        limit,
      },
    });
  } catch (err: any) {
    console.error('🔥 Delete email exception:', err);
    res.status(500).json({ error: 'Server error deleting email' });
  }
});


/**
 * Generate AI response for email 
 */
router.post('/:id/respond', authenticateToken, async (req: any, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Get the email
    const { data: email, error: emailError } = await supabase
      .from('emails')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (emailError || !email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Get user info (fetch full_name or fallback)
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('full_name, email')
      .eq('id', userId)
      .single();

    let userName =
      userData?.full_name ||
      (userData?.email ? userData.email.split('@')[0] : 'User');

    // Capitalize first letter
    userName = userName.charAt(0).toUpperCase() + userName.slice(1);

    // AI Prompt
    const responsePrompt = `
You are ${userName}'s AI Assistant.
Generate a polite, professional, and context-aware email reply.

Subject: ${email.subject}
From: ${email.sender}
Email Content:
${email.body.substring(0, 1500)}

Guidelines:
- Acknowledge the sender appropriately.
- Be polite, concise, and professional.
- If scheduling or availability is mentioned, respond accordingly.
- Avoid placeholders like [Your Name].
- End the message with exactly:

Best regards,
${userName}'s AI Assistant

Reply with the email body only.
    `.trim();

    const aiResponse = await llamaService.generateResponse(responsePrompt);

    res.json({
      success: true,
      response: aiResponse.trim(),
      originalSubject: email.subject,
      originalSender: email.sender,
    });
  } catch (error: any) {
    console.error('Generate response error:', error);
    if (error.message?.includes('LLaMA 3 service unavailable')) {
      res.status(503).json({ error: 'AI service is unavailable. Please ensure LLaMA 3 is running.' });
    } else {
      res.status(500).json({ error: 'Failed to generate response' });
    }
  }
});



/**
 * Send response email 
 */
router.post('/:id/send-response', authenticateToken, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;
    const userId = req.user.userId;

    if (!body) {
      return res.status(400).json({ error: 'Response body is required' });
    }

    // Get the email
    const { data: email, error } = await supabase
      .from('emails')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Create authenticated Gmail client
    const auth = await createAuthenticatedClient(userId);
    const gmail = google.gmail({ version: 'v1', auth });

    // Prepare email message
    const subject = email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;
    const message = [
      `To: ${email.sender}`,
      `Subject: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedMessage = Buffer.from(message).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send email via Gmail API
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    // Mark original email as read
    await supabase
      .from('emails')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId);

    res.json({
      success: true,
      messageId: result.data.id,
      message: 'Response sent successfully'
    });
  } catch (error: any) {
    console.error('Send response error:', error);
    if (error.message.includes('invalid_grant') || error.message.includes('unauthorized')) {
      res.status(401).json({ error: 'Authentication expired. Please login again.' });
    } else {
      res.status(500).json({ error: 'Failed to send response' });
    }
  }
});
/**
 * 📌 Generate stable event signature (ignores time for modifications)
 */
function generateEventSignature(eventData: any): string {
  const base = `${eventData.title || ""}|${eventData.location || ""}|${(eventData.attendees || []).join(",")}`;
  return crypto.createHash("sha256").update(base).digest("hex");
}


/**
 * 📌 Normalize date into ISO string
 */
function normalizeDateTime(value?: string): string {
  if (!value) return new Date().toISOString();
  try {
    return new Date(value).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * 📌 Sync email with calendar
 */
router.post("/:id/sync-calendar", authenticateToken, async (req: any, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // 1️⃣ Fetch email
    const { data: email, error } = await supabase
      .from("emails")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error || !email) {
      return res.status(404).json({ error: "Email not found" });
    }

    // 2️⃣ Check eligibility
    const eligibleCategories = ["Prise de RDV", "Modification", "Annulation"];
    if (!eligibleCategories.includes(email.category)) {
      return res.status(400).json({ error: "Email category not eligible" });
    }

    // 3️⃣ Extract event data with Llama
    const extractionPrompt = `
You are a strict JSON generator. 
Extract the calendar event from this email. 

Respond with ONLY valid JSON:
{
  "title": "string",
  "description": "string",
  "startTime": "ISO 8601 datetime string",
  "endTime": "ISO 8601 datetime string or empty string",
  "location": "string",
  "attendees": ["string"]
}

Subject: ${email.subject}
Body: ${email.body}
Category: ${email.category}
    `.trim();

    let eventData: any = {};
    let rawAiOutput = "";

    try {
      rawAiOutput = await llamaService.generateResponse(extractionPrompt);
      eventData = (llamaService as any).extractJson(rawAiOutput);
    } catch (err: any) {
      console.error("⚠️ Extraction error:", err.message);
      eventData = {};
    }

    // 3b. Safe defaults
    const now = new Date();
    const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
    const extractedEmails = (email.body.match(emailRegex) || []).map((e: string) =>
      e.toLowerCase()
    );

    const defaultAttendees = Array.from(
      new Set([email.sender, ...extractedEmails].filter(Boolean))
    );

    eventData = {
      title: eventData.title || email.subject,
      description: eventData.description || email.body.substring(0, 500),
      startTime:
        eventData.startTime || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      endTime:
        eventData.endTime || new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString(),
      location: eventData.location || "",
      attendees: [...new Set(defaultAttendees)],
    };

    // 4️⃣ Generate event signature
    const eventSignature = generateEventSignature(eventData);

    // 5️⃣ Look for existing event
    const { data: existingEvent } = await supabase
      .from("events")
      .select("*")
      .eq("event_signature", eventSignature)
      .eq("user_id", userId)
      .maybeSingle();


    // 6️⃣ Handle Annulation
    if (email.category === "Annulation") {
      if (existingEvent) {
        try {
          if (existingEvent.google_event_id) {
            const auth = await createAuthenticatedClient(userId);
            const calendar = google.calendar({ version: "v3", auth });
            await calendar.events.delete({
              calendarId: "primary",
              eventId: existingEvent.google_event_id,
            });
          }
        } catch (gErr: any) {
          console.warn("Google event already deleted:", gErr.message);
        }
        await supabase.from("events").delete().eq("id", existingEvent.id);

        return res.json({ success: true, action: "deleted", event: existingEvent });
      }
      return res.json({ success: true, action: "not_found" });
    }

    // 7️⃣ Handle Modification / Update
    if ((email.category === "Modification" || existingEvent) && existingEvent) {
      try {
        if (existingEvent.google_event_id) {
          const auth = await createAuthenticatedClient(userId);
          const calendar = google.calendar({ version: "v3", auth });

          await calendar.events.update({
            calendarId: "primary",
            eventId: existingEvent.google_event_id,
            requestBody: {
              summary: eventData.title,
              description: eventData.description,
              start: { dateTime: normalizeDateTime(eventData.startTime), timeZone: "UTC" },
              end: { dateTime: normalizeDateTime(eventData.endTime), timeZone: "UTC" },
              location: eventData.location,
              attendees: eventData.attendees.map((email: string) => ({ email })),
            },
          });
        }
      } catch (gErr: any) {
        console.warn("Google event update error:", gErr.message);
      }

      const { data: updatedEvent, error: updateError } = await supabase
        .from("events")
        .update({
          title: eventData.title,
          description: eventData.description,
          start_time: normalizeDateTime(eventData.startTime),
          end_time: normalizeDateTime(eventData.endTime),
          location: eventData.location,
          attendees: eventData.attendees,
          raw_ai_output: rawAiOutput,
          event_signature: eventSignature,
          email_id: email.id, // still store this email reference
        })
        .eq("id", existingEvent.id)
        .select()
        .single();

      if (updateError) {
        console.error("Supabase update error:", updateError);
        return res.status(500).json({ error: "Failed to update event" });
      }

      return res.json({ success: true, action: "updated", event: updatedEvent });
    }

    // 8️⃣ Create new event
    const { data: inserted, error: insertError } = await supabase
      .from("events")
      .insert({
        user_id: userId,
        email_id: email.id,
        title: eventData.title,
        description: eventData.description,
        start_time: normalizeDateTime(eventData.startTime),
        end_time: normalizeDateTime(eventData.endTime),
        location: eventData.location,
        attendees: eventData.attendees,
        raw_ai_output: rawAiOutput,
        event_signature: eventSignature,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return res.status(500).json({ error: "Failed to create event" });
    }

    let calendarEvent = inserted;

    // 9️⃣ Push to Google
    try {
      const auth = await createAuthenticatedClient(userId);
      const calendar = google.calendar({ version: "v3", auth });

      const googleEvent = {
        summary: eventData.title,
        description: eventData.description,
        start: { dateTime: normalizeDateTime(eventData.startTime), timeZone: "UTC" },
        end: { dateTime: normalizeDateTime(eventData.endTime), timeZone: "UTC" },
        location: eventData.location,
        attendees: eventData.attendees.map((email: string) => ({ email })),
      };

      const googleResponse = await calendar.events.insert({
        calendarId: "primary",
        requestBody: googleEvent,
      });

      await supabase
        .from("events")
        .update({ google_event_id: googleResponse.data.id })
        .eq("id", calendarEvent.id);

      calendarEvent.google_event_id = googleResponse.data.id;
    } catch (googleError: any) {
      console.error("Google Calendar sync error:", googleError.message);
    }

    res.json({ success: true, action: "created", event: calendarEvent });
  } catch (error: any) {
    console.error("Sync calendar error:", error.message);
    res.status(500).json({ error: "Failed to sync with calendar" });
  }
});


export { router as emailsRouter };

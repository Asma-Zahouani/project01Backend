import express from "express";
import { google } from "googleapis";
import jwt from "jsonwebtoken";
import { supabase } from "../supabase.js";
import { DEFAULT_CATEGORIES } from "../prompts.js";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

// ==========================
// 0. Init OAuth Client safely
// ==========================
function getOAuthClient() {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
  ) {
    throw new Error("❌ Missing Google OAuth environment variables");
  }

  // Pick redirect URI dynamically
  const redirectUri =
    process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL}/api/auth/google/callback`
      : "http://localhost:3001/api/auth/google/callback";

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

// ==========================
// 1. Generate Google OAuth URL
// ==========================
router.get("/google", (_req, res) => {
  try {
    const oauth2Client = getOAuthClient();

    const scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes,
    });

    res.json({ authUrl: url });
  } catch (err: any) {
    console.error("❌ Error generating auth URL:", err.message);
    res.status(500).json({ error: "Failed to generate Google OAuth URL" });
  }
});

// ==========================
// 2. Handle OAuth callback
// ==========================
router.get("/google/callback", async (req, res) => {
  try {
    // ✅ Safely cast and validate the authorization code
    const code = typeof req.query.code === "string" ? req.query.code : null;

    if (!code) {
      return res.status(400).send(`
        <script>
          window.opener.postMessage(
            { error: "No authorization code received" },
            "${process.env.FRONTEND_URL || "http://localhost:5173"}"
          );
          window.close();
        </script>
      `);
    }

    const oauth2Client = getOAuthClient();

    // ✅ Properly get the tokens and destructure them safely
    const tokenResponse = await oauth2Client.getToken({ code });
    const tokens = tokenResponse.tokens;
    oauth2Client.setCredentials(tokens);

    // ✅ Fetch Google user info
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;
    const full_name = userInfo.data.name || null;

    if (!email) {
      throw new Error("❌ Failed to fetch Google account email");
    }

    // ✅ Retrieve or create user in Supabase
    let { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (userError && userError.code !== "PGRST116") {
      throw userError;
    }

    if (!user) {
      // 🆕 New user → insert
      const { data: newUser, error: insertError } = await supabase
        .from("users")
        .insert({ email, full_name })
        .select()
        .single();

      if (insertError) throw insertError;
      user = newUser;

      // Add default categories
      const categories = DEFAULT_CATEGORIES.map((cat) => ({
        user_id: user.id,
        name: cat.name,
        prompt: cat.prompt,
      }));

      const { error: catError } = await supabase
        .from("categories")
        .insert(categories);

      if (catError)
        console.error("⚠️ Failed to insert default categories:", catError);

      console.log(`✅ New user created: ${email} (${full_name})`);
    } else {
      // 🔄 Existing user → merge tokens + update name
      const storedTokens = JSON.parse(user.google_token || "{}");
      const mergedTokens = {
        ...storedTokens,
        ...tokens,
        refresh_token: tokens.refresh_token || storedTokens.refresh_token,
      };

      const { error: updateError } = await supabase
        .from("users")
        .update({
          google_token: JSON.stringify(mergedTokens),
          full_name: user.full_name || full_name,
        })
        .eq("id", user.id);

      if (updateError) throw updateError;

      console.log(`🔄 Updated tokens for user: ${email}`);
    }

    // ✅ Generate JWT
    if (!process.env.JWT_SECRET) {
      throw new Error("❌ JWT_SECRET is missing from environment variables");
    }

    const jwtToken = jwt.sign(
      { userId: user.id, email, full_name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // ✅ Return HTML to frontend
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authentication Success</title></head>
        <body>
          <script>
            window.opener.postMessage(
              { 
                token: "${jwtToken}", 
                user: { 
                  id: "${user.id}", 
                  email: "${email}", 
                  full_name: "${user.full_name || full_name}" 
                } 
              },
              "${process.env.FRONTEND_URL || "http://localhost:5173"}"
            );
            window.close();
          </script>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error("❌ Auth callback error:", error.message);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authentication Error</title></head>
        <body>
          <script>
            window.opener.postMessage(
              { error: "Authentication failed: ${error.message}" },
              "${process.env.FRONTEND_URL || "http://localhost:5173"}"
            );
            window.close();
          </script>
        </body>
      </html>
    `);
  }
});


// ==========================
// 3. JWT Verification Middleware
// ==========================
export function authenticateToken(req: any, res: any, next: any) {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.split(" ")[1];
  if (!token) return res.sendStatus(401);

  const jwtSecret = process.env.JWT_SECRET || "defaultsecret";
  jwt.verify(token, jwtSecret, (err: any, decoded: any) => {
    if (err) return res.sendStatus(403);
    req.user = decoded;
    next();
  });
}

export { router as authRouter };

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("❌ Missing Supabase credentials in .env");
}

// ⚡ Client Supabase backend (avec SERVICE ROLE KEY)
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ==================
// Types (équivalents de tes interfaces)
// ==================
export interface User {
  id: number;
  email: string;
  google_token: string | null;
  created_at: string;
}

export interface Category {
  id: number;
  user_id: number;
  name: string;
  prompt: string;
}

export interface Email {
  id: number;
  user_id: number;
  gmail_id: string;
  subject: string;
  body: string;
  category: string | null;
  processed_at: string | null;
  snippet?: string | null;
  sender?: string | null;
}

export interface Event {
  id: number;
  user_id: number;
  calendar_id: string;
  title: string;
  start_time: string;
  end_time: string;
  status: string;
}

// ==================
// Fonction d’init
// ==================
export async function initDatabase() {
  console.log("⚡ Supabase client initialized – tables must be created in Supabase directly.");
}

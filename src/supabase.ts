import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Recreate __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

console.log(process.env.SUPABASE_URL!);

// Variables backend
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;


if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('❌ Missing Supabase environment variables');
}

// Client Supabase backend (service role key)
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// --------------------
// Database interfaces
// --------------------
export interface Email {
  id: string;               // uuid
  user_id: string;          // uuid
  gmail_id: string;
  subject: string;
  body: string;
  snippet?: string;
  sender?: string;
  category?: string;
  is_read?: boolean;
  processed_at?: string;
  created_at?: string;
  updated_at?: string | null;
}

export interface Category {
  id: string;               // uuid
  user_id: string;          // uuid
  name: string;
  prompt: string;
  created_at?: string;
}

export interface Event {
  id: string;               // uuid
  user_id: string;          // uuid
  email_id: string;         // uuid (FK to emails.id)
  google_event_id?: string | null;
  event_signature: string;  // unique identifier (google_event_id OR fallback)
  title: string;
  description?: string;
  start_time: string;       // ISO timestamp
  end_time: string;         // ISO timestamp
  location?: string;
  attendees: string[];      // stored as array of emails
  raw_ai_output?: string | null;
  created_at?: string;
  updated_at?: string;
}


export interface User {
  id: string;               // uuid
  email: string;
  google_token?: string;
  gmail_history_id?: string; 
  created_at: string;
}

import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(url && anonKey);

// If env vars aren't set (e.g. someone forks this and hasn't configured
// Supabase yet), the app should still work fully in visitor/local mode -
// it just can't offer login. supabase stays null in that case.
export const supabase = hasSupabaseConfig ? createClient(url, anonKey) : null;

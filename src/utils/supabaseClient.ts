import { createClient, type SupabaseClient, type Session, type AuthChangeEvent } from '@supabase/supabase-js';
import { isGoogleOAuthEnabled } from './authOptions';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
const googleOAuthEnabled = isGoogleOAuthEnabled(Boolean(supabaseUrl && supabaseKey), import.meta.env.VITE_SUPABASE_GOOGLE_OAUTH_ENABLED);

let clientInstance: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseKey);
}

export function isGoogleOAuthConfigured(): boolean {
  return googleOAuthEnabled;
}

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!clientInstance) {
    clientInstance = createClient(supabaseUrl, supabaseKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'uptoskills-supabase-auth-token',
      },
    });
  }
  return clientInstance;
}

export async function getAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data: { session }, error } = await client.auth.getSession();
    if (error || !session) return null;
    return session.access_token;
  } catch {
    return null;
  }
}

export async function getCurrentUser() {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return null;
    return user;
  } catch {
    return null;
  }
}

export async function signUpWithEmail(email: string, password: string, redirectTo?: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase authentication is not configured.');
  return client.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectTo || (typeof window !== 'undefined' ? `${window.location.origin}` : undefined),
    },
  });
}

export async function signInWithEmail(email: string, password: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase authentication is not configured.');
  return client.auth.signInWithPassword({
    email,
    password,
  });
}

export async function signInWithGoogle(redirectTo?: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase authentication is not configured.');
  if (!googleOAuthEnabled) throw new Error('Google sign-in is not enabled for this deployment.');
  return client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectTo || (typeof window !== 'undefined' ? `${window.location.origin}` : undefined),
    },
  });
}

export async function resendSignUpVerification(email: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase authentication is not configured.');
  return client.auth.resend({ type: 'signup', email: email.trim() });
}

export async function signOut() {
  const client = getSupabaseClient();
  if (!client) return;
  return client.auth.signOut();
}

export async function sendPasswordResetEmail(email: string, redirectTo?: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase authentication is not configured.');
  return client.auth.resetPasswordForEmail(email, {
    redirectTo: redirectTo || (typeof window !== 'undefined' ? `${window.location.origin}` : undefined),
  });
}

export async function updatePassword(newPassword: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase authentication is not configured.');
  return client.auth.updateUser({
    password: newPassword,
  });
}

export function onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void) {
  const client = getSupabaseClient();
  if (!client) return { data: { subscription: { unsubscribe: () => {} } } };
  return client.auth.onAuthStateChange(callback);
}

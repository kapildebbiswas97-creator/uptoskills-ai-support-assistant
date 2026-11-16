export function isGoogleOAuthEnabled(
  supabaseConfigured: boolean,
  enableFlag: string | undefined
): boolean {
  return supabaseConfigured && enableFlag?.trim().toLowerCase() === 'true';
}

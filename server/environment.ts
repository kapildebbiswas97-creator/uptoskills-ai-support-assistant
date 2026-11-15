const APP_ROLES = new Set(['super_admin', 'admin', 'support_agent', 'knowledge_manager', 'user']);

export interface EnvironmentValidation {
  valid: boolean;
  issues: string[];
}

export function isStagingRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.APP_ENV?.toLowerCase() === 'staging' ||
    environment.NODE_ENV?.toLowerCase() === 'staging' ||
    environment.VERCEL_ENV?.toLowerCase() === 'preview';
}

export function requiresAuthenticatedChat(environment: NodeJS.ProcessEnv = process.env): boolean {
  const anonymousOverride = environment.ALLOW_ANONYMOUS_CHAT?.trim().toLowerCase();
  const production = environment.NODE_ENV?.toLowerCase() === 'production' || environment.VERCEL_ENV?.toLowerCase() === 'production';
  if (anonymousOverride === 'true' && !production && (!isStagingRuntime(environment) || environment.ANONYMOUS_CHAT_APPROVED?.trim().toLowerCase() === 'true')) return false;
  if (anonymousOverride === 'false') return true;
  return isStagingRuntime(environment) || environment.NODE_ENV?.toLowerCase() === 'production' ||
    environment.VERCEL_ENV?.toLowerCase() === 'production';
}

export function validateEnvironment(environment: NodeJS.ProcessEnv = process.env, staging = false): EnvironmentValidation {
  const issues: string[] = [];
  const present = (name: string) => Boolean(environment[name]?.trim());
  const requireOne = (names: string[], label: string) => {
    if (!names.some(present)) issues.push(`${label} is required`);
  };
  const pairs: Array<[string, string]> = [
    ['MONGODB_URI', 'MONGODB_DATABASE'],
    ['MALWARE_SCANNER_URL', 'MALWARE_SCANNER_TOKEN'],
  ];
  for (const [left, right] of pairs) {
    if (present(left) !== present(right)) issues.push(`${left} and ${right} must be configured together`);
  }
  const supabaseConfigured = present('SUPABASE_URL');
  const oidc = supabaseConfigured || ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'].some(present);
  if (oidc && !supabaseConfigured && (!present('AUTH_ISSUER') || !present('AUTH_AUDIENCE'))) issues.push('AUTH_ISSUER and AUTH_AUDIENCE are required together');
  if (environment.NODE_ENV === 'production' && oidc && !present('AUTH_ROLE_MAPPING')) issues.push('AUTH_ROLE_MAPPING is required when OIDC is enabled in production');
  if (present('AUTH_ISSUER')) validateHttpsUrl(environment.AUTH_ISSUER!, 'AUTH_ISSUER', environment.NODE_ENV, issues);
  if (present('AUTH_JWKS_URL')) validateHttpsUrl(environment.AUTH_JWKS_URL!, 'AUTH_JWKS_URL', environment.NODE_ENV, issues);
  if (present('SUPABASE_URL')) validateHttpsUrl(environment.SUPABASE_URL!, 'SUPABASE_URL', environment.NODE_ENV, issues);
  if (present('VITE_SUPABASE_URL')) validateHttpsUrl(environment.VITE_SUPABASE_URL!, 'VITE_SUPABASE_URL', environment.NODE_ENV, issues);
  if (present('MALWARE_SCANNER_URL')) validateHttpsUrl(environment.MALWARE_SCANNER_URL!, 'MALWARE_SCANNER_URL', environment.NODE_ENV, issues);
  if (present('MONGODB_URI')) {
    try {
      const uri = new URL(environment.MONGODB_URI!);
      if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol)) issues.push('MONGODB_URI must use mongodb:// or mongodb+srv://');
    } catch {
      issues.push('MONGODB_URI must be a valid MongoDB connection URL');
    }
  }
  if (present('AUTH_ROLE_MAPPING')) {
    try {
      const mapping: unknown = JSON.parse(environment.AUTH_ROLE_MAPPING!);
      if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping) ||
          Object.values(mapping).some((role) => typeof role !== 'string' || !APP_ROLES.has(role))) {
        issues.push('AUTH_ROLE_MAPPING must be a JSON object mapping trusted provider roles to supported application roles');
      }
    } catch {
      issues.push('AUTH_ROLE_MAPPING must be valid JSON');
    }
  }
  if (present('ALLOW_ANONYMOUS_CHAT') && !['true', 'false'].includes(environment.ALLOW_ANONYMOUS_CHAT!.trim().toLowerCase())) {
    issues.push('ALLOW_ANONYMOUS_CHAT must be true or false');
  }
  if (present('ANONYMOUS_CHAT_APPROVED') && !['true', 'false'].includes(environment.ANONYMOUS_CHAT_APPROVED!.trim().toLowerCase())) {
    issues.push('ANONYMOUS_CHAT_APPROVED must be true or false');
  }
  if (present('DATABASE_URL') && !isPostgresUrl(environment.DATABASE_URL!)) issues.push('DATABASE_URL must use postgres:// or postgresql://');
  if (present('DATABASE_INGEST_URL') && !isPostgresUrl(environment.DATABASE_INGEST_URL!)) issues.push('DATABASE_INGEST_URL must use postgres:// or postgresql://');
  if (present('DATABASE_MIGRATION_URL') && !isPostgresUrl(environment.DATABASE_MIGRATION_URL!)) issues.push('DATABASE_MIGRATION_URL must use postgres:// or postgresql://');
  if (present('DATABASE_URL') && postgresUsername(environment.DATABASE_URL!) !== 'uts_assistant_reader') {
    issues.push('DATABASE_URL must authenticate as the least-privilege uts_assistant_reader role');
  }
  if (present('DATABASE_INGEST_URL') && postgresUsername(environment.DATABASE_INGEST_URL!) !== 'uts_assistant_writer') {
    issues.push('DATABASE_INGEST_URL must authenticate as the least-privilege uts_assistant_writer role');
  }
  const postgresRuntimeConfigured = present('DATABASE_URL') || present('DATABASE_INGEST_URL');
  if (postgresRuntimeConfigured && !present('RLS_CONTEXT_KEY_ID')) issues.push('RLS_CONTEXT_KEY_ID is required when PostgreSQL runtime access is configured');
  if (postgresRuntimeConfigured && !present('RLS_CONTEXT_HMAC_KEY')) issues.push('RLS_CONTEXT_HMAC_KEY is required when PostgreSQL runtime access is configured');
  if (present('RLS_CONTEXT_KEY_ID') && !/^[A-Za-z0-9_-]{1,40}$/.test(environment.RLS_CONTEXT_KEY_ID!.trim())) {
    issues.push('RLS_CONTEXT_KEY_ID must contain 1–40 letters, digits, underscores, or hyphens');
  }
  if (present('RLS_CONTEXT_HMAC_KEY')) {
    const encodedKey = environment.RLS_CONTEXT_HMAC_KEY!.trim();
    const keyBytes = Buffer.from(encodedKey, 'base64url');
    if (keyBytes.length !== 32 || keyBytes.toString('base64url') !== encodedKey) {
      issues.push('RLS_CONTEXT_HMAC_KEY must be a canonical base64url encoding of 32 random bytes');
    }
  }
  if (present('EMBEDDING_DIMENSIONS') && environment.EMBEDDING_DIMENSIONS !== '768') issues.push('EMBEDDING_DIMENSIONS must be 768 for the current PostgreSQL vector schema');
  if (present('EMBEDDING_VERSION') && (!/^\d+$/.test(environment.EMBEDDING_VERSION!) || Number(environment.EMBEDDING_VERSION) < 1)) issues.push('EMBEDDING_VERSION must be a positive integer');
  const secureDeployment = environment.NODE_ENV === 'production' || isStagingRuntime(environment);
  if (secureDeployment && present('MONGODB_URI') && !environment.MONGODB_URI!.startsWith('mongodb+srv://') && !/[?&](?:tls|ssl)=true/i.test(environment.MONGODB_URI!)) {
    issues.push('Staging and production MONGODB_URI must use Atlas SRV or explicitly enable TLS');
  }
  for (const name of ['DATABASE_URL', 'DATABASE_INGEST_URL']) {
    if (secureDeployment && present(name) && !/[?&]sslmode=(?:require|verify-ca|verify-full)/i.test(environment[name]!)) {
      issues.push(`${name} must require TLS in staging and production`);
    }
  }

  if (staging) {
    for (const name of ['MONGODB_URI', 'MONGODB_DATABASE', 'DATABASE_URL', 'DATABASE_INGEST_URL', 'AUTH_ROLE_MAPPING', 'MALWARE_SCANNER_URL', 'MALWARE_SCANNER_TOKEN']) {
      requireOne([name], name);
    }
    requireOne(['AUTH_ISSUER', 'SUPABASE_URL'], 'AUTH_ISSUER');
    requireOne(['AUTH_AUDIENCE', 'SUPABASE_URL'], 'AUTH_AUDIENCE');
    requireOne(['GEMINI_API_KEY', 'GOOGLE_API_KEY'], 'A Gemini embedding API key');
    requireOne(['OPENROUTER_API_KEY', 'AI_API_KEY', 'GROQ_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CEREBRAS_API_KEY', 'NVIDIA_API_KEY', 'MISTRAL_API_KEY', 'REQUESTY_API_KEY'], 'A supported AI provider API key');
    requireOne(['RLS_CONTEXT_KEY_ID'], 'RLS_CONTEXT_KEY_ID');
    requireOne(['RLS_CONTEXT_HMAC_KEY'], 'RLS_CONTEXT_HMAC_KEY');
    if (environment.ALLOW_ANONYMOUS_CHAT?.trim().toLowerCase() === 'true' && environment.ANONYMOUS_CHAT_APPROVED?.trim().toLowerCase() !== 'true') {
      issues.push('ALLOW_ANONYMOUS_CHAT requires ANONYMOUS_CHAT_APPROVED=true for isolated staging verification');
    }
  }
  return { valid: issues.length === 0, issues };
}

function isPostgresUrl(value: string): boolean {
  try { return ['postgres:', 'postgresql:'].includes(new URL(value).protocol); } catch { return false; }
}

function postgresUsername(value: string): string | undefined {
  try { return decodeURIComponent(new URL(value).username); } catch { return undefined; }
}

function validateHttpsUrl(value: string, name: string, nodeEnv: string | undefined, issues: string[]): void {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const allowedLocal = nodeEnv !== 'production' && loopback && url.protocol === 'http:';
    if ((url.protocol !== 'https:' && !allowedLocal) || url.username || url.password) issues.push(`${name} must be an HTTPS URL without embedded credentials`);
  } catch {
    issues.push(`${name} must be an absolute HTTPS URL`);
  }
}

export function assertRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  requireCompleteStagingConfiguration = isStagingRuntime(environment)
): void {
  const result = validateEnvironment(environment, requireCompleteStagingConfiguration);
  if (!result.valid) throw new Error(`Invalid application environment: ${result.issues.join('; ')}`);
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/server/environment.ts')) {
  void import('dotenv/config').then(() => {
    const staging = process.argv.includes('--staging');
    const result = validateEnvironment(process.env, staging);
    if (!result.valid) {
      process.stderr.write(`Environment validation failed:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Environment validation passed (${staging ? 'staging' : 'configured values'}).\n`);
  });
}

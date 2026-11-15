import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = path.join(root, 'node_modules', '.cache');
await mkdir(cacheRoot, { recursive: true });
const tempDir = await mkdtemp(path.join(cacheRoot, 'vercel-esm-check-'));
try {
  const outputDir = path.join(tempDir, 'api');
  await mkdir(outputDir);
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['api/[...path].ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    packages: 'external',
    metafile: true,
    outdir: outputDir,
    entryNames: 'index',
    outExtension: { '.js': '.mjs' },
  });
  const errors = [];
  const pdfPackagePattern = /^(?:pdf-parse(?:\/.*)?|pdfjs-dist(?:\/.*)?|@napi-rs\/canvas(?:-.*)?)$/;
  const inputs = Object.entries(result.metafile.inputs);
  for (const [input, details] of inputs) {
    for (const edge of details.imports) {
      if (edge.external && pdfPackagePattern.test(edge.path) && edge.kind !== 'dynamic-import') {
        errors.push(`${input}: PDF runtime dependency '${edge.path}' is eagerly loaded with ${edge.kind}`);
      }
      if (edge.external || !edge.original?.startsWith('.')) continue;
      const extension = path.extname(edge.original);
      if (!['.js', '.mjs', '.cjs'].includes(extension)) {
        errors.push(`${input}: relative ${edge.kind} '${edge.original}' is extensionless or lacks an explicit JavaScript extension`);
      }
    }
  }
  if (errors.length) throw new Error(`Serverless ESM import graph failed (${inputs.length} source modules):\n${errors.map((error) => `- ${error}`).join('\n')}`);

  await cp(path.join(root, 'knowledge.yaml'), path.join(tempDir, 'knowledge.yaml'));
  const environmentNames = [
    'NODE_ENV', 'VERCEL_ENV', 'MONGODB_URI', 'MONGODB_DATABASE', 'DATABASE_URL', 'DATABASE_INGEST_URL', 'DATABASE_MIGRATION_URL',
    'RLS_CONTEXT_KEY_ID', 'RLS_CONTEXT_HMAC_KEY', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'AUTH_ROLE_MAPPING',
    'OPENROUTER_API_KEY', 'AI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID', 'CEREBRAS_API_KEY', 'NVIDIA_API_KEY', 'MISTRAL_API_KEY', 'REQUESTY_API_KEY', 'REDIS_URL',
  ];
  const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  process.env.NODE_ENV = 'production';
  process.env.VERCEL_ENV = 'preview';
  const previousCwd = process.cwd();
  const attemptedPdfImports = [];
  const pdfImportGuard = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (pdfPackagePattern.test(specifier)) {
        attemptedPdfImports.push(specifier);
        throw new Error('PDF dependency must not load during serverless handler initialization');
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    // Keep this startup test independent from any PDFs a contributor may have
    // added to the repository docs directory.
    process.chdir(tempDir);
    const outputFile = path.join(outputDir, 'index.mjs');
    const { default: handler } = await import(pathToFileURL(outputFile).href);
    const server = createServer((request, response) => { void handler(request, response); });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local runtime smoke server has no TCP address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const healthResponse = await fetch(`${baseUrl}/api/health`);
      if (healthResponse.status !== 503) throw new Error(`/api/health must report missing Preview dependencies with HTTP 503, got ${healthResponse.status}`);
      const health = await healthResponse.json();
      if (health.status !== 'degraded' || health.databases?.mongo !== 'not_configured' || health.databases?.postgres !== 'not_configured') throw new Error('/api/health did not report missing Preview dependencies accurately');
      const routes = [
        ['/api/session', 'GET'], ['/api/models', 'GET'], ['/api/escalations', 'POST'],
        ['/api/meeting-requests', 'POST'], ['/api/chat', 'POST'], ['/api/chat/stream', 'POST'],
      ];
      for (const [url, method] of routes) {
        const response = await fetch(`${baseUrl}${url}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'runtime-check' }) } : {}) });
        if (response.status !== 401) throw new Error(`${method} ${url} must reject unauthenticated Preview access with HTTP 401, got ${response.status}`);
      }
      if (attemptedPdfImports.length) throw new Error(`Serverless initialization loaded PDF parser dependencies: ${attemptedPdfImports.join(', ')}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    process.chdir(previousCwd);
    pdfImportGuard.deregister();
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  process.stdout.write(`Serverless ESM verification passed: ${inputs.length} source modules bundled to Node 26 ESM; runtime ${process.version} loaded the output, missing Preview integrations returned health 503, and six protected routes returned 401.\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

export const VERCEL_ORIGINAL_API_PATH = '__vercelOriginalApiPath';

/**
 * Restore the URL rewritten to the single Vercel function entrypoint.
 * Vercel carries the matched API path as a query parameter; the remaining
 * query parameters are retained and passed to Express in their original order.
 */
export function restoreRewrittenApiPath(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return undefined;

  let rewritten: URL;
  try {
    rewritten = new URL(requestUrl, 'http://vercel.internal');
  } catch {
    return undefined;
  }

  const routeValues = rewritten.searchParams.getAll(VERCEL_ORIGINAL_API_PATH);
  if (routeValues.length === 0) return undefined;

  // The rewrite destination contributes its value before preserved incoming
  // query parameters. Select that first value and keep any caller-supplied
  // parameter with the same name in the reconstructed query string.
  const routePath = routeValues[0].replace(/^\/+/, '');
  const segments = routePath.split('/');
  if (!routePath || segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;

  const entries = [...rewritten.searchParams.entries()];
  const internalIndex = entries.findIndex(([key, value]) => key === VERCEL_ORIGINAL_API_PATH && value === routeValues[0]);
  if (internalIndex < 0) return undefined;
  entries.splice(internalIndex, 1);

  const remainingQuery = new URLSearchParams(entries).toString();
  const restoredPath = `/api/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  return remainingQuery ? `${restoredPath}?${remainingQuery}` : restoredPath;
}

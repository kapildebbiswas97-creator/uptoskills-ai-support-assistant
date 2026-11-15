import express, { type RequestHandler } from 'express';

const MAX_JSON_BODY_BYTES = 4.2 * 1024 * 1024;
const MAX_WORKFLOW_BODY_BYTES = 16 * 1024;

function bodyLimitForPath(path: string): number {
  return path === '/api/escalations' || path.startsWith('/api/escalations/') ||
    path.startsWith('/api/meeting-requests') || path.startsWith('/api/admin/meeting-requests')
    ? MAX_WORKFLOW_BODY_BYTES
    : MAX_JSON_BODY_BYTES;
}

export function createRequestBodyParser(): RequestHandler {
  const parseJson = express.json({
    limit: MAX_JSON_BODY_BYTES,
    verify: (request, _response, body) => {
      const path = request.url?.split('?')[0] || '';
      if (body.byteLength > bodyLimitForPath(path)) {
        const error = new Error('Request body too large') as Error & { status: number };
        error.status = 413;
        throw error;
      }
    },
  });

  return (request, response, next) => {
    let parsedBody: unknown;
    try {
      // On Vercel this is a lazy getter that parses the body when accessed.
      parsedBody = request.body;
    } catch {
      return response.status(400).json({ error: 'Invalid request body' });
    }

    // Vercel's Node adapter may parse JSON and consume the incoming stream
    // before invoking the function. Keep that parsed body and enforce the
    // same limits instead of asking body-parser to read a consumed stream.
    if (parsedBody !== undefined || request.readableEnded || !request.readable) {
      if (parsedBody !== undefined) request.body = parsedBody;
      const contentLength = Number(request.get('content-length'));
      let byteLength = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined;
      if (byteLength === undefined && parsedBody !== undefined) {
        try {
          const serialized = JSON.stringify(parsedBody);
          if (serialized !== undefined) byteLength = Buffer.byteLength(serialized);
        } catch {
          return response.status(400).json({ error: 'Invalid request body' });
        }
      }

      if (byteLength !== undefined && byteLength > bodyLimitForPath(request.url?.split('?')[0] || '')) {
        return response.status(413).json({ error: 'Request body is too large' });
      }
      return next();
    }

    return parseJson(request, response, next);
  };
}

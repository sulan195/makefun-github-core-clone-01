// http.ts — shared HTTP helpers for the forge's surfaces.
//
// Every response the forge sends is JSON and carries a non-empty
// X-GitHub-Request-Id header. Bodies are read with an explicit byte cap;
// a body that exceeds it is rejected before it is parsed.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Monotonic request ids (`req-1`, `req-2`, ...): unique and deterministic. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Read a request body fully, up to `maxBytes` (default 10 MiB). */
export function readBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** The path of a request URL, or '/' when it does not parse (never throws). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The bearer token of a request, or null when no Authorization header is present. */
export function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(auth.trim());
  return match === null ? null : match[1];
}

/** True when the request carries exactly the trial token. */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return false;
  const presented = bearerToken(req);
  return presented !== null && presented === token;
}

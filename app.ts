// app.ts — the forge's HTTP server and router.
//
// One process serves all four surfaces from one Store:
//   GET  /healthz                 the env's boot probe (no auth)
//   /api/v3/*                     GitHub REST v3
//   POST /api/graphql             GitHub GraphQL v4
//   POST /mcp                     Model Context Protocol (Streamable HTTP)
//   /<owner>/<repo>.git/*         git smart HTTP
//   anything else                 404 JSON, never HTML
//
// The server binds nothing until the caller listens; main.ts listens on an
// ephemeral port. The token is read once from MAKEFUN_SHOP_TOKEN at startup.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathOf, readBody, sendJson } from './http.ts';

/** A git smart-HTTP path: /<owner>/<repo>.git[/...]. */
const GIT_PATH = /^\/[^/]+\/[^/]+\.git(\/.*)?$/;

async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store, token: string): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP reads its own (possibly large, binary) body.
  if (GIT_PATH.test(path)) {
    const handled = await handleGit(req, res, store, token);
    if (handled) return;
  }

  // Every other surface takes a JSON body (or none for GET/DELETE).
  let body = Buffer.alloc(0);
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'Request body too large' });
      return;
    }
  }

  if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
    const handled = await handleGraphql(req, res, store, token, body);
    if (handled) return;
  }

  if (path === '/mcp' || path.startsWith('/mcp/')) {
    const handled = await handleMcp(req, res, store, token, body);
    if (handled) return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const handled = await handleRest(req, res, store, token, body);
    if (handled) return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    dispatch(req, res, store, token).catch((err: unknown) => {
      // Never crash the process on one bad request; never leak a stack.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    });
  });
}

// createApp(): the forge's HTTP server. One process, one in-memory store, four surfaces:
// git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL v4 at /api/graphql and
// MCP at /mcp. main.ts owns the lifecycle (bind, register, poll done); this file owns the wire.
// Every reply carries a non-empty X-GitHub-Request-Id; every API reply is JSON, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, Store } from './src/store.ts';
import { bearerOf, nextRequestId, sendJson } from './src/http.ts';
import { handleRest } from './src/rest.ts';
import { handleGit } from './src/githttp.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** The smart-HTTP path shape: /{owner}/{repo}.git/{suffix}. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/;

interface SurfaceContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly authed: boolean;
}

/** Render a thrown error as the JSON body its status calls for; the server always stays up. */
function renderError(res: ServerResponse, err: unknown): void {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
  const message = err instanceof Error && status !== 500 ? err.message : status === 500 ? 'Internal server error' : String(err);
  if (status === 500) process.stderr.write(`[gforge] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  if (!res.headersSent) sendJson(res, status, { message });
  else res.end();
}

async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store, shopToken: string): Promise<void> {
  res.setHeader('x-github-request-id', nextRequestId());
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot probe: no auth, twice.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const bearer = bearerOf(req);
  const authed = bearer !== null && (shopToken === '' || bearer === shopToken);
  const ctx: SurfaceContext = { req, res, url, store, authed };

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(ctx);
    return;
  }
  if (path === '/api/graphql') {
    await handleGraphQL(ctx);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(ctx);
    return;
  }
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    await handleGit({ ...ctx, owner: decodeURIComponent(gitMatch[1]!), repo: decodeURIComponent(gitMatch[2]!), suffix: gitMatch[3] ?? '' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    void dispatch(req, res, store, shopToken).catch((err: unknown) => renderError(res, err));
  });
  // Keep-alive is the read benchmark's transport; give idle sockets a generous window.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.on('clientError', (_err, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n');
  });
  return server;
}

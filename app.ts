// The forge's HTTP server: one process, standard library only (node:http).
// Routes: GET /healthz (no auth), git smart HTTP under /{owner}/{repo}.git/...,
// REST v3 under /api/v3, GraphQL at /api/graphql, MCP at /mcp, JSON 404 elsewhere.
// Every API call carries Authorization: Bearer $MAKEFUN_SHOP_TOKEN; when that
// variable is set the token must match it exactly, otherwise any non-empty
// bearer token is accepted. Every reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/githttp.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { VIEWER } from './src/scenario.ts';
import { ForgeStore } from './src/store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, contentType: string, body: Buffer | null, headers?: Record<string, string>): void {
  const allHeaders: Record<string, string> = { 'content-type': contentType, ...(headers ?? {}) };
  if (body === null) {
    response.writeHead(status, allHeaders);
    response.end();
    return;
  }
  allHeaders['content-length'] = String(body.length);
  response.writeHead(status, allHeaders);
  response.end(body);
}

function jsonError(response: ServerResponse, requestId: string, status: number, message: string): void {
  send(response, status, 'application/json', Buffer.from(JSON.stringify({ message }), 'utf8'), { 'X-GitHub-Request-Id': requestId });
}

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  if (expected) return token === expected;
  return true;
}

export function createApp(): Server {
  const store = new ForgeStore();
  const server = createServer((request, response) => {
    void (async () => {
      const requestId = store.nextRequestId();
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
        const method = (request.method ?? 'GET').toUpperCase();
        const segments = url.pathname.split('/').filter(Boolean);
        const baseUrl = `http://${request.headers.host ?? '127.0.0.1'}`;

        if (method === 'GET' && url.pathname === '/healthz') {
          send(response, 200, 'application/json', Buffer.from(JSON.stringify({ ok: true }), 'utf8'), { 'X-GitHub-Request-Id': requestId });
          return;
        }

        if (!isAuthorized(request)) {
          jsonError(response, requestId, 401, 'Requires authentication');
          return;
        }

        const body = await readBody(request);

        // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
        if (segments.length >= 2 && segments[1]?.endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
          if (!repo) {
            jsonError(response, requestId, 404, 'Not Found');
            return;
          }
          const gitPath = segments.slice(2).join('/');
          if (method === 'GET' && gitPath === 'info/refs') {
            const result = handleInfoRefs(store, repo, url.searchParams.get('service'), request.headers['git-protocol'] ?? null);
            send(response, result.status, result.contentType, result.body, { 'X-GitHub-Request-Id': requestId });
            return;
          }
          if (method === 'POST' && gitPath === 'git-upload-pack') {
            try {
              const result = handleUploadPack(store, repo, body, request.headers['git-protocol'] ?? null);
              send(response, result.status, result.contentType, result.body, { 'X-GitHub-Request-Id': requestId });
            } catch (err) {
              jsonError(response, requestId, 400, `malformed upload-pack request: ${(err as Error).message}`);
            }
            return;
          }
          if (method === 'POST' && gitPath === 'git-receive-pack') {
            const result = handleReceivePack(store, repo, body);
            send(response, result.status, result.contentType, result.body, { 'X-GitHub-Request-Id': requestId });
            return;
          }
          jsonError(response, requestId, 404, 'Not Found');
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const reply = handleRest({
            store,
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            baseUrl,
            rawBody: body,
          });
          send(response, reply.status, reply.contentType, reply.body, {
            'X-GitHub-Request-Id': requestId,
            ...(reply.headers ?? {}),
          });
          return;
        }

        // GraphQL.
        if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          const result = handleGraphQL(store, body.toString('utf8'));
          send(response, result.status, 'application/json', Buffer.from(JSON.stringify(result.body), 'utf8'), { 'X-GitHub-Request-Id': requestId });
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            jsonError(response, requestId, 405, 'Method not allowed');
            return;
          }
          const result = handleMcp(store, body.toString('utf8'));
          if (result.body === null) {
            send(response, result.status, 'application/json', null, { 'X-GitHub-Request-Id': requestId });
          } else {
            send(response, result.status, 'application/json', result.body, { 'X-GitHub-Request-Id': requestId });
          }
          return;
        }

        jsonError(response, requestId, 404, 'Not Found');
      } catch (err) {
        try {
          jsonError(response, requestId, 500, (err as Error).message);
        } catch {
          response.destroy();
        }
      }
    })();
  });
  return server;
}

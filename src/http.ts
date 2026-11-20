// Shared HTTP plumbing: JSON replies with the request-id header, body reads with a size cap,
// bearer-token extraction. Every reply the forge sends goes through here.

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body the forge accepts (a push pack is a few MB at most). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** A non-empty, deterministic request id (a counter, never a clock or a random draw). */
export function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(8, '0').toUpperCase();
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-length': 0, ...headers });
  res.end();
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

/** Read the whole request body; null when it is past the cap. */
export async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The bearer token of a request, or null when it carries none. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** Parse a JSON body: {} when empty, an ApiError-shaped throw when malformed. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> {
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Problems parsing JSON'), { status: 400 });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Object.assign(new Error('Body should be a JSON object'), { status: 400 });
  }
  return value as Record<string, unknown>;
}

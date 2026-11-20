// Git smart HTTP at /{owner}/{repo}.git:
//   GET  /info/refs?service=git-upload-pack   — protocol v2 advertisement when the client sends
//        Git-Protocol: version=2, v0 otherwise (side-band-64k, shallow, symref).
//   POST /git-upload-pack                     — v2 commands ls-refs and fetch (shallow/deepen),
//        plus the v0 want/have negotiation. Packfiles are generated delta-free and cached by the
//        exact object set they carry, so repeated clones of the same tip reuse one pack.
//   GET  /info/refs?service=git-receive-pack  — v0 advertisement: report-status, side-band-64k,
//        delete-refs.
//   POST /git-receive-pack                    — command list + pack; objects are indexed, refs move
//        fast-forward only, and every command answers one report-status line (ok / ng).
// A missing repository is a 404 on both services; the server always stays up.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Repo, type Store } from './store.ts';
import { ZERO_OID, collectReachable, commitWalk, isObjectId, parseCommit, peel } from './git.ts';
import { decodePackets, packetLines, pktDelim, pktFlush, pktLine, readPack, sidebandPack, writePack, type Packet } from './pack.ts';
import { readBody, sendBuffer } from './http.ts';

export interface GitContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly authed: boolean;
  readonly owner: string;
  readonly repo: string;
  readonly suffix: string;
}

const AGENT = 'gforge/1.0';
const UPLOAD_CAPS_V0 = `multi_ack multi_ack_detailed thin-pack ofs-delta side-band-64k shallow no-progress include-tag agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;

/** Packs are immutable and content-addressed: cache them by repo + the exact oid set they carry. */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 256;

function cachedPack(store: Store, repo: Repo, oids: readonly string[]): Buffer {
  const sorted = [...oids].sort();
  const key = `${repo.id}:${sorted.join(',')}`;
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const objects = sorted.map((oid) => store.objects.get(oid)).filter((object): object is NonNullable<typeof object> => object !== undefined);
  const pack = writePack(objects);
  if (packCache.size >= PACK_CACHE_MAX) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

export async function handleGit(ctx: GitContext): Promise<void> {
  const repo = ctx.store.findRepo(ctx.owner, ctx.repo);
  if (!repo) throw new ApiError(404, 'Repository not found');
  if (!ctx.authed) throw new ApiError(401, 'Authentication required');
  const method = ctx.req.method ?? 'GET';
  const suffix = ctx.suffix;

  if (method === 'GET' && suffix === 'info/refs') {
    const service = ctx.url.searchParams.get('service');
    if (service === 'git-upload-pack') return advertiseUpload(ctx, repo);
    if (service === 'git-receive-pack') return advertiseReceive(ctx, repo);
    throw new ApiError(403, 'Invalid service');
  }
  if (method === 'POST' && suffix === 'git-upload-pack') return uploadPack(ctx, repo);
  if (method === 'POST' && suffix === 'git-receive-pack') return receivePack(ctx, repo);
  throw new ApiError(404, 'Not Found');
}

// ---------------------------------------------------------------- advertisements

/** The ref lines a v0 advertisement carries: HEAD first, then heads and tags, peeled tags after. */
function v0RefLines(store: Store, repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (headSha === undefined && refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps} ${symref}\n`));
    return lines;
  }
  let first = true;
  if (headSha !== undefined) {
    lines.push(pktLine(`${headSha} HEAD\u0000${caps} ${symref}\n`));
    first = false;
  }
  for (const [ref, oid] of refs) {
    if (first) {
      lines.push(pktLine(`${oid} ${ref}\u0000${caps} ${symref}\n`));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${ref}\n`));
    }
    if (ref.startsWith('refs/tags/')) {
      const peeled = peel(oid, store.lookup);
      if (peeled !== oid) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return lines;
}

function advertiseUpload(ctx: GitContext, repo: Repo): void {
  const protocol = ctx.req.headers['git-protocol'];
  const wantsV2 = typeof protocol === 'string' && protocol.split(',').some((part) => part.trim() === 'version=2');
  const type = 'application/x-git-upload-pack-advertisement';
  if (wantsV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow thin-pack ofs-delta no-progress\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ]);
    sendBuffer(ctx.res, 200, body, type);
    return;
  }
  const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), pktFlush(), ...v0RefLines(ctx.store, repo, UPLOAD_CAPS_V0), pktFlush()]);
  sendBuffer(ctx.res, 200, body, type);
}

function advertiseReceive(ctx: GitContext, repo: Repo): void {
  const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), pktFlush(), ...v0RefLines(ctx.store, repo, RECEIVE_CAPS_V0), pktFlush()]);
  sendBuffer(ctx.res, 200, body, 'application/x-git-receive-pack-advertisement');
}

// ---------------------------------------------------------------- upload-pack

/** What one fetch (v2 or v0) asks for, parsed from its request lines. */
interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

/** The objects a fetch delivers and the shallow boundary moves it reports. */
interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(store: Store, request: FetchRequest): FetchPlan {
  const wants = [...new Set(request.wants)].filter((oid) => isObjectId(oid) && store.objects.has(oid));
  if (wants.length === 0) return { send: [], shallow: [], unshallow: [] };
  const clientShallow = new Set(request.shallow);
  // What the client holds: its haves' closure, cut at its own shallow boundary (it does not hold
  // the parents of a shallow commit, so those must not be subtracted from what we deliver).
  const haves = new Set(
    collectReachable(request.haves, store.lookup, {
      allowMissing: true,
      stopAt: clientShallow.size > 0 ? clientShallow : undefined,
    }),
  );

  if (request.deepen !== null) {
    // deepen N: the wants' history to depth N (a want is depth 1). The boundary is the commits at
    // depth N; a client boundary that is now interior unshallows.
    const depths = commitWalk(wants, store.lookup, request.deepen);
    const shallow: string[] = [];
    for (const [oid, depth] of depths) {
      if (depth !== request.deepen) continue;
      const object = store.objects.get(oid);
      if (object && object.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
    const unshallow = request.shallow.filter((oid) => {
      const depth = depths.get(oid);
      return depth !== undefined && depth < request.deepen!;
    });
    const closure = collectReachable(wants, store.lookup, { maxCommitDepth: request.deepen });
    const send = [...closure].filter((oid) => !haves.has(oid));
    return { send, shallow, unshallow };
  }

  if (clientShallow.size > 0) {
    // A shallow fetch without deepen: cut the walk at the client's boundary.
    const closure = collectReachable(wants, store.lookup, { stopAt: clientShallow });
    const send = [...closure].filter((oid) => !haves.has(oid));
    const shallow: string[] = [];
    for (const oid of closure) {
      const object = store.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => clientShallow.has(parent) && !closure.has(parent))) shallow.push(oid);
    }
    return { send, shallow, unshallow: [] };
  }

  const closure = collectReachable(wants, store.lookup);
  const send = [...closure].filter((oid) => !haves.has(oid));
  return { send, shallow: [], unshallow: [] };
}

async function uploadPack(ctx: GitContext, repo: Repo): Promise<void> {
  const raw = await readBody(ctx.req);
  if (raw === null) throw new ApiError(413, 'Body too large');
  let packets: Packet[];
  try {
    ({ packets } = decodePackets(raw));
  } catch {
    throw new ApiError(400, 'Malformed pkt-line stream');
  }
  const lines = packetLines(packets);
  const first = lines[0] ?? '';
  if (first.startsWith('command=ls-refs')) return lsRefs(ctx, repo, packets);
  if (first.startsWith('command=fetch')) return fetchV2(ctx, repo, packets);
  return fetchV0(ctx, repo, packets);
}

/** v2 ls-refs: peel, symrefs, unborn and ref-prefix filtering, server-side. */
function lsRefs(ctx: GitContext, repo: Repo, packets: readonly Packet[]): void {
  let peelArg = false;
  let symrefsArg = false;
  let unbornArg = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peelArg = true;
    else if (line === 'symrefs') symrefsArg = true;
    else if (line === 'unborn') unbornArg = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      const symref = symrefsArg ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`${headSha} HEAD${symref}\n`));
    } else if (unbornArg) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peelArg && ref.startsWith('refs/tags/')) {
      const peeled = peel(oid, ctx.store.lookup);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  sendBuffer(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** Parse the argument lines of a v2 fetch (after the delim packet). */
function parseFetchArgs(packets: readonly Packet[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
    else if (line === 'done') request.done = true;
  }
  return request;
}

function fetchV2(ctx: GitContext, repo: Repo, packets: readonly Packet[]): void {
  const request = parseFetchArgs(packets);
  const plan = planFetch(ctx.store, request);
  const pack = cachedPack(ctx.store, repo, plan.send);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush());
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  sendBuffer(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** v0 want/have negotiation: wants + shallow/deepen, flush, haves + done, flush. */
function fetchV0(ctx: GitContext, repo: Repo, packets: readonly Packet[]): void {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') continue;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      const oid = space < 0 ? rest : rest.slice(0, space);
      if (space >= 0 && rest.slice(space + 1).split(' ').includes('side-band-64k')) sideband = true;
      request.wants.push(oid);
    } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line === 'done') request.done = true;
  }
  const plan = planFetch(ctx.store, request);
  const pack = cachedPack(ctx.store, repo, plan.send);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (sideband) parts.push(...sidebandPack(pack));
  else parts.push(pack);
  parts.push(pktFlush());
  sendBuffer(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(ctx: GitContext, repo: Repo): Promise<void> {
  const raw = await readBody(ctx.req);
  if (raw === null) throw new ApiError(413, 'Body too large');
  let packets: Packet[];
  let packBytes: Buffer;
  try {
    ({ packets, rest: packBytes } = decodePackets(raw));
  } catch {
    throw new ApiError(400, 'Malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      const caps = line.slice(nul + 1).split(' ');
      sideband = caps.includes('side-band-64k');
      reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      throw new ApiError(400, 'Malformed push command');
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }

  // Unpack first: every object lands in the store even when a ref update is refused.
  let unpackError: string | null = null;
  const hasUpdate = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdate && packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => ctx.store.objects.get(oid));
      for (const [oid, object] of parsed.objects) {
        if (!ctx.store.objects.has(oid)) ctx.store.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (hasUpdate && packBytes.length === 0) {
    unpackError = 'missing pack';
  }

  // Evaluate every command against the pre-push ref state, then apply the accepted ones.
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const applied: Array<{ ref: string; oid: string | null }> = [];
  for (const command of commands) {
    const verdict = judgeCommand(ctx.store, repo, command, unpackError);
    reports.push({ ref: command.ref, ok: verdict === null, reason: verdict ?? '' });
    if (verdict === null) applied.push({ ref: command.ref, oid: command.newOid === ZERO_OID ? null : command.newOid });
  }
  for (const update of applied) {
    if (update.oid === null) repo.refs.delete(update.ref);
    else repo.refs.set(update.ref, update.oid);
  }
  // An unborn repo's HEAD follows the first branch that lands.
  if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
    const firstHead = [...repo.refs.keys()].find((ref) => ref.startsWith('refs/heads/'));
    if (firstHead !== undefined) repo.defaultBranch = firstHead.slice('refs/heads/'.length);
  }
  if (applied.length > 0) repo.updatedAt = ctx.store.tick();

  // The report: pkt-lined lines, inside sideband band 1 when the client asked for it.
  const reportLines: Buffer[] = [pktLine(`unpack ${unpackError === null ? 'ok' : unpackError}\n`)];
  if (reportStatus || !sideband) {
    for (const report of reports) {
      reportLines.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
    }
  }
  reportLines.push(pktFlush());
  const reportBytes = Buffer.concat(reportLines);
  const parts: Buffer[] = sideband ? [...sidebandPack(reportBytes), pktFlush()] : [reportBytes];
  sendBuffer(ctx.res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** One command's verdict: null when accepted, else the ng reason. */
function judgeCommand(store: Store, repo: Repo, command: PushCommand, unpackError: string | null): string | null {
  if (unpackError !== null) return 'unpack failed';
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || /[\s\u0000-\u001f]/.test(ref)) return 'invalid ref name';
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return 'ref does not exist';
    if (oldOid !== ZERO_OID && oldOid !== current) return 'stale info';
    return null;
  }
  const object = store.objects.get(newOid);
  if (!object) return 'missing necessary objects';
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
  if (ref.startsWith('refs/tags/') && object.type !== 'commit' && object.type !== 'tag') return 'not a taggable object';
  if (!store.connected(newOid)) return 'missing necessary objects';
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return 'already exists';
    return null;
  }
  if (current === undefined) return 'ref does not exist';
  if (oldOid !== current) return 'stale info';
  if (!store.fastForward(current, newOid)) return 'non-fast-forward';
  return null;
}

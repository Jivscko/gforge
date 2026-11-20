// The git wire codec: pkt-line framing and packfiles. Reading resolves OFS_DELTA and REF_DELTA
// (thin packs included, bases supplied by the store); writing emits plain zlib-deflated objects,
// which every git client accepts. Node built-ins only: node:zlib and node:crypto.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { type GitObject, type GitObjectType, hashObject } from './git.ts';

export const PKT_LINE_MAX = 65520;
const PKT_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The largest band-1 chunk: a pkt payload minus the sideband byte. */
export const SIDEBAND_CHUNK = PKT_MAX_PAYLOAD - 1;

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
const RESPONSE_END = Buffer.from('0002', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return FLUSH;
}

export function pktDelim(): Buffer {
  return DELIM;
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete pkt-line stream; trailing raw bytes (a pack) are returned separately. */
export function decodePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) break; // raw pack bytes follow
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > buffer.length) {
      throw new Error(`invalid pkt-line length ${header}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** The data packets' text lines (control packets dropped). */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/** Frame a pack into sideband band-1 pkt-lines. */
export function sidebandPack(pack: Buffer, band: 1 | 2 = 1): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(payload));
  }
  return parts;
}

// ---------------------------------------------------------------- pack reading

const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readSizeHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack size varint too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Inflate one zlib stream at offset; returns its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length || written + literal > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly count: number;
  readonly deltaCount: number;
}

/**
 * Read a version 2/3 packfile, resolving every delta. `resolveBase` supplies thin-pack bases the
 * pack leaves out (the server's store). Every object's SHA-1 is recomputed as it is resolved.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readSizeHeader(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) throw new Error('ofs-delta base offset invalid');
      entry.baseOffset = entryOffset - base.distance;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('stray bytes before the pack trailer');

  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      const base = baseEntry ? resolve(baseEntry) : resolveBase?.(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const object: GitObject = { type, data };
    entry.resolved = object;
    byOid.set(hashObject(type, data), entry);
    resolving.delete(entry.offset);
    return object;
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const object = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    const oid = hashObject(object.type, object.data);
    if (!objects.has(oid)) objects.set(oid, object);
  }
  return { objects, count, deltaCount };
}

// ---------------------------------------------------------------- pack writing

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a delta-free packfile from objects, in the order given, with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  let count = 0;
  const body: Buffer[] = [];
  for (const object of objects) {
    count += 1;
    body.push(packObjectHeader(object.type, object.data.length));
    body.push(deflateSync(object.data));
  }
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  parts.push(header, ...body);
  const packed = Buffer.concat(parts);
  return Buffer.concat([packed, createHash('sha1').update(packed).digest()]);
}

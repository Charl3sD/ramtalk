// File transfer helpers: chunk sizing, receiver-side reassembly with limits, and sanitizers for
// peer-supplied names and MIME types. Received data lives only in memory.

import { SEAL_OVERHEAD } from '../crypto/session';
import { CHUNK_FRAME_OVERHEAD, MAX_FILENAME_CHARS } from './frames';

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_TOTAL_INCOMING_BYTES = 500 * 1024 * 1024;
export const MAX_CONCURRENT_INCOMING = 8;

/** Images that are safe to render inline via <img>. SVG is deliberately excluded. */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Largest file chunk that keeps each sealed frame within the peer's advertised SCTP
 * max-message-size, capped at 64 KiB for interop (0 means "no limit" per RFC 8841).
 */
export function chunkSizeFor(peerMaxMessageSize: number): number {
  const limit = peerMaxMessageSize === 0 ? 65536 : Math.min(peerMaxMessageSize, 65536);
  return Math.max(1024, limit - SEAL_OVERHEAD - CHUNK_FRAME_OVERHEAD);
}

export function sanitizeFilename(name: string): string {
  let n = name
    .normalize('NFC')
    // Path separators, characters invalid on common filesystems, and control/bidi characters.
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (n.length > MAX_FILENAME_CHARS) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    n = n.slice(0, MAX_FILENAME_CHARS - ext.length) + ext;
  }
  return n || 'file';
}

export function sanitizeMime(mime: string): string {
  const m = mime.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(m) ? m : 'application/octet-stream';
}

/**
 * The type given to the in-memory Blob. Anything that isn't an allowlisted image becomes
 * octet-stream, so a blob: URL (same origin as the app) can never be rendered as HTML/SVG.
 */
export function blobTypeFor(mime: string): string {
  return INLINE_IMAGE_TYPES.has(mime) ? mime : 'application/octet-stream';
}

export class FileLimitError extends Error {}

interface Incoming {
  name: string;
  mime: string;
  size: number;
  parts: Uint8Array<ArrayBuffer>[];
  received: number;
  nextIdx: number;
}

export class IncomingFiles {
  private active = new Map<string, Incoming>();
  private done = new Set<string>();
  private reservedBytes = 0;

  /** Validates and registers an incoming file; returns its sanitized name and type. */
  start(id: string, rawName: string, rawMime: string, size: number): { name: string; mime: string } {
    if (this.active.has(id) || this.done.has(id)) throw new FileLimitError('duplicate file id');
    if (this.active.size >= MAX_CONCURRENT_INCOMING) throw new FileLimitError('too many files at once');
    if (size > MAX_FILE_BYTES) throw new FileLimitError(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    if (this.reservedBytes + size > MAX_TOTAL_INCOMING_BYTES) {
      throw new FileLimitError('not enough room for more files in this chat');
    }
    const name = sanitizeFilename(rawName);
    const mime = sanitizeMime(rawMime);
    this.reservedBytes += size;
    this.active.set(id, { name, mime, size, parts: [], received: 0, nextIdx: 0 });
    return { name, mime };
  }

  has(id: string): boolean {
    return this.active.has(id);
  }

  /** Returns bytes received so far, or null if the id is unknown (e.g. already cancelled). */
  chunk(id: string, idx: number, data: Uint8Array<ArrayBuffer>): number | null {
    const f = this.active.get(id);
    if (!f) return null;
    if (idx !== f.nextIdx) throw new FileLimitError('chunk out of order');
    if (f.received + data.length > f.size) throw new FileLimitError('file larger than announced');
    f.parts.push(data);
    f.received += data.length;
    f.nextIdx++;
    return f.received;
  }

  finish(id: string): { blob: Blob; name: string; mime: string } | null {
    const f = this.active.get(id);
    if (!f) return null;
    this.active.delete(id);
    if (f.received !== f.size) {
      this.reservedBytes -= f.size;
      throw new FileLimitError('file ended early');
    }
    this.done.add(id);
    return { blob: new Blob(f.parts as BlobPart[], { type: blobTypeFor(f.mime) }), name: f.name, mime: f.mime };
  }

  cancel(id: string): void {
    const f = this.active.get(id);
    if (!f) return;
    this.active.delete(id);
    this.reservedBytes -= f.size;
  }

  clear(): void {
    this.active.clear();
    this.done.clear();
    this.reservedBytes = 0;
  }
}

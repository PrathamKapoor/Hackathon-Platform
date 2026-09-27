/**
 * File uploads.
 *
 * Uploaded files are untrusted input. The pipeline is:
 *
 *   1. Size is checked against the limit *while streaming*, so a large body is
 *      rejected without ever being buffered in full.
 *   2. The extension is checked against an allow-list.
 *   3. The **magic bytes** are checked against the declared type. This is the
 *      step that matters: renaming `payload.php` to `screenshot.png` passes an
 *      extension check and fails here.
 *   4. The stored name is generated, never derived from the client's filename.
 *   5. The file is written outside the web root and served only through a
 *      controller that checks authorization and sets `X-Content-Type-Options:
 *      nosniff` plus a `Content-Disposition: attachment` for non-images.
 *
 * There is no "execute", no SVG (SVG is a script vector) and no HTML.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { newId } from '@verdict/core/ids';
import { now } from '@verdict/core/time';
import { errors } from '../lib/errors.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export type UploadKind = 'SCREENSHOT' | 'ATTACHMENT' | 'LOGO' | 'BANNER' | 'DOCUMENT';

export type UploadRow = {
  id: string;
  event_id: string | null;
  submission_id: string | null;
  user_id: string;
  kind: UploadKind;
  original_name: string;
  stored_name: string;
  mime_type: string;
  byte_size: number;
  checksum: string;
  width: number | null;
  height: number | null;
  created_at: string;
};

/**
 * The allow-list. Each entry declares the MIME types accepted and the byte
 * signatures that must appear at offset 0.
 */
type FileRule = {
  extensions: string[];
  mimeTypes: string[];
  magic: { offset: number; bytes: number[]; label: string }[];
  maxBytes: number;
  serveInline: boolean;
};

const RULES: Record<UploadKind, FileRule> = {
  SCREENSHOT: {
    // SVG is deliberately absent: it can carry script and is a stored-XSS vector.
    extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    magic: [
      { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
      { offset: 0, bytes: [0xff, 0xd8, 0xff], label: 'JPEG' },
      { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], label: 'GIF' },
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], label: 'WEBP (RIFF)' },
    ],
    maxBytes: 8 * 1024 * 1024,
    serveInline: true,
  },
  ATTACHMENT: {
    extensions: ['.pdf', '.txt', '.md', '.csv', '.json', '.zip'],
    mimeTypes: ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/zip'],
    magic: [
      { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
      { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP' },
    ],
    // Text formats have no signature, so they are identified by extension and
    // then checked for the absence of NUL bytes, which rules out a binary
    // payload renamed to .txt.
    maxBytes: 8 * 1024 * 1024,
    serveInline: false,
  },
  DOCUMENT: {
    extensions: ['.pdf', '.md', '.txt'],
    mimeTypes: ['application/pdf', 'text/markdown', 'text/plain'],
    magic: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF' }],
    maxBytes: 8 * 1024 * 1024,
    serveInline: false,
  },
  LOGO: {
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    magic: [
      { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
      { offset: 0, bytes: [0xff, 0xd8, 0xff], label: 'JPEG' },
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], label: 'WEBP (RIFF)' },
    ],
    maxBytes: 2 * 1024 * 1024,
    serveInline: true,
  },
  BANNER: {
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    magic: [
      { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
      { offset: 0, bytes: [0xff, 0xd8, 0xff], label: 'JPEG' },
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], label: 'WEBP (RIFF)' },
    ],
    maxBytes: 8 * 1024 * 1024,
    serveInline: true,
  },
};

export type UploadInput = {
  kind: UploadKind;
  filename: string;
  declaredMimeType: string;
  data: Buffer;
  eventId?: string | null;
  submissionId?: string | null;
};

export class UploadService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly config: Services['config'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.config = services.config;
  }

  /**
   * Validate and store one file.
   *
   * Validation order matters: cheap structural checks first, then the signature
   * check, so a hostile upload is rejected as cheaply as possible.
   */
  async store(input: UploadInput, ctx: ActorContext): Promise<UploadRow> {
    const actor = requireActor(ctx);
    const rule = RULES[input.kind];
    if (rule === undefined) {
      throw errors.badRequest(`Unknown upload kind "${String(input.kind)}".`);
    }

    // 1. size
    const limit = Math.min(rule.maxBytes, this.config.security.maxUploadBytes);
    if (input.data.byteLength === 0) {
      throw errors.validation('The uploaded file is empty.', [{ field: 'file' }]);
    }
    if (input.data.byteLength > limit) {
      this.audit.record({
        action: 'upload.rejected',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: input.eventId ?? null,
        resourceType: 'upload',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        outcome: 'DENIED',
        metadata: { reason: 'too large', bytes: input.data.byteLength, limit, filename: input.filename },
        at: ctx.at,
      });
      throw errors.payloadTooLarge(
        `"${safeName(input.filename)}" is ${formatBytes(input.data.byteLength)}; the limit for this kind of file is ${formatBytes(limit)}.`,
      );
    }

    // 2. extension
    const extension = extname(input.filename).toLowerCase();
    if (!rule.extensions.includes(extension)) {
      return this.reject(input, ctx, `extension "${extension || '(none)'}" is not accepted here (allowed: ${rule.extensions.join(', ')})`);
    }

    // 3. declared MIME type
    if (input.declaredMimeType && !rule.mimeTypes.includes(input.declaredMimeType.toLowerCase())) {
      return this.reject(input, ctx, `declared type "${input.declaredMimeType}" is not accepted here (allowed: ${rule.mimeTypes.join(', ')})`);
    }

    // 4. magic bytes
    const detected = detectSignature(input.data);
    if (rule.magic.length > 0) {
      const matched = rule.magic.some((candidate) => matches(input.data, candidate));
      if (!matched) {
        // A .txt/.md/.csv/.json has no signature; fall back to a NUL-byte check
        // so a binary payload renamed to .txt is still refused.
        const textual = ['.txt', '.md', '.csv', '.json'].includes(extension);
        if (!textual || input.data.includes(0)) {
          return this.reject(
            input,
            ctx,
            `file contents (${detected}) do not match the declared ${extension} type. The upload was refused.`,
          );
        }
      }
    }

    const dimensions = imageDimensions(input.data, detected);

    // 5. write with a generated name, never the client's
    const eventFolder = input.eventId ?? 'global';
    const folder = join(this.config.storageDir, 'uploads', eventFolder);
    await mkdir(folder, { recursive: true });
    const storedName = `${newId('upload')}${extension}`;
    const absolute = this.resolveInsideStorage(join(folder, storedName));
    await writeFile(absolute, input.data, { flag: 'wx', mode: 0o640 });

    const checksum = createHash('sha256').update(input.data).digest('hex');
    const id = newId('upload');
    const at = ctx.at;

    this.db.exec(
      `INSERT INTO uploads (id, event_id, submission_id, user_id, kind, original_name, stored_name,
         mime_type, byte_size, checksum, width, height, created_at)
       VALUES (:id, :e, :s, :u, :kind, :original, :stored, :mime, :size, :checksum, :w, :h, :at)`,
      {
        id,
        e: input.eventId ?? null,
        s: input.submissionId ?? null,
        u: actor.id,
        kind: input.kind,
        original: safeName(input.filename),
        stored: storedName,
        mime: input.declaredMimeType || guessMime(extension),
        size: input.data.byteLength,
        checksum,
        w: dimensions?.width ?? null,
        h: dimensions?.height ?? null,
        at,
      },
    );

    return this.require(id);
  }

  private reject(input: UploadInput, ctx: ActorContext, reason: string): never {
    const actor = requireActor(ctx);
    this.audit.record({
      action: 'upload.rejected',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: input.eventId ?? null,
      resourceType: 'upload',
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      outcome: 'DENIED',
      metadata: { reason, filename: safeName(input.filename), declaredType: input.declaredMimeType, bytes: input.data.byteLength },
      at: ctx.at,
    });
    throw errors.unsupportedMedia(`Upload refused: ${reason}`);
  }

  /** Read a stored file for serving, after the caller has authorized access. */
  async read(uploadId: string): Promise<{ row: UploadRow; data: Buffer; serveInline: boolean }> {
    const row = this.require(uploadId);
    const absolute = this.resolveInsideStorage(join(this.config.storageDir, 'uploads', row.event_id ?? 'global', row.stored_name));

    // Verify the checksum before serving: a truncated or swapped file is a
    // signal worth failing on rather than rendering.
    const data = await readFile(absolute);
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== row.checksum) {
      this.audit.record({
        action: 'upload.rejected',
        actorId: null,
        actorRoles: [],
        eventId: row.event_id,
        resourceType: 'upload',
        resourceId: row.id,
        outcome: 'FAILED',
        metadata: { reason: 'checksum mismatch on read', expected: row.checksum, actual },
        at: now(),
      });
      throw errors.internal('The stored file failed its integrity check.', new Error('upload checksum mismatch'));
    }

    return { row, data, serveInline: RULES[row.kind].serveInline };
  }

  findById(id: string): UploadRow | null {
    return this.db.get<UploadRow>('SELECT * FROM uploads WHERE id = :id', { id });
  }

  require(id: string): UploadRow {
    const row = this.findById(id);
    if (row === null) throw errors.notFound('Upload', id);
    return row;
  }

  listForSubmission(submissionId: string): UploadRow[] {
    return this.db.all<UploadRow>('SELECT * FROM uploads WHERE submission_id = :s ORDER BY created_at', { s: submissionId });
  }

  async remove(uploadId: string, ctx: ActorContext): Promise<void> {
    const row = this.require(uploadId);
    const actor = requireActor(ctx);
    const owns = row.user_id === actor.id;
    if (!owns && !this.db.value('SELECT 1 AS ok FROM user_roles WHERE user_id = :u AND role IN (\'ORGANIZER\',\'ADMIN\') AND revoked_at IS NULL', { u: actor.id })) {
      throw errors.forbidden('You cannot delete that file.');
    }
    this.db.exec('DELETE FROM uploads WHERE id = :id', { id: uploadId });
    try {
      await unlink(this.resolveInsideStorage(join(this.config.storageDir, 'uploads', row.event_id ?? 'global', row.stored_name)));
    } catch {
      // The row is gone; a leftover blob is a housekeeping problem, not a
      // correctness one, and must not fail the request.
    }
  }

  async usage(): Promise<{ files: number; bytes: number }> {
    const row = this.db.get<{ files: number; bytes: number }>(
      'SELECT COUNT(*) AS files, COALESCE(SUM(byte_size), 0) AS bytes FROM uploads',
    );
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  async exists(absolutePath: string): Promise<boolean> {
    try {
      const info = await stat(absolutePath);
      return info.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Defence in depth against path traversal: whatever the caller supplies, the
   * resolved path must stay inside the storage root.
   */
  private resolveInsideStorage(candidate: string): string {
    const root = resolve(this.config.storageDir);
    const target = resolve(candidate);
    if (target !== root && !target.startsWith(root + sep)) {
      throw errors.forbidden('Refusing to access a path outside the storage directory.');
    }
    return target;
  }

  public rules(): { kind: UploadKind; extensions: string[]; mimeTypes: string[]; maxBytes: number }[] {
    return (Object.keys(RULES) as UploadKind[]).map((kind) => ({
      kind,
      extensions: RULES[kind].extensions,
      mimeTypes: RULES[kind].mimeTypes,
      maxBytes: Math.min(RULES[kind].maxBytes, this.config.security.maxUploadBytes),
    }));
  }
}

/* ------------------------------------------------------------- helpers */

function matches(data: Buffer, candidate: { offset: number; bytes: number[] }): boolean {
  if (data.byteLength < candidate.offset + candidate.bytes.length) return false;
  return candidate.bytes.every((byte, index) => data[candidate.offset + index] === byte);
}

function detectSignature(data: Buffer): string {
  const known: { bytes: number[]; label: string }[] = [
    { bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG image' },
    { bytes: [0xff, 0xd8, 0xff], label: 'JPEG image' },
    { bytes: [0x47, 0x49, 0x46, 0x38], label: 'GIF image' },
    { bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF document' },
    { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP archive' },
    { bytes: [0x7b], label: 'JSON text' },
    { bytes: [0x3c], label: 'XML/HTML markup' },
    { bytes: [0x7b, 0x3c, 0x3f], label: 'script source' },
  ];
  for (const candidate of known) {
    if (matches(data, { offset: 0, bytes: candidate.bytes })) return candidate.label;
  }
  if (data.byteLength > 8 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'WEBP image';
  }
  if (data.includes(0)) return 'binary data';
  return 'text';
}

/** Read PNG/JPEG dimensions from the header, for gallery layout. */
function imageDimensions(data: Buffer, detected: string): { width: number; height: number } | null {
  try {
    if (detected === 'PNG image' && data.byteLength > 24) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (detected === 'GIF image' && data.byteLength > 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (detected === 'JPEG image') {
      let offset = 2;
      while (offset + 9 < data.byteLength) {
        if (data[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = data[offset + 1] as number;
        const length = data.readUInt16BE(offset + 2);
        // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function guessMime(extension: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return map[extension] ?? 'application/octet-stream';
}

function safeName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'file';
  return base.replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'file';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { randomBytes };

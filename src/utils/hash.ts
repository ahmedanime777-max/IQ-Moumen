import crypto from 'node:crypto';
import fs from 'node:fs';

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function fileSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return sha256(buf);
}

export function uuid(): string {
  return crypto.randomUUID();
}

// Deterministic UUID derived from a string (used for stable document ids).
export function stableUuid(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

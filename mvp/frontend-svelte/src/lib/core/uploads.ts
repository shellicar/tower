// core/uploads.ts — attachment upload over HTTP (POST /attachment), separate
// from the WS transport (the wire stays light). Stateless: returns a reference
// the caller holds until the say. Eager, at attach time; the transit store's
// TTL cleans up abandons, so an upload the user drops costs nothing.

import type { AttachmentRef } from '../types';

export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const response = await fetch('/attachment', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`upload failed: ${response.status} ${body}`.trim());
  }
  const meta = (await response.json()) as { id: string; mediaType: string; size: number };
  return {
    type: meta.mediaType.startsWith('image/') ? 'image' : 'document',
    source: { type: 'object', id: meta.id, mediaType: meta.mediaType, size: meta.size },
  };
}

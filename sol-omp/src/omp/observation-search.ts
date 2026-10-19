import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const SEARCH_MAX_MATCHES = 10;
export const SEARCH_MAX_QUERY_BYTES = 256;
const SCAN_BYTES = 64 * 1024;

/** Literal UTF-8 search with bounded memory and excerpts; offsets address the original archive. */
export async function searchArchive(path: string, query: string, offset = 0, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const needle = Buffer.from(query, "utf8");
  if (!query || needle.length > SEARCH_MAX_QUERY_BYTES || query.includes("\0")) {
    throw new Error("query must contain 1–256 UTF-8 bytes without NUL");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Stored observation is not a regular file");
    if (offset > stats.size) throw new Error("Search offset exceeds observation size");
    const matches: Array<{ offset: number; excerptOffset: number; text: string }> = [];
    let position = offset;
    let nextOffset = offset;
    let carry = Buffer.alloc(0);
    while (position < stats.size) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(SCAN_BYTES, stats.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) throw new Error("Stored observation changed during search");
      const window = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const windowOffset = position - carry.length;
      let index = window.indexOf(needle, Math.max(0, nextOffset - windowOffset));
      while (index >= 0) {
        signal?.throwIfAborted();
        const matchOffset = windowOffset + index;
        // Excerpt reads use the SAME opened object, so replacing a pathname
        // during a scan cannot mix excerpts from a different archive.
        const start = Math.max(0, matchOffset - 128);
        const excerpt = Buffer.alloc(Math.min(1028, stats.size - start));
        const read = await handle.read(excerpt, 0, excerpt.length, start);
        let from = 0;
        while (from < read.bytesRead && (excerpt[from]! & 0xc0) === 0x80) from++;
        let end = Math.min(read.bytesRead, from + 1024);
        while (end > from && end < read.bytesRead && (excerpt[end]! & 0xc0) === 0x80) end--;
        // JSON-escaped excerpts keep even newline-heavy observations within
        // the tool's line budget while preserving their exact text.
        let text = "";
        let escapedBytes = 2;
        for (const character of excerpt.subarray(from, end).toString("utf8")) {
          const bytes = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
          if (escapedBytes + bytes > 1024) break;
          text += character;
          escapedBytes += bytes;
        }
        matches.push({ offset: matchOffset, excerptOffset: start + from, text });
        nextOffset = matchOffset + needle.length;
        signal?.throwIfAborted();
        if (matches.length === SEARCH_MAX_MATCHES) return { matches, nextOffset, eof: nextOffset >= stats.size };
        index = window.indexOf(needle, index + needle.length);
      }
      carry = Buffer.from(window.subarray(Math.max(0, window.length - needle.length + 1)));
      position += bytesRead;
    }
    signal?.throwIfAborted();
    return { matches, nextOffset: stats.size, eof: true };
  } finally {
    await handle.close();
  }
}

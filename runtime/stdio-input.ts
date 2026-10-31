import { Transform, type TransformCallback } from "node:stream";

// Import data accepts 40 MiB of base64. Leave room for the JSON-RPC envelope,
// while allocating only for bytes actually received, never for this limit.
export const CAD_MESSAGE_LIMIT = 48 * 1024 * 1024;

/** Extract only a top-level request id while discarding a rejected JSON line.
 * SDKs can put id after a huge params value; a prefix regex cannot find it.
 */
class RequestId {
  private depth = 0;
  private string = false;
  private escape = false;
  private needKey = false;
  private key = "";
  private idNext = false;
  private capture: "key" | "id" | undefined;
  private token: number[] = [];
  private atom = false;
  private found = false;
  value: string | number | null = null;
  private finish() {
    try {
      const value = JSON.parse(Buffer.from(this.token).toString("utf8"));
      if (this.capture === "key") this.key = typeof value === "string" ? value : "";
      else if (this.capture === "id" && (typeof value === "string" || typeof value === "number" || value === null)) {
        this.value = value; this.found = true;
      }
    } catch { /* Malformed or over-budget identifiers remain unknown. */ }
    this.token = []; this.capture = undefined; this.atom = false;
  }
  feed(bytes: Buffer) {
    for (const c of bytes) {
      if (this.found) return;
      if (this.string) {
        if (this.capture && this.token.length < 4096) this.token.push(c);
        if (this.escape) { this.escape = false; continue; }
        if (c === 92) { this.escape = true; continue; }
        if (c === 34) { this.string = false; this.finish(); }
        continue;
      }
      if (this.atom) {
        if (c !== 44 && c !== 125 && c !== 93 && c > 32) {
          if (this.token.length < 4096) this.token.push(c);
          continue;
        }
        this.finish(); if (this.found) return;
      }
      if (c === 34) {
        this.string = true;
        this.capture = this.depth === 1 ? this.needKey ? "key" : this.idNext ? "id" : undefined : undefined;
        this.token = this.capture ? [c] : [];
        if (this.capture === "key") this.needKey = false;
        this.idNext = false;
      } else if (this.depth === 1 && this.idNext && c > 32) {
        this.idNext = false; this.capture = "id"; this.atom = true; this.token = [c];
      } else if (c === 123 || c === 91) {
        this.depth++; if (this.depth === 1) this.needKey = true;
      } else if (c === 125 || c === 93) this.depth--;
      else if (this.depth === 1 && c === 44) { this.needKey = true; this.key = ""; this.idNext = false; }
      else if (this.depth === 1 && c === 58) this.idNext = this.key === "id";
    }
  }
}

/** Frame complete bounded JSON lines before the SDK buffers them. Its default
 * 10 MiB overflow closes the entire transport, including unrelated CAD tools.
 * Oversized requests are discarded through their newline and receive an error;
 * the next request is processed normally. No retries or runtime restarts.
 */
export class CadStdioInput extends Transform {
  private parts: Buffer[] = [];
  private size = 0;
  private rejectedId: RequestId | undefined;
  private dropping = false;
  constructor(private readonly rejectRequest: (id: string | number | null) => void,
    private readonly limit = CAD_MESSAGE_LIMIT) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline + 1;
      const piece = chunk.subarray(start, end);
      if (!this.dropping) {
        this.size += piece.length;
        if (this.size > this.limit) {
          this.dropping = true; this.rejectedId = new RequestId();
          for (const part of this.parts) this.rejectedId.feed(part);
          this.parts = []; this.rejectedId.feed(piece);
        }
        else this.parts.push(piece);
      } else this.rejectedId?.feed(piece);
      if (newline >= 0) {
        if (this.dropping) {
          this.rejectRequest(this.rejectedId?.value ?? null);
        } else this.push(this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size));
        this.parts = []; this.size = 0; this.rejectedId = undefined; this.dropping = false;
      }
      start = end;
    }
    callback();
  }
}

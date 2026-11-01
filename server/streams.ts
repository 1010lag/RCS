import type { ServerResponse } from "node:http";
import type { Database } from "./db";
import { Problem } from "./domain";

type Stream = { userId: string; sessionId: string; response: ServerResponse; revision: string; sentAt: number; stop: () => void };
export class StreamHub {
  private streams = new Set<Stream>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(private db: Database) {}
  assertCapacity(userId: string) {
    if ([...this.streams].filter((stream) => stream.userId === userId).length >= 3)
      throw new Problem(429, "SSE_LIMIT", "Слишком много открытых вкладок. Закройте лишние вкладки RCS");
    if (this.streams.size >= 100) throw new Problem(503, "SSE_BUSY", "Слишком много подключений. Попробуйте позже");
  }
  add(userId: string, sessionId: string, response: ServerResponse) {
    let stopped = false;
    const stream: Stream = { userId, sessionId, response, revision: "", sentAt: Date.now(), stop: () => {
      if (stopped) return;
      stopped = true;
      this.streams.delete(stream);
      if (!response.destroyed) response.end();
      if (!this.streams.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    } };
    this.streams.add(stream);
    response.once("close", stream.stop);
    if (!this.timer) { this.timer = setInterval(() => void this.poll(), 1000); void this.poll(); }
  }
  private write(stream: Stream, data: string) {
    if (stream.response.destroyed || stream.response.writableLength > 65536) { stream.stop(); return; }
    stream.response.write(data);
    stream.sentAt = Date.now();
  }
  private async poll() {
    if (this.polling || !this.streams.size) return;
    this.polling = true;
    const batch = [...this.streams];
    try {
      const rows = await this.db.query(
        "SELECT s.id AS session_id,(SELECT COALESCE(max(id),0)::text FROM events) AS revision FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=ANY($1::text[]) AND s.expires_at>clock_timestamp() AND u.active",
        [[...new Set(batch.map((stream) => stream.sessionId))]],
      );
      const valid = new Map(rows.map((row) => [row.session_id, row.revision as string]));
      for (const stream of batch) {
        if (!this.streams.has(stream)) continue;
        const revision = valid.get(stream.sessionId);
        if (revision === undefined) { this.write(stream, "event: revoked\ndata: {}\n\n"); stream.stop(); }
        else if (revision !== stream.revision) { stream.revision = revision; this.write(stream, `event: change\ndata: ${JSON.stringify({ revision })}\n\n`); }
        else if (Date.now() - stream.sentAt >= 15000) this.write(stream, ": heartbeat\n\n");
      }
    } catch { for (const stream of batch) stream.stop(); }
    finally { this.polling = false; }
  }
  close() { for (const stream of [...this.streams]) stream.stop(); }
}

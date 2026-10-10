/**
 * Lightweight, in-memory usage counters for the HTTP server (shown at GET /analytics).
 *
 * Nothing is written to disk and nothing personal is kept (no IP addresses, no arguments):
 * just how many requests arrived and how often each tool was called. Counters reset when the
 * container restarts, which is fine for a quick "is anyone using this?" view.
 */

export interface ToolStats {
  calls: number;
  errors: number;
  /** Average time per call in milliseconds. */
  avgMs: number;
  lastCalledAt: string | null;
}

export class UsageStats {
  private readonly startedAt = new Date();
  private totalRequests = 0;
  private readonly requestsByEndpoint = new Map<string, number>();
  private readonly tools = new Map<string, { calls: number; errors: number; totalMs: number; last: Date | null }>();
  private readonly hourly = new Map<string, number>();

  /** Count one HTTP request (endpoint is a fixed label like "POST /mcp", never a raw URL). */
  recordRequest(endpoint: string): void {
    this.totalRequests++;
    this.requestsByEndpoint.set(endpoint, (this.requestsByEndpoint.get(endpoint) ?? 0) + 1);
    const hour = new Date().toISOString().slice(0, 13); // e.g. 2026-10-12T07 (UTC)
    this.hourly.set(hour, (this.hourly.get(hour) ?? 0) + 1);
    // Keep only the last 48 hours of hourly buckets.
    if (this.hourly.size > 48) {
      const oldest = [...this.hourly.keys()].sort()[0];
      if (oldest) this.hourly.delete(oldest);
    }
  }

  /** Count one tool call (pass this as the onToolCall hook when creating servers). */
  recordToolCall = (name: string, ok: boolean, ms: number): void => {
    const t = this.tools.get(name) ?? { calls: 0, errors: 0, totalMs: 0, last: null };
    t.calls++;
    if (!ok) t.errors++;
    t.totalMs += ms;
    t.last = new Date();
    this.tools.set(name, t);
  };

  /** Everything as plain JSON. */
  snapshot() {
    const toolCalls: Record<string, ToolStats> = {};
    let totalToolCalls = 0;
    for (const [name, t] of [...this.tools.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
      totalToolCalls += t.calls;
      toolCalls[name] = { calls: t.calls, errors: t.errors, avgMs: Math.round(t.totalMs / t.calls), lastCalledAt: t.last?.toISOString() ?? null };
    }
    return {
      serverStartTime: this.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      totalRequests: this.totalRequests,
      totalToolCalls,
      requestsByEndpoint: Object.fromEntries(this.requestsByEndpoint),
      toolCalls,
      hourlyRequestsUtc: Object.fromEntries([...this.hourly.entries()].sort()),
      note: 'In-memory counters only; they reset when the server restarts.',
    };
  }
}

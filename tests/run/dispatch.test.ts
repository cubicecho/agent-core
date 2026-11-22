import { describe, expect, it } from 'vitest';
import type { ToolCallReport } from '../../src/run/dispatch.ts';

describe('ToolCallReport', () => {
  it("hands its log over where agent-mcp-pool's onLog goes", () => {
    // The pool's `CallOptions.onLog` as 3.13.0 declares it: the level a closed union, and a
    // `dropped` count on the cap's summary. This compiling is the test.
    type PoolLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
    type PoolEntry = { level: PoolLevel; logger?: string; data: unknown; dropped?: number };
    const options = (report: ToolCallReport): { onLog?: (entry: PoolEntry) => void } => ({ onLog: report.log });
    expect(options).toBeTypeOf('function');
  });
});

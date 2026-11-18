import { describe, expect, it } from 'vitest';
import { RunEventKind, stamp } from '../../src/run/events.ts';
import {
  IDEMPOTENCY_HEADER,
  PROGRESS_FIELD,
  progressChunk,
  progressEvent,
  progressEvents,
  remoteRun,
  withProgress,
} from '../../src/run/remote.ts';

/** The head every chunk of ai-router's stream for run `r1` carries. */
const head = { id: 'chatcmpl-r1', created: 1_700_000_000, model: 'helper' };

/** A tool call as a remote agent's run said it, numbered and stamped by the server. */
const called = stamp({ kind: RunEventKind.ToolCall, id: 'Srv000001', name: 'ask_user', text: '{}' }, 'r1', 7, 42);

/** What travelled: the value as JSON writes it and reads it back. */
const overTheWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('progressChunk and progressEvent', () => {
  it("writes a chunk in ai-router's shape: empty choices, the event under ai_router", () => {
    expect(progressChunk(called, head)).toEqual({
      ...head,
      object: 'chat.completion.chunk',
      choices: [],
      ai_router: { event: called },
    });
  });

  it('reads back the event it wrote, run id, seq and time as the server gave them', () => {
    expect(progressEvent(overTheWire(progressChunk(called, head)))).toEqual(called);
  });

  it('writes and reads under the field a host names, and finds nothing under another', () => {
    const chunk = overTheWire(progressChunk(called, head, 'agent_run'));
    expect(chunk).toEqual({ ...head, object: 'chat.completion.chunk', choices: [], agent_run: { event: called } });
    expect(progressEvent(chunk, 'agent_run')).toEqual(called);
    expect(progressEvent(chunk)).toBeUndefined();
    const completion = overTheWire(withProgress({ id: 'c', choices: [] }, 'r1', [called], 'agent_run'));
    expect(progressEvents(completion, 'agent_run')).toEqual({ runId: 'r1', events: [called] });
    expect(progressEvents(completion)).toBeUndefined();
  });

  it('reads nothing off a chunk that carries no event', () => {
    expect(progressEvent({ ...head, choices: [{ index: 0, delta: { content: 'hi' } }] })).toBeUndefined();
    expect(progressEvent({ ...head, choices: [], usage: { prompt_tokens: 1 } })).toBeUndefined();
    expect(progressEvent(null)).toBeUndefined();
  });

  it('reads nothing off an event that is malformed, or of a kind this version does not know', () => {
    const { seq: _seq, ...unnumbered } = called;
    expect(progressEvent({ [PROGRESS_FIELD]: { event: unnumbered } })).toBeUndefined();
    expect(progressEvent({ [PROGRESS_FIELD]: { event: { ...called, kind: 'teleport' } } })).toBeUndefined();
    expect(progressEvent({ [PROGRESS_FIELD]: { event: { ...called, ok: 'yes' } } })).toBeUndefined();
  });
});

describe('progressEvent and progressEvents from a server before 5.0.0', () => {
  /** An exchange beginning, and a call inside it, as a 4.x server wrote them. */
  const began = { runId: 'r1', seq: 1, at: 40, kind: 'step', text: '', name: 'plan', step: '', ok: null, usage: null };
  const inside = { ...began, seq: 2, kind: 'tool-call', name: 'ask_user', text: '{}', id: 'Srv1', step: 'plan' };

  it('reads a step event as an exchange, and the step field as the exchange', () => {
    expect(progressEvent({ [PROGRESS_FIELD]: { event: began } })).toEqual(
      stamp({ kind: RunEventKind.Exchange, name: 'plan' }, 'r1', 1, 40),
    );
    const event = progressEvent({ [PROGRESS_FIELD]: { event: inside } });
    expect(event).toEqual(
      stamp({ kind: RunEventKind.ToolCall, name: 'ask_user', text: '{}', id: 'Srv1', exchange: 'plan' }, 'r1', 2, 40),
    );
    expect(event).not.toHaveProperty('step');
  });

  it('reads nothing off an event that names no exchange under either name', () => {
    const { step: _step, ...unplaced } = inside;
    expect(progressEvent({ [PROGRESS_FIELD]: { event: unplaced } })).toBeUndefined();
    expect(progressEvent({ [PROGRESS_FIELD]: { event: { ...unplaced, exchange: '', kind: 'step' } } })).toBeUndefined();
  });

  it('reads them so off an answer that is not streamed', () => {
    expect(progressEvents({ [PROGRESS_FIELD]: { runId: 'r1', events: [began, inside] } })?.events).toEqual([
      stamp({ kind: RunEventKind.Exchange, name: 'plan' }, 'r1', 1, 40),
      stamp({ kind: RunEventKind.ToolCall, name: 'ask_user', text: '{}', id: 'Srv1', exchange: 'plan' }, 'r1', 2, 40),
    ]);
  });
});

describe('withProgress and progressEvents', () => {
  /** A non-streamed answer of a run that handed a call back, as ai-router writes one. */
  const completion = {
    ...head,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
  const done = stamp({ kind: RunEventKind.Done, ok: true }, 'r1', 8, 43);

  it('puts the run and its events beside choices, and leaves the rest of the answer as it was', () => {
    const answer = withProgress(completion, 'r1', [called, done]);
    expect(answer).toEqual({ ...completion, ai_router: { runId: 'r1', events: [called, done] } });
    expect(completion).not.toHaveProperty(PROGRESS_FIELD);
  });

  it('reads back the run and every event it wrote', () => {
    expect(progressEvents(overTheWire(withProgress(completion, 'r1', [called, done])))).toEqual({
      runId: 'r1',
      events: [called, done],
    });
  });

  it('keeps the good events of a list with a bad one in it, and reads nothing off an answer without', () => {
    const mixed = { ...completion, [PROGRESS_FIELD]: { runId: 'r1', events: [called, { kind: 'teleport' }, done] } };
    expect(progressEvents(mixed)).toEqual({ runId: 'r1', events: [called, done] });
    expect(progressEvents(completion)).toBeUndefined();
    expect(progressEvents({ ...completion, [PROGRESS_FIELD]: { events: [called] } })).toBeUndefined();
  });
});

describe('remoteRun', () => {
  it("asks for progress under the host's own router fields, and keeps a host's progress: false", () => {
    expect(remoteRun({ top_k: 20, ai_router: { task: 'triage' } }, () => {}).extraBody).toEqual({
      top_k: 20,
      ai_router: { progress: true, task: 'triage' },
    });
    expect(remoteRun({ ai_router: { progress: false } }, () => {}).extraBody).toEqual({
      ai_router: { progress: false },
    });
  });

  it("forwards the server's events but its done, and holds back the loop's own for the server's steps", () => {
    const told: unknown[] = [];
    const remote = remoteRun(undefined, (event) => told.push(event));
    remote.onChunk(progressChunk(called, head));
    remote.onChunk(progressChunk(stamp({ kind: RunEventKind.Done, ok: true }, 'r1', 8, 43), head));
    remote.emit({ kind: RunEventKind.ToolCall, id: 'Srv000001', name: 'ask_user' });
    remote.emit({ kind: RunEventKind.Notice, text: 'retrying' });
    expect(told).toEqual([called, { kind: RunEventKind.Notice, text: 'retrying' }]);
    expect(remote.runId()).toBe('r1');
  });

  it('says every event of its own where the host turned progress off', () => {
    const told: unknown[] = [];
    const remote = remoteRun({ ai_router: { progress: false } }, (event) => told.push(event));
    remote.emit({ kind: RunEventKind.Turn, text: 'turn 1' });
    expect(told).toEqual([{ kind: RunEventKind.Turn, text: 'turn 1' }]);
  });

  it('asks for progress and forwards it under the field it is given', () => {
    const told: unknown[] = [];
    const remote = remoteRun({ agent_run: { task: 'triage' } }, (event) => told.push(event), { field: 'agent_run' });
    expect(remote.extraBody).toEqual({ agent_run: { progress: true, task: 'triage' } });
    remote.onChunk(progressChunk(called, head));
    remote.onChunk(progressChunk(called, head, 'agent_run'));
    expect(told).toEqual([called]);
  });

  it('makes a new idempotency key for each turn', () => {
    let made = 0;
    const remote = remoteRun(undefined, () => {}, { newKey: () => `key-${++made}` });
    expect(remote.turnHeaders()).toEqual({ [IDEMPOTENCY_HEADER]: 'key-1' });
    expect(remote.turnHeaders()).toEqual({ [IDEMPOTENCY_HEADER]: 'key-2' });
  });
});

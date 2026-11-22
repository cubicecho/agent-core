import { describe, expect, it } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import type { AgentLoopOptions } from '../../src/run/agent-loop.ts';
import { nestEvent, type RunEvent, type RunEventInput, RunEventKind, stamp } from '../../src/run/events.ts';
import {
  asRemoteAgent,
  IDEMPOTENCY_HEADER,
  PROGRESS_FIELD,
  progressChunk,
  progressEvent,
  progressEvents,
  progressWarnings,
  REMOTE_AGENT_NOTICE,
  remoteRun,
  withProgress,
} from '../../src/run/remote.ts';
import { CallIds } from '../../src/wire/call-ids.ts';
import { catalog, config, user } from '../helpers.ts';

/** The head every chunk of ai-router's stream for run `r1` carries. */
const head = { id: 'chatcmpl-r1', created: 1_700_000_000, model: 'helper' };

/** A tool call as a remote agent's run said it, numbered and stamped by the server. */
const called = stamp({ kind: RunEventKind.ToolCall, id: 'Srv000001', name: 'ask_user', text: '{}' }, 'r1', 7, 42);

/** What travelled: the value as JSON writes it and reads it back. */
const overTheWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('progressChunk and progressEvent', () => {
  it("writes a chunk in ai-router's shape: empty choices, the event under agent_core", () => {
    expect(progressChunk(called, head)).toEqual({
      ...head,
      object: 'chat.completion.chunk',
      choices: [],
      agent_core: { event: called },
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
    const { exchange: _exchange, ...unplaced } = called;
    expect(progressEvent({ [PROGRESS_FIELD]: { event: unplaced } })).toBeUndefined();
  });

  it("reads back a nested event's via, the hops it came by, unchanged", () => {
    const nested = { ...called, via: [{ runId: 'inner', callId: 'Srv000000' }] };
    expect(progressEvent(overTheWire(progressChunk(nested, head)))).toEqual(nested);
  });

  it('reads nothing off an event whose via is not a list of hops', () => {
    for (const via of ['inner', [{ runId: 'inner' }], [{ runId: 'inner', callId: 7 }]]) {
      expect(progressEvent({ [PROGRESS_FIELD]: { event: { ...called, via } } })).toBeUndefined();
    }
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
    expect(answer).toEqual({ ...completion, agent_core: { runId: 'r1', events: [called, done] } });
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
  /** A remote half over `extraBody`, with every event it tells collected. */
  const listening = (extraBody?: Record<string, unknown>, options?: Parameters<typeof remoteRun>[2]) => {
    const told: (RunEventInput | RunEvent)[] = [];
    return { remote: remoteRun(extraBody, (event) => told.push(event), options), told };
  };

  it("asks for progress under the host's own router fields, and keeps a host's progress: false", () => {
    expect(remoteRun({ top_k: 20, agent_core: { task: 'triage' } }, () => {}).extraBody).toEqual({
      top_k: 20,
      agent_core: { progress: true, task: 'triage' },
    });
    expect(remoteRun({ agent_core: { progress: false } }, () => {}).extraBody).toEqual({
      agent_core: { progress: false },
    });
  });

  it("forwards the server's events but its done, and holds back the loop's own for the server's steps", () => {
    const { remote, told } = listening();
    remote.onChunk(progressChunk(called, head));
    remote.onChunk(progressChunk(stamp({ kind: RunEventKind.Done, ok: true }, 'r1', 8, 43), head));
    remote.emit({ kind: RunEventKind.ToolCall, id: 'Srv000001', name: 'ask_user' });
    remote.emit({ kind: RunEventKind.Notice, text: 'retrying' });
    expect(told).toEqual([called, { kind: RunEventKind.Notice, text: 'retrying' }]);
    expect(remote.runId()).toBe('r1');
  });

  it("raises the server's warnings about the app's parts as notices", () => {
    const { remote, told } = listening();
    const warned = {
      agent_core: {
        warnings: [{ part: 'rules', rule: 'replace-not-allowed', message: 'Dropped rules.' }, { part: 'x' }],
      },
    };
    expect(progressWarnings(warned)).toEqual(['Dropped rules.']);
    remote.onChunk(warned as never);
    expect(told).toEqual([{ kind: RunEventKind.Notice, text: 'Dropped rules.' }]);
    expect(progressWarnings({ choices: [] })).toEqual([]);
  });

  it('says every event of its own where the host turned progress off', () => {
    const { remote, told } = listening({ agent_core: { progress: false } });
    remote.emit({ kind: RunEventKind.Turn, text: 'turn 1' });
    expect(told).toEqual([{ kind: RunEventKind.Turn, text: 'turn 1' }]);
  });

  it('asks for progress and forwards it under the field it is given', () => {
    const { remote, told } = listening({ agent_run: { task: 'triage' } }, { field: 'agent_run' });
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

  it("forwards an inner run's done, which is not the server's own", () => {
    const { remote, told } = listening();
    const innerDone = stamp({ kind: RunEventKind.Done, ok: true }, 'inner', 3, 40);
    const event = stamp(nestEvent(innerDone, { runId: 'inner', callId: 'Srv000000' }), 'r1', 8, 41);
    remote.onChunk(progressChunk(event, head));
    expect(told).toEqual([event]);
  });
});

describe('asRemoteAgent', () => {
  /** An exchange's options against a remote agent, with whatever the test asks for laid on, and what it noticed. */
  const remote = (given: Partial<AgentLoopOptions> = {}, extra: Partial<AgentLoopOptions['config']> = {}) => {
    const notices: string[] = [];
    const options: AgentLoopOptions = {
      config: { ...config, remoteAgent: true, contextLength: 8192, ...extra },
      messages: [user('hi')],
      dispatch: async () => 'ok',
      onEvent: (event: RunEventInput) => notices.push(event.text ?? ''),
      ...given,
    };
    return { options, notices, set: asRemoteAgent(options) };
  };

  it('hands back the options themselves for a model that is not a remote agent', () => {
    const options: AgentLoopOptions = { config, messages: [user('hi')], dispatch: async () => 'ok', compact: true };
    expect(asRemoteAgent(options)).toBe(options);
  });

  it("sets aside what is the server's to do, and names in one notice what the app asked for", () => {
    const asked = { compact: true, prune: true, preselect: true, maxContinuations: 2, catalog };
    const { set, notices } = remote(
      { ...asked, recoverToolCalls: true, callIds: CallIds.Minted },
      { toolDiscovery: ToolDiscovery.OnDemand },
    );
    expect(set).toMatchObject({ compact: false, prune: false, preselect: false, maxContinuations: 0 });
    expect(set.recoverToolCalls).toBe(false);
    expect(set.config).toMatchObject({ toolDiscovery: ToolDiscovery.Eager, contextLength: 0 });
    expect(notices).toHaveLength(1);
    expect(notices[0].startsWith(REMOTE_AGENT_NOTICE)).toBe(true);
    for (const name of [
      'compact',
      'prune',
      'preselect',
      'toolDiscovery',
      'maxContinuations',
      'recoverToolCalls',
      'callIds',
    ]) {
      expect(notices[0]).toContain(name);
    }
  });

  it('says nothing where the app asked for none of it, on-demand discovery with no catalogue included', () => {
    const { set, notices } = remote({}, { toolDiscovery: ToolDiscovery.OnDemand });
    expect(notices).toEqual([]);
    expect(set.config.toolDiscovery).toBe(ToolDiscovery.Eager);
  });
});

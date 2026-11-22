import { beforeEach, describe, expect, it } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import { type AgentLoopOptions, runAgentLoop } from '../../src/run/agent-loop.ts';
import { type RunEvent, type RunEventInput, RunEventKind, stamp } from '../../src/run/events.ts';
import { IDEMPOTENCY_HEADER, PROGRESS_FIELD, progressChunk, REMOTE_AGENT_NOTICE } from '../../src/run/remote.ts';
import { resetAll } from '../../src/runtime/reset.ts';
import { AGENT_SPEC, type AgentSpec, parseSpec, resolveAgentSpec } from '../../src/spec/spec.ts';
import { toolName } from '../../src/tools/tool-loading.ts';
import { CallIds } from '../../src/wire/call-ids.ts';
import { HttpStatus, Role } from '../../src/wire/wire.ts';
import { answeredBy, type Body, catalog, respond, streamed, tool, user } from '../helpers.ts';

/** The remote agent's run, as ai-router names it in every event and chunk. */
const RUN = 'run-1';

/** The id ai-router minted for the call it hands back. */
const HANDED = 'Srv000001';

/** What every chunk of the fake's stream carries, as ai-router's do. */
const head = { id: `chatcmpl-${RUN}`, created: 1, model: 'helper' };

/** One stretch of the remote run: what it says on the way, what it answers, and the calls it hands back. */
interface Stretch {
  events: RunEventInput[];
  content?: string;
  handBack?: { id: string; name: string; arguments: string }[];
}

/** What the fake was sent: the body, and the headers the loop added. */
interface Received {
  body: Body & Record<string, unknown>;
  key: string | null;
  session: string | null;
  url: string;
}

/**
 * A remote agent answered in process, streaming as ai-router does: an opening role chunk, a progress
 * chunk per event where the request asked for progress, the answer's text, the calls it hands back,
 * the finish, the usage, and `[DONE]`. Its events are numbered across stretches, as the router's are.
 *
 * @param stretches - What each request is answered with, in order.
 * @param [failFirst] - How many requests are refused with a 503 before any is answered.
 * @param [field] - The field the server reads its options and writes its progress under.
 * @returns The `fetch` to put on the endpoint, and what reached it.
 */
function remoteAgent(stretches: Stretch[], failFirst = 0, field: string = PROGRESS_FIELD) {
  const received: Received[] = [];
  let seq = 0;
  let failures = failFirst;
  let answered = 0;
  const fetch = answeredBy(async (request) => {
    const body = (await request.json()) as Received['body'];
    received.push({
      body,
      key: request.headers.get(IDEMPOTENCY_HEADER),
      session: request.headers.get('x-session-id'),
      url: request.url,
    });
    if (failures > 0) {
      failures--;
      return respond({ error: { message: 'the router is busy' } }, HttpStatus.ServiceUnavailable);
    }
    const stretch = stretches[answered++];
    if (!stretch) {
      throw new Error('the fake has no stretch left');
    }
    const options = body[field] as { progress?: boolean } | undefined;
    const progress = options?.progress === true ? stretch.events : [];
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      ...head,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const calls = (stretch.handBack ?? []).map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
    return streamed(
      chunk({ role: Role.Assistant, content: '' }),
      ...progress.map((input) => progressChunk(stamp(input, RUN, ++seq, 1000 + seq), head, field)),
      ...(stretch.content ? [chunk({ content: stretch.content })] : []),
      ...(calls.length ? [chunk({ tool_calls: calls })] : []),
      chunk({}, calls.length ? 'tool_calls' : 'stop'),
      {
        ...head,
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
      },
    );
  });
  return { fetch, received };
}

/** A run that searches on the server, then asks the app which colour it wants. */
const asking: Stretch = {
  events: [
    { kind: RunEventKind.Turn, text: 'turn 1' },
    { kind: RunEventKind.Thinking, text: 'look it up' },
    { kind: RunEventKind.ToolCall, id: 'loop_a', name: 'search', text: '{}' },
    { kind: RunEventKind.ToolResult, id: 'loop_a', name: 'search', ok: true, text: 'found' },
    { kind: RunEventKind.Usage, usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 } },
    { kind: RunEventKind.Turn, text: 'turn 2' },
    { kind: RunEventKind.ToolCall, id: HANDED, name: 'ask_user', text: '{"q":"which?"}' },
    { kind: RunEventKind.Usage, usage: { promptTokens: 40, completionTokens: 4, totalTokens: 44 } },
    { kind: RunEventKind.Notice, text: 'the run waits for the app to answer the call it handed back.' },
  ],
  handBack: [{ id: HANDED, name: 'ask_user', arguments: '{"q":"which?"}' }],
};

/** The same run resumed by the app's answer, to its end. */
const answering: Stretch = {
  events: [
    { kind: RunEventKind.ToolResult, id: HANDED, name: 'ask_user', ok: true, text: 'blue' },
    { kind: RunEventKind.Turn, text: 'turn 3' },
    { kind: RunEventKind.Output, text: 'Blue it is.' },
    { kind: RunEventKind.Usage, usage: { promptTokens: 60, completionTokens: 8, totalTokens: 68 } },
    { kind: RunEventKind.Done, ok: true },
  ],
  content: 'Blue it is.',
};

/** The least a run on a remote agent is configured with: no sampling chosen. */
const remoteConfig = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'http://router.internal/v1',
  apiKey: 'key',
  model: 'helper',
  remoteAgent: true as const,
  maxToolIterations: 4,
  fetch,
});

/**
 * Runs one question with the app's `ask_user`, answered `blue`.
 *
 * @param config - The run's config.
 * @param [more] - Options over the defaults.
 * @returns The result, every event the host heard, and every call `dispatch` was handed.
 */
async function ask(config: AgentLoopOptions['config'], more: Partial<AgentLoopOptions> = {}) {
  const events: (RunEventInput | RunEvent)[] = [];
  const dispatched: { id: string; name: string }[] = [];
  const result = await runAgentLoop({
    config,
    messages: [user('pick a colour')],
    hostTools: [tool('ask_user')],
    dispatch: async (call) => {
      dispatched.push({ id: call.id, name: call.name });
      return 'blue';
    },
    onEvent: (event) => events.push(event),
    ...more,
  });
  return { result, events, dispatched };
}

/** The kinds the server says of its own turns. */
const turnKinds: string[] = [
  RunEventKind.Turn,
  RunEventKind.Thinking,
  RunEventKind.Output,
  RunEventKind.ToolCall,
  RunEventKind.ToolResult,
  RunEventKind.Usage,
];

beforeEach(() => resetAll());

describe('a run on a remote agent', () => {
  it("forwards the server's events as it numbered them, and says none of its turns a second time", async () => {
    const { fetch } = remoteAgent([asking, answering]);
    const { result, events } = await ask(remoteConfig(fetch));

    const forwarded = events.filter((event): event is RunEvent => 'seq' in event);
    // Every event the server sent but its `done`, in its order and under its numbering.
    expect(forwarded.map((event) => [event.runId, event.seq, event.kind])).toEqual(
      [...asking.events, ...answering.events]
        .map((event, at) => [RUN, at + 1, event.kind])
        .filter(([, , kind]) => kind !== RunEventKind.Done),
    );
    // Nothing of the turns' own kinds came from the loop: the handed-back call is told once each way.
    expect(events.filter((event) => turnKinds.includes(event.kind) && 'seq' in event === false)).toEqual([]);
    expect(events.filter((event) => event.name === 'ask_user').map((event) => [event.kind, event.id])).toEqual([
      [RunEventKind.ToolCall, HANDED],
      [RunEventKind.ToolResult, HANDED],
    ]);
    expect(result.remoteRunId).toBe(RUN);
    expect(result.turn.content).toBe('Blue it is.');
    // The run's metrics are the server's turns: the search and the app's answer.
    expect(result.metrics.toolCalls).toBe(2);
  });

  it("says the client's exchange itself, and forwards none of the server's own starts or ends", async () => {
    const serverExchange: RunEventInput[] = [
      { kind: RunEventKind.Exchange, name: 'server-side' },
      { kind: RunEventKind.ExchangeEnd, outcome: 'answered', ok: true },
    ];
    const told: Stretch = { ...answering, events: [serverExchange[0], ...answering.events, serverExchange[1]] };
    const { fetch } = remoteAgent([{ ...asking }, told]);
    const { events } = await ask(remoteConfig(fetch), { exchange: 'colour' });

    const bounds = events.filter(
      (event) => event.kind === RunEventKind.Exchange || event.kind === RunEventKind.ExchangeEnd,
    );
    expect(bounds.map((event) => [event.kind, 'seq' in event])).toEqual([
      [RunEventKind.Exchange, false],
      [RunEventKind.ExchangeEnd, false],
    ]);
    expect(events[0]).toMatchObject({ kind: RunEventKind.Exchange, name: 'colour' });
    expect(events.at(-1)).toMatchObject({ kind: RunEventKind.ExchangeEnd, outcome: 'answered' });
    // The server's events name no exchange of their own, so they are filed under the client's.
    expect(events.filter((event) => 'seq' in event).every((event) => event.exchange === 'colour')).toBe(true);
  });

  it("answers the handed-back call with the host's dispatch, and resumes the run by the server's id", async () => {
    const { fetch, received } = remoteAgent([asking, answering]);
    const { result, dispatched } = await ask(remoteConfig(fetch));

    expect(dispatched).toEqual([{ id: HANDED, name: 'ask_user' }]);
    expect(received).toHaveLength(2);
    const resumed = received[1].body.messages;
    expect(resumed.at(-2)).toMatchObject({ role: Role.Assistant, tool_calls: [{ id: HANDED }] });
    expect(resumed.at(-1)).toEqual({ role: Role.Tool, tool_call_id: HANDED, content: 'blue' });
    // Both requests declared the app's tool, and nothing of the loop's own.
    expect(received.map(({ body }) => body.tools?.map(toolName))).toEqual([['ask_user'], ['ask_user']]);
    expect(result.toolCalls.map((call) => call.id)).toEqual([HANDED]);
  });

  it("keeps the server's call id even where the transcript already holds it, which a plain run renames", async () => {
    const earlier = [
      user('earlier'),
      {
        role: Role.Assistant,
        content: null,
        tool_calls: [{ id: HANDED, type: 'function' as const, function: { name: 'ask_user', arguments: '{}' } }],
      },
      { role: Role.Tool, tool_call_id: HANDED, content: 'red' },
      { role: Role.Assistant, content: 'Red, then.' },
      user('pick a colour'),
    ];
    const remote = remoteAgent([asking, answering]);
    const kept = await ask(remoteConfig(remote.fetch), { messages: earlier });
    expect(kept.dispatched).toEqual([{ id: HANDED, name: 'ask_user' }]);

    const plain = remoteAgent([asking, answering]);
    const { remoteAgent: _flag, ...config } = remoteConfig(plain.fetch);
    const renamed = await ask({ ...config, maxTokens: 0, temperature: 0 }, { messages: earlier });
    expect(renamed.dispatched[0].id).not.toBe(HANDED);
  });

  it('asks for and reads progress under the field the config names', async () => {
    const { fetch, received } = remoteAgent([asking, answering], 0, 'agent_run');
    const { result, events } = await ask({ ...remoteConfig(fetch), progressField: 'agent_run' });
    expect(received[0].body.agent_run).toEqual({ progress: true });
    expect(received[0].body).not.toHaveProperty(PROGRESS_FIELD);
    expect(events.filter((event) => 'seq' in event)).toHaveLength(asking.events.length + answering.events.length - 1);
    expect(result.remoteRunId).toBe(RUN);
  });

  it('sends no sampling the host did not set, and what it did set as it was set', async () => {
    const unset = remoteAgent([asking, answering]);
    await ask(remoteConfig(unset.fetch));
    for (const { body } of unset.received) {
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body[PROGRESS_FIELD]).toEqual({ progress: true });
    }

    const chosen = remoteAgent([asking, answering]);
    await ask({
      ...remoteConfig(chosen.fetch),
      temperature: 0.3,
      maxTokens: 50,
      extraBody: { top_k: 20, [PROGRESS_FIELD]: { task: 'triage' } },
    });
    expect(chosen.received[0].body).toMatchObject({
      temperature: 0.3,
      max_tokens: 50,
      top_k: 20,
      [PROGRESS_FIELD]: { progress: true, task: 'triage' },
    });
  });

  it("keeps a session on the server's own slots: the header is sent, no slot is asked for or probed", async () => {
    const { fetch, received } = remoteAgent([asking, answering]);
    await ask(remoteConfig(fetch), { session: 'conversation-9' });
    expect(received.map(({ url }) => new URL(url).pathname)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    expect(received.map(({ session }) => session)).toEqual(['conversation-9', 'conversation-9']);
    expect(received[0].body).not.toHaveProperty('id_slot');
  });

  it("sets aside the loop's own compaction, pruning, preselection, loading, continuations and window guard", async () => {
    const { spec, errors } = parseSpec({
      spec: AGENT_SPEC,
      endpoint: { baseUrl: 'http://router.internal/v1' },
      model: { model: 'helper' },
      tools: { discovery: ToolDiscovery.OnDemand },
      tasks: { toolSelect: { model: 'tiny' }, compaction: { model: 'tiny' } },
    });
    expect(errors).toEqual([]);
    const { fetch, received } = remoteAgent([asking, answering]);
    const long = 'word '.repeat(20_000);
    const { result, events } = await ask(
      { ...resolveAgentSpec([spec as AgentSpec]), remoteAgent: true, contextLength: 8192, fetch },
      {
        messages: [user(long)],
        tools: [tool('gmail__send_email')],
        catalog,
        preselect: true,
        compact: true,
        prune: true,
        maxContinuations: 2,
      },
    );

    expect(result.turn.content).toBe('Blue it is.');
    // Two requests, both the remote run's: no preselection, summary or continuation was sent.
    expect(received.map(({ body }) => [body.model, body.stream])).toEqual([
      ['helper', true],
      ['helper', true],
    ]);
    // Eager: the host's tools, no `load_tools`, and no catalogue on a system prompt.
    expect(received[0].body.tools?.map(toolName)).toEqual(['ask_user', 'gmail__send_email']);
    expect(received[0].body.messages).toEqual([user(long)]);
    expect(events).toContainEqual({
      kind: RunEventKind.Notice,
      text: `${REMOTE_AGENT_NOTICE}compact, prune, preselect, toolDiscovery "ondemand", maxContinuations`,
    });
  });

  it('names call recovery and minted call ids in its notice, which it also sets aside', async () => {
    const { fetch } = remoteAgent([{ events: [], content: 'Blue it is.' }]);
    const { events } = await ask(remoteConfig(fetch), { recoverToolCalls: true, callIds: CallIds.Minted });
    expect(events).toContainEqual({
      kind: RunEventKind.Notice,
      text: `${REMOTE_AGENT_NOTICE}recoverToolCalls, callIds "minted"`,
    });
  });

  it('takes a call the remote agent wrote into its answer as the answer, not as a call', async () => {
    const written = '<tool_call>{"name": "ask_user", "arguments": {}}</tool_call>';
    const { fetch } = remoteAgent([{ events: [], content: written }]);
    const { result, dispatched } = await ask(remoteConfig(fetch));
    expect(dispatched).toEqual([]);
    expect(result.turn.content).toBe(written);
  });

  it("sends one idempotency key across a turn's retries, and a new one on the next turn", async () => {
    const { fetch, received } = remoteAgent([asking, answering], 1);
    await ask({ ...remoteConfig(fetch), maxRetries: 1 });
    const keys = received.map(({ key }) => key);
    expect(keys).toHaveLength(3);
    expect(keys.every((key) => typeof key === 'string' && key !== '')).toBe(true);
    // The first request was refused before a chunk and sent again under the same key.
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("says the loop's own events where the host turned progress off", async () => {
    const { fetch, received } = remoteAgent([asking, answering]);
    const { events, result } = await ask({
      ...remoteConfig(fetch),
      extraBody: { [PROGRESS_FIELD]: { progress: false } },
    });
    expect(received[0].body[PROGRESS_FIELD]).toEqual({ progress: false });
    expect(events.some((event) => 'seq' in event)).toBe(false);
    expect(events.filter((event) => event.kind === RunEventKind.Turn).map((event) => event.text)).toEqual([
      'turn 1',
      'turn 2',
    ]);
    expect(result.remoteRunId).toBeUndefined();
  });

  it("writes the app's parts itself, and leaves the transcript's system messages as they came", async () => {
    const { fetch, received } = remoteAgent([{ events: [], content: 'Blue it is.' }]);
    await ask(
      { ...remoteConfig(fetch), promptLayout: 'xml' },
      {
        systemPrompt: [{ role: Role.System, name: 'identity', content: 'You pick colours.', owner: 'agent' }],
        messages: [{ role: Role.System, content: 'Today is Monday.' }, user('pick a colour')],
      },
    );
    const [system, ...rest] = received[0].body.messages;
    expect(String(system.content)).toContain('<prompt_identity>\nYou pick colours.\n</prompt_identity>');
    // The server stacks its own: the loop does not take them in as `app_system`.
    expect(String(system.content)).not.toContain('prompt_app_system');
    expect(String(system.content).endsWith('\n\nToday is Monday.')).toBe(true);
    expect(rest).toEqual([user('pick a colour')]);
  });

  it('names the remote run on what it throws', async () => {
    const { fetch } = remoteAgent([asking]);
    // The second request finds no stretch left, and the fake throws.
    const failed = ask(remoteConfig(fetch));
    await expect(failed).rejects.toMatchObject({ remoteRunId: RUN });
  });
});

describe('a run on a plain OpenAI server, with no flag', () => {
  it('sends its sampling, asks for no progress, sends no key, and says its own events', async () => {
    const { fetch, received } = remoteAgent([asking, answering]);
    const { remoteAgent: _flag, ...endpoint } = remoteConfig(fetch);
    const { events, result, dispatched } = await ask({ ...endpoint, temperature: 0.7, maxTokens: 100 });

    expect(received[0].body).toMatchObject({ temperature: 0.7, max_tokens: 100 });
    expect(received[0].body).not.toHaveProperty(PROGRESS_FIELD);
    expect(received.map(({ key }) => key)).toEqual([null, null]);
    expect(events.some((event) => 'seq' in event)).toBe(false);
    expect(events.filter((event) => event.kind === RunEventKind.ToolCall).map((event) => event.id)).toEqual([HANDED]);
    expect(dispatched).toEqual([{ id: HANDED, name: 'ask_user' }]);
    expect(result.remoteRunId).toBeUndefined();
  });
});

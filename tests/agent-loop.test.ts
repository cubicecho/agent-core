import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock("../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.ts")>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { buildBody, preselect, preview, resolveApiKey, runAgentLoop } = await import(
  "../src/agent-loop.ts"
);
const { capabilitiesFor, modelCapabilitiesFor, resetCapabilities } = await import(
  "../src/capabilities.ts"
);
const { LOAD_TOOLS } = await import("../src/tool-loading.ts");
const { configureHooks, resetHooks } = await import("../src/hooks.ts");

type Message = OpenAI.ChatCompletionMessageParam;
type Turn = import("../src/stream.ts").Turn;
type ToolCall = import("../src/tool-calls.ts").ToolCall;
type ToolCallRequest = import("../src/agent-loop.ts").ToolCallRequest;
type RunUsage = import("../src/events.ts").RunUsage;
type Body = OpenAI.ChatCompletionCreateParamsStreaming;

const stream = (...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list as OpenAI.ChatCompletionChunk[];
  },
});
/** A turn that answers in words. */
const says = (content: string, finish = "stop") =>
  stream(
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: finish }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  );
/** A turn that asks for these calls. */
const calls = (...list: [name: string, args: string][]) =>
  stream({
    choices: [
      {
        delta: {
          tool_calls: list.map(([name, args], index) => ({
            index,
            id: `c${index}`,
            function: { name, arguments: args },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  });

/** A turn that makes these deltas and reports this prompt, with a cache count, and ten tokens out. */
const reported = (
  prompt: number,
  cached: number,
  delta: Record<string, unknown>,
  finish = "stop",
) =>
  stream(
    { choices: [{ delta, finish_reason: finish }] },
    {
      choices: [],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: 10,
        total_tokens: prompt + 10,
        prompt_tokens_details: { cached_tokens: cached },
      },
    },
  );
/** The same, asking for one call. */
const reportedCall = (prompt: number, cached: number, name: string, args = "{}") =>
  reported(
    prompt,
    cached,
    { tool_calls: [{ index: 0, id: "c0", function: { name, arguments: args } }] },
    "tool_calls",
  );

const tool = (name: string): OpenAI.ChatCompletionTool => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

const config = {
  baseUrl: "http://local/v1",
  apiKey: "",
  model: "m",
  maxTokens: 100,
  temperature: 0.2,
  maxToolIterations: 4,
};
const question: Message[] = [{ role: "user", content: "hi" }];
/** What each request was sent, by the name of every tool it declared. */
const declared = () =>
  create.mock.calls.map(([body]) =>
    ((body as Body).tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name),
  );

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe("buildBody", () => {
  const messages: Message[] = [{ role: "user", content: "hi" }];

  it("sends what a fresh endpoint and model have not refused", () => {
    const supports = capabilitiesFor("https://api.openai.com/v1");
    const body = buildBody({ ...config, reasoningEffort: "low" }, supports, undefined, messages, [
      tool("a"),
    ]);
    expect(body).toMatchObject({
      model: "m",
      max_tokens: 100,
      temperature: 0.2,
      reasoning_effort: "low",
      stream: true,
      stream_options: { include_usage: true },
      messages,
    });
    expect(body.tools).toHaveLength(1);
  });

  it("spells the ceiling, drops the temperature and effort the model refused", () => {
    const supports = capabilitiesFor("https://api.openai.com/v1");
    const refused = modelCapabilitiesFor(supports, "m");
    Object.assign(refused, {
      legacyTokenLimit: false,
      chosenTemperature: false,
      reasoningEffort: false,
    });
    const body = buildBody({ ...config, reasoningEffort: "high" }, supports, refused, messages);
    expect(body).toMatchObject({ max_completion_tokens: 100 });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("tools");
  });

  it("sends no ceiling at zero and no effort at off", () => {
    const body = buildBody(
      { ...config, maxTokens: 0, reasoningEffort: "off" },
      capabilitiesFor("http://local/v1"),
      undefined,
      messages,
    );
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("merges extraBody last, less the refused fields and the loop's own", () => {
    const supports = capabilitiesFor("http://local/v1");
    const refused = modelCapabilitiesFor(supports, "m");
    refused.refusedFields.add("min_p");
    const body = buildBody(
      {
        ...config,
        extraBody: { id_slot: 2, min_p: 0.1, temperature: 0.9, model: "x", stream: false },
      },
      supports,
      refused,
      messages,
    );
    expect(body).toMatchObject({ id_slot: 2, temperature: 0.9, model: "m", stream: true });
    expect(body).not.toHaveProperty("min_p");
  });

  it("relaxes schemas where the endpoint could not build a grammar", () => {
    const supports = capabilitiesFor("http://local/v1");
    supports.strictSchemas = false;
    const pattern: OpenAI.ChatCompletionTool = {
      type: "function",
      function: {
        name: "p",
        parameters: { type: "object", properties: { s: { type: "string", pattern: "^a$" } } },
      },
    };
    const body = buildBody(config, supports, undefined, messages, [pattern]);
    expect(JSON.stringify(body.tools)).not.toContain("pattern");
  });

  /** The names a built body declares, in the order it declares them. */
  const names = (body: Body) =>
    (body.tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name);

  it("declares the same set in the same order however the caller built the array", () => {
    const supports = capabilitiesFor("http://local/v1");
    const one = buildBody(config, supports, undefined, messages, [
      tool("b__x"),
      tool("a__y"),
      tool("a__x"),
    ]);
    const other = buildBody(config, supports, undefined, messages, [
      tool("a__x"),
      tool("b__x"),
      tool("a__y"),
    ]);
    expect(names(one)).toEqual(["a__x", "a__y", "b__x"]);
    expect(names(other)).toEqual(names(one));
  });

  it("sends the caller's own order when told to", () => {
    const supports = capabilitiesFor("http://local/v1");
    const body = buildBody(config, supports, undefined, messages, [tool("b"), tool("a")], false);
    expect(names(body)).toEqual(["b", "a"]);
  });

  it("orders by a comparator of the caller's", () => {
    const supports = capabilitiesFor("http://local/v1");
    const body = buildBody(
      config,
      supports,
      undefined,
      messages,
      [tool("a"), tool("b"), tool("c")],
      (a, b) => b.localeCompare(a),
    );
    expect(names(body)).toEqual(["c", "b", "a"]);
  });
});

describe("resolveApiKey", () => {
  const env = { OPENAI_API_KEY: "env-key" };

  it("prefers the endpoint's own key", () => {
    expect(
      resolveApiKey({ apiKey: "own", baseUrl: "http://x" }, { baseUrl: "http://y" }, env),
    ).toBe("own");
  });

  it("sends no inherited key to an endpoint the settings did not name", () => {
    expect(
      resolveApiKey(
        { baseUrl: "http://friend/v1" },
        { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
        env,
      ),
    ).toBe("agent-core");
  });

  it("inherits on the same endpoint, however the URL is written", () => {
    expect(
      resolveApiKey({ baseUrl: " http://x/v1/ " }, { baseUrl: "http://x/v1", apiKey: "k" }, env),
    ).toBe("k");
    expect(resolveApiKey({}, { baseUrl: "http://x/v1" }, env)).toBe("env-key");
    expect(resolveApiKey({}, undefined, {})).toBe("agent-core");
  });
});

describe("preview", () => {
  it("cuts long text and says how long it was", () => {
    expect(preview("abc", 5)).toBe("abc");
    expect(preview("abcdefgh", 5)).toBe("abcde… (8 chars)");
  });
});

describe("preselect", () => {
  const catalog = [{ id: "s", label: "S", tools: [{ name: "s__read", description: "reads" }] }];

  it("hands back the catalogued names the small model picked", async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '["s__read", "nope"]' } }] });
    expect(await preselect(config, "small", catalog, "read it")).toEqual(["s__read"]);
    expect(create.mock.calls[0][0]).toMatchObject({
      response_format: { type: "json_schema", json_schema: { name: "preselection" } },
    });
    create.mockResolvedValue({ choices: [{ message: { content: '{"tools": ["s__read"]}' } }] });
    expect(await preselect(config, "small", catalog, "read it")).toEqual(["s__read"]);
  });

  it("picks nothing without a model, and nothing when the call fails", async () => {
    expect(await preselect(config, "", catalog, "read it")).toEqual([]);
    const notices: string[] = [];
    create.mockRejectedValueOnce(new Error("boom"));
    const got = await preselect(config, "small", catalog, "x", {
      onNotice: (n) => notices.push(n),
    });
    expect(got).toEqual([]);
    expect(notices).toEqual([expect.stringContaining("boom")]);
  });
});

describe("runAgentLoop", () => {
  it("runs the tools between turns and hands back the transcript", async () => {
    create
      .mockReturnValueOnce(calls(["a", '{"x":1}'], ["b", ""]))
      .mockReturnValueOnce(says("done"));
    const dispatch = vi.fn(async ({ name, args }: { name: string; args: unknown }) => {
      if (name === "b") throw new Error("b broke");
      return JSON.stringify(args);
    });
    const events: { kind: string }[] = [];
    const result = await runAgentLoop({
      config,
      system: "be brief",
      messages: question,
      tools: [tool("a"), tool("b")],
      dispatch,
      onEvent: (event) => events.push(event),
    });
    expect(result.turn.content).toBe("done");
    expect(result.toolCalls).toEqual([
      { name: "a", ok: true },
      { name: "b", ok: false },
    ]);
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(result.messages[3]).toMatchObject({ content: "b broke" });
    // Stored as `{}` so a server that parses the replayed call does not refuse an empty one.
    expect(JSON.stringify(result.messages[1])).toContain('"arguments":"{}"');
    expect(question).toHaveLength(1);
    expect((create.mock.calls[0][0] as Body).messages[0]).toEqual({
      role: "system",
      content: "be brief",
    });
    expect(result.usage).toEqual({ prompt: 10, completion: 2, total: 12, cached: 0 });
    expect(events.map((e) => e.kind)).toEqual([
      "turn",
      "usage",
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
      "turn",
      "output",
      "usage",
    ]);
  });

  it("stops when the tool budget is spent", async () => {
    create.mockImplementation(() => calls(["a", "{}"]));
    await expect(
      runAgentLoop({
        config: { ...config, maxToolIterations: 2 },
        messages: question,
        tools: [tool("a")],
        dispatch: async () => "ok",
      }),
    ).rejects.toThrow("Stopped after 2 tool iterations.");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reports every turn on its own usage event, with the cache weighed against the last request", async () => {
    create
      .mockReturnValueOnce(reportedCall(100, 0, "a"))
      .mockReturnValueOnce(reported(130, 108, { content: "done" }));
    const reports: RunUsage[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch: async () => "ok",
      onEvent: (event) => event.kind === "usage" && event.usage && reports.push(event.usage),
    });
    expect(reports).toHaveLength(2);
    expect(reports[0].turn).toMatchObject({
      prompt: 100,
      cached: 0,
      uncached: 100,
      finishReason: "tool_calls",
      toolsDeclared: 1,
      retries: 0,
    });
    expect(reports[0].turn?.toolSchemaTokens).toBeGreaterThan(0);
    // Nothing before the first request to weigh it against.
    expect(reports[0].turn).not.toHaveProperty("cacheExpected");
    expect(reports[1]).toMatchObject({ promptTokens: 230, cachedTokens: 108 });
    expect(reports[1].turn).toMatchObject({
      cacheExpected: 110,
      cacheBroken: false,
      finishReason: "stop",
    });
    expect(reports[1].turn).not.toHaveProperty("cacheBreakReason");
    expect(result.metrics).toMatchObject({
      turns: 2,
      requests: 2,
      toolCalls: 1,
      promptTokens: 230,
      cachedTokens: 108,
      cacheBreaks: 0,
      outcome: "answered",
    });
    expect(result.metrics.wallMs).toBeGreaterThanOrEqual(0);
    // Loads are only counted where tools load on demand.
    expect(result.metrics).not.toHaveProperty("toolsLoaded");
  });

  it("names what broke the cache: a rewritten history, or nothing it knows of", async () => {
    const reasons = async (
      beforeStep?: (m: readonly Message[], step: number) => Message[] | undefined,
    ) => {
      create
        .mockReset()
        .mockReturnValueOnce(reportedCall(100, 0, "a"))
        .mockReturnValueOnce(reported(130, 4, { content: "done" }));
      const turns: RunUsage["turn"][] = [];
      const result = await runAgentLoop({
        config,
        messages: question,
        tools: [tool("a")],
        dispatch: async () => "ok",
        beforeStep,
        onEvent: (event) => event.kind === "usage" && turns.push(event.usage?.turn),
      });
      expect(result.metrics.cacheBreaks).toBe(1);
      expect(turns[1]?.cacheBroken).toBe(true);
      return turns[1]?.cacheBreakReason;
    };
    expect(await reasons()).toBe("none-known");
    expect(
      await reasons((messages, step) =>
        step === 1 ? [{ role: "user", content: "shorter" }, ...messages.slice(1)] : undefined,
      ),
    ).toBe("history-rewritten");
  });

  it("says nothing of a break where the endpoint reported no cache count", async () => {
    create.mockReturnValueOnce(calls(["a", "{}"])).mockReturnValueOnce(says("done"));
    const turns: RunUsage["turn"][] = [];
    await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch: async () => "ok",
      onEvent: (event) => event.kind === "usage" && turns.push(event.usage?.turn),
    });
    // The first turn reported no prompt, so there is nothing for the second to be weighed against.
    expect(turns[1]).not.toHaveProperty("cacheExpected");
    expect(turns[1]).not.toHaveProperty("cacheBroken");
  });

  it("continues an answer cut off at the ceiling when asked to, as one turn", async () => {
    create.mockReturnValueOnce(says("half", "length")).mockReturnValueOnce(says(" and the rest"));
    const notices: string[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      dispatch: async () => "",
      maxContinuations: 2,
      onEvent: (event) => event.kind === "notice" && notices.push(event.text ?? ""),
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1][0] as Body).messages.at(-1)).toEqual({
      role: "assistant",
      content: "half",
    });
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "half and the rest",
    });
    expect(notices).toEqual([]);
    expect(result.usage).toMatchObject({ prompt: 20, completion: 4 });
    expect(result.metrics).toMatchObject({
      turns: 1,
      requests: 2,
      truncatedTurns: 0,
      outcome: "answered",
    });
  });

  it("does not continue a cut-off answer unless asked to", async () => {
    create.mockReturnValueOnce(says("half", "length"));
    const result = await runAgentLoop({ config, messages: question, dispatch: async () => "" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.metrics).toMatchObject({ truncatedTurns: 1, outcome: "truncated" });
  });

  it("says when a turn was cut off at the ceiling", async () => {
    create.mockReturnValueOnce(says("half", "length"));
    const notices: string[] = [];
    await runAgentLoop({
      config,
      messages: question,
      dispatch: async () => "",
      onEvent: (event) => event.kind === "notice" && notices.push(event.text ?? ""),
    });
    expect(notices).toEqual(["the model stopped at maxTokens (100); this turn is cut short"]);
  });

  it("drops a call that never got a name", async () => {
    create.mockReturnValueOnce(calls(["", "{}"]));
    const dispatch = vi.fn();
    const result = await runAgentLoop({ config, messages: question, dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.messages.at(-1)).not.toHaveProperty("tool_calls");
  });

  it("hands the tool repaired arguments and replays them as JSON", async () => {
    create
      .mockReturnValueOnce(calls(["a", "{'x': True,}"], ["a", "{nope"]))
      .mockReturnValueOnce(says("done"));
    const dispatch = vi.fn(async (_call: ToolCallRequest) => "ok");
    const result = await runAgentLoop({ config, messages: question, tools: [tool("a")], dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ args: { x: true }, raw: "{'x': True,}" });
    const replayed = (result.messages[1] as OpenAI.ChatCompletionAssistantMessageParam).tool_calls;
    expect(replayed?.map((c) => (c as ToolCall).function.arguments)).toEqual(['{"x":true}', "{}"]);
    expect(result.messages[3]).toMatchObject({ content: expect.stringContaining("invalid tool") });
    expect(result.toolCalls).toEqual([
      { name: "a", ok: true },
      { name: "a", ok: false },
    ]);
  });

  it("tells a call cut off at the ceiling to raise maxTokens", async () => {
    create
      .mockReturnValueOnce(
        stream({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c0", function: { name: "a", arguments: '{"x": "lo' } },
                ],
              },
              finish_reason: "length",
            },
          ],
        }),
      )
      .mockReturnValueOnce(says("done"));
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch: async () => "ok",
    });
    expect(result.messages[2]).toMatchObject({
      content: expect.stringContaining("raise maxTokens"),
    });
  });

  it("runs tool calls written as text, and says the parser does not match", async () => {
    create
      .mockReturnValueOnce(
        says('Checking.\n<tool_call>\n{"name": "a", "arguments": {"x": 1}}\n</tool_call>'),
      )
      .mockReturnValueOnce(says("done"));
    const dispatch = vi.fn(async (_call: ToolCallRequest) => "ok");
    const notices: string[] = [];
    const turns: Turn[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch,
      onTurn: (turn) => turns.push(turn),
      onEvent: (event) => event.kind === "notice" && notices.push(event.text ?? ""),
    });
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      id: "call_recovered_0",
      name: "a",
      args: { x: 1 },
    });
    expect(result.messages[1]).toMatchObject({ role: "assistant", content: "Checking." });
    expect(result.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_recovered_0" });
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(notices[0]).toContain("recovered 1 tool call the model wrote as text");
  });

  it("leaves a call written as text alone when recovery is off, or no tools exist", async () => {
    const text = '{"name": "a", "arguments": {}}';
    create
      .mockReturnValueOnce(says(text))
      .mockReturnValueOnce(says(`<tool_call>${text}</tool_call>`));
    const dispatch = vi.fn();
    const off = await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch,
      recoverToolCalls: false,
    });
    expect(off.turn.content).toBe(text);
    const bare = await runAgentLoop({ config, messages: question, dispatch });
    expect(bare.turn.toolCalls).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops between calls once aborted", async () => {
    const controller = new AbortController();
    create.mockReturnValueOnce(calls(["a", "{}"], ["a", '{"n":2}']));
    const dispatch = vi.fn(async () => {
      controller.abort();
      return "ok";
    });
    await expect(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool("a")],
        dispatch,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("runs a step's calls together, and an identical call once", async () => {
    create
      .mockReturnValueOnce(calls(["a", "{}"], ["a", "{}"], ["a", '{"n":1}']))
      .mockReturnValueOnce(says("done"));
    let running = 0;
    let most = 0;
    const dispatch = vi.fn(async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return "ok";
    });
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch,
      parallel: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(most).toBe(2);
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(3);
  });

  it("makes a failed identical call again rather than replaying the failure", async () => {
    create
      .mockReturnValueOnce(calls(["a", "{}"]))
      .mockReturnValueOnce(calls(["a", "{}"]))
      .mockReturnValueOnce(says("done"));
    const dispatch = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValue("ok");
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch,
      parallel: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toEqual([
      { name: "a", ok: false },
      { name: "a", ok: true },
    ]);
  });

  it("declares the tools in name order, and as the host built them when told to", async () => {
    const tools = [tool("z"), tool("a")];
    create.mockReturnValueOnce(says("done"));
    await runAgentLoop({ config, messages: question, tools, dispatch: async () => "ok" });
    create.mockReturnValueOnce(says("done"));
    await runAgentLoop({
      config,
      messages: question,
      tools,
      toolOrder: false,
      dispatch: async () => "ok",
    });
    expect(declared()).toEqual([
      ["a", "z"],
      ["z", "a"],
    ]);
    // The host's array is read, never rearranged in place.
    expect(tools.map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name)).toEqual([
      "z",
      "a",
    ]);
  });

  it("answers an identical call once when the calls run one after another too", async () => {
    create
      .mockReturnValueOnce(calls(["a", "{}"], ["a", '{"n": 1}'], ["a", '{"n":1}']))
      .mockReturnValueOnce(says("done"));
    const dispatch = vi.fn(async () => "ok");
    const result = await runAgentLoop({ config, messages: question, tools: [tool("a")], dispatch });
    // Three calls, two questions: the repeat is the repaired arguments matching, not the text.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(3);
  });

  it("asks again in a later step, where the tools between may have moved the world", async () => {
    create
      .mockReturnValueOnce(calls(["a", "{}"]))
      .mockReturnValueOnce(calls(["a", "{}"]))
      .mockReturnValueOnce(says("done"));
    const dispatch = vi.fn(async () => "ok");
    await runAgentLoop({ config, messages: question, tools: [tool("a")], dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("dispatches every call where the host turned deduping off", async () => {
    create.mockReturnValueOnce(calls(["a", "{}"], ["a", "{}"])).mockReturnValueOnce(says("done"));
    const dispatch = vi.fn(async () => "ok");
    await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch,
      dedupeToolCalls: false,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("lets a tool that does something rather than reads something opt out", async () => {
    create
      .mockReturnValueOnce(calls(["send", "{}"], ["send", "{}"], ["read", "{}"], ["read", "{}"]))
      .mockReturnValueOnce(says("done"));
    const dispatched: string[] = [];
    const dispatch = vi.fn(async (call: ToolCallRequest) => {
      dispatched.push(call.name);
      return "ok";
    });
    await runAgentLoop({
      config,
      messages: question,
      tools: [tool("send"), tool("read")],
      dispatch,
      dedupeToolCalls: (call) => call.name !== "send",
    });
    // Two emails, one read.
    expect(dispatched).toEqual(["send", "send", "read"]);
  });

  describe("on demand", () => {
    const catalog = [
      {
        id: "s",
        label: "S",
        tools: [
          { name: "s__read", description: "reads" },
          { name: "s__write", description: "writes" },
        ],
      },
    ];
    const tools = [tool("s__read"), tool("s__write")];
    const onDemand = { ...config, toolDiscovery: "ondemand" as const };

    it("loads what the model asks for and declares it on the next step", async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
        .mockReturnValueOnce(calls(["s__read", "{}"]))
        .mockReturnValueOnce(says("done"));
      const dispatch = vi.fn(async () => "contents");
      const result = await runAgentLoop({
        config: onDemand,
        system: "sys",
        messages: question,
        tools,
        catalog,
        dispatch,
      });
      expect(declared()).toEqual([[LOAD_TOOLS], [LOAD_TOOLS, "s__read"], [LOAD_TOOLS, "s__read"]]);
      const systems = create.mock.calls.map(([body]) => (body as Body).messages[0].content);
      expect(systems[0]).toContain("sys");
      // The head of the prompt does not move when a tool is loaded, so the cache survives it.
      expect(new Set(systems).size).toBe(1);
      expect(systems[0]).not.toContain("(loaded)");
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.loaded).toEqual(["s__read"]);
      expect(result.used).toEqual(["s__read"]);
    });

    it("counts what the model loaded, and calls a load that moved the tools a cache break", async () => {
      create
        .mockReturnValueOnce(reportedCall(100, 0, LOAD_TOOLS, '{"names":["s__read","nope"]}'))
        .mockReturnValueOnce(reportedCall(160, 0, LOAD_TOOLS, '{"names":["s__read"]}'))
        .mockReturnValueOnce(reported(190, 170, { content: "done" }));
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch: async () => "ok",
      });
      expect(result.metrics).toMatchObject({
        loadCalls: 2,
        toolsLoaded: 1,
        redundantLoads: 1,
        unknownToolNames: 1,
        cacheBreaks: 1,
        cacheBreakReasons: { "tools-changed": 1 },
      });
    });

    it("declares loads in name order however they happened, and answers a repeat load", async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__write"]}']))
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read","s__write"]}']))
        .mockReturnValueOnce(says("done"));
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch: async () => "ok",
      });
      // `s__write` was loaded first and is still declared second: the array a request sends is
      // decided by the names in it, not by the order the loads happened in, so the same pair
      // renders the same way in a run that loaded them the other way round.
      expect(declared()).toEqual([
        [LOAD_TOOLS],
        [LOAD_TOOLS, "s__write"],
        [LOAD_TOOLS, "s__read", "s__write"],
      ]);
      const second = result.messages.filter((message) => message.role === "tool")[1];
      expect(second.content).toContain("Loaded 1 tool(s)");
      expect(second.content).toContain("Already loaded and in your tool list: s__write");
    });

    it("loads and runs a catalogued tool called without loading it", async () => {
      create.mockReturnValueOnce(calls(["s__write", "{}"])).mockReturnValueOnce(says("done"));
      const dispatch = vi.fn(async () => "written");
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.loaded).toEqual(["s__write"]);
      expect(declared()[1]).toEqual([LOAD_TOOLS, "s__write"]);
    });

    it("opens a preselected run with those tools alone, and the catalogue after", async () => {
      create.mockReturnValueOnce(calls(["s__read", "{}"])).mockReturnValueOnce(says("done"));
      await runAgentLoop({
        config: onDemand,
        system: "sys",
        messages: question,
        tools,
        catalog,
        preselected: ["s__read"],
        dispatch: async () => "ok",
      });
      expect(declared()).toEqual([["s__read"], [LOAD_TOOLS, "s__read"]]);
      expect((create.mock.calls[0][0] as Body).messages[0].content).toBe("sys");
      expect((create.mock.calls[1][0] as Body).messages[0].content).toContain("Tool catalogue");
    });
  });

  it("puts the hooks' context on the question, and tells them the reply", async () => {
    create.mockReturnValueOnce(calls(["a", "{}"])).mockReturnValueOnce(says("the answer"));
    const run = vi.fn(async (event: string) =>
      event === "beforeTurn"
        ? [
            {
              serverId: "m",
              label: "memory",
              hookId: "h",
              event,
              ok: true,
              text: "you like tea",
              inject: true,
              maxTokens: 500,
            },
          ]
        : [],
    );
    const result = await runAgentLoop({
      config,
      messages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "sure" },
        { role: "user", content: "what do I like?" },
      ],
      tools: [tool("a")],
      dispatch: async () => "ok",
      hooks: { run: run as never, context: { session: { id: "s1" } } },
    });
    for (const [body] of create.mock.calls) {
      const sent = (body as Body).messages;
      expect(sent[2].content).toContain("you like tea");
      expect(sent[0].content).toBe("earlier");
    }
    // The transcript handed back is the one without the context; it was for the request only.
    expect(result.messages[2].content).toBe("what do I like?");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const [event, context] = run.mock.calls[1] as unknown as [string, Record<string, unknown>];
    expect(event).toBe("afterTurn");
    expect(context).toMatchObject({ reply: "the answer", turn: { index: 1 } });
  });

  it("says configureHooks' preface above the hooks' context, unless the loop gives its own", async () => {
    const run = async (event: string) => [
      {
        serverId: "m",
        label: "memory",
        hookId: "h",
        event,
        ok: true,
        text: "you like tea",
        inject: true,
        maxTokens: 500,
      },
    ];
    const sentQuestion = async (preface?: string) => {
      create.mockReset().mockReturnValueOnce(says("ok"));
      await runAgentLoop({
        config,
        messages: question,
        dispatch: async () => "ok",
        hooks: { run: run as never, context: { session: { id: "s1" } }, preface },
      });
      return (create.mock.calls[0][0] as Body).messages[0].content as string;
    };
    configureHooks({ preface: "From min-agent:" });
    try {
      expect(await sentQuestion()).toMatch(/^From min-agent:\n\n<context source="memory">/);
      expect(await sentQuestion("From kanban:")).toMatch(/^From kanban:\n\n<context/);
      expect(await sentQuestion("")).toMatch(/^<context source="memory">/);
    } finally {
      resetHooks();
    }
  });

  it("lets beforeStep replace the transcript", async () => {
    create.mockReturnValueOnce(calls(["a", "{}"])).mockReturnValueOnce(says("done"));
    const beforeStep = vi.fn((messages: readonly Message[], step: number) =>
      step === 1
        ? [{ role: "user" as const, content: "shorter" }, ...messages.slice(1)]
        : undefined,
    );
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool("a")],
      dispatch: async () => "ok",
      beforeStep,
    });
    expect(beforeStep).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1][0] as Body).messages[0]).toEqual({
      role: "user",
      content: "shorter",
    });
    expect(result.messages[0]).toEqual({ role: "user", content: "shorter" });
  });

  it("drops an extraBody field the model refuses, and keeps it dropped", async () => {
    const refusal = Object.assign(
      new Error("400 Unrecognized request argument supplied: id_slot"),
      {
        status: 400,
      },
    );
    create
      .mockRejectedValueOnce(refusal)
      .mockReturnValueOnce(says("done"))
      .mockReturnValueOnce(says("again"));
    const withSlot = { ...config, extraBody: { id_slot: 1 } };
    await runAgentLoop({ config: withSlot, messages: question, dispatch: async () => "" });
    await runAgentLoop({ config: withSlot, messages: question, dispatch: async () => "" });
    expect(create.mock.calls.map(([body]) => "id_slot" in (body as object))).toEqual([
      true,
      false,
      false,
    ]);
  });
});

import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock("../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.ts")>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { buildBody, parseToolArguments, preselect, preview, resolveApiKey, runAgentLoop } =
  await import("../src/agent-loop.ts");
const { capabilitiesFor, modelCapabilitiesFor, resetCapabilities } = await import(
  "../src/capabilities.ts"
);
const { LOAD_TOOLS } = await import("../src/tool-loading.ts");

type Message = OpenAI.ChatCompletionMessageParam;
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

describe("preview and parseToolArguments", () => {
  it("cuts long text and says how long it was", () => {
    expect(preview("abc", 5)).toBe("abc");
    expect(preview("abcdefgh", 5)).toBe("abcde… (8 chars)");
  });

  it("reads an object, reads empty as none, and refuses anything else", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments("  ")).toEqual({});
    expect(() => parseToolArguments("[1]")).toThrow("not an object");
    expect(() => parseToolArguments("{nope")).toThrow("invalid tool arguments");
  });
});

describe("preselect", () => {
  const catalog = [{ id: "s", label: "S", tools: [{ name: "s__read", description: "reads" }] }];

  it("hands back the catalogued names the small model picked", async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '["s__read", "nope"]' } }] });
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
    expect(result.usage).toEqual({ prompt: 10, completion: 2, total: 12 });
    expect(events.map((e) => e.kind)).toEqual([
      "turn",
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
      const system = (create.mock.calls[1][0] as Body).messages[0].content as string;
      expect(system).toContain("sys");
      expect(system).toContain("s__read (loaded)");
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.loaded).toEqual(["s__read"]);
      expect(result.used).toEqual(["s__read"]);
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

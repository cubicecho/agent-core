import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  compact,
  contextChars,
  contextTokens,
  estimateTokens,
  messageTokens,
  requestTokens,
  toolsChars,
} from '../src/tokens.ts';
import { FUNCTION_TOOL, PartType, Role, SchemaType } from '../src/wire.ts';

describe('requestTokens', () => {
  it('sizes a request from what is actually sent, tools included', () => {
    const messages = [{ role: Role.User, content: 'x'.repeat(400) }];
    const bare = requestTokens({ model: 'm', stream: true, messages });
    const withTools = requestTokens({
      model: 'm',
      stream: true,
      messages,
      tools: [{ type: FUNCTION_TOOL, function: { name: 't', parameters: { type: SchemaType.Object } } }],
    });
    expect(bare).toBeGreaterThan(100);
    expect(withTools).toBeGreaterThan(bare);
  });

  it('sizes a request at the characters per token it is given, and at four otherwise', () => {
    const message = { role: Role.User, content: 'x'.repeat(1000) };
    const body = {
      model: 'm',
      stream: true as const,
      messages: [message],
      tools: [{ type: FUNCTION_TOOL, function: { name: 't', parameters: { type: SchemaType.Object } } }],
    };
    const atFour = requestTokens(body);
    expect(requestTokens(body, { charsPerToken: 4 })).toBe(atFour);
    // Half the characters per token is about twice the tokens, tools included.
    expect(requestTokens(body, { charsPerToken: 2 })).toBeGreaterThanOrEqual(2 * atFour - 2);
    expect(messageTokens(message, { charsPerToken: 2 })).toBeGreaterThanOrEqual(2 * messageTokens(message) - 1);
    // Nothing usable is the fallback, not a division by zero.
    expect(requestTokens(body, { charsPerToken: 0 })).toBe(atFour);
    expect(requestTokens(body, { charsPerToken: -3 })).toBe(atFour);
  });

  it('charges a transcript more the longer it gets, and walks every part of it', () => {
    const turn = (n: number) => [
      { role: Role.User, content: `ask ${n} ${'x'.repeat(200)}` },
      {
        role: Role.Assistant,
        content: null,
        tool_calls: [
          {
            id: `call_${n}`,
            type: FUNCTION_TOOL,
            function: { name: 'search', arguments: JSON.stringify({ q: 'y'.repeat(100) }) },
          },
        ],
      },
      { role: Role.Tool, tool_call_id: `call_${n}`, content: 'z'.repeat(300) },
    ];
    const sized = (turns: number) =>
      requestTokens({
        model: 'm',
        stream: true,
        messages: Array.from({ length: turns }, (_, i) => turn(i)).flat(),
      });
    expect(sized(5)).toBeGreaterThan(sized(1));
    expect(sized(20)).toBeGreaterThan(sized(5));
    // Within a rounding error of what serialising the same body would have said, which is what
    // the walk replaced. `estimateTokens` is documented as running low; it must not run wild.
    const walked = sized(20);
    const serialized = estimateTokens(JSON.stringify(Array.from({ length: 20 }, (_, i) => turn(i)).flat()));
    expect(walked).toBeGreaterThan(serialized * 0.9);
    expect(walked).toBeLessThan(serialized * 1.1);
  });

  it('counts the keys only some messages carry, not only their values', () => {
    // `ENVELOPE` is the two keys every message has. It was being applied to the three shapes that
    // carry another, whose value was counted and whose key was not — 4.5 tokens on every tool
    // result, the message a tool-using run accumulates most of, and short in the one direction
    // this estimate must not be short in: `requestTokens` guards a window, and under-counting
    // passes a request that then overflows for real.
    const sized = (messages: OpenAI.ChatCompletionMessageParam[]) =>
      requestTokens({ model: 'm', stream: true, messages });
    const serialized = (messages: OpenAI.ChatCompletionMessageParam[]) => estimateTokens(JSON.stringify(messages));
    // A hundred of a shape, so a per-message constant is worth whole tokens rather than a
    // rounding the ceiling swallows.
    const many = (message: OpenAI.ChatCompletionMessageParam) => Array.from({ length: 100 }, () => message);

    // Each key, priced against the same message without it: the difference the walk sees has to
    // be the difference the serialisation sees.
    const named = many({ role: Role.User, name: 'bob', content: 'hi' });
    const anonymous = many({ role: Role.User, content: 'hi' });
    expect(sized(named) - sized(anonymous)).toBe(serialized(named) - serialized(anonymous));

    const result = many({ role: Role.Tool, tool_call_id: 'call_1', content: 'hi' });
    const bare = many({ role: Role.User, content: 'hi' });
    expect(sized(result) - sized(bare)).toBe(serialized(result) - serialized(bare));

    // The scratchpad a caller passes back to gpt-oss or DeepSeek, in either spelling.
    const thought = many({ role: Role.Assistant, content: 'hi', reasoning_content: 'because' } as never);
    const plain = many({ role: Role.Assistant, content: 'hi' });
    expect(sized(thought) - sized(plain)).toBe(serialized(thought) - serialized(plain));
    const routed = many({ role: Role.Assistant, content: 'hi', reasoning: 'because' } as never);
    expect(sized(routed) - sized(plain)).toBe(serialized(routed) - serialized(plain));

    // And the whole shape, end to end: twenty tool results is what a real run is mostly made of,
    // and the body the omission was worth ninety tokens on.
    const run = Array.from({ length: 20 }, (_, i) => ({
      role: Role.Tool,
      tool_call_id: `call_${i}`,
      content: 'x'.repeat(200),
    }));
    expect(sized(run)).toBe(serialized(run));
  });

  it('sizes a message whose content is parts from the parts it has text in', () => {
    const sized = (content: OpenAI.ChatCompletionUserMessageParam['content']) =>
      requestTokens({ model: 'm', stream: true, messages: [{ role: Role.User, content }] });
    const serialized = (content: OpenAI.ChatCompletionUserMessageParam['content']) =>
      estimateTokens(JSON.stringify([{ role: Role.User, content }]));

    // Each part is an object in the body, so splitting the same text across more of them makes
    // the request bigger — `{"type":"text","text":""},` is 26 characters that are really sent.
    // Charging only `part.text` read the split content as the unsplit content and was short by
    // 6.5 tokens a part, which grows with the part count rather than with what the parts say.
    const plain = sized('x'.repeat(400));
    const one = sized([{ type: PartType.Text, text: 'x'.repeat(400) }]);
    const eight = sized(Array.from({ length: 8 }, () => ({ type: PartType.Text, text: 'x'.repeat(50) })));
    expect(one).toBeGreaterThan(plain);
    expect(eight).toBeGreaterThan(one);

    // And each of the three is what serialising that same body says, which is the point: the
    // string case was already exact and the parts cases now are too.
    expect(plain).toBe(serialized('x'.repeat(400)));
    expect(one).toBe(serialized([{ type: PartType.Text, text: 'x'.repeat(400) }]));
    expect(eight).toBe(serialized(Array.from({ length: 8 }, () => ({ type: PartType.Text, text: 'x'.repeat(50) }))));

    // An image part is a URL or a blob, and is not priced by the length of either — a vision
    // model does not charge a data URL by its base64 length, so this one stays uncounted on
    // purpose and the text part beside it is unaffected.
    const withImage = sized([
      { type: PartType.Text, text: 'x'.repeat(400) },
      { type: PartType.ImageUrl, image_url: { url: `data:image/png;base64,${'A'.repeat(5000)}` } },
    ]);
    expect(withImage).toBe(one);
  });

  it('charges a refusal part its own envelope too', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: Role.Assistant, content: [{ type: PartType.Refusal, refusal: 'no'.repeat(100) }] },
    ];
    expect(requestTokens({ model: 'm', stream: true, messages })).toBe(estimateTokens(JSON.stringify(messages)));
  });

  it('measures the same tools array only once', () => {
    const tools: OpenAI.ChatCompletionTool[] = [
      { type: FUNCTION_TOOL, function: { name: 't', parameters: { type: SchemaType.Object } } },
    ];
    const messages = [{ role: Role.User, content: 'hi' }];
    const first = requestTokens({ model: 'm', stream: true, messages, tools });
    // Mutated behind the cache: a second reading of the same array must be the memoised number,
    // not a fresh walk, or the identity key is not doing what the comment says it does.
    tools.push({ type: FUNCTION_TOOL, function: { name: 'u'.repeat(500), parameters: {} } });
    expect(requestTokens({ model: 'm', stream: true, messages, tools })).toBe(first);
  });
});

describe('compact', () => {
  it('shortens token counts the way they are read', () => {
    expect(compact(999)).toBe('999');
    expect(compact(1234)).toBe('1.2k');
  });
});

describe('contextTokens and contextChars', () => {
  /** A request with something substantial in every part, so no share rounds to nothing. */
  const fourParts = (): OpenAI.ChatCompletionCreateParamsStreaming => ({
    model: 'm',
    stream: true,
    messages: [
      { role: Role.System, content: 's'.repeat(800) },
      { role: Role.User, content: 'u'.repeat(1200) },
      { role: Role.Assistant, content: 'a'.repeat(400) },
      { role: Role.Tool, tool_call_id: 'c1', content: 't'.repeat(2000) },
    ],
    tools: [{ type: FUNCTION_TOOL, function: { name: 't', parameters: { type: SchemaType.Object } } }],
  });

  it('cut a request along the levers an operator actually has', () => {
    const chars = contextChars(fourParts());
    // Each part holds the thing named after it, and the four are exhaustive.
    expect(chars.system).toBeGreaterThan(800);
    expect(chars.history).toBeGreaterThan(1600);
    expect(chars.toolResults).toBeGreaterThan(2000);
    expect(chars.tools).toBeGreaterThan(0);
    expect(chars.system + chars.tools + chars.history + chars.toolResults).toBe(chars.total);
    // The tool results are only the `tool` messages: what `pruneToolResults` can shrink, no more.
    expect(chars.toolResults).toBeLessThan(2100);
  });

  it('charge a developer message to the system prompt, wherever it sits', () => {
    const body: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: 'm',
      stream: true,
      messages: [
        { role: Role.User, content: 'hi' },
        { role: Role.Developer, content: 'd'.repeat(500) },
      ],
    };
    expect(contextChars(body).system).toBeGreaterThan(500);
  });

  it('add up to the total exactly, estimated or reported', () => {
    const body = fourParts();
    const sum = (b: ReturnType<typeof contextTokens>) => b.system + b.tools + b.history + b.toolResults;

    const estimated = contextTokens(body);
    expect(sum(estimated)).toBe(estimated.total);
    // Without a reported count the total is the number the pre-flight guard uses.
    expect(estimated.total).toBe(requestTokens(body));

    // With one, it is the number the server charged — every part a share of it.
    const reported = contextTokens(body, { promptTokens: 1000 });
    expect(reported.total).toBe(1000);
    expect(sum(reported)).toBe(1000);
    // The shares are proportions of the characters, not a fresh estimate.
    const chars = contextChars(body);
    expect(reported.toolResults).toBe(Math.round((chars.toolResults / chars.total) * 1000));
  });

  it('agree with the turn metrics on the tool block rather than sharing it out', () => {
    const body = fourParts();
    // `TurnMetrics.toolSchemaTokens` is this expression; a readout that disagreed with it by a
    // token would have an operator chasing a difference that is only rounding.
    expect(contextTokens(body).tools).toBe(Math.ceil(toolsChars(body.tools ?? []) / 4));
    expect(contextTokens(body, { charsPerToken: 3 }).tools).toBe(Math.ceil(toolsChars(body.tools ?? []) / 3));
  });

  it('land an odd total somewhere, and break an empty request into nothing', () => {
    // One token to share over four parts: it goes to the biggest, and nothing is lost.
    const one = contextTokens(fourParts(), { promptTokens: 1 });
    expect(one.toolResults).toBe(1);
    expect(one.system + one.tools + one.history).toBe(0);

    const empty = contextTokens({ model: 'm', stream: true, messages: [] });
    expect(empty).toEqual({ system: 0, tools: 0, history: 0, toolResults: 0, total: 0 });
  });
});

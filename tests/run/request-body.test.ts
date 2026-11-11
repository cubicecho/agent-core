import type OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, modelCapabilitiesFor, resetCapabilities } from '../../src/endpoint/capabilities.ts';
import { buildBody, singleSystem } from '../../src/run/request-body.ts';
import { FUNCTION_TOOL, PARALLEL_TOOL_CALLS, Role, SchemaType } from '../../src/wire/wire.ts';
import {
  assistant,
  type Body,
  config,
  type Message,
  pairsByPosition,
  singleCallRefusal,
  templateRefusal,
  tool,
  user,
} from '../helpers.ts';

afterEach(() => resetCapabilities());

describe('buildBody', () => {
  const messages: Message[] = [{ role: Role.User, content: 'hi' }];

  it('sends what a fresh endpoint and model have not refused', () => {
    const supports = capabilitiesFor('https://api.openai.com/v1');
    const body = buildBody({ ...config, reasoningEffort: 'low' }, supports, undefined, messages, [tool('a')]);
    expect(body).toMatchObject({
      model: 'm',
      max_tokens: 100,
      temperature: 0.2,
      reasoning_effort: 'low',
      stream: true,
      stream_options: { include_usage: true },
      messages,
    });
    expect(body.tools).toHaveLength(1);
  });

  it('spells the ceiling, drops the temperature and effort the model refused', () => {
    const supports = capabilitiesFor('https://api.openai.com/v1');
    const refused = modelCapabilitiesFor(supports, 'm');
    Object.assign(refused, {
      legacyTokenLimit: false,
      chosenTemperature: false,
      reasoningEffort: false,
    });
    const body = buildBody({ ...config, reasoningEffort: 'high' }, supports, refused, messages);
    expect(body).toMatchObject({ max_completion_tokens: 100 });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('tools');
  });

  it('replays the scratchpad until the model refuses it, and leaves the caller its own messages', () => {
    const supports = capabilitiesFor('https://api.groq.com/openai/v1');
    const reasoned = [
      ...messages,
      { role: Role.Assistant, content: null, reasoning_content: 'look it up', tool_calls: [] } as Message,
    ];
    expect(buildBody(config, supports, undefined, reasoned).messages).toBe(reasoned);
    const refused = modelCapabilitiesFor(supports, 'm');
    refused.reasoningContent = false;
    const body = buildBody(config, supports, refused, reasoned);
    expect(body.messages[1]).not.toHaveProperty('reasoning_content');
    expect(body.messages[0]).toBe(reasoned[0]);
    expect(reasoned[1]).toHaveProperty('reasoning_content', 'look it up');
  });

  it('steps an effort the model refused by value up to one it takes', () => {
    // The refusal that means the opposite of the one above: the model reasons, it just does not
    // reason at `none`. Sending nothing would run at its own default, which is neither what the
    // config asks for nor anything an operator reading the settings row can see.
    const supports = capabilitiesFor('https://api.openai.com/v1');
    const refused = modelCapabilitiesFor(supports, 'm');
    refused.refusedEfforts.add('none');
    refused.supportedEfforts = ['minimal', 'low', 'medium', 'high'];
    const body = buildBody({ ...config, reasoningEffort: 'none' }, supports, refused, messages);
    expect(body).toMatchObject({ reasoning_effort: 'minimal' });
    // Anything the model does list goes out as asked.
    expect(buildBody({ ...config, reasoningEffort: 'high' }, supports, refused, messages)).toMatchObject({
      reasoning_effort: 'high',
    });
  });

  it('sends no ceiling at zero and no effort at off', () => {
    const body = buildBody(
      { ...config, maxTokens: 0, reasoningEffort: 'off' },
      capabilitiesFor('http://local/v1'),
      undefined,
      messages,
    );
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it("merges extraBody last, less the refused fields and the loop's own", () => {
    const supports = capabilitiesFor('http://local/v1');
    const refused = modelCapabilitiesFor(supports, 'm');
    refused.refusedFields.add('min_p');
    const body = buildBody(
      {
        ...config,
        extraBody: { id_slot: 2, min_p: 0.1, temperature: 0.9, model: 'x', stream: false },
      },
      supports,
      refused,
      messages,
    );
    expect(body).toMatchObject({ id_slot: 2, temperature: 0.9, model: 'm', stream: true });
    expect(body).not.toHaveProperty('min_p');
  });

  describe('one call per message', () => {
    const asking: Message = {
      role: Role.Assistant,
      content: null,
      tool_calls: ['a', 'b'].map((id) => ({ id, type: FUNCTION_TOOL, function: { name: id, arguments: '{}' } })),
    };
    const transcript: Message[] = [
      user('read a and b'),
      asking,
      { role: Role.Tool, tool_call_id: 'a', content: 'A' },
      { role: Role.Tool, tool_call_id: 'b', content: 'B' },
    ];

    it('sends neither the field nor a split by default', () => {
      const body = buildBody(config, capabilitiesFor('http://local/v1'), undefined, transcript, [tool('a')]);
      expect(body).not.toHaveProperty(PARALLEL_TOOL_CALLS);
      expect(body.messages).toBe(transcript);
    });

    it('asks for one call at a time beside tools and replays each call as a pair of its own', () => {
      const single = { ...config, singleCallMessages: true };
      const body = buildBody(single, capabilitiesFor('http://local/v1'), undefined, transcript, [tool('a')]);
      expect(body).toHaveProperty(PARALLEL_TOOL_CALLS, false);
      expect(singleCallRefusal(transcript)).toBeDefined();
      expect(singleCallRefusal(body.messages)).toBeUndefined();
      expect(pairsByPosition(body.messages)).toBe(true);
      // OpenAI refuses the field on a request with no tools.
      const bare = buildBody(single, capabilitiesFor('http://local/v1'), undefined, transcript);
      expect(bare).not.toHaveProperty(PARALLEL_TOOL_CALLS);
      expect(singleCallRefusal(bare.messages)).toBeUndefined();
    });

    it('does the same for a model whose template refused, and drops the field once it is refused', () => {
      const supports = capabilitiesFor('http://local/v1');
      const refused = modelCapabilitiesFor(supports, 'm');
      refused.multiCallMessages = false;
      const body = buildBody(config, supports, refused, transcript, [tool('a')]);
      expect(body).toHaveProperty(PARALLEL_TOOL_CALLS, false);
      expect(singleCallRefusal(body.messages)).toBeUndefined();
      refused.refusedFields.add(PARALLEL_TOOL_CALLS);
      const without = buildBody(config, supports, refused, transcript, [tool('a')]);
      expect(without).not.toHaveProperty(PARALLEL_TOOL_CALLS);
      expect(singleCallRefusal(without.messages)).toBeUndefined();
    });

    it("lets extraBody's own parallel_tool_calls win", () => {
      const single = { ...config, singleCallMessages: true, extraBody: { [PARALLEL_TOOL_CALLS]: true } };
      const body = buildBody(single, capabilitiesFor('http://local/v1'), undefined, transcript, [tool('a')]);
      expect(body).toHaveProperty(PARALLEL_TOOL_CALLS, true);
    });
  });

  it('relaxes schemas where the endpoint could not build a grammar', () => {
    const supports = capabilitiesFor('http://local/v1');
    supports.strictSchemas = false;
    const pattern: OpenAI.ChatCompletionTool = {
      type: FUNCTION_TOOL,
      function: {
        name: 'p',
        parameters: { type: SchemaType.Object, properties: { s: { type: SchemaType.String, pattern: '^a$' } } },
      },
    };
    const body = buildBody(config, supports, undefined, messages, [pattern]);
    expect(JSON.stringify(body.tools)).not.toContain('pattern');
  });

  /** The names a built body declares, in the order it declares them. */
  const names = (body: Body) => (body.tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name);

  it('declares the same set in the same order however the caller built the array', () => {
    const supports = capabilitiesFor('http://local/v1');
    const one = buildBody(config, supports, undefined, messages, [tool('b__x'), tool('a__y'), tool('a__x')]);
    const other = buildBody(config, supports, undefined, messages, [tool('a__x'), tool('b__x'), tool('a__y')]);
    expect(names(one)).toEqual(['a__x', 'a__y', 'b__x']);
    expect(names(other)).toEqual(names(one));
  });

  it("sends the caller's own order when told to", () => {
    const supports = capabilitiesFor('http://local/v1');
    const body = buildBody(config, supports, undefined, messages, [tool('b'), tool('a')], false);
    expect(names(body)).toEqual(['b', 'a']);
  });

  it("orders by a comparator of the caller's", () => {
    const supports = capabilitiesFor('http://local/v1');
    const body = buildBody(config, supports, undefined, messages, [tool('a'), tool('b'), tool('c')], (a, b) =>
      b.localeCompare(a),
    );
    expect(names(body)).toEqual(['c', 'b', 'a']);
  });
});

describe('singleSystem', () => {
  const system = (content: string): Message => ({ role: Role.System, content });

  it('joins the leading system messages into one, a blank line apart, and keeps the rest', () => {
    const tail = [user('q'), assistant('a')];
    expect(singleSystem([system('rules'), system(' '), system('more rules'), ...tail])).toEqual([
      system('rules\n\nmore rules'),
      ...tail,
    ]);
    expect(templateRefusal(singleSystem([system('rules'), system('more rules'), ...tail]))).toBeUndefined();
  });

  it('hands back the array itself when there is nothing to join', () => {
    const one = [system('rules'), user('q')];
    expect(singleSystem(one)).toBe(one);
  });

  it('leaves a system message further down where the host put it', () => {
    const later = [system('rules'), user('q'), system('a notice')];
    expect(singleSystem(later)).toBe(later);
  });
});

# How agent-core works

Diagrams of what the package does today: how an app's prompt reaches the model, what one
exchange does turn by turn, and how one request is sent. The words are the glossary's, in
[`.agents/domain-model.md`](.agents/domain-model.md); the code each step names is the place to
read for how.

- [The pieces](#the-pieces)
- [From prompt parts to a system prompt](#from-prompt-parts-to-a-system-prompt)
- [What the model is sent](#what-the-model-is-sent)
- [One exchange](#one-exchange)
- [One request](#one-request)
- [How an exchange ends](#how-an-exchange-ends)
- [What keeps the prompt cache warm](#what-keeps-the-prompt-cache-warm)

## The pieces

The work comes in four sizes: a **session** holds **runs**, a run holds **exchanges**, and an
exchange is a series of **turns**, each one model reply plus the tools it asked for.

```mermaid
flowchart LR
  subgraph App["The app"]
    doc["Agent document layers<br/>(optional)"]
    own["Its own prompt, tools<br/>and conversation"]
    runner["Tool runner<br/>(dispatch)"]
    hookrunner["Hook runner"]
  end
  subgraph Core["agent-core"]
    resolve["resolveAgentSpec"]
    loop["runAgentLoop<br/>one exchange"]
    turn["runTurn<br/>one request"]
    bus["Event bus"]
  end
  server[("Model server")]
  watcher["Watchers"]

  doc --> resolve --> loop
  own --> loop
  loop -- "each turn" --> turn --> server
  server -- "streamed reply" --> turn --> loop
  loop -- "tool calls" --> runner -- "results" --> loop
  loop -- "fixed moments" --> hookrunner -- "context, notes" --> loop
  loop -- "events" --> bus --> watcher
```

The package never knows what the run is for. The prompt, the tools and what a tool call does
are the app's.

## From prompt parts to a system prompt

An agent document's `prompt` is a list of **prompt parts**, each written like a chat message:
`{ role, name, content }`, with an optional `mode`. An app stacks documents weakest first, for
example settings, then the agent, then a task, and `resolveAgentSpec` merges the parts by name:

- a new name adds a part, after those already there;
- the same name with no `mode` overwrites the part in the place it first had;
- the same name with `mode: "extend"` or `"replace"` adds a part of its own, `<name>_2`, marked
  as adding to that part or taking its place, which stays where it was;
- an empty `content` deletes the part, and every part marked against it.

```mermaid
flowchart LR
  subgraph L1["1 · settings"]
    s1["identity: You are a helpful assistant."]
    s2["format: Answer in full sentences."]
  end
  subgraph L2["2 · agent"]
    a1["identity: You are a code reviewer."]
    a2["rules: Cite file:line."]
  end
  subgraph L3["3 · task"]
    t1["identity, extend: Review PR 42."]
    t2["format: (empty content)"]
  end
  subgraph R["Resolved, in order"]
    r1["identity: You are a code reviewer."]
    r2["rules: Cite file:line."]
    r3["identity_2, extends identity: Review PR 42."]
  end
  L1 --> L2 --> L3 --> R
```

The resolved agent keeps the merged list as `prompt` (each a `StackedPart`, with its owner and
mark), its `promptLayout`, and the same parts joined as plain text in `systemPrompt`
(`plainPrompt`: a replace is written in the place of the part it replaces).

### Two ways an app hands its prompt to the loop

The loop's `systemPrompt` option takes either one string or the agent's parts.

```mermaid
flowchart TB
  subgraph Parts["An app with an agent document"]
    direction TB
    d1["agent document layers"] --> dr["resolveAgentSpec"] --> dp["prompt: the agent's parts<br/>promptLayout"]
    ap["its own parts:<br/>extraBody.agent_core.prompt"]
  end
  subgraph Own["An app with its own string (min-agent)"]
    direction TB
    o1["settings row:<br/>one systemPrompt column"] --> os["the string"]
  end
  dp --> loop["runAgentLoop({ systemPrompt })"]
  ap --> loop
  os --> loop
```

A string with no `agent_core` is used as it is, and never split or rewritten. Parts, or any
`agent_core`, go through stacking first.

## What the model is sent

The loop writes the system message on every turn, in one place (`runTurns`,
`src/run/agent-loop.ts`, with `src/run/system-prompt.ts`).

**Given a string and no `agent_core`**, it is today's text:

```mermaid
flowchart TB
  system["1 · systemPrompt, as given"]
  instr["2 · server instructions<br/>each server's guidance, fenced and attributed<br/>(when serverInstructions is on)"]
  cat["3 · tool catalogue<br/>tool names, server by server<br/>(on-demand or proxied loading)"]
  join["joined with blank lines"]
  single["singleSystem<br/>merges any leading system messages in after it"]
  out["the request's first message"]

  system --> join
  instr --> join
  cat --> join
  join --> single --> out
```

**Given parts, or `agent_core`**, the loop stacks first (`stackRequest`). For a model that is not
an agent it takes `agent_core` out of the body, puts `app_` in front of each of the app's part
names, drops any whose mode the agent's part does not allow (with a notice), and turns the
conversation's leading system messages into one part, `app_system`. Then it writes, in the agent's
`promptLayout`:

```mermaid
flowchart TB
  p1["1 · the agent's parts"]
  p2["2 · precedence: the agent's words win<br/>(markdown and xml, when an app added parts)"]
  p3["3 · the app's parts, app_… names"]
  p4["4 · server instructions"]
  p5["5 · tool catalogue"]
  p6["6 · app_system: the leading system messages<br/>(last: it changes most)"]
  out["one system message"]
  p1 --> p2 --> p3 --> p4 --> p5 --> p6 --> out
```

| Layout | A part is written as | The loop's sections |
| --- | --- | --- |
| `plain` (default) | Its content; a replace overwrites in place | Headed `# MCP server instructions`, `# Tool catalogue` |
| `markdown` | Under `## Name In Title Case`, its own headings moved two levels down | `## Server Instructions`, `## Tool Catalogue`, `## Precedence` |
| `xml` | Inside `<prompt_name>`, marked `extends="…"` or `replaces="…"` | `<server_instructions>`, `<tool_catalogue>`, `<precedence>` |

In every layout each server's guidance is inside `<untrusted source="<server label>">`, and every
part's content, server's guidance and hook's text is fenced (`fence`): it cannot open or close any
tag the layout writes. The catalogue is left out on a turn whose tools a preselection already
chose. To a remote agent, `agent_core` is sent through instead, for the server to stack, and the
warnings its reply carries are raised as notices.

Where everything else goes:

| What | Where in the request | When it is written |
| --- | --- | --- |
| The app's prompt, server instructions, catalogue, `app_system` | The system message | The same text on every turn of an exchange |
| `agent_core` | Taken out of the body for a model that is not an agent; sent through to an agent | Read once per exchange |
| Hook context (`sessionStart`, `beforeExchange`) | Before the question, in the user's message, as `<hook_context source="…">` blocks after a short preface | Once per exchange, on the request only, never in the stored transcript |
| The conversation | The messages after the system message | Grows by appending each turn |
| Input the app sent mid-exchange | A new message in the conversation | Between turns |
| Tools | The `tools` array, sorted by name unless `toolOrder` is `false` | Per turn: which tools depends on the loading mode |

Which tools a turn declares:

| Loading mode | Tools declared |
| --- | --- |
| Eager | Every tool, plus the app's own |
| On-demand | `load_tools`, the tools loaded so far, and the app's own |
| Proxied | `load_tools` and `call_tool`, which never change, and the app's own; definitions load into the conversation |
| Preselected, first turn | The shortlist and the app's own, unless `preselectRouting` is `append` |

## One exchange

```mermaid
flowchart TB
  start(["runAgentLoop(options)"]) --> ev1["event: exchange"]
  ev1 --> prep

  subgraph prep["Once, before the first turn"]
    direction TB
    p1["hooks: sessionStart / beforeExchange → context blocks"]
    p2["find tools: eager, on-demand, proxied, preselected"]
    p3["server instructions from the catalogue"]
    p4["proxied shortlist loaded into the conversation"]
  end

  prep --> turnstart

  subgraph turnloop["Each turn, up to maxToolIterations"]
    direction TB
    turnstart["stopped? throw"] --> take["takeInput: the app's waiting message"]
    take --> rewrite["beforeTurn: the app may rewrite the conversation"]
    rewrite --> prune["prune: old tool results become stubs"]
    prune --> fold["summarise the oldest stretch if the window is too full"]
    fold --> build["write the system message, pick the tools,<br/>put hook context before the question"]
    build --> request["runTurn: send one request"]
    request --> cont["cut off at maxTokens? continueTurn"]
    cont --> read["read the reply: recover calls written as text,<br/>give each call a unique id"]
    read --> callless{"said it was calling tools<br/>and sent none?"}
    callless -- "first time" --> turnstart
    callless -- "no" --> split["split off calls handed back to the app"]
    split --> runcalls["runCalls: run each call or batch,<br/>write results in the order asked"]
  end

  runcalls --> decide{"how did the turn end?"}
  decide -- "tools answered, turns left" --> turnstart
  decide -- "answered, but the app has a new message" --> turnstart
  decide -- "answered / a tool ended it / calls handed back" --> finish
  decide -- "no turns left" --> limit["throw ToolIterationLimit"]

  finish["afterExchange hooks told"] --> ev2["event: exchange-end"] --> result(["result: messages, usage, outcome"])
```

The events the loop sends along the way include `turn`, the streamed `thinking` and `output`,
each call and result, `usage` per turn, `wait` when calls are handed back, and notices.

## One request

`runTurn` is the retry loop around the negotiation around the stream.

```mermaid
sequenceDiagram
  autonumber
  participant Loop as runAgentLoop
  participant Turn as runTurn
  participant Neg as negotiate
  participant Srv as Model server

  Loop->>Turn: build(supported, refused), options
  Turn->>Turn: size the request against contextLimit (at most once)
  loop until answered or out of retries
    Turn->>Neg: send
    Neg->>Srv: streamed request, without what it refused before
    alt the server refuses a feature or field
      Srv-->>Neg: refusal
      Neg->>Neg: latch it off, rebuild the body
      Neg->>Srv: resend
    else the model is still loading
      Srv-->>Turn: loading
      Turn->>Turn: wait, ask again (not a retry)
    else lost, timed out or busy
      Srv-->>Turn: error
      Turn->>Turn: back off, resend (one retry spent)
    else the reply streams in
      Srv-->>Turn: chunks
    end
  end
  Turn-->>Loop: reply, tool calls, usage
```

A reply that has produced anything is never sent again, and a request too big for the window
fails as `ContextOverflow` whichever side finds out.

## How an exchange ends

```mermaid
stateDiagram-v2
  [*] --> Starting
  Starting --> Running
  Running --> Running: tools answered, turns left
  Running --> Running: the app had a new message
  Running --> Answered: replied without asking for tools
  Running --> CutShort: stopped at the length limit
  Running --> Filtered: the provider withheld the reply
  Running --> Ended: a tool said the job is done
  Running --> Waiting: calls handed back to the app
  Running --> Failed: no turns left, a callback threw, a request failed, or it overflowed
  Running --> Stopped: the app's signal aborted it
  Waiting --> Starting: the app answers and starts again
  Answered --> [*]
  CutShort --> [*]
  Filtered --> [*]
  Ended --> [*]
  Failed --> [*]
  Stopped --> [*]
```

Every way out sends one `exchange-end` event, a failed or stopped exchange just before it
throws.

## What keeps the prompt cache warm

A model server reuses the longest prefix a request shares with the one before it, so the
request is built to change only at its end.

```mermaid
flowchart TB
  subgraph req["One request, top to bottom"]
    direction TB
    a["system message<br/>the same text on every turn of the exchange"]
    b["the conversation so far<br/>earlier turns never change"]
    c["the question, with hook context before it"]
    d["this turn's new messages"]
  end
  a --> b --> c --> d
```

- The system message is written from the same inputs each turn, and loading a tool does not
  change the catalogue's text: what is loaded is said in the tool array and the `load_tools`
  result instead.
- Hook context goes on the request, never into the system prompt or the stored transcript.
- Tools are sorted by name unless `toolOrder` is `false`, so the same set always reads the same.
- Pruning moves its boundary only forward, so between moves each request extends the last.
- Between exchanges, the first prompt part that differs is where reuse stops: everything after
  it is read again. `app_system`, which a chat client rewrites on every message, is written last,
  after the server instructions and catalogue, so a change to it costs only itself.

The token ledger records each request's size and, when a cache falls short of the one before,
its likely cause (`cacheDiagnosis`).

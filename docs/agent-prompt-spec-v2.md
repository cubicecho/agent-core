# Agent prompt spec, version 2

How an agent-core agent's prompt is put together: what an agent says about itself, what an app
that uses it may add, what the job adds, and how all of it becomes the text a model reads. It goes
with version 2 of the agent document, [`agent-spec-v2.md`](agent-spec-v2.md).

**Status: agreed, not yet built.** The code still does what version 1 says; the ledger's M12–M18
make it do this. How particular services and apps follow this page is in
[`prompt-implementations.md`](prompt-implementations.md). The words are the glossary's, in
[`.agents/domain-model.md`](../.agents/domain-model.md), and how the package works today is drawn
in [`HOW-IT-WORKS.md`](../HOW-IT-WORKS.md).

## Why

An agent is meant to be written once and used by many apps. A Task Reviewer kept on an agent
server should check work the same way whichever app is asking. That only holds if:

- what the agent says about itself reaches the model whole, whoever is calling;
- each app can say how it uses the agent, without restating or replacing the agent;
- the job (the card, the todo, the question) is kept apart from both;
- the result is the same text on every turn, so the model server's prompt cache keeps working.

In version 1 the pieces are joined with blank lines into one string, and the model never learns
where one ends and the next begins. An app running on an agent kept elsewhere can only add one
unlabelled block, which the model cannot tell apart from the agent's own words.

## Words

| Word | Means |
| --- | --- |
| **Agent** | A defined assistant: who it is, how it works, which tools it may use. Written once, by its author, as an agent document. On an agent server, every app that names it gets the same agent. |
| **Agent document** | The JSON an agent is written in ([`agent-spec-v2.md`](agent-spec-v2.md)). An app's settings, a task and a stage are written in the same shape, as layers. |
| **App** | The program that wants work done. An app either runs the loop itself, with agent-core, or asks an agent server to run an agent for it, the way it would ask a model. |
| **Agent server** | A service that keeps agents and runs them for apps, with agent-core. It is neither an agent nor an app: it is where the two meet, so it is where section 3's rules are checked. |
| **The app's system messages** | The `system` or `developer` messages at the start of an app's request. They become one part, `app_system`. |
| **`agent_core`** | The field of a request that carries the app's parts (section 4). Sent through to an agent; turned into system messages for any other model. |
| **Job** | What the agent is asked to do this time: the card, the todo, the user's question. |
| **agent-core** | This package: the loop an agent server and every app running its own loop both use. |
| **Owner** | Whoever wrote a layer: the agent's author, or the app (section 3). |
| **Prompt part** | One named piece of the system prompt, such as `identity` or `rules`. |
| **Layer** | One document in a stack of documents, weakest first. A later layer can change the parts below it, by a mode (section 2). |
| **Mode** | How a part changes the part with its name: `extend` or `replace`. With no mode, a matching name overwrites. |
| **Layout** | How the parts are written into the text the model reads: `plain`, `markdown` or `xml`. |

## 1. How an agent defines its parts

An agent's prompt is a list of **parts** in its agent document. Each part is written
the way a chat message is, with a **role**, a **name** and its **content**:

```json
{
  "spec": "cubicecho.agent/2",
  "id": "task-reviewer",
  "name": "Task Reviewer",
  "prompt": [
    { "role": "system", "name": "identity", "content": "You are Task Reviewer. You decide whether work is actually done. You are careful and sceptical." },
    { "role": "system", "name": "rules",    "content": "Judge the work itself, not reports about it. Give a verdict, pass or fail, with your reasons." },
    { "role": "system", "name": "format",   "content": "Start with PASS or FAIL on its own line." }
  ]
}
```

### The shape of a part

A part has the fields of a chat message, so a part reads the same in an agent document, in a
request's `agent_core.prompt` (section 4) and in the messages agent-core sends a model:

| Field | Means |
| --- | --- |
| `role` | `system` or `developer`. Both are written into the system prompt the same way |
| `name` | What the part is for, such as `identity`. Below |
| `content` | The part's text |
| `mode` | How it changes the part with its name below it: `extend` or `replace` (section 2) |
| `allowedModes` | Which modes an app may use on it (section 3) |

Version 1 of the agent document ([`agent-spec-v1.md`](agent-spec-v1.md)) wrote a part as
`{ id, text }`, or `{ id, ref }`. Version 2 ([`agent-spec-v2.md`](agent-spec-v2.md)) is the shape
above, with no references (below). Version 1 documents are not read; `upgradeSpec` converts one
(section 9).

### The name

The name names what the part is *for*. It does three jobs:

1. **It lets a later layer find the part.** A later layer can overwrite or delete it, or extend
   or replace it with a part of its own (section 2).
2. **It fixes the part's place.** Parts are written in the order the agent lists them, and a
   replacement keeps the place the name first had.
3. **In the XML and markdown layouts, it names the section the model reads.** `identity` is
   written as `<prompt_identity>…</prompt_identity>`, or under `## Identity` (section 6).

Any non-empty string is accepted. In the XML layout, a name that is not a valid tag name is
cleaned (`my lane` becomes `<prompt_my_lane>`), and the document's check warns that it was. In the
markdown layout, it becomes a heading in Title Case (`## My Lane`).

### Well-known names

Agents and apps mean the same thing by these names. Using them is a convention, not a rule: any name
is accepted, and none of these is required.

| Id | Says | Example |
| --- | --- | --- |
| `identity` | Who the agent is and what it is for | "You are Task Reviewer. You decide whether work is actually done." |
| `rules` | How it works: what it must and must not do | "Judge the work itself, not reports about it." |
| `format` | How it answers | "Start with PASS or FAIL on its own line." |
| `examples` | Sample inputs and the answers wanted | A short card and the verdict it should get |
| `background` | Standing facts it should know | "Our licence policy allows MIT, BSD and Apache-2.0." |

An app's own concerns get names of their own, such as `lane` or `project`.

### A part that adds to another

A part can name a part already there and say, in `mode`, how it adds to it:

```json
{ "role": "system", "name": "identity", "mode": "extend", "content": "Here you review the output of one workflow step." }
```

This leaves `identity` as it was. It adds a part of its own, marked as extending `identity`.
Section 2 covers `mode` and its values.

### Content only

A part's content is its text, written in the document. A part cannot point at a file or a URL
for it: an app that keeps its prompts in files reads them itself and writes the text into the
part, before the document reaches agent-core.

### What makes a good set of parts

- **One concern per part.** `identity` says who the agent is; `rules` says how it judges; `format`
  says how it answers. A layer can then change the format without touching the rules.
- **The most stable first.** The text at the top is what every request shares, so the prompt cache
  reuses it for longest. Who the agent is changes least; put it first.
- **Nothing about one job.** "Review PR 42" is the job, not the agent: it goes in the user message
  (section 5). A part that changes on every request costs the cache everything written after it.

### Example: the same agent, three ways of writing it

All three are valid. The first one is the easiest to share:

| Parts | What a layer above can do |
| --- | --- |
| `identity`, `rules`, `format` | Change just the format, or just the rules |
| One part, `main`, holding all three paragraphs | Only replace the lot, or add after it |
| `identity` with the format sentence folded in | Change the format only by rewriting who the agent is |

## 2. Layers: how parts change from one layer to the next

A prompt is usually built from several documents stacked weakest first: an app's settings, then
the agent, then a task, then a stage. Each layer can do five things to the parts below it:

| To | The layer writes | Result |
| --- | --- | --- |
| **Add** | A part with a new name | Added after the parts already there |
| **Extend** | A part with a name already there, and `"mode": "extend"` | A new part, added after the parts already there, marked as adding to that name |
| **Replace** | A part with a name already there, and `"mode": "replace"` | A new part, added after the parts already there, marked as taking that name's place; the old text stays where it was |
| **Overwrite** | A part with a name already there, content, and no `mode` | The text is overwritten, in the place the name first had |
| **Delete** | A part with a name already there, and `"content": ""` | The part is gone, and so is everything extending or replacing it |

The name always names the part being changed. `mode` says how; without it, a matching name
overwrites, as it does today.

Section 3 says which of these a layer may do to a part it does not own. Within one owner, such as
an app stacking its own settings, agent and task layers, all five are allowed.

### The new part's name

Extending and replacing add a part, and a part needs a name of its own, so a later layer can
change it. It is the name it names, numbered: the first part extending or replacing `identity` is
`identity_2`, the next `identity_3`. An app's parts get `app_` in front instead (section 4), so
an app extending an agent's `identity` adds `app_identity`.

### Two ways to change a part's text

**Overwrite** and **replace** both change what a part says, but they leave different text behind:

| | Overwrite | Replace |
| --- | --- | --- |
| The old text | Gone | Still there, in its place |
| The new text | Where the old text was | After the parts already there, marked `replaces="<name>"` |
| The prompt cache | Reused only up to the overwritten part | Reused for everything the layers below wrote |
| The model reads | One text | Both, and is told the later one wins |
| Use it when | One owner is changing its own words | The words below are shared, by other apps or other runs, and should stay put |

Replacing costs the tokens of both texts, and it relies on the model following the mark (section
8 says how the model is told what `extends` and `replaces` mean).

### Example

Three layers, weakest first:

```json
// 1 · the app's settings
"prompt": [
  { "role": "system", "name": "identity", "content": "You are a helpful assistant." },
  { "role": "system", "name": "format",   "content": "Answer in full sentences." }
]

// 2 · the agent
"prompt": [
  { "role": "system", "name": "identity", "content": "You are Task Reviewer. You decide whether work is actually done." },
  { "role": "system", "name": "rules",    "content": "Judge the work itself, not reports about it." }
]

// 3 · a task
"prompt": [
  { "role": "system", "name": "identity",  "mode": "extend",  "content": "Here you review the output of one workflow step." },
  { "role": "system", "name": "format",    "mode": "replace", "content": "Start with PASS or FAIL on its own line." },
  { "role": "system", "name": "checklist", "content": "Check the tests, the changelog and the licence." }
]
```

What each layer did:

| Part | Layer 1 | Layer 2 | Layer 3 | Resolved |
| --- | --- | --- | --- | --- |
| `identity` | adds | overwrites | (extended) | "You are Task Reviewer…" |
| `format` | adds | | (replaced) | "Answer in full sentences.", left in place |
| `rules` | | adds | | "Judge the work itself…" |
| `identity_2` | | | extends `identity` | "Here you review…" |
| `format_2` | | | replaces `format` | "Start with PASS or FAIL…" |
| `checklist` | | | adds | "Check the tests…" |

The model reads, in the XML layout:

```
<prompt_identity>
You are Task Reviewer. You decide whether work is actually done.
</prompt_identity>

<prompt_format>
Answer in full sentences.
</prompt_format>

<prompt_rules>
Judge the work itself, not reports about it.
</prompt_rules>

<prompt_identity_2 extends="identity">
Here you review the output of one workflow step.
</prompt_identity_2>

<prompt_format_2 replaces="format">
Start with PASS or FAIL on its own line.
</prompt_format_2>

<prompt_checklist>
Check the tests, the changelog and the licence.
</prompt_checklist>
```

Everything layers 1 and 2 wrote comes first, unchanged, so a run with a different task layer
reuses all of it from the cache.

### How extending and replacing work

- **Where they go.** Like any new part: after the parts already there, in the order their layers
  come. They do not move next to the part they name, so the parts below them stay one unbroken
  block.
- **They are parts in their own right.** A later layer can overwrite or delete `identity_2`
  without touching `identity`.
- **They follow the part they name.** Overwriting `identity` leaves `identity_2` extending the new
  text. Deleting `identity` deletes `identity_2` too.
- **A part that is not there.** If no layer below has the name, `mode` has nothing to act on: the
  part is an ordinary added part, under its own name, with no mark.
- **Two replaces of one part.** The later one wins; both are written, each marked.
- **Why a part of its own, not added to the same text.** The model can tell the words below from
  the addition, and a later layer can remove the addition without restating the text below. So
  there is no action that appends inside another part's tag.

### Replacing in the plain layout

The plain layout has no tags, so nothing can tell the model which of two texts wins. There, a
replace is written as an overwrite: the new text in the old one's place, and the old text gone.
It costs the cache what an overwrite does, and the model reads one text. Extending needs no such
rule: in the plain layout the extension is just the next paragraph. The XML and markdown layouts
both mark a replace, so neither needs this rule.

## 3. Who owns which parts

A layer's **owner** is whoever wrote it. A run that uses a shared agent has three:

| Owner | Writes | Example |
| --- | --- | --- |
| **The agent** | The agent document's parts | Task Reviewer's `identity`, `rules`, `format` |
| **The app** | Parts of its own, saying how it uses the agent | A board's `lane`, a project's `project`, a chat client's system message |
| **The job** | No parts: the job is the user message (section 5) | The card, the todo, the question |

### Within one owner

When one owner wrote every layer, such as an app stacking its own settings, its own copy of an
agent and a task, all five actions of section 2 are allowed. Every word changed is the
owner's own.

### Across owners

When an app's layer sits on an agent someone else wrote, the agent's words are shared: other apps
rely on them reading the same. So an app may do less to them:

| What an app does to the agent's part | Allowed |
| --- | --- |
| **Add** a part of its own | Always |
| **Extend** it (`"mode": "extend"`) | Unless the agent's part forbids it |
| **Replace** it (`"mode": "replace"`) | Only if the agent's part allows it |
| **Overwrite** or **delete** it | Never |

Adding and extending leave the agent's words standing. Replacing leaves them in place but tells
the model to follow the app's, so it is the agent's author who decides where that is acceptable.
Overwriting and deleting take the agent's words out, and that would make it a different agent.

The last row needs no check of its own. Every name an app sends gets `app_` in front of it
(section 4), so an app's part never has the agent's name, and a matching name is the only way to
overwrite or delete.

### The agent says which modes an app may use

A part lists the modes an app may use on it, in `allowedModes`:

```json
"prompt": [
  { "role": "system", "name": "identity", "content": "You are Task Reviewer. You decide whether work is actually done." },
  { "role": "system", "name": "rules",    "content": "Judge the work itself, not reports about it." },
  { "role": "system", "name": "format",   "content": "Start with PASS or FAIL on its own line.", "allowedModes": ["extend", "replace"] }
]
```

An app may then replace `format`, say to get its verdict back as JSON. No app can do more than
extend `identity` or `rules`, so Task Reviewer judges the same way for everyone.

| `allowedModes` | An app may |
| --- | --- |
| Left out | Extend it |
| `["extend", "replace"]` | Extend it or replace it |
| `["replace"]` | Replace it, but not extend it |
| `[]` | Nothing: the part is locked |

Adding is not a mode on a part: an app's new part names no part of the agent's, so an app may
always add. What it adds sits below `<precedence>` (section 8), so it cannot outrank the agent's
words. Overwrite and delete cannot be listed: an app never can (see above).

### When an app's part breaks the rule

The rule is enforced where an app's parts are put on top of the agent's: by `stackAppParts`, which
an agent server runs for an agent it keeps and agent-core runs for any other model (section 4). A
part that breaks it is dropped with a warning, and the rest of the request runs. The warning names
the part and the rule.

An app running a copy of an agent owns the copy, and can change the document itself. The parts
it sends in `agent_core` are still checked against it, so the copy reads the same as the
original until the app changes it.

## 4. How an app adds its parts

### One request, whatever the model

An app builds its request the same way whether the model is a plain model or an agent on an
agent server: an ordinary chat request, with its parts in a field of the body named `agent_core`.

```json
{
  "model": "task-reviewer",
  "messages": [
    { "role": "system", "content": "Today is 2026-11-19." },
    { "role": "user",   "content": "Card 812: add the licence check to CI. Diff: …" }
  ],
  "agent_core": {
    "prompt": [
      { "role": "system", "name": "identity", "mode": "extend",  "content": "Here you review the output of one workflow step." },
      { "role": "system", "name": "lane",                        "content": "This is the Review lane: a card that passes moves to Done." },
      { "role": "system", "name": "format",   "mode": "replace", "content": "Answer as JSON: { \"verdict\": \"pass\" | \"fail\", \"reasons\": [] }" }
    ]
  }
}
```

`agent_core` is a field of the request body, beside `model` and `messages`, not inside a message.
With the `openai` SDK it is `extra_body` in Python and an extra key on the request in TypeScript.

Each part has the shape of a part in an agent document (section 1): `role`, `name`, `content` and
`mode`. A part's `role` is `system` or `developer`; nothing else is a part. With no `mode`, the
part is added.

What becomes of the field depends on the model:

| The model is | `agent_core` is | The parts are stacked and written by |
| --- | --- | --- |
| An agent on an agent server | Sent through | The agent server |
| Any other model | Taken out of the body, and its parts turned into system messages | agent-core, before it sends |

agent-core tells the two apart by `remoteAgent`, which an app sets from the agent server's model
listing (an agent's entry says `"agent_core": { "kind": "agent" }`). Either way the parts are
stacked by the same function, `stackAppParts` in agent-core's `spec` module, which an agent server
calls instead of keeping rules of its own. So, given the same agent, the model reads the same text
in both cases.

### Stacking

Wherever it happens, stacking does three things:

1. **Puts `app_` in front of every name.** `lane` becomes `app_lane`. The app writes plain names,
   the same names it would use in its own documents, and never the prefix. A part named `format`
   with no `mode` becomes `app_format`, an added part, and cannot touch the agent's `format` by
   accident.
2. **Checks each `mode` against the agent's part it names.** A part extending or replacing a name
   the agent does not have is an ordinary added part. A mode the part's `allowedModes` does not
   list is dropped with a warning.
3. **Puts the parts in order:** the agent's parts, then the app's in the order it sent them, then
   the request's leading system messages, joined into one part, `app_system`.

With no agent at all, such as an app with only its own parts, the result is the app's parts and
`app_system`, still prefixed, so the model reads the same names it would through an agent server.

The prefix belongs to apps alone: a document whose part name has `app` as its first word
(`app_lane`, `app-lane`, `app lane`) is refused by its check. So an app's part can never meet an
agent's part of the same name, and in the markdown layout no agent's heading starts with "App".

### When the model is an agent

agent-core sends the request as the app wrote it, adding only `progress: true` to `agent_core`:

```json
{
  "model": "task-reviewer",
  "messages": [
    { "role": "system", "content": "Today is 2026-11-19." },
    { "role": "user",   "content": "Card 812: …" }
  ],
  "agent_core": {
    "progress": true,
    "prompt": [ "…the three parts, as the app wrote them…" ]
  }
}
```

The agent server stacks Task Reviewer's parts with the app's and runs the loop. With `format`
allowing replace, the model reads:

```
<prompt_identity>
You are Task Reviewer. You decide whether work is actually done.
</prompt_identity>

<prompt_rules>
Judge the work itself, not reports about it.
</prompt_rules>

<prompt_format>
Start with PASS or FAIL on its own line.
</prompt_format>

<precedence>…</precedence>

<prompt_app_identity extends="identity">
Here you review the output of one workflow step.
</prompt_app_identity>

<prompt_app_lane>
This is the Review lane: a card that passes moves to Done.
</prompt_app_lane>

<prompt_app_format replaces="format">
Answer as JSON: { "verdict": "pass" | "fail", "reasons": [] }
</prompt_app_format>

<server_instructions>…</server_instructions>

<tool_catalogue>…</tool_catalogue>

<prompt_app_system>
Today is 2026-11-19.
</prompt_app_system>
```

and then the user message, the card. `<precedence>` is the loop's sentence saying the agent's
parts win (section 8). The loop's own sections come before `app_system`, because `app_system` is
what changes most (section 7). Without `replace` in `format`'s `allowedModes`, `app_format` would
be dropped and the app warned.

### When the model is any other model

agent-core takes `agent_core` out of the body and does the agent server's work itself. The agent's
parts come from the agent document the app gave the loop, such as a copy of Task Reviewer; an
app that runs a copy owns it.

It stacks the parts, the same way, and turns each into a system message, its tag written into the
content:

```json
"messages": [
  { "role": "system", "name": "identity",     "content": "<prompt_identity>\nYou are Task Reviewer. …\n</prompt_identity>" },
  { "role": "system", "name": "rules",        "content": "<prompt_rules>\nJudge the work itself, …\n</prompt_rules>" },
  { "role": "system", "name": "format",       "content": "<prompt_format>\nStart with PASS or FAIL …\n</prompt_format>" },
  { "role": "system", "name": "app_identity", "content": "<prompt_app_identity extends=\"identity\">\nHere you review …\n</prompt_app_identity>" },
  { "role": "system", "name": "app_lane",     "content": "<prompt_app_lane>\nThis is the Review lane: …\n</prompt_app_lane>" },
  { "role": "system", "name": "app_format",   "content": "<prompt_app_format replaces=\"format\">\nAnswer as JSON: …\n</prompt_app_format>" },
  { "role": "system", "name": "app_system",   "content": "<prompt_app_system>\nToday is 2026-11-19.\n</prompt_app_system>" },
  { "role": "user",   "content": "Card 812: …" }
]
```

The loop adds its own sections, `<precedence>` after the agent's parts and the server
instructions and catalogue before `app_system`, and always merges the leading system messages
into one, as `singleSystem` does today, even for a server that would take several. So what is
sent is:

```json
{
  "model": "qwen3-32b",
  "messages": [
    { "role": "system", "content": "<prompt_identity>…</prompt_identity>\n\n<prompt_rules>…</prompt_rules>\n\n<prompt_format>…</prompt_format>\n\n<precedence>…</precedence>\n\n…\n\n<server_instructions>…</server_instructions>\n\n<tool_catalogue>…</tool_catalogue>\n\n<prompt_app_system>…</prompt_app_system>" },
    { "role": "user",   "content": "Card 812: …" }
  ],
  "tools": ["…"],
  "stream": true
}
```

A plain chat request that any server takes, whose system message is the text an agent's model
would read. The names and modes never leave agent-core; the tags keep the parts apart inside the
one message.

### Side by side

| | The model is an agent | Any other model |
| --- | --- | --- |
| The app writes | The request above | The same request |
| `agent_core` | Sent through, with `progress: true` | Taken out |
| Stacked and written by | The agent server, with `stackAppParts` | agent-core, with `stackAppParts` |
| The agent's parts come from | The agent server's agent | The document the app gave the loop, or none |
| A part that breaks the rules | Dropped; a warning in the reply | Dropped; a warning event |
| The system message | One, merged | One, merged |
| What the model reads | The text above | The same text |

### Warnings

A dropped part is reported with what it was and why:

```json
"agent_core": {
  "warnings": [
    { "part": "format", "rule": "replace-not-allowed", "message": "Task Reviewer's format does not let an app replace it, so the part was dropped." }
  ]
}
```

Through an agent server, that comes back in the reply's `agent_core` field (on the last chunk
when it streams) and as a progress event. On any other model, agent-core raises it as an event.
agent-core relays an agent server's warnings as the same event, so an app handles one thing
either way.

### No switch for app parts

An agent server takes an app's parts, and its system messages, whenever it runs an agent: there
is no switch that refuses them. The agent's words are kept by the structure (no overwrite or
delete, replace only where `allowedModes` allows, the fence), by `allowedModes: []` on any part
that must not even be extended, and by `<precedence>` for words that conflict. What a switch would
still stop is an addition that conflicts with nothing, and it would stop every useful addition
with it. If an agent ever needs to take no additions at all, that belongs in its own document,
beside `allowedModes`.

### A plain chat client

A chat client that knows nothing of `agent_core` still works. It sends system messages, and
those become `app_system`, after the agent's parts. It can add; it cannot extend or replace.

### An app that sends parts and system messages

An app's parts come first, then `app_system`, with the loop's sections between them:

```
the agent's parts
the app's parts       stable for the app
the loop's server instructions and catalogue
app_system            may change on every request
```

System messages are what changes most: chat clients add the date, the user's name, memories or
retrieved documents to them. Written last, a change costs only what comes after it, and the app's
parts stay cached. Both come after the agent's parts either way, so the order does not change
whose words win over the agent's (section 8).

**Later, if an app needs it:** an empty part named `system` in `agent_core.prompt` could mark where
the system messages go. Until then the name `system` is reserved: an app part named so would clash
with `app_system`, and is dropped with a warning.

### Seeing what an agent allows

An app can read an agent's part names and what each allows apps to do, from the agent server's entry
for the agent in its model listing, before it sends anything. It then knows which names it can
extend or replace, without learning only from warnings. The texts need not be part of that entry.

### The `agent_core` field

Everything an app and an agent server say to each other beyond a chat request goes under one
key, `agent_core`:

| Where | Key | Means |
| --- | --- | --- |
| A request | `prompt` | The app's parts |
| A request | `progress` | Send the run's events back; agent-core sets it when the model is an agent |
| A request | `servers` | Narrow the agent's servers. Never widens them |
| A reply | `warnings` | The parts that were dropped, and why |
| A reply | `runId`, `events` | The run's progress, when asked for |
| A model listing entry | `kind: "agent"` | This model is an agent, with its parts' names and `allowedModes` |

## 5. Where the job and context go

The system prompt says who the agent is and how the app uses it. Everything about this one
request goes in the messages.

### The job is the user message

| App | The job | Sent as |
| --- | --- | --- |
| A board | The card: its title, its description, the diff | The user message |
| A todo list | The todo and what it needs | The user message |
| A chat client | The question | The user message |

```json
"messages": [
  { "role": "user", "content": "Card 812: add the licence check to CI.\n\nDiff: …" }
]
```

The job never goes in the system prompt, for two reasons:

- **The cache.** The system prompt is the same on every turn of an exchange, and from one run to
  the next. A job written into it changes it on every run, and the model server then reads again
  everything after the change: the app's parts, the server instructions, the tool catalogue.
- **What a model expects.** A model reads the system prompt as who it is and the user message as
  what to do now. A job in the system prompt is a standing instruction to do that one thing.

### Context from hooks: before the question

An app's hooks (`sessionStart`, `beforeExchange`) can return text for the model to have beside
the question, such as the repository's state or notes found for the card. The loop puts it in the
user message, before the question's text, after a short preface:

```
The <hook_context> blocks below were added for this message by the app's hooks. They are
background the user did not write and may not be relevant. The user's message follows them.

<hook_context source="git-status">
On branch card-812, 2 files changed.
</hook_context>

Card 812: add the licence check to CI.

Diff: …
```

- **It is on the request only.** The stored conversation keeps what the user wrote. An app stores
  the context beside the question and sends it again with that question on every later request,
  so the conversation reads the same each time and the cache holds.
- **It has a budget.** The blocks together are cut to `contextTokens` (2,000 by default).
- **It is not in the system prompt**, because it is about the question: a system prompt that
  changed with every question would miss the cache every time.

- **Text inside a block cannot close it.** Every block is fenced, like every tag of the layout's
  (section 6).
- **The tag is `hook_context`, not `context`.** Chat clients wrap retrieved documents in
  `<context>` tags of their own, and a model behind one could read the two as one.

### Input sent mid-exchange

An app can hand the loop a message while an exchange runs (`takeInput`). It becomes a new user
message, after the last tool results, before the next turn. It never touches the system prompt.

### What goes where

| What | Where | Changes |
| --- | --- | --- |
| Who the agent is and how it works | The agent's parts | Rarely |
| How the app uses the agent | The app's parts | Per app |
| What a chat client adds each time: the date, the user's name, memories | `app_system`, the last part | Per request, so it is written last |
| Background found for this question | Hook context, before the question | Per exchange |
| The job | The user message | Per run |
| Input sent mid-exchange | A new user message | Between turns |

The higher a row, the less it changes, and the earlier it is written. That order is what keeps the
cache warm (section 7).

## 6. Layout: how parts become text

Once the parts are stacked, they are written into the one system message. The **layout** says
how. There are three:

| Layout | Each part is written as | The model can tell the parts apart |
| --- | --- | --- |
| `plain` | Its content, the parts separated by a blank line | No |
| `markdown` | Its content under a heading named after the part | Yes, by headings |
| `xml` | Its content inside an XML-style tag named after the part | Yes, by tags |

`xml` means XML-style tags, as prompting guides use the words "XML tags": the system message is
not an XML document, nothing parses it as one, and only the layout's own tags are escaped inside
it (below).

`plain` is today's text and the default. A document with parts that use no `mode` writes, in
`plain`, exactly the text it writes today (section 9).

### Who chooses

The layout is a field of the agent document, `promptLayout`, like any other setting of how the
agent runs:

```json
{
  "spec": "cubicecho.agent/2",
  "id": "task-reviewer",
  "promptLayout": "xml",
  "prompt": [ "…" ]
}
```

| The model is | The layout comes from |
| --- | --- |
| An agent on an agent server | The agent's document. An app has no say: `agent_core` has no layout field |
| Any other model | The documents the app gave the loop, stacked like any other setting: a later layer wins. With none, `plain` |

### The same parts in each layout

Task Reviewer, with an app extending `identity` and replacing `format`:

**`plain`**

```
You are Task Reviewer. You decide whether work is actually done.

Judge the work itself, not reports about it.

Answer as JSON: { "verdict": "pass" | "fail", "reasons": [] }

Here you review the output of one workflow step.
```

**`xml`**

```
<prompt_identity>
You are Task Reviewer. You decide whether work is actually done.
</prompt_identity>

<prompt_rules>
Judge the work itself, not reports about it.
</prompt_rules>

<prompt_format>
Start with PASS or FAIL on its own line.
</prompt_format>

<precedence>…</precedence>

<prompt_app_identity extends="identity">
Here you review the output of one workflow step.
</prompt_app_identity>

<prompt_app_format replaces="format">
Answer as JSON: { "verdict": "pass" | "fail", "reasons": [] }
</prompt_app_format>
```

**`markdown`**

```markdown
## Identity

You are Task Reviewer. You decide whether work is actually done.

## Rules

Judge the work itself, not reports about it.

## Format

Start with PASS or FAIL on its own line.

## Precedence

…

## App Identity (extends Identity)

Here you review the output of one workflow step.

## App Format (replaces Format)

Answer as JSON: { "verdict": "pass" | "fail", "reasons": [] }
```

In `plain`, the replace is an overwrite: the new format sits where the old one was, and the old one
is gone (section 2). The extension is just the next paragraph.

### Tag names

A part's tag is `prompt_` and its name. The prefix keeps a part's tag from ever being one a model
already gives a meaning to: chat templates use `<tools>`, `<tool_call>` and `<think>`, and a part
named `tools` would otherwise be written as one of them.

A tag name can hold letters, digits, `_` and `-`. A name with anything else is cleaned:

| Name | Tag | The check warns |
| --- | --- | --- |
| `identity` | `prompt_identity` | No |
| `task-list` | `prompt_task-list` | No |
| `my lane` | `prompt_my_lane` | Yes: cleaned |
| `review/rules` | `prompt_review_rules` | Yes: cleaned |
| `my_lane`, after `my lane` | `prompt_my_lane_2` | Yes: two names make one tag |

- **Cleaning** turns each run of other characters into one `_`.
- **A clash**, two names that make the same tag, numbers the later one with the next free number.
- **The name is unchanged.** Cleaning is only how the tag is written: layers still find the part
  by its name, as written.
- **The warning** comes from the document's check, for a document's parts, and from
  `stackAppParts`, for an app's.

### The marks

An extension or a replacement carries the part it names as an attribute:

```
<prompt_app_identity extends="identity">
<prompt_app_format replaces="format">
```

The value is the named part's tag without `prompt_`, so it reads the same as the tag it points at.
What the marks mean is said once, in the system prompt (section 8).

### Content cannot close its tag

A part whose content contains `</prompt_identity>` would end its section early, and what followed
would read as something else. Worse, an app's part could write `</prompt_app_format><prompt_rules>`
and pass its own words off as the agent's.

So every tag in the layout's own vocabulary that appears inside a content, opening or closing, in
any case, has its `<` escaped (`&lt;/prompt_rules>`). That vocabulary is:

- every `prompt_` tag, not only the part's own;
- the loop's own sections, below;
- `untrusted` and `hook_context`.

Nothing else in the content changes. It is the same fence `untrusted` already uses, and one helper
does it for all of them, so hook context (section 5) gets it too. In the markdown layout the same
tags are escaped too, since `untrusted` and `hook_context` blocks appear in it.

### The markdown layout

The markdown layout writes each part under a heading instead of inside a tag. Everything else is
the same: the same parts, in the same order, with the same marks and `<precedence>`.

**Headings.** Every part's heading is at level 2 (`##`), and the loop's own sections are too.
Level 1 is not used.

**A heading is the part's name in Title Case.** The name is split on `_`, `-` and spaces, and each
word starts with a capital letter:

| Name | Heading | The check warns |
| --- | --- | --- |
| `identity` | `## Identity` | No |
| `task-list` | `## Task List` | No |
| `app_identity` | `## App Identity` | No |
| `my lane` | `## My Lane` | No |
| `my_lane`, after `my lane` | `## My Lane 2` | Yes: two names make one heading |
| `tool_catalogue` | `## Tool Catalogue 2` | Yes: the loop's section has that heading |

As with tags, the heading is only how the part is written: layers still find the part by its
name. Title Case loses the difference between `_`, `-` and a space, so a clash is likelier than with
tags, and the next free number settles it the same way. The loop's headings (`Precedence`,
`Server Instructions`, `Tool Catalogue`) count as taken.

**The marks go in brackets after the heading**, naming the part's heading:
`## App Identity (extends Identity)`, `## App Format (replaces Format)`.

**Content cannot start a section.** A heading has no closing tag: a section ends where the next
`##` starts. So a heading inside a part's content would read as a new section, and an app's part
could write `## Rules` to pass its words off as the agent's. Every heading inside a content is
moved down by two levels, below the sections: `#` becomes `###`, `##` becomes `####`, and so on,
to `######` at most. A heading underlined with `===` or `---` is rewritten the same way. Lines
inside a code block in the content are left alone. Only the heading markers change; the content's
headings keep their order against one another.

**Text from outside stays tagged.** Server instructions keep their `<untrusted source="…">` blocks,
and hook context keeps its `<hook_context>` blocks in the user message. That is where text nobody
vouched for comes in, and an escaped tag is a firmer boundary than a heading.

### Which layout to choose

How a model reads a layout depends on the model. OpenAI recommends markdown headings for its
models' prompts and notes that XML tags mark a section's start and end precisely; Anthropic
recommends XML tags for Claude. In published comparisons, which format scores best changes from
one model to another, and smaller models are far more sensitive to it than larger ones. So the
choice is the agent's author's, per agent, and the way to make it is to run the agent's own cases
under each layout on the model it will use. `plain` stays the default.

### The loop's own sections

The loop adds sections of its own, placed as section 7 says. They follow the layout:

| Section | `plain` (today) | `markdown` | `xml` |
| --- | --- | --- | --- |
| Server instructions | Under `# MCP server instructions`, each server under `## <label>` | Under `## Server Instructions`, each server under `### <label>`, its text in `<untrusted source="<label>">` | Inside `<server_instructions>`, each server's text in its own `<untrusted source="<label>">` |
| Tool catalogue | Under `# Tool catalogue` | Under `## Tool Catalogue` | Inside `<tool_catalogue>` |
| The standing sentence (section 8) | Not written | Under `## Precedence`, between the agent's parts and the app's | Inside `<precedence>`, between the agent's parts and the app's |

In the XML layout they take no `prompt_` prefix: no part makes them, so no part's name can
clash with them, and a part named `tool_catalogue` is written as `<prompt_tool_catalogue>`. In the
markdown layout their headings count as taken, so that part is written under
`## Tool Catalogue 2`.

## 7. The order of the whole system prompt

A model server reuses the longest start a request shares with one it has seen, and reads
everything after the first difference again. So the system prompt is written from what changes
least to what changes most:

| # | What | Written by | Changes when |
| --- | --- | --- | --- |
| 1 | The agent's parts | The agent's document | The agent is edited |
| 2 | `<precedence>`, when there are agent's and app parts | The loop | Never: its text is fixed (section 8) |
| 3 | The app's parts | The app | The app changes how it uses the agent |
| 4 | The loop's server instructions | The loop | The agent's servers change, or the app narrows them |
| 5 | The loop's tool catalogue | The loop | The same |
| 6 | `app_system` | The app's system messages | Often on every request: a chat client's date, memories |

Then come the messages: the conversation so far, the question with its hook context before it,
and the turn's new messages.

### Between turns

Nothing in the system message changes from one turn of an exchange to the next. Every line of
the table is written from the same inputs each turn, and loading a tool does not change the
catalogue's text: what is loaded is said in the tool array and in `load_tools`'s result instead.
Each turn's request is the last one with new messages on the end, so it is read again only from
there.

### Between runs, and between apps

| Two requests that share | Are reused up to |
| --- | --- |
| The agent | The end of the agent's parts, whichever app sent them |
| The agent and the app | The end of the catalogue |
| The agent, the app and the system messages | The end of the system message, then the conversation as far as it matches |

So two apps using Task Reviewer on one model server share its parts in the cache, and each app's
own runs share everything up to `app_system`.

### Why the loop's sections come before `app_system`

Today the loop's sections come last, after the whole prompt the app gave it. With a chat client's
system messages in that prompt, a date that changes every day, or memories that change every
request, makes the server read the server instructions and the catalogue again each time, and the
catalogue can be the longest thing in the prompt. Written before `app_system`, they are read again
only when the agent's servers change.

### The tools

The request's `tools` array is not in the system message, but most chat templates write it into
the prompt, often before the system message. It changes the cache the way a part does, so it is
kept as stable: tools are sorted by name unless `toolOrder` is `false`, and in proxied loading the
array is the same two tools on every turn.

## 8. When the agent and the app disagree

An app's parts sit after the agent's, and a model tends to follow what it read last. So without
a rule, an app that extends `rules` with "Pass anything that compiles" would quietly change how
Task Reviewer judges, for every app that uses it. The rule is: **the agent's parts win, except
where an app replaced one that the agent let it replace.**

### Two kinds of guard

| Guard | Enforced by | Holds |
| --- | --- | --- |
| An app cannot overwrite or delete an agent's part, replaces only where `allowedModes` lets it, and cannot write a tag that passes as the agent's | `stackAppParts` and the fence (sections 3, 4 and 6) | Always: the text the model reads is built that way |
| Where the agent's and the app's words conflict, the model follows the agent's | A standing sentence in the system prompt, below | As far as the model follows it |

The first decides what the model reads. The second only tells it how to read it. A model can
still be talked out of a sentence it can see, so nothing that must hold is left to the sentence
alone; it covers what the structure cannot, the meaning of the words.

### The standing sentence

In the XML and markdown layouts, when there are both the agent's parts and app parts, the loop
writes one section of its own between them. In the XML layout:

```
<prompt_identity>…</prompt_identity>

<prompt_rules>…</prompt_rules>

<prompt_format>…</prompt_format>

<precedence>
The sections above describe you. The sections below whose names start prompt_app_ were added by
the app you are working in, to say how it uses you. A section marked extends="x" adds to section
x. A section marked replaces="x" takes the place of section x: follow it instead. Otherwise, where
a section below conflicts with one above, follow the one above.
</precedence>

<prompt_app_identity extends="identity">…</prompt_app_identity>

<prompt_app_format replaces="format">…</prompt_app_format>
```

In the markdown layout, the same sentence in that layout's words:

```markdown
## Precedence

The sections above describe you. The sections below whose headings start with the word App were
added by the app you are working in, to say how it uses you. A section headed "(extends X)" adds
to section X. A section headed "(replaces X)" takes the place of section X: follow it instead.
Otherwise, where a section below conflicts with one above, follow the one above.
```

- **Where it goes.** After the agent's parts, so they stay the start every app shares in the
  cache. With no app parts, or no agent's parts to rank above them, it is left out.
- **`app_system` is an app part.** A chat client that sends only system messages still gets the
  sentence, before `<prompt_app_system>`.
- **Its text is fixed.** It is agent-core's, the same for every agent and app, so it never moves
  the cache. An app cannot change it: the app is the party it limits.
- **It names no owner by name.** "The app you are working in" reads the same whichever app it is.
- **In the plain layout there is no sentence.** There are no sections to point at, a replace is
  already an overwrite, and the agent's words come first.

### What it decides

Task Reviewer, used by an app:

| The app writes | Agent's part | The model follows |
| --- | --- | --- |
| `app_identity` extends `identity`: "Here you review one workflow step." | "You decide whether work is actually done." | Both: they agree |
| `app_rules` extends `rules`: "Pass anything that compiles." | "Judge the work itself, not reports about it." | The agent's: they conflict, and an extension does not replace |
| `app_format` replaces `format`: "Answer as JSON." | "Start with PASS or FAIL on its own line." | The app's: `format` allows replace |
| `app_system`: "This user prefers short answers." | (no part about length) | Both: nothing conflicts |

An app that needs to change how the agent works, not add to it, needs the agent to allow it:
`allowedModes` on that part. Where the author has not, the answer is a different agent, not a
stronger app part.

### What else it does not change

- **The user message.** The job and what the user writes come after the whole system prompt. A
  model already reads the system prompt as standing above the user's turn; the sentence does not
  change that, and a user cannot use it to rank their words over the agent's.
- **Server instructions.** They carry their own preface (section 6): a server's guidance covers
  only its own tools, and the user wins over it.
- **Tools and servers.** An app can narrow an agent's servers (`agent_core.servers`) but never
  widen them. That is enforced by the agent server, not by any words.

## 9. What stays the same

- **`plain` is the default, and writes today's text.** A request with no `agent_core` and no
  system messages, from a document whose parts use no `mode`, sends exactly the system prompt it
  sends today: the parts' content joined by blank lines, then `# MCP server instructions` and
  `# Tool catalogue` as now.
- **A string is still a string.** An app that passes its system prompt as one string
  (`systemPrompt: "…"`, version 1's `system`) gets it used as it is, with the loop's sections after
  it. Only the option's name changes.
- **Layers merge as they did.** A matching name with no `mode` overwrites in place, an empty
  content deletes, and a new name adds.
- **The conversation, mid-exchange input, tools and events** work as they did.
- **Hook context** goes where it went, before the question, on the request only.

### What changes even in `plain`

| Change | Who notices |
| --- | --- |
| The leading system messages, as `app_system`, come after the loop's sections, not before them (section 7) | Chat clients on an agent server. Their words move after the catalogue |
| Hook context's tag is `<hook_context>`, its text cannot close it, and its preface says "the app's hooks" | Apps with hooks |

### Version 1 documents

A version 1 document is refused, as another major always is. `upgradeSpec` turns one into
version 2:

| Version 1 | Version 2 |
| --- | --- |
| `{ "id": "identity", "text": "…" }` | `{ "role": "system", "name": "identity", "content": "…" }` |
| `{ "id": "rules", "ref": { … } }` | Dropped, with a warning |
| `{ "id": "format", "text": "" }` (a delete) | `{ "role": "system", "name": "format", "content": "" }` |

- **An agent server** runs it once over the agents it keeps, and over the layers of the runs it
  keeps, so a run started before the change can still be resumed.
- **An app that takes documents from people** runs it on each, and reports its warnings with its
  own.
- **An app that writes documents from settings rows** (`defineSpecColumns`) writes version 2 as
  soon as it uses the new agent-core. Its rows do not change.

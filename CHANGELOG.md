# [2.17.0](https://github.com/cubicecho/agent-core/compare/v2.16.0...v2.17.0) (2026-09-18)


### Features

* pick tools from the catalogue by the request's own words ([6773500](https://github.com/cubicecho/agent-core/commit/677350064b02ee2aeebf6ada0246e0516dc8a560)), closes [#92](https://github.com/cubicecho/agent-core/issues/92)

# [2.16.0](https://github.com/cubicecho/agent-core/compare/v2.15.0...v2.16.0) (2026-09-18)


### Features

* step a refused reasoning_effort up to one the model takes ([b80fbeb](https://github.com/cubicecho/agent-core/commit/b80fbebe3df24405e9cd0b9d1d2a04bec4126f67)), closes [#42](https://github.com/cubicecho/agent-core/issues/42) [#94](https://github.com/cubicecho/agent-core/issues/94)

# [2.15.0](https://github.com/cubicecho/agent-core/compare/v2.14.0...v2.15.0) (2026-09-18)


### Features

* dedupe identical tool calls on both paths, per step, with an opt-out ([8e1eb71](https://github.com/cubicecho/agent-core/commit/8e1eb71f14baf482f13021fb5cc939c505a485d2))

# [2.14.0](https://github.com/cubicecho/agent-core/compare/v2.13.0...v2.14.0) (2026-09-18)


### Features

* break a request's tokens into the four parts a consumer can shrink ([8a07073](https://github.com/cubicecho/agent-core/commit/8a0707393db225ec50f317d6d78dedcebb657a0b)), closes [#108](https://github.com/cubicecho/agent-core/issues/108)
* forget one endpoint's latched capabilities, or let them expire ([0271c91](https://github.com/cubicecho/agent-core/commit/0271c91fc830b27dc6bdf5d0abbdd100f7cee3b2)), closes [#95](https://github.com/cubicecho/agent-core/issues/95)

# [2.13.0](https://github.com/cubicecho/agent-core/compare/v2.12.0...v2.13.0) (2026-09-17)


### Bug Fixes

* write the tool-dedupe separator as \0 rather than a raw NUL byte ([5ae3489](https://github.com/cubicecho/agent-core/commit/5ae34896a34b3d250071771f4554c92b05a29d10))


### Features

* compaction as a stored fold record, not only a rewritten array ([97fde6a](https://github.com/cubicecho/agent-core/commit/97fde6a52b9d5fbc8fcb4bb974db0d292f02ed46))
* declare tools in a stable order, so the same set meets the same cache ([98254fa](https://github.com/cubicecho/agent-core/commit/98254fa9696c3fd3dc88841e5a53b7bea7acc23b))

# [2.12.0](https://github.com/cubicecho/agent-core/compare/v2.11.0...v2.12.0) (2026-09-17)


### Features

* calibrated token estimates, per-turn and per-run metrics, and continuing a cut-off answer ([8b361c2](https://github.com/cubicecho/agent-core/commit/8b361c24435106be39f86a7674ecc231d468ac9d)), closes [#90](https://github.com/cubicecho/agent-core/issues/90) [#91](https://github.com/cubicecho/agent-core/issues/91) [#93](https://github.com/cubicecho/agent-core/issues/93)
* let a beforeCompact hook veto a compaction when the host asks ([b71aaf1](https://github.com/cubicecho/agent-core/commit/b71aaf1a936f4821c6f8d9e9de0857c7af183c8a)), closes [#83](https://github.com/cubicecho/agent-core/issues/83)

# [2.11.0](https://github.com/cubicecho/agent-core/compare/v2.10.0...v2.11.0) (2026-09-17)


### Features

* ask and askJson take the content parts a vision model reads ([a940930](https://github.com/cubicecho/agent-core/commit/a9409300a97434fd2c8a4e7994c2bd434259263e))

# [2.10.0](https://github.com/cubicecho/agent-core/compare/v2.9.0...v2.10.0) (2026-09-15)


### Features

* export endpointKey and endpointId, and configureClients({ maxClients, listingMissMs }) ([fd68fca](https://github.com/cubicecho/agent-core/commit/fd68fcaa8bc89fb710ad2b14442fd6854ea31eb5)), closes [#97](https://github.com/cubicecho/agent-core/issues/97)

# [2.9.0](https://github.com/cubicecho/agent-core/compare/v2.8.1...v2.9.0) (2026-09-15)


### Features

* configureHooks({ preface }) sets the preface for every call that does not give its own ([4780ddc](https://github.com/cubicecho/agent-core/commit/4780ddc8c69e8879789a70a63e5cb0d9ca37f72a)), closes [#98](https://github.com/cubicecho/agent-core/issues/98)

## [2.8.1](https://github.com/cubicecho/agent-core/compare/v2.8.0...v2.8.1) (2026-09-15)


### Bug Fixes

* keep the on-demand catalogue fixed so a load does not bust the prompt cache ([d7ed508](https://github.com/cubicecho/agent-core/commit/d7ed5086ff0f3864863dae1fde83b18038640c87)), closes [#63](https://github.com/cubicecho/agent-core/issues/63)

# [2.8.0](https://github.com/cubicecho/agent-core/compare/v2.7.0...v2.8.0) (2026-09-15)


### Bug Fixes

* keep streamed tool calls apart on a server that sends no index ([f5af0d7](https://github.com/cubicecho/agent-core/commit/f5af0d70f9d4315af692e3c398e4ae76b100e615)), closes [#73](https://github.com/cubicecho/agent-core/issues/73)
* start runAgentLoop's usage total with cached at zero ([00d666c](https://github.com/cubicecho/agent-core/commit/00d666c695a6af457ae2ffdb8b23b68a4c57de39))


### Features

* keep a turn's reasoning, and count it when it is passed back ([aebf31c](https://github.com/cubicecho/agent-core/commit/aebf31cbb62d46d4676228404d90f432ba93c60f)), closes [#69](https://github.com/cubicecho/agent-core/issues/69)
* take a scratchpad fenced in content out of the answer ([f1e418d](https://github.com/cubicecho/agent-core/commit/f1e418d8d6176c0101c682d379dd0288975715ba)), closes [#70](https://github.com/cubicecho/agent-core/issues/70)

# [2.7.0](https://github.com/cubicecho/agent-core/compare/v2.6.0...v2.7.0) (2026-09-15)


### Bug Fixes

* start runAgentLoop's usage total with cached at zero ([e6c1e0f](https://github.com/cubicecho/agent-core/commit/e6c1e0fb5adb746de626ae675c1d940140b5968b))


### Features

* find the window llama.cpp and LM Studio are actually serving ([ab04c51](https://github.com/cubicecho/agent-core/commit/ab04c51e26b4b0536fc5cb8ddea96873c51ebe7c)), closes [#67](https://github.com/cubicecho/agent-core/issues/67)
* give a streamed turn's first token its own wait ([a942154](https://github.com/cubicecho/agent-core/commit/a9421541899105847aa7e5cad22649f56defedd8)), closes [#71](https://github.com/cubicecho/agent-core/issues/71)
* wait for a local server that is still loading the model ([ebb645a](https://github.com/cubicecho/agent-core/commit/ebb645aad93ca54d0a4bb7398f4eb59c31d7bfae)), closes [#72](https://github.com/cubicecho/agent-core/issues/72)

# [2.6.0](https://github.com/cubicecho/agent-core/compare/v2.5.0...v2.6.0) (2026-09-15)


### Bug Fixes

* start runAgentLoop's usage total with cached at zero ([8ff028c](https://github.com/cubicecho/agent-core/commit/8ff028c43651a9ae0c8fa996b7444288bb8ab224))


### Features

* untrusted() and UNTRUSTED_PREFACE for fencing text nobody vouched for ([fc1b449](https://github.com/cubicecho/agent-core/commit/fc1b44935e0df148a9b188136969b24e3e1e15a1)), closes [#64](https://github.com/cubicecho/agent-core/issues/64)

# [2.5.0](https://github.com/cubicecho/agent-core/compare/v2.4.0...v2.5.0) (2026-09-15)


### Bug Fixes

* latch the no-thinking hints only once dropping them worked ([576b402](https://github.com/cubicecho/agent-core/commit/576b4022d2dfa64fab334e9333a1613d1ca1aee8)), closes [#61](https://github.com/cubicecho/agent-core/issues/61)
* reserve the reply ceiling in runTurn's pre-flight guard ([83ea11d](https://github.com/cubicecho/agent-core/commit/83ea11de992efd0ed34695db1a4d2166b8f25104)), closes [#68](https://github.com/cubicecho/agent-core/issues/68)
* start runAgentLoop's usage total with cached at zero ([7ceaa15](https://github.com/cubicecho/agent-core/commit/7ceaa150d0fc25de226cc250a4a48e6e2e2975c1))


### Features

* agent loop, extraBody latch, and compaction ([#82](https://github.com/cubicecho/agent-core/issues/82)) ([c12137a](https://github.com/cubicecho/agent-core/commit/c12137a204fe94f2418d86176d785693e999f9b5)), closes [#78](https://github.com/cubicecho/agent-core/issues/78) [#80](https://github.com/cubicecho/agent-core/issues/80) [#79](https://github.com/cubicecho/agent-core/issues/79)
* askJson, structured side tasks negotiated through response_format ([f3d148b](https://github.com/cubicecho/agent-core/commit/f3d148bb27dd7b37ef25452160b28d961882ee8f)), closes [#77](https://github.com/cubicecho/agent-core/issues/77)
* export and import latched capabilities across restarts ([b949b9c](https://github.com/cubicecho/agent-core/commit/b949b9c0da5662f58a0e4719366b4ad8dca4f701)), closes [#74](https://github.com/cubicecho/agent-core/issues/74)
* extraBody on ModelParams, and a latch for the fields a model refuses by name ([3532580](https://github.com/cubicecho/agent-core/commit/3532580242def919b92c2ef3e5f728eb74b37413)), closes [#78](https://github.com/cubicecho/agent-core/issues/78)
* repair tool arguments and recover tool calls written as text ([4b6e858](https://github.com/cubicecho/agent-core/commit/4b6e858819abb24d2bcee8986def71ffa4d2fa86)), closes [#75](https://github.com/cubicecho/agent-core/issues/75) [#76](https://github.com/cubicecho/agent-core/issues/76)
* report cached prompt tokens in turn usage ([bd98d18](https://github.com/cubicecho/agent-core/commit/bd98d182870a420e32f9a260802476d9fbf9ed4c)), closes [#62](https://github.com/cubicecho/agent-core/issues/62)
* runAgentLoop, buildBody, preselect, preview and resolveApiKey ([343f161](https://github.com/cubicecho/agent-core/commit/343f161db0835034ad4c9b9c23fc9707cdb04ac0)), closes [#80](https://github.com/cubicecho/agent-core/issues/80)
* tool-result pruning and transcript compaction ([6c80ca0](https://github.com/cubicecho/agent-core/commit/6c80ca03bc012991d1e34d2caa6bbe0d973c8f9c)), closes [#79](https://github.com/cubicecho/agent-core/issues/79)

# [2.4.0](https://github.com/cubicecho/agent-core/compare/v2.3.0...v2.4.0) (2026-09-13)


### Features

* let the hooks' context budget be configured or passed in ([35b0f59](https://github.com/cubicecho/agent-core/commit/35b0f59e80a3d722a822bafdab8ab88b84c2871a))

# [2.3.0](https://github.com/cubicecho/agent-core/compare/v2.2.4...v2.3.0) (2026-09-13)


### Features

* host-side lifecycle hooks, and caches keyed on the whole endpoint ([e10663c](https://github.com/cubicecho/agent-core/commit/e10663ccb0eaaaa11824673e64d26543699f48e6))

## [2.2.4](https://github.com/cubicecho/agent-core/compare/v2.2.3...v2.2.4) (2026-09-07)


### Bug Fixes

* tell a refused temperature from a refused value ([#58](https://github.com/cubicecho/agent-core/issues/58)) ([#60](https://github.com/cubicecho/agent-core/issues/60)) ([f31bfee](https://github.com/cubicecho/agent-core/commit/f31bfee102106d921fd75ef4660819076cc2912c))

## [2.2.3](https://github.com/cubicecho/agent-core/compare/v2.2.2...v2.2.3) (2026-09-07)


### Bug Fixes

* latch produced on what a chunk carried, not on its arrival ([#57](https://github.com/cubicecho/agent-core/issues/57)) ([#59](https://github.com/cubicecho/agent-core/issues/59)) ([fe35c9a](https://github.com/cubicecho/agent-core/commit/fe35c9accdb5d4fd9654ddac919c6aec4c8292f6))

## [2.2.2](https://github.com/cubicecho/agent-core/compare/v2.2.1...v2.2.2) (2026-09-07)


### Bug Fixes

* charge a content part its own envelope ([#55](https://github.com/cubicecho/agent-core/issues/55)) ([#56](https://github.com/cubicecho/agent-core/issues/56)) ([fb75ad8](https://github.com/cubicecho/agent-core/commit/fb75ad8eb9df1ade6bc3b8f30f508a5cc474e634)), closes [#52](https://github.com/cubicecho/agent-core/issues/52)

## [2.2.1](https://github.com/cubicecho/agent-core/compare/v2.2.0...v2.2.1) (2026-09-07)


### Bug Fixes

* count the keys only some messages carry ([#52](https://github.com/cubicecho/agent-core/issues/52)) ([#54](https://github.com/cubicecho/agent-core/issues/54)) ([28c001d](https://github.com/cubicecho/agent-core/commit/28c001d5052bf0093c06f53312e3b2894707840b)), closes [#47](https://github.com/cubicecho/agent-core/issues/47)
* name the model in the no-thinking-hints notice ([#51](https://github.com/cubicecho/agent-core/issues/51)) ([#53](https://github.com/cubicecho/agent-core/issues/53)) ([0437e42](https://github.com/cubicecho/agent-core/commit/0437e42b504e204465ecfaaf067ffd1488130db1))

# [2.2.0](https://github.com/cubicecho/agent-core/compare/v2.1.2...v2.2.0) (2026-09-07)


### Features

* name the model in the notices that are about one ([#43](https://github.com/cubicecho/agent-core/issues/43)) ([#50](https://github.com/cubicecho/agent-core/issues/50)) ([dded90e](https://github.com/cubicecho/agent-core/commit/dded90e3651b5ced9bf4f1b98a1be8b50da73edd))

## [2.1.2](https://github.com/cubicecho/agent-core/compare/v2.1.1...v2.1.2) (2026-09-07)


### Bug Fixes

* let a side task answer what the model refuses ([#45](https://github.com/cubicecho/agent-core/issues/45)) ([#46](https://github.com/cubicecho/agent-core/issues/46)) ([67249ef](https://github.com/cubicecho/agent-core/commit/67249ef7362b42fdcf6f7af6bfa15a0b30157af1))

## [2.1.1](https://github.com/cubicecho/agent-core/compare/v2.1.0...v2.1.1) (2026-09-07)


### Bug Fixes

* tell the effort being refused from the field being refused ([#42](https://github.com/cubicecho/agent-core/issues/42)) ([#44](https://github.com/cubicecho/agent-core/issues/44)) ([a2f14de](https://github.com/cubicecho/agent-core/commit/a2f14de5a787790a25b18094dbbb1a080fd90c4b))

# [2.1.0](https://github.com/cubicecho/agent-core/compare/v2.0.8...v2.1.0) (2026-09-07)


### Features

* negotiate what the model refuses, not only the endpoint ([#38](https://github.com/cubicecho/agent-core/issues/38)) ([#39](https://github.com/cubicecho/agent-core/issues/39)) ([77fd8a0](https://github.com/cubicecho/agent-core/commit/77fd8a0c24572e20c7d68ec122973a776f2e8e4a))

## [2.0.8](https://github.com/cubicecho/agent-core/compare/v2.0.7...v2.0.8) (2026-09-07)


### Bug Fixes

* stop sending the definitions nothing points at any more ([#37](https://github.com/cubicecho/agent-core/issues/37)) ([9ce7111](https://github.com/cubicecho/agent-core/commit/9ce71114d7d2e8bf8ede2723657e501d99aae8e9))

## [2.0.7](https://github.com/cubicecho/agent-core/compare/v2.0.6...v2.0.7) (2026-09-07)


### Bug Fixes

* resolve the union branch that arrives as a reference ([#35](https://github.com/cubicecho/agent-core/issues/35)) ([#36](https://github.com/cubicecho/agent-core/issues/36)) ([f4dfbd8](https://github.com/cubicecho/agent-core/commit/f4dfbd8905880eb2e4f6079191625708005ac862))

## [2.0.6](https://github.com/cubicecho/agent-core/compare/v2.0.5...v2.0.6) (2026-09-07)


### Bug Fixes

* strip the reasoning fence that never opens ([#33](https://github.com/cubicecho/agent-core/issues/33)) ([604edd2](https://github.com/cubicecho/agent-core/commit/604edd21f0d46dc7a7258f7599ca26624126fe75))

## [2.0.5](https://github.com/cubicecho/agent-core/compare/v2.0.4...v2.0.5) (2026-09-07)


### Bug Fixes

* tell a model the call is full instead of calling its name over-broad ([#32](https://github.com/cubicecho/agent-core/issues/32)) ([0c875f5](https://github.com/cubicecho/agent-core/commit/0c875f52db498732f662516845776e0ffe783853))

## [2.0.4](https://github.com/cubicecho/agent-core/compare/v2.0.3...v2.0.4) (2026-09-07)


### Bug Fixes

* do not fail the run that lost the capability race ([#31](https://github.com/cubicecho/agent-core/issues/31)) ([fe46bc1](https://github.com/cubicecho/agent-core/commit/fe46bc1b2d0ad3f8c09deea25544d7d8e7fdb7fd))

## [2.0.3](https://github.com/cubicecho/agent-core/compare/v2.0.2...v2.0.3) (2026-09-07)


### Bug Fixes

* stop deleting event streams something still depends on ([#30](https://github.com/cubicecho/agent-core/issues/30)) ([b838089](https://github.com/cubicecho/agent-core/commit/b8380891fd9e413f7afeff5cb88483c81638212f))

## [2.0.2](https://github.com/cubicecho/agent-core/compare/v2.0.1...v2.0.2) (2026-09-07)


### Bug Fixes

* fold a root anyOf/oneOf in rather than deleting the arguments ([#29](https://github.com/cubicecho/agent-core/issues/29)) ([71b724e](https://github.com/cubicecho/agent-core/commit/71b724e567e57d4908a99bad08a0fb7c1ec34948))

## [2.0.1](https://github.com/cubicecho/agent-core/compare/v2.0.0...v2.0.1) (2026-09-07)


### Bug Fixes

* **events:** release what a stalled watcher drops, and seq the gap inside it ([93a486e](https://github.com/cubicecho/agent-core/commit/93a486e367f91fb2bb4309c13f38e7745f9226d9))

# [2.0.0](https://github.com/cubicecho/agent-core/compare/v1.3.0...v2.0.0) (2026-09-07)


* feat!: v2 API, and stop the event bus scaling badly per token ([f272ab0](https://github.com/cubicecho/agent-core/commit/f272ab07f7f9d1ac9a67942989a2974991f2d088))


### Features

* size a request against an opt-in contextLimit in runTurn ([cfae8fc](https://github.com/cubicecho/agent-core/commit/cfae8fcdc586a0728439649dfaf849fec922a8e9))


### Performance Improvements

* cache relaxTools, and size a request without serialising it ([f81ecda](https://github.com/cubicecho/agent-core/commit/f81ecda6299cc7b12d6b06285bf417095197aaee))


### BREAKING CHANGES

* `reset` is renamed `resetEvents`; `RunEvent.at` is epoch
milliseconds rather than a `Date`; `tryAsk` takes an options argument and
neither it nor `ask` writes to the console — pass `onNotice` to be told;
`LOAD_TOOLS_DEFINITION` is frozen. `Endpoint.requestTimeoutSeconds` becoming
optional is source-compatible for callers and widens the shape for implementors.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MDW8PWYhkMRpZS7D6Wxid8

# [1.3.0](https://github.com/cubicecho/agent-core/compare/v1.2.0...v1.3.0) (2026-09-07)


### Features

* runTurn, the whole turn loop rather than its parts ([c06fb17](https://github.com/cubicecho/agent-core/commit/c06fb1777f10883e79eb39ba9870c557305e3821)), closes [#18](https://github.com/cubicecho/agent-core/issues/18)

# [1.2.0](https://github.com/cubicecho/agent-core/compare/v1.1.0...v1.2.0) (2026-09-07)


### Bug Fixes

* **capabilities:** hand send the produced flag instead of expecting two ([78a3a72](https://github.com/cubicecho/agent-core/commit/78a3a7264118175d4d777a8d846f267545d3ac9d))


### Features

* one call that forgets every cache and latch ([307c486](https://github.com/cubicecho/agent-core/commit/307c486a7a73a96c18ad8d6ad21d85154bac5eed))

# [1.1.0](https://github.com/cubicecho/agent-core/compare/v1.0.0...v1.1.0) (2026-09-07)


### Bug Fixes

* **client:** re-list an endpoint that has not named this model ([8bfd4df](https://github.com/cubicecho/agent-core/commit/8bfd4df895496f85a08e11802529c8916061d897)), closes [#10](https://github.com/cubicecho/agent-core/issues/10)
* **events:** hold the ordering guarantee, and stop leaking streams ([21eabc4](https://github.com/cubicecho/agent-core/commit/21eabc42d077062c8b04df3f566d4220cb3021a4))
* **retry,side-task:** stop two classifiers disagreeing about one error ([75ea65a](https://github.com/cubicecho/agent-core/commit/75ea65a43a5a6d70f380ecff9057c219ceda25aa))
* **schema-compat:** stop losing arguments to the root rewrites ([ab81c6d](https://github.com/cubicecho/agent-core/commit/ab81c6decbc0dea386202ca0d041de835d844640))
* **tool-loading:** budget the whole load call, and drop empty servers ([d6450c4](https://github.com/cubicecho/agent-core/commit/d6450c4f9a2f9fd52fab237dc8af55157d7206c0))


### Features

* **capabilities:** remember what an endpoint refused, per endpoint ([0ae6c09](https://github.com/cubicecho/agent-core/commit/0ae6c098a6ee1f7787a0010e3a70341b5de3e3f2)), closes [#8](https://github.com/cubicecho/agent-core/issues/8) [#9](https://github.com/cubicecho/agent-core/issues/9)
* **stream:** export streamTurn, the loop EndpointSilent was exported for ([fb8fa7c](https://github.com/cubicecho/agent-core/commit/fb8fa7c3d3bf247a2f192e1647e94c794cc58e8e)), closes [#6](https://github.com/cubicecho/agent-core/issues/6) [#7](https://github.com/cubicecho/agent-core/issues/7)

# 1.0.0 (2026-09-07)


### Bug Fixes

* key the no-thinking refusal by endpoint, and only on a 4xx ([bfd49c0](https://github.com/cubicecho/agent-core/commit/bfd49c0ec44b53dea1e7f089abb1954598380031))


### Features

* cover the retry rules and side tasks, and neutralise the prompt wording ([40fc6ed](https://github.com/cubicecho/agent-core/commit/40fc6ed09d51aeb9eebda5c69ee113e865d14f8b))
* extract the shared agent runner from kanban_server, task_server and min-agent ([04a003c](https://github.com/cubicecho/agent-core/commit/04a003ca4789a364800a3c550f0f901fbf2b36d1))

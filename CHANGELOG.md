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

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

# TASK-004 · 双任务重放与演示

ID: TASK-004
Status: BLOCKED
Parent: FEAT-001
Requirements: FR-001、FR-002、AI-001、AC-001、AC-007
Depends on: TASK-003
Parallel group: None
Parallelization class: Sequential
Primary engineer: 项目发起人负责里程碑验收
Agent role/runtime: 本地 Codex 开发者
Agent collaboration pattern: Independent builder
Agent execution size: Small
Expected agent cycles: 预计 1–3 个本地实现与验证回合，按失败证据调整
Execution location: Local
Repository: unirain/codex-orchestration
Base revision: 7784b441860f762ed9e1011f072d3779c3f67043
Branch: work/routing-demo，顺序累积上游修订
Worktree: 相邻目录 codex-orchestration-routing-demo，单写入者
Expected write set: 双任务场景夹具、演示入口与只读证据输出
Protected files/surfaces: 规格、原型 checkout、真实账号凭据、宿主 GitHub 写入
Shared contracts: Trigger ID、Ticket 与 Assignment 标识、SQLite 提交边界及 Assessor/Executor/Channel 端口
Delegation level: D3
Monitoring level: M1
Supervision units: 1（相对任务负担）
Overnight-safe: No
Integration target/owner: 由发起人在完整演示后验收，目标 master
Human checkpoint: GATE-001 完整双任务演示走读

## Objective

让发起人能从三句话复核路由。

## Execution Context

以[规格 v0.46](../../spec.md)和[主计划](../../plan.md)为准。基线上尚无应用测试。实施时核对当前修订及已完成的上游工作。

## Implementation Boundary

写入范围为上列模块。Assessor 与 Executor 的决策在这一阶段由测试输入控制，领域状态由 Engine 和 SQLite 产生。

## Planned Steps

从空库录入主计划中的三条消息；固定模拟 Worker 对消息的接手／交回响应，关联查询真实 Engine 写入的 SQLite 记录；另跑归属含糊的补充。

## Tests and Evals

两张 Ticket、两份不同 Mandate、两次启动请求；第三条追问产生零次新 Eval。含糊追问发出澄清且无猜测出的变更。

## Completion Evidence

一条可重放命令、两张 Ticket 的事件记录和原型测试对照。

## Stop Conditions

如需扩大授权、改变 Mandate 或改变规格所定义的消息归属，保留失败输入并交发起人决定。普通测试失败在本任务范围内自行定位。

## Risks and Escalation

夹具可能掩盖领域错误。分别核对端口观测与持久化结果；真实模型调用、容器和外部写入留给后续阶段。

## Required Handoff

按[执行报告模板](../../../../.agents/skills/plan-readiness/assets/templates/agent-execution-report.md)交接实际修订、改动文件、命令、结果及偏差，供下一任务从同一工作现场续接。

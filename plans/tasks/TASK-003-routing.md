# TASK-003 · 订阅投递与全部交回

ID: TASK-003
Status: BLOCKED
Parent: FEAT-001
Requirements: BR-003、BR-005、BR-006、AI-002、AI-003、AC-006、AC-007、AC-008
Depends on: TASK-002
Parallel group: None
Parallelization class: Sequential
Primary engineer: 项目发起人负责里程碑验收
Agent role/runtime: 本地 Codex 开发者
Agent collaboration pattern: Independent builder
Agent execution size: Medium
Expected agent cycles: 预计 1–3 个本地实现与验证回合，按失败证据调整
Execution location: Local
Repository: unirain/codex-orchestration
Base revision: 7784b441860f762ed9e1011f072d3779c3f67043
Branch: work/routing-demo，顺序累积上游修订
Worktree: 相邻目录 codex-orchestration-routing-demo，单写入者
Expected write set: Engine 的订阅、Disposition、Eval 队列、attach/stop 路由规则和对应测试
Protected files/surfaces: 规格、原型 checkout、真实账号凭据、宿主 GitHub 写入
Shared contracts: Trigger ID、Ticket 与 Assignment 标识、SQLite 提交边界及 Assessor/Executor/Channel 端口
Delegation level: D3
Monitoring level: M1
Supervision units: 2（相对任务负担）
Overnight-safe: No
Integration target/owner: 由发起人在完整演示后验收，目标 master
Human checkpoint: GATE-001 完整双任务演示走读

## Objective

区分仍有负责者的追问与可重新 Eval 的 Trigger。

## Execution Context

以[规格 v0.46](../../spec.md)和[主计划](../../plan.md)为准。基线上尚无应用测试。实施时核对当前修订及已完成的上游工作。

## Implementation Boundary

写入范围为上列模块。Assessor 与 Executor 的决策在这一阶段由测试输入控制，领域状态由 Engine 和 SQLite 产生。

## Planned Steps

按有效订阅交付原文、记录负责者及其交回理由；同一 Thread 的 Eval 串行执行，验证 Policy 版本、只读订阅、交回后禁止附回和 stop 的授权边界。

## Tests and Evals

一位交回而另一位负责时新增 Eval 为零；全部交回后新增一次；重复交回不能二次入队；后到消息留到下一批。旧版本命令不能产生 Ticket。

## Completion Evidence

每个 Trigger 的投递、交回、Decision 与派工计数，以及含糊输入通过 Channel 澄清的记录。

## Stop Conditions

如需扩大授权、改变 Mandate 或改变规格所定义的消息归属，保留失败输入并交发起人决定。普通测试失败在本任务范围内自行定位。

## Risks and Escalation

夹具可能掩盖领域错误。分别核对端口观测与持久化结果；真实模型调用、容器和外部写入留给后续阶段。

## Required Handoff

按[执行报告模板](../../.agents/skills/plan-readiness/assets/templates/agent-execution-report.md)交接实际修订、改动文件、命令、结果及偏差，供下一任务从同一工作现场续接。

# TASK-001 · 建立路由测试入口

ID: TASK-001
Status: READY FOR AGENT
Parent: EN-001
Requirements: DR-001、DR-002、AC-006
Depends on: None
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
Expected write set: 本地 TypeScript 测试入口、测试依赖清单、临时库工厂与三个记录端口
Protected files/surfaces: 规格、原型 checkout、真实账号凭据、宿主 GitHub 写入
Shared contracts: Trigger ID、Ticket 与 Assignment 标识、SQLite 提交边界及 Assessor/Executor/Channel 端口
Delegation level: D3
Monitoring level: M1
Supervision units: 1（相对任务负担）
Overnight-safe: No
Integration target/owner: 由发起人在完整演示后验收，目标 master
Human checkpoint: GATE-001 完整双任务演示走读

## Objective

建立可重复运行的领域测试环境。

## Execution Context

以[规格 v0.46](../../spec.md)和[主计划](../../plan.md)为准。基线上尚无应用测试。实施时核对当前修订及已完成的上游工作。

## Implementation Boundary

写入范围为上列模块。Assessor 与 Executor 的决策在这一阶段由测试输入控制，领域状态由 Engine 和 SQLite 产生。

## Planned Steps

探查 TS 与 SQLite 支持，选用与仓库约束兼容的最小组合；建立两个独立临时库，记录 Assessor、Executor、Channel 收到的载荷与次数。

## Tests and Evals

同一夹具重放两次，断言输入相同、初态为空且两次运行没有共享记录。将可从干净 checkout 执行的确切测试命令写入交接。

## Completion Evidence

可重复执行的命令、运行输出、SQLite 版本与端口记录示例。

## Stop Conditions

如需扩大授权、改变 Mandate 或改变规格所定义的消息归属，保留失败输入并交发起人决定。普通测试失败在本任务范围内自行定位。

## Risks and Escalation

夹具可能掩盖领域错误。分别核对端口观测与持久化结果；真实模型调用、容器和外部写入留给后续阶段。

## Required Handoff

按[执行报告模板](../../../../.agents/skills/plan-readiness/assets/templates/agent-execution-report.md)交接实际修订、改动文件、命令、结果及偏差，供下一任务从同一工作现场续接。

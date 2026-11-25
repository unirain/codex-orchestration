# 本地持续推进的 Codex agent · 实施计划

Type: Project
Version: 0.3
Status: APPROVED — READY TO IMPLEMENT
Specification: [已批准规格](spec.md#human-approval)
Specification version: 0.46
Base revision: 7784b441860f762ed9e1011f072d3779c3f67043

## Planning Objective

从一个入口处理多项开发工作，由宿主管理各 Ticket 的 Worker 并接续已授权工作。首先展示可重复的领域路由，其次验证真实 Codex 会话，再组合后台反馈、交付和重启恢复。

## Approved Inputs and Baseline

发起人于 2026-11-23 批准规格 v0.46。本地仓库基线上有规格、UML 和工作流技能，规格批准记录位于当前工作区。检查时本机 Node 为 v26.13.0。项目尚无依赖清单、构建、测试和迁移命令；TASK-001 产出第一条可复跑的应用测试命令。参考原型修订为 `8c32a9d`。

## System Decomposition

Source/Channel 持有来源对话地址；Engine 管理 Gate、Eval、Mandate、订阅和事务；Assessor 驱动 Main；Executor 管理 Ticket 的 Worker、槽位与测试。宿主保存外部操作回执，以专用账号写 GitHub。[架构图集](../uml/README.md)

## Foundation and Enabler Register

### EN-001 · 领域记录和事务

临时 SQLite、不可变标识和可记录的端口支持业务重放；退出证据为接单失败整体回滚、成功只派工一次。

### EN-002 · Codex 运行协议

验证会话创建与续接、角色工具回调、重复调用、迟到回调和 turn 中断，以 Ticket、Assignment、thread、turn 归属为契约。

### EN-003 · Ticket 执行环境

验证目录准备、固定镜像、服务身份、凭据和网络边界；交付可重建的隔离测试环境。与 EN-002 组合验证真实 Worker。

## Epic and Feature Map

| 功能 | 可独立观察的结果 | 前置 |
| --- | --- | --- |
| EP-001 · 路由 / FEAT-001 | 原 Trigger 的直通、交回、澄清和接单可回溯 | EN-001 |
| EP-002 · 持续执行 / FEAT-002 | 入口重连、单票暂停、测试失败后原 Worker 接续 | EP-001、EN-002、EN-003 |
| EP-003 · 交付与恢复 / FEAT-003 | 验证 PR 归属、授权、收尾和丢失回执后的恢复 | FEAT-002 |

### FEAT-001 · 双任务路由

原型的领域模型、接收逻辑和 Eval 可以与执行器分开阅读。先验收路由，可以单独定位订阅扇出、全部交回和原子接单的问题。真实 Codex 回调、容器重建及凭据隔离是本地适配，前一阶段的测试替身无法验证它们。[规格中的原型对照](spec.md#2026-11-20-原型对照复盘) · [架构图集](../uml/README.md)

2026-11-23，项目发起人选择 A，确认先展示同一入口下的两项工作正确分流，再验证真实 Codex Worker。原型测试向真实 Engine 注入可控的 Assessor 和 Executor，可分别观察评估、启动和投递次数。本项目用同样的方法验证路由，同时用临时 SQLite 数据库观察真实接单事务的提交与回滚。[原型 Engine 测试](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9d/tests/core-engine.spec.ts#L20) · [原型多 Worker 交回测试](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9d/tests/followups.spec.ts#L80)

## Dependency Graph and Critical Path

首个里程碑依次执行 TASK-001 → TASK-002 → TASK-003 → TASK-004。领域回归通过后，将同一组标识接入 EN-002 和 EN-003；真实回调与隔离证据齐备后才能把关闭终端后的修复归因于原 Worker。取得可验证的 GitHub 身份之后，再验证重启时找回在途写入。依据这些前置条件安排先后，当前没有可据以估计工期的实测时长。

## Phase Plan and Gates

| 阶段 | 前置依赖与交付物 | 如何判断通过 |
| --- | --- | --- |
| PHASE-001 · 工作归属 | 建立 EN-001，即领域标识、SQLite 接单事务和提交后执行的 Effects。用可控的 Assessor 与 Executor 验证 EP-001 消息路由。 | GATE-001：同一来源 Thread 先提 follow up 再提邮件 bug。保留原 Trigger，全部负责者交回后才重新 Eval；重复 accept 和事务回滚均不会留下第二次派工。核对 AC-001、006、007 的领域记录。 |
| PHASE-002 · Codex 执行边界 | EN-002 验证真实 App Server 的动态工具、thread/turn 绑定与 resume；EN-003 验证每 Ticket 容器内的源码、服务身份和网络边界。两项取证可以提前准备，接入真实业务状态依赖 EN-001 的稳定标识。 | GATE-002：两张 Ticket 的工具回调可正确归属；旧 Assignment 的迟到回调被拒绝；替换容器可续接原 thread；项目命令不能取得或借用模型身份。核对 AC-016、028、043、044。隔离布局若无法满足规格，提交证据并返回规格评审。 |
| PHASE-003 · 终端离线后接续 | EP-002 串起终端、常驻后台、槽位、测试结果和 Worker。依赖 GATE-001 与 GATE-002。 | GATE-003：关闭终端后让邮件测试失败，只唤醒原 Worker；另一次在测试结束前暂停，则只留下结果。重连能从原 Thread 查到两张 Ticket 的不同进展。核对 AC-002、004、012、015、030。 |
| PHASE-004 · 交付、恢复与收尾 | EP-003 接入宿主专用 GitHub 身份、PR 写入与轮询、后台重启及回执对账。真实组合验收依赖 GATE-003、独立测试仓库和已验证的专用账号。 | GATE-004：在独立仓库制造“PR 已创建、回执丢失”，重启后找回同一个 PR，合并并完成在途工作后只通知一次；撤销授权后不得重发写入。核对 AC-010、034 至 037、046。 |

## Parallel Workstreams

首阶段四个任务共用标识、事务和端口，按序改动同一工作树。后续 EN-002 协议夹具和 EN-003 镜像配置可各自准备，实际连接、权限校验和运行证据必须在同一个已识别的测试环境合并验证。

## Engineer and Agent Capacity

每次由一个本地开发代理写入，项目发起人负责演示验收及是否集成。首个里程碑只占用一次常规人工走读。此安排可在一个工作树内完成，不要求发起人分配多个 session。尚无并行审阅、人手或夜间执行容量的实测依据；计划按串行排程。

## Execution Orchestration

| 任务 | 依赖 | 交付与判据 |
| --- | --- | --- |
| [TASK-001](plans/tasks/TASK-001-harness.md) · 建立路由测试入口 | 无 | 建立最小 TypeScript 测试入口、临时数据库和可控的 Assessor、Executor、Channel。记录每次 Candidate、启动、Input 投递和回执；同一输入序列可重放。 |
| [TASK-002](plans/tasks/TASK-002-accept.md) · 实现原子接单 | TASK-001 | 对首条明确请求，Engine 经 Gate 和 Eval 接受后，一次提交 Decision、Mandate、Ticket、首个 Assignment、Subscription 和待执行操作。重放不重复派工；模拟事务失败后查不到部分记录，Executor 与 Channel 均未被调用。对应 BR-004、DR-002、AC-006。 |
| [TASK-003](plans/tasks/TASK-003-routing.md) · 实现订阅直通与交回 | TASK-002 | 原文先按有效订阅投递；有负责者时不启动 Eval，全部交回后同一个 Trigger 只评估一次。旧 Policy 的迟到决定无效；禁止 attach 回交还该消息的 Ticket。对应 BR-003、BR-005、AC-006、AC-007。 |
| [TASK-004](plans/tasks/TASK-004-replay.md) · 重放双任务并出示证据 | TASK-003 | 用下述消息运行完整流程；从 SQLite 记录和端口调用记录交叉核对每次投递、Eval 与启动。另测归属含糊时向用户澄清。对应 AC-001、AC-007 的领域行为。 |

演示从空库开始。① 输入「调整 follow up」，应出现 Ticket A 和一次 Worker 启动请求。② 输入「修一下发送邮件的 bug」，A 交回，保留同一条 Trigger，接单后出现 Ticket B 和第二次启动请求。③ 输入「刚才的 follow up，先改触发条件」，两张 Ticket 都订阅了默认 Thread；让 B 交回而 A 接手，验证系统没有为这条追问开启 Eval，也没有发出第三次启动请求。每一步都能顺着 Trigger ID 查到负责者和处理理由。真实 Worker 的创建和续接由 GATE-002 取证。

## Integration and Assembly

首阶段以短期分支 `work/routing-demo` 和相邻工作树 `codex-orchestration-routing-demo` 累积四项改动，每项完成后交接经过验证的修订。代码、数据库格式或端口契约发生漂移时，先重跑受影响的回归。GATE-001 汇总运行后由发起人走读并决定集成；后续阶段在前一阶段证据就绪时细化工作包和写入范围。

## Quality and Evidence

使用同一原始输入对比 SQLite 事实与端口调用；用可控时钟区分 turn 重试、后台等待与 PR 轮询。真实运行保留脱敏的 Ticket、Assignment、thread、turn、测试、提交和 PR 标识；发版按下表逐条回查证据。领域测试替身只能覆盖 AC-001 的路由部分，其真实会话和终端体验在后续阶段补验。

## Environments, Rollout, and Recovery

依次使用临时 SQLite、专用 Linux 测试容器、独立 GitHub 测试仓库。首次试用记录版本、镜像和基线提交。停止旧实例、保存一致备份后才能升级 SQLite 格式；回退用兼容程序和对应备份，恢复前先核对已生效的远端动作。出现跨票执行、越权、泄密或重复交付时立即停止试用，保留脱敏证据和工作目录。

## Risks, Assumptions, and Blockers

真实服务的会话重建、动态工具、凭据隔离和代理出网策略仍待验证。密钥仅提供给受保护的服务身份，用测试标记核对日志、子进程和工具返回。无法满足已批准的隔离边界时，将失败证据交发起人并回到规格评审。目标镜像、模型身份与独立测试仓库在进入相应验收前提供。当前只具备规划证据。

## Requirement Traceability

以下映射覆盖全部首版验收。每行列出工作项、证据与汇入的里程碑；各 AC 对应的精确需求和通过条件见[规格验收场景](spec.md#acceptance-scenarios)。

| 工作项 / 验收点 | 规格验收 | 对应需求 | 完成与发版证据 |
| --- | --- | --- | --- |
| TASK-002、TASK-003、TASK-004；FEAT-002 / GATE-001、GATE-003 | AC-001、AC-005、AC-006、AC-007、AC-008、AC-009 | AI-001、AI-002、AI-003、BR-001、BR-003、BR-004、BR-005、BR-006、BR-007、DR-002、FR-001、FR-002、FR-006、SEC-002、SEC-003 | 路由轨迹、不可变 Mandate、事务回滚、stop 和重新唤醒资格；最终以真实终端重连核对两张工单。 |
| EN-002 / GATE-002 | AC-016、AC-017、AC-018 | AI-003、AI-004、AI-005、IR-004、IR-005、OBS-002、SEC-005 | 回调重放与过期 Assignment、模型选择、断线及有限重试的实际事件。 |
| EN-003 / GATE-002 | AC-013、AC-014、AC-021、AC-022、AC-027、AC-028、AC-029、AC-043、AC-044 | AI-005、DR-006、FR-004、FR-007、FR-008、FR-009、IR-002、IR-006、IR-008、IR-011、SEC-004、SEC-006、SEC-007、SEC-008、SEC-009、SEC-012、SEC-013 | 准备目录、Git 基线、主机与端口、容器重建、密钥标记；对依赖暂停或恢复的子场景在 GATE-003、GATE-004 再验。 |
| FEAT-002 / GATE-003 | AC-002、AC-004、AC-011、AC-012、AC-015、AC-023、AC-026 | AI-001、BR-008、BR-009、DR-001、DR-003、FR-003、FR-004、FR-007、IR-001、IR-002、IR-003、IR-004、NFR-001、NFR-002、NFR-003、NFR-004、OBS-001 | 保存原 thread 的接续、暂停和槽位轨迹；覆盖无新验证依据的阻塞及 30 分钟测试等待。 |
| FEAT-002 / GATE-003 | AC-019、AC-020、AC-030、AC-031、AC-032、AC-042 | AI-005、DR-002、DR-003、DR-004、FR-003、FR-006、FR-010、FR-011、IR-010、OBS-003、OBS-004、SEC-004、SEC-011 | 可重放的双终端连接、鉴权拒绝、显式停机、按测试运行查询的摘要和用量去重记录。 |
| FEAT-003 / GATE-004 | AC-003、AC-010、AC-033、AC-034、AC-039、AC-040 | BR-002、FR-003、FR-005、FR-012、IR-007、IR-009、SEC-001、SEC-003、SEC-004、SEC-010 | 对照测试仓库核实草稿、ready、自建 PR 集合、撤权后的部分回执、实际专用账号和唯一结束通知。 |
| FEAT-003、FEAT-002 / GATE-004 | AC-035、AC-036、AC-037、AC-038、AC-041、AC-045 | AI-005、BR-004、BR-006、DR-004、DR-005、DR-007、FR-007、FR-008、FR-012、FR-013、IR-007、IR-008、NFR-004、SEC-001 | 冷启动重放、中断时刻、合并事实、时钟记录、原工作目录及完整账目；逐条保留对账前后差异。 |
| EP-003 / GATE-004 | AC-046 | FR-002、FR-003、FR-005、FR-012、IR-003、IR-007、OBS-001 | 在独立仓库从两条消息跑到离线修复、PR 回执丢失、重启及合并。核对唯一 PR、唯一结束通知。 |

AC-024、AC-025 随 BR-010、BR-011 延期。发版复核全部 44 项有效验收，任何分阶段取得的部分证据都需补齐。

## Ready Queue

2026-11-25 已核对审批基线。TASK-001 已进入 READY FOR AGENT；TASK-002 至 TASK-004 按序等待直接上游的修订、测试命令和证据。清单中的后续功能在对应阶段入口细化。

## Human Checkpoints

2026-11-23，发起人第一次选择 A 确认领域路由优先；第二次选择 A 确认首阶段集中在完整双任务演示走读，常规任务之间由开发代理按证据自行衔接。规格例外、外部写入与真实身份的启用仍在各自工作范围和授权下处理。

## Plan Readiness

状态为 APPROVED — READY TO IMPLEMENT。按项目量表，输入、仓库、分解、依赖、写入与集成、监督容量、验收、恢复、人控依次评为 4/4/3/4/4/3/4/3/3（每项满分 4），加权 91.25/100。后续阶段以功能和验收为粒度，在前置证据就绪后拆成执行任务。发起人已确认单写入者和完整演示后的集成审阅安排。

## Human Approval

- Decision: Approved
- Approver: 项目发起人
- 审批对象为计划 v0.3、规格 v0.46、仓库基线 7784b441860f762ed9e1011f072d3779c3f67043。
- Approval evidence: 2026-11-25（Asia/Shanghai），项目发起人针对上述计划、规格和基线回复「批准计划」。

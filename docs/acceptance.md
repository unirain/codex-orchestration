# 首版验收证据

依据[规格 v0.46](../spec.md#acceptance-scenarios)。表中的「实测」标明实际使用的运行环境，「受控」表示该用例所需的时间、消息或故障由测试提供。「部分」说明还有条件缺少证据。AC-024、AC-025 已在规格中后置，首版共有 44 项有效验收。

## 复跑环境

2026-11-25 的独立审查使用本机 Node 26.13、SQLite、Git、Codex App Server 0.171.0 和本地 Colima 镜像。以下命令运行真实 CLI、真实容器及真实 App Server 的本地 Responses 夹具。真实模型行为和额度错误的补充验收见下文。真实 GitHub 操作、回执丢失和模型续接的记录另见[独立仓库验收](acceptance/ac-046.md)。

```sh
env -u CODEX_LIVE_DEEPSEEK -u ORCH_DEEPSEEK_LIVE \
  CODEX_TEST_BIN=/absolute/path/to/codex-0.171.0 \
  ORCH_TEST_IMAGE=orch-local/codex-node:0.171.0 npm test
```

在宿主修订 3fcdf53 加入本次审查用例后，上述组合共注册 68 项测试，66 项通过，2 项真实 DeepSeek 选测跳过，0 项失败。

## 真实模型判断与角色绑定

在受审分支上使用 Codex 0.171.0、同版本镜像及专用 DeepSeek 凭据运行以下四项补充用例，2026-11-25 两轮独立运行均为 4/4 通过。AC-032 的额度错误由本地协议服务注入，终端与宿主走实际代码路径。

```sh
ORCH_DEEPSEEK_LIVE=1 CODEX_TEST_BIN=/absolute/path/to/codex-0.171.0 \
  ORCH_TEST_IMAGE=orch-local/codex-node:0.171.0 node --test \
  tests/audit-models.test.ts tests/audit-stalled-model.test.ts tests/audit-limit.test.ts
```

- AC-017：第二轮中初始 Main `01a210e7-dc3b-7593-9416-e7b69252391e` 与 Worker A `01a210e7-e0e3-7b11-ab34-cf1f72682c03` 使用 deepseek-flash。完成各自的受控任务后关闭服务并重连，仍得到原 thread ID 和模型。配置角色覆盖后新 Worker B `01a210e7-f48c-7930-9d3f-0ae26c2d638e` 与独立绑定中的新 Main 均得到 deepseek-v4-pro。
- AC-023：隔离容器中每个场景均先执行三次退出码为 1 的邮件诊断。出现连接池耗尽的新证据时，真实 Worker 在 turn `01a210e7-e20d-7ac2-a8a9-3ed96fc268cc` 请求并运行低/高并发对比，验证通过。只有重复失败且缺少上游事务 ID 时，另一个 Worker 在 turn `01a210e7-f1fe-7053-b274-22f193050a70` 报告 blocked，列出尝试、询问 SMTP 事务 ID 和供应商跟踪记录，Ticket 进入暂停。两种场景仅开放已授权的工作目录与只读探针。
- AC-032：首次 turn 完成后后台失败结果唤醒同一 Worker。在第二个 turn 已开始后，提供方为首个 turn 补发两份相同的累计用量并返回硬额度错误。CLI 的 `status` 显示对应 Ticket 暂停和额度原因，`show` 显示 61 tokens，Main 单列 5 tokens，宿主未登记自动重试。

原型提供了检验追问归属、多个 Worker 交回、依照 PR 事实收尾的领域规则。运行在此仓库的测试使用本项目 Engine 和 SQLite。表中引用的 App Server、Docker、回环终端、宿主 gh 凭据隔离及恢复回执属于本地适配的验证范围。

## 验收矩阵

| 用例 | 核实到的行为及边界 | 证据 |
| --- | --- | --- |
| AC-001 | 三条消息得到两张 Ticket，追问触发零次新 Eval 和零次启动。含糊输入得到澄清。独立仓库用两个真实 Worker 验证新目标的交回与接单。 | [重放](../tests/replay.test.ts) · [澄清](../tests/host-tools.test.ts) · [实际会话](acceptance/ac-046.md) |
| AC-002 | 终端命令退出后，邮件测试延后失败，原 Worker 在同一 thread 修复并复测。记录只有两条人的 Trigger。 | [实际会话及运行结果](acceptance/ac-046.md) |
| AC-003 | 真实本地 Git 和受控远端上保存 draft，更新同一 PR 并标记可评审。撤权后保留已推送回执。真实仓库另有可评审 PR。 | [草稿与更新](../tests/audit-history.test.ts) · [撤权](../tests/delivery.test.ts) · [实测交付](acceptance/ac-046.md) |
| AC-004 | 真实两个 Worker 场景确认邮件 turn 终止、已启动测试在暂停期间以失败收尾，另一票继续推进；用户继续后在原 thread 上开新 turn。 | [真实暂停](../tests/host-live-pause.test.ts) · [调度竞争](../tests/supervision.test.ts) |
| AC-005 | 测试结果作为 note 关联原 Assignment，非授权来源无法发起接单。受控输入覆盖伪装成任务的测试输出；真实后台结果另有 AC-002 记录。 | [接单门槛](../tests/accept.test.ts) · [反馈事务](../tests/supervision.test.ts) |
| AC-006 | 实际 SQLite 提交前故障整体回滚，重复 accept 返回原决定。旧 Policy 及后到消息按批次分别处理。 | [原子接单](../tests/accept.test.ts) · [串行 Eval](../tests/routing.test.ts) |
| AC-007 | 同一 Trigger 扇出给两张 Ticket。全部负责者交回后只重新 Eval 一次，不能附回已交还该消息的 Ticket。 | [订阅与交回](../tests/routing.test.ts) |
| AC-008 | 已结束工单获准时复用原 Mandate；Policy 不再准入或用户 stop 时保持 ended。仓库撤权独立阻止后续写入。 | [授权复核](../tests/routing.test.ts) · [交付门槛](../tests/delivery.test.ts) |
| AC-009 | 真实 CLI 从不同 cwd 连接同一端点与默认 Thread；独立仓库的 A、B 使用各自目录与会话。两张工单明确追问的分配由重放验证。 | [跨目录 CLI](../tests/audit-host.test.ts) · [双工单](../tests/replay.test.ts) · [工作目录证据](acceptance/ac-046.md) |
| AC-010 | 受控远端在推送后撤权，宿主保留推送收据并阻止建 PR；真实容器测试检查项目身份和宿主凭据入口。 | [撤权](../tests/delivery.test.ts) · [容器](../tests/executor-container.test.ts) |
| AC-011 | 用真实 SQLite 预留 3 个普通槽位，只允许已有空闲工单的人工唤醒到第 4 槽，人工队列优先。 | [并发与排队](../tests/supervision.test.ts) |
| AC-012 | 暂停期间确认目标 turn 终止后即释放槽位，已启动测试在槽外收尾，完成事件不触发新执行。 | [暂停竞争](../tests/supervision.test.ts) |
| AC-013 | 空目录、并发准备、Git 目录复用、空目录失败清理及非空现场保留用真实文件系统验证；准备命令 10 分钟超时属于代码配置，本次未实际等待到期。 | [准备及失败](../tests/executor-workspace.test.ts) |
| AC-014 | 真实本地 Git 远端 HEAD 指向 trunk；使用远端提交创建 Ticket 分支及私有 git 元数据，未提交的操作者工作区改动保留。PR 基线写入交付引用。 | [仓库与基线](../tests/executor-workspace.test.ts) |
| AC-015 | 真实 DeepSeek 邮件 Worker 的 thread 为 `01a210e4-9eb2-79a2-8eb6-134a32a978b8`，暂停中断了 `01a210e4-9f06-7702-a71e-96da87b89b62`，后续接续 `01a210e4-c4a9-7a03-89e2-96acfa155271`。另一张 Ticket 独立继续。 | [真实两票暂停](../tests/host-live-pause.test.ts) · [离线反馈](acceptance/ac-046.md) |
| AC-016 | 模拟跨角色及迟到回调，用实际 SQLite 检查报告归属和重放；真实 Codex + 本地 Responses 验证动态工具、Input 标识及续接。 | [领域工具](../tests/host-tools.test.ts) · [协议](../tests/codex-real.test.ts) |
| AC-017 | 已核对实际新建 Main、Worker A、覆盖后的 Worker B 和新 Main；恢复旧会话仍使用原 ID、模型与记录的选择来源。 | [实际进程和容器](../tests/audit-models.test.ts) |
| AC-018 | 启动前明确过载按 15/30/60 秒同模型重试，耗尽后可查询原因。真实 App Server 测试中启动回执丢失后重新连接、核对并观察原活动 turn；宿主重启的替换 Assignment 路径单独测试。 | [启动前重试](../tests/host-controls.test.ts) · [连接恢复](../tests/host-reattach.test.ts) · [容器传输](../tests/executor-container.test.ts) · [重启](../tests/host-recovery.test.ts) |
| AC-019 | 实际 SQLite 分别保留失败与复测摘要，用测试标记验证命令和失败片段脱敏、字节截断及 UTF-8 边界。 | [运行记录](../tests/supervision.test.ts) |
| AC-020 | 时间推进到一年后、重新开库仍可查询；清理一张工单后历史摘要与另一张工单的片段保留。 | [定向清理](../tests/supervision.test.ts) · [重启回查](../tests/audit-history.test.ts) |
| AC-021 | 容器通过获准本地模拟包源，未获准目标被拒；受控故障测试显示 blocked/具体问题。依赖阻塞到用户处理的真实模型对话尚未单独实测。 | [容器与代理](../tests/executor-container.test.ts) · [报告](../tests/host-tools.test.ts) |
| AC-022 | 真实容器与本地 TLS 测试服务按完整主机及端口授权，测试重定向、CONNECT、子域及通配规则。 | [TLS 包源](../tests/executor-container.test.ts) · [网络规则](../tests/executor-network.test.ts) |
| AC-023 | 实际运行两组各三次失败，调用真实 DeepSeek 判断下一步，分别观察到有区分力的复测和列出所需信息后暂停。 | [模型行为](../tests/audit-stalled-model.test.ts) · [持久记录](../tests/supervision.test.ts) |
| AC-024 / AC-025 | 逐 Ticket 配额与预算宽限在 v0.46 后置。 | [规格](../spec.md#llm-and-model-strategy) |
| AC-026 | 使用可控时钟从 turn 结束开始算 30 分钟；重开 turn/暂停撤销旧窗口，重复终态不误释放当前槽位。实际进程终止另有 Docker 证据。 | [计时](../tests/supervision.test.ts) · [实际取消](../tests/executor-container.test.ts) |
| AC-027 | 两张真实隔离容器验证另一 Ticket、外部符号链接和宿主接口无法访问；受保护的内置工具另有真实模型选测。跨全部文件读取路径、用户主动提供片段后继续的完整模型上下文仍需单列验证。 | [源码隔离](../tests/executor-container.test.ts) |
| AC-028 | 实际 Docker 并发验证不同文件、凭据、网络和取消；用实际 SQLite 验证暂停的作业能收尾。 | [容器](../tests/executor-container.test.ts) · [暂停](../tests/supervision.test.ts) |
| AC-029 | 两个容器运行相同固定镜像；缺失镜像启动失败，Ticket 工作目录保留；测试记录含镜像身份。 | [环境](../tests/executor-container.test.ts) · [摘要](../tests/supervision.test.ts) |
| AC-030 | 两个真实 CLI 进程从不同 cwd 同时启动，连到同一常驻进程。受控 Main 建一张 Ticket、一个首个 Assignment，之前的客户端退出后仍可查询。真实后台接续见 AC-002。 | [并发启动](../tests/audit-host.test.ts) · [退出入口后接续](acceptance/ac-046.md) |
| AC-031 | Host.close 对两个 Worker 和 Main 发出中断并等待确认，终止测试；重开 SQLite 核对排队 Input、测试状态和未提交现场。此用例替换会话及后台进程端口。 | [宿主停机](../tests/audit-stop.test.ts) · [实际容器进程](../tests/executor-container.test.ts) |
| AC-032 | 实际宿主在用量尚未到达时接续原工作，CLI 可分别查询 Main/Worker 用量；相同迟到快照仅计一次，提供方硬额度错误显示影响范围与暂停原因。 | [真实 CLI 与受控额度事件](../tests/audit-limit.test.ts) · [用量归属](../tests/supervision.test.ts) |
| AC-033 | 两个自建 PR 和一个上下文 PR，正反两种关闭顺序得出相同结局；没有自建 PR 时等全部跟踪 PR。重复事实只产生一次结束。 | [多 PR 生命周期](../tests/audit-pr.test.ts) |
| AC-034 | 已接手人工追问时先记下 merged、Ticket 保持 open，收尾后才结束；保存真实关闭时间并发送一次对应 Ticket 的通知。GitHub 事实由夹具提供。 | [延迟结束](../tests/audit-pr.test.ts) · [终端事件](../tests/host-controls.test.ts) |
| AC-035 | 实际 SQLite 验证 pending/运行中/等待/待评审/受阻/失败/暂停、输入回执与重复扫描；真实独立仓库重启保留 A 的等待状态并接续 B。 | [恢复矩阵](../tests/host-recovery.test.ts) · [真实重启](acceptance/ac-046.md) |
| AC-036 | 真实独立仓库写入成功后丢失回执；重启找回原 PR。未知写入与撤权限制另有受控测试。 | [实测时间线](acceptance/ac-046.md) · [交付日志](../tests/delivery.test.ts) |
| AC-037 | 重新实例化轮询器后补收关闭事实；临时失败、去重、只查绑定号码及重复重启均有断言。GitHub 读取用受控远端。 | [轮询与恢复](../tests/audit-pr.test.ts) |
| AC-038 | 普通 60 秒、GitHub 指定 120 秒、Worker 的 15/30/60 秒、测试等候 30 分钟分别验证。gh 子进程测试保留产生错误的原响应头。 | [HTTP 响应](../tests/audit-github.test.ts) · [轮询](../tests/audit-pr.test.ts) · [重试](../tests/codex-session.test.ts) · [测试计时](../tests/supervision.test.ts) |
| AC-039 | gh 子进程验证实际账号、仓库及 push 权限；错误作者不允许绑定。错误分支、跨 fork 和已由另一开放 Ticket 占用的 PR 均被拒绝。 | [账号与权限](../tests/audit-github.test.ts) · [分支及占用](../tests/audit-history.test.ts) · [作者](../tests/delivery.test.ts) |
| AC-040 | 专用 gh 入口的临时退出登录、错误身份及个人环境变量隔离由子进程验证。独立仓库的真实 PR 使用发起人明确批准的本机 unirain 登录做验收；生产专用账号仍需独立配置。 | [CLI 鉴权](../tests/audit-github.test.ts) · [真实 PR](acceptance/ac-046.md) |
| AC-041 | 真实 Git 的保留、用户清理后对原分支提交的核实，与会话恢复及原 Mandate 的复用分别验证。 | [工作目录](../tests/executor-workspace.test.ts) · [重新唤醒](../tests/routing.test.ts) · [清理后历史](../tests/audit-history.test.ts) |
| AC-042 | 实际回环 HTTP 校验本地凭据；缺失/错误凭据未调用宿主处理器。两个 CLI 的有效凭据可暂停和恢复同一张 Ticket。 | [管理端点](../tests/host-server.test.ts) · [CLI](../tests/audit-host.test.ts) |
| AC-043 | 真实 Ticket 容器隔离、受保护的模型身份、持久卷与原 thread 续接均有实测；替换容器接续同一工作，历史缺失时返回恢复阻塞。 | [Docker 和真实 Worker](../tests/executor-container.test.ts) · [协议](../tests/codex-real.test.ts) · [投递对账](../tests/host-recovery.test.ts) |
| AC-044 | 使用真实 Worker 成功执行授权命令，换入无效测试密钥后 turn 失败，文件未变化；换回服务凭据恢复原 thread，只产生一次追加。宿主记录的 Input 与已成功的远端写入分别通过历史核对和 PR 收据测试复核。 | [密钥失效与恢复](../tests/executor-container.test.ts) · [已送达 Input](../tests/host-recovery.test.ts) · [远端回执](acceptance/ac-046.md) |
| AC-045 | 实际宿主 SQLite、Git 与受控远端建立 PR 回执。清理目录和失败片段、关闭并重开宿主后，trace 按原 Trigger 回溯 Decision、Mandate、Assignment、历次报告、PR 和清理标记。重复 Trigger 未开新单。 | [跨重启 trace](../tests/audit-history.test.ts) |
| AC-046 | 独立仓库已取得真实双 Ticket、离线失败自动修复、复测通过、PR 创建与回执丢失后的同 PR 对账。审查时只读 GitHub 查询显示 PR #1 仍 open；合并后唯一 ended/merged 终端结果仍待实际观察。 | [运行标识与 PR](acceptance/ac-046.md) |

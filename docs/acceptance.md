# 首版验收证据

依据[规格 v0.46](../spec.md#acceptance-scenarios)。表中的「实测」标明实际使用的运行环境，「受控」表示该用例所需的时间、消息或故障由测试提供。「部分」说明还有条件缺少证据。AC-024、AC-025 已在规格中后置，首版共有 44 项有效验收。

## 复跑环境

2026-11-25 的独立审查使用本机 Node 26.13、SQLite、Git、Codex App Server 0.171.0 和本地 Colima 镜像。以下命令运行真实 CLI、真实容器及真实 App Server 的本地 Responses 夹具。它不会启用两个需要真实模型服务的选测。真实 GitHub 操作、回执丢失和模型续接的记录另见[独立仓库验收](acceptance/ac-046.md)。

```sh
env -u CODEX_LIVE_DEEPSEEK -u ORCH_DEEPSEEK_LIVE \
  CODEX_TEST_BIN=/absolute/path/to/codex-0.171.0 \
  ORCH_TEST_IMAGE=orch-local/codex-node:0.171.0 npm test
```

在宿主修订 3fcdf53 加入本次审查用例后，上述组合共注册 68 项测试，66 项通过，2 项真实 DeepSeek 选测跳过，0 项失败。

原型提供了检验追问归属、多个 Worker 交回、依照 PR 事实收尾的领域规则。运行在此仓库的测试使用本项目 Engine 和 SQLite。表中引用的 App Server、Docker、回环终端、宿主 gh 凭据隔离及恢复回执属于本地适配的验证范围。

## 验收矩阵

| 用例 | 核实到的行为及边界 | 证据 |
| --- | --- | --- |
| AC-001 | 三条消息得到两张 Ticket，追问触发零次新 Eval 和零次启动。含糊输入得到澄清。独立仓库用两个真实 Worker 验证新目标的交回与接单。 | [重放](../tests/replay.test.ts) · [澄清](../tests/host-tools.test.ts) · [实际会话](acceptance/ac-046.md) |
| AC-002 | 终端命令退出后，邮件测试延后失败，原 Worker 在同一 thread 修复并复测。记录只有两条人的 Trigger。 | [实际会话及运行结果](acceptance/ac-046.md) |
| AC-003 | 真实本地 Git 和受控远端上保存 draft，更新同一 PR 并标记可评审。撤权后保留已推送回执。真实仓库另有可评审 PR。 | [草稿与更新](../tests/audit-history.test.ts) · [撤权](../tests/delivery.test.ts) · [实测交付](acceptance/ac-046.md) |
| AC-004 | 经真实 CLI 发起暂停和继续；受控两个 Worker 中，暂停等待目标 turn 终止，另一工单可占槽继续。前一测试收尾不唤醒，继续后只消费一次。 | [CLI](../tests/audit-host.test.ts) · [调度](../tests/supervision.test.ts) |
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
| AC-015 | 真实邮件 Worker 在原 thread 上自动接续；定向 interrupt 与终态回执以协议夹具验证；两张实际工单期间的整条暂停竞争未单独做真人模型试验。 | [实际接续](acceptance/ac-046.md) · [中断协议](../tests/codex-session.test.ts) · [暂停](../tests/supervision.test.ts) |
| AC-016 | 模拟跨角色及迟到回调，用实际 SQLite 检查报告归属和重放；真实 Codex + 本地 Responses 验证动态工具、Input 标识及续接。 | [领域工具](../tests/host-tools.test.ts) · [协议](../tests/codex-real.test.ts) |
| AC-017 | 宿主设置角色模型后保留既有会话绑定；App Server 返回实际模型，DeepSeek 角色模型配置有选测。单一用例中对两个角色分别覆盖、再创建和续接三张真实会话的全组合仍需取证。 | [宿主管理](../tests/host-controls.test.ts) · [会话](../tests/codex-real.test.ts) |
| AC-018 | 宿主已测启动前明确拒绝的 15/30/60 秒重试与耗尽记录、丢失启动回执后根据历史判定、拒绝无法核实的重发。完整验收还需区分宿主重启与仅连接中断，并在活跃旧 turn 上继续观察。 | [启动前重试](../tests/host-controls.test.ts) · [协议故障](../tests/codex-session.test.ts) · [对账](../tests/host-recovery.test.ts) |
| AC-019 | 实际 SQLite 分别保留失败与复测摘要，用测试标记验证命令和失败片段脱敏、字节截断及 UTF-8 边界。 | [运行记录](../tests/supervision.test.ts) |
| AC-020 | 时间推进到一年后、重新开库仍可查询；清理一张工单后历史摘要与另一张工单的片段保留。 | [定向清理](../tests/supervision.test.ts) · [重启回查](../tests/audit-history.test.ts) |
| AC-021 | 容器通过获准本地模拟包源，未获准目标被拒；受控故障测试显示 blocked/具体问题。依赖阻塞到用户处理的真实模型对话尚未单独实测。 | [容器与代理](../tests/executor-container.test.ts) · [报告](../tests/host-tools.test.ts) |
| AC-022 | 真实容器与本地 TLS 测试服务按完整主机及端口授权，测试重定向、CONNECT、子域及通配规则。 | [TLS 包源](../tests/executor-container.test.ts) · [网络规则](../tests/executor-network.test.ts) |
| AC-023 | 三轮失败后仍能继续，明确报告已无可验证方向后暂停。真实邮件任务验证了从一次失败自行修复；连续三轮识别新证据的模型判断仍仅有受控证据。 | [反馈与阻塞](../tests/supervision.test.ts) · [真实修复](acceptance/ac-046.md) |
| AC-024 / AC-025 | 逐 Ticket 配额与预算宽限在 v0.46 后置。 | [规格](../spec.md#llm-and-model-strategy) |
| AC-026 | 使用可控时钟从 turn 结束开始算 30 分钟；重开 turn/暂停撤销旧窗口，重复终态不误释放当前槽位。实际进程终止另有 Docker 证据。 | [计时](../tests/supervision.test.ts) · [实际取消](../tests/executor-container.test.ts) |
| AC-027 | 两张真实隔离容器验证另一 Ticket、外部符号链接和宿主接口无法访问；受保护的内置工具另有真实模型选测。跨全部文件读取路径、用户主动提供片段后继续的完整模型上下文仍需单列验证。 | [源码隔离](../tests/executor-container.test.ts) |
| AC-028 | 实际 Docker 并发验证不同文件、凭据、网络和取消；用实际 SQLite 验证暂停的作业能收尾。 | [容器](../tests/executor-container.test.ts) · [暂停](../tests/supervision.test.ts) |
| AC-029 | 两个容器运行相同固定镜像；缺失镜像启动失败，Ticket 工作目录保留；测试记录含镜像身份。 | [环境](../tests/executor-container.test.ts) · [摘要](../tests/supervision.test.ts) |
| AC-030 | 两个真实 CLI 进程从不同 cwd 同时启动，连到同一常驻进程。受控 Main 建一张 Ticket、一个首个 Assignment，之前的客户端退出后仍可查询。真实后台接续见 AC-002。 | [并发启动](../tests/audit-host.test.ts) · [退出入口后接续](acceptance/ac-046.md) |
| AC-031 | Host.close 对两个 Worker 和 Main 发出中断并等待确认，终止测试；重开 SQLite 核对排队 Input、测试状态和未提交现场。此用例替换会话及后台进程端口。 | [宿主停机](../tests/audit-stop.test.ts) · [实际容器进程](../tests/executor-container.test.ts) |
| AC-032 | 延迟、重复和过期的累计快照不会阻碍接续，主会话单列，不能跨票归集。供应方硬限额的最终终端体验另需目标环境证据。 | [用量](../tests/supervision.test.ts) · [协议错误](../tests/codex-session.test.ts) |
| AC-033 | 两个自建 PR 和一个上下文 PR，正反两种关闭顺序得出相同结局；没有自建 PR 时等全部跟踪 PR。重复事实只产生一次结束。 | [多 PR 生命周期](../tests/audit-pr.test.ts) |
| AC-034 | 已接手人工追问时先记下 merged、Ticket 保持 open，收尾后才结束；保存真实关闭时间并发送一次对应 Ticket 的通知。GitHub 事实由夹具提供。 | [延迟结束](../tests/audit-pr.test.ts) · [终端事件](../tests/host-controls.test.ts) |
| AC-035 | 实际 SQLite 验证 pending/运行中/等待/待评审/受阻/失败/暂停、输入回执与重复扫描；真实独立仓库重启保留 A 的等待状态并接续 B。 | [恢复矩阵](../tests/host-recovery.test.ts) · [真实重启](acceptance/ac-046.md) |
| AC-036 | 真实独立仓库写入成功后丢失回执；重启找回原 PR。未知写入与撤权限制另有受控测试。 | [实测时间线](acceptance/ac-046.md) · [交付日志](../tests/delivery.test.ts) |
| AC-037 | 重新实例化轮询器后补收关闭事实；临时失败、去重、只查绑定号码及重复重启均有断言。GitHub 读取用受控远端。 | [轮询与恢复](../tests/audit-pr.test.ts) |
| AC-038 | 普通 60 秒、GitHub 指定 120 秒、Worker 的 15/30/60 秒、测试等候 30 分钟分别验证。gh 子进程测试保留产生错误的原响应头。 | [HTTP 响应](../tests/audit-github.test.ts) · [轮询](../tests/audit-pr.test.ts) · [重试](../tests/codex-session.test.ts) · [测试计时](../tests/supervision.test.ts) |
| AC-039 | gh 子进程验证实际账号、仓库及 push 权限；错误作者不允许绑定。错误分支、跨 fork 和已由另一开放 Ticket 占用的 PR 均被拒绝。 | [账号与权限](../tests/audit-github.test.ts) · [分支及占用](../tests/audit-history.test.ts) · [作者](../tests/delivery.test.ts) |
| AC-040 | 专用 gh 入口的临时退出登录、错误身份、脱离个人环境都由子进程验证。独立仓库的交付事实另见 AC-046；测试环境的账号配置不能替代生产专用账号验收。 | [CLI 鉴权](../tests/audit-github.test.ts) · [实际 PR](acceptance/ac-046.md) |
| AC-041 | 真实 Git 的保留、用户清理后对原分支提交的核实，与会话恢复及原 Mandate 的复用分别验证。 | [工作目录](../tests/executor-workspace.test.ts) · [重新唤醒](../tests/routing.test.ts) · [清理后历史](../tests/audit-history.test.ts) |
| AC-042 | 实际回环 HTTP 校验本地凭据；缺失/错误凭据未调用宿主处理器。两个 CLI 的有效凭据可暂停和恢复同一张 Ticket。 | [管理端点](../tests/host-server.test.ts) · [CLI](../tests/audit-host.test.ts) |
| AC-043 | 真实容器验证两个执行边界与持久卷，真实 Codex 验证历史 Input 标识，丢失会话信息以阻塞处理。使用真实模型的容器重建选测与本地回归独立运行。 | [Docker](../tests/executor-container.test.ts) · [Codex](../tests/codex-real.test.ts) · [恢复](../tests/host-recovery.test.ts) |
| AC-044 | 容器隔离服务凭据和宿主通道，实际模型调用已有 AC-046 证据。模拟密钥失效、替换后继续且不重复全部副作用的完整链仍需单独取证。 | [容器](../tests/executor-container.test.ts) · [原操作对账](../tests/host-recovery.test.ts) · [真实模型](acceptance/ac-046.md) |
| AC-045 | 实际宿主 SQLite、Git 与受控远端建立 PR 回执。清理目录和失败片段、关闭并重开宿主后，trace 按原 Trigger 回溯 Decision、Mandate、Assignment、历次报告、PR 和清理标记。重复 Trigger 未开新单。 | [跨重启 trace](../tests/audit-history.test.ts) |
| AC-046 | 独立仓库已取得真实双 Ticket、离线失败自动修复、复测通过、PR 创建与回执丢失后的同 PR 对账。审查时只读 GitHub 查询显示 PR #1 仍 open；合并后唯一 ended/merged 终端结果仍待实际观察。 | [运行标识与 PR](acceptance/ac-046.md) |

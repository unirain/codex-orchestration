# Specification — 本地持续推进的 Codex agent

Type: Project
Status: READY FOR HUMAN REVIEW
Version: 0.46
Owner: 项目发起人
Intent: [intent.md](intent.md)，2026-11-18 批准，2026-11-19 修订 PR 交付语义，2026-11-20 扩展至绑定 PR 的关闭与合并反馈，以及后台重启恢复
Parent specification: 不适用
Last updated: 2026-11-20

## Intent Traceability

- 项目发起人从一个入口交代、补充、暂停和查询多项开发工作。系统管理 Codex session。
- 入口关闭且本地 agent 仍运行时，已交代工作收到相关本地测试反馈后自动接续。Worker 可在预授权仓库创建或更新 PR，自审完成且相关检查通过后报告 `ready`。
- 自主发现并发起新工作、接手本系统之外创建的 Codex 会话、操作系统开机自启、后台异常退出后由守护程序自动拉起、GitHub CI 与评审事件接入均留待后续。合并 PR 由仓库现有流程负责。首版采用本地终端，网页入口留待后续讨论。
- 本规格在「领域对象与原型落点」中逐项记录对象、职责、流转规则和对应源码。首版范围由已批准意图约束。终端、Codex 和本地测试是首版的适配点。本版记录已确认的产品选择、可验证的技术边界，以及需要在独立测试仓库取得的运行证据。

## System Context

- 已核实：本工作区为新项目，目前没有应用实现。在本机 Codex CLI 0.165.0 上，已用 App Server 验证 `thread/list` 和 `thread/read`。新 turn 投递及关闭入口后的自动接续尚未实测。
- 已核实：参考原型 `dsh-superagent-prototype` 在 `src/executor/dsh.ts` 按 Ticket 组织工作目录和 worker session，在 `src/core/intake.ts` 根据来源 Thread 的订阅投递追问，在 `src/app/effects.ts` 保存待执行的操作。
- 已核实：[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server) 定义了 thread 的创建与续接、turn 事件和中断接口。[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) 与 [非交互 CLI](https://learn.chatgpt.com/docs/cli/reference#codex-exec) 也可续接保存的会话。
- 目标边界包括本机终端与宿主后台、每张活跃 Ticket 的本地 Linux 容器及 worktree、已配置的 Codex 服务和经用户授权的 Git 远端。

## Actors, Roles, and Permissions

| 角色 | 权限 | 边界 |
|---|---|---|
| 项目发起人 | 发起、补充、查看、暂停工作，管理允许写入的仓库 | 首版唯一人类操作者 |
| Engine | 唯一的领域写入口，执行准入、流转与授权检查 | 在事务中提交领域状态并登记 Effects |
| Main Session | 读取 Candidate、Thread、Ticket 和 Decision，提交路由命令，处理需要用户关注的报告 | 原需求交给 Worker，结构化命令由 Engine 校验 |
| Executor Session（Worker Session） | 在 Ticket 的工作目录内处理 Assignment 和 Input，提交 Report，交回超范围的 Trigger | 工作范围由 Mandate 确定，远端权限另经检查 |
| 本地测试进程 | 返回所属 Assignment 上的运行结果 | 输出是证据，与用户指令和授权分开处理 |

## Capabilities and Workflows

1. **接收。** 后台实例启动时绑定一个工作仓库。终端 Source 使用持久的默认 Thread。用户从其他目录重新连接时，仍回到该 Thread，新 Ticket 也使用该实例绑定的仓库。用户消息形成不可变的 Trigger。Engine 按 Trigger ID 去重，追加到 Thread，并根据 Subscription 向相关 Ticket 记录 Input 和 Disposition。
2. **首次接单。** 无 Worker 负责的 Trigger 在主 Thread 等待 Eval。Gate 先判断是否为授权用户的明确请求。Main Session 获取 Candidate，根据上下文提出 `accept`、`attach`、`stop` 或 `ignore`。Engine 记录结果。`accept` 在一个事务中创建 Decision、Mandate、Ticket、首个 Assignment、Subscription 及待执行的启动与回执 Effects。
3. **订阅直通。** 人的追问到达负责它的 Ticket 时先交给该 Worker 判断。主 Session 可以收到已投递通知。`attach` 只用于消息明确指向已有 Ticket 的情形，并建立订阅。对同一 Thread 上的另一个请求，Worker 记录 hand-back。所有负责它的 Worker 都已交回时，同一个 Trigger 回到 Eval，并保留原文和交回原因。归属仍不清楚时通过 Channel 请用户澄清。
4. **后台接续。** Worker 的 turn 可以早于相关测试结束。测试归 Executor 管理，将结果交回原 Ticket 的 Worker Session。用户关闭终端后仍可接续。测试结果须关联有效的 Assignment 和运行记录；暂停或已失效的 Assignment 只保留事实，不自动启动执行。
5. **报告与交付。** Worker 遵循仓库与团队要求，按 Ticket 选择相关检查并自审。Worker 决定何时交付，向宿主请求推送提交、创建或更新 PR。宿主在每次远端写入之前校验 Ticket、目标仓库及当前授权。遇到具体阻塞时，可用 draft PR 保存有价值的部分成果，并报告真实检查结果、阻塞与剩余工作。需要等待的检查仍在运行时，Worker 等结果返回再评估就绪状态。`ready` 且关联开放 PR 时，Ticket 显示待评审。宿主检查报告所引用 PR 的归属，Main Session 经 Channel 交付结果或具体问题。宿主继续观察已绑定 PR。收到关闭或合并事实后，由 Engine 依据 FR-012 判断何时结束 Ticket，保留订阅与历史。原型依据见 `prompts/work.md`、`prompts/team/scope.md` 和 `docs/003-execution.md`。
6. **状态。** Ticket 生命周期为 open / ended。Assignment 独立经历 pending / running / ended。Worker turn 的运行、空闲、中断单独记录。用户暂停时 Ticket 保持 open 并保留 Mandate。终端进度根据这些记录、暂停标记、Report、Attention 与交付状态推导。

## Functional and Business Requirements

- `FR-001`: 单一本地终端入口支持发起、补充、查询和暂停多项可区分的开发工作。用户操作以工作为单位。
- `FR-002`: 用户补充明确指向已有工作时，系统将原消息交给该工作。若归属不确定，先向用户澄清。
- `FR-003`: 入口关闭且后台 agent 仍运行时，系统继续处理已有工作的后续本地测试结果。重开入口可见反馈与后续进展。
- `FR-004`: 当用户要求暂停、任务需要扩大范围或权限、或自行排查后仍无法验证时，系统暂停受影响的工作并展示原因。其他工作仍可推进。
- `BR-009`: Worker 根据每次修复和复测带来的证据判断是否继续。在原 Mandate 内，能指出新证据、已排除的原因，或基于现有观察提出有区分力的下一次验证时，继续处理。多次尝试仍重复同一失败且已无可行的新验证办法时，保留改动并报告具体阻塞、已尝试的方法及缺少的信息。修复轮数本身不触发暂停。模型服务故障另按 `AI-005` 的有限重试规则处理。
- `FR-005`: 代码改动交付评审时，Worker 须完成自审与相关检查，在 `ready` Report 中说明实际改动、已运行的检查、结果和风险，并提供属于该 Ticket 的可访问 PR。用户能区分草稿、待评审和已结束。
- `FR-006`: 后台仍运行时，终端重新连接必须复用默认来源 Thread 的标识、历史和已有订阅。每个 Ticket 继续使用自身的 Mandate、工作目录和 Worker Session。
- `FR-010`: 仓库绑定已配置时，打开终端入口即查找该绑定对应的本机后台。实例已就绪则直接连接，尚无实例则自动启动。多个终端并发打开时只允许一个实例取得该绑定的调度权，所有终端连接同一默认 Thread。启动失败时入口显示具体原因。关闭最后一个终端只断开客户端连接，常驻后台继续处理已有工作。
- `FR-011`: 用户明确停止整个后台时，停止接收新工作和派发新 turn，取消 Main 与 Worker 的活跃 turn，终止后台测试并记录中断。保留已收到的待处理输入、已提交的领域记录、worktree 与本地改动。正在处理的 Effect 收尾后刷新并关闭存储，再释放实例锁。对已发出但结果未知的远端操作保留待核实状态。整个后台停机与关闭终端、暂停一张 Ticket 有各自独立的语义。
- `FR-007`: 用户明确暂停 Ticket 时，系统中断该 Ticket 当前的 Codex turn，冻结新的修改、测试与交付。已启动的本地测试可以跑完，结果按原运行标识保存供查询。等待用户明确要求继续后，Worker 才可在原 Mandate 范围内处理积存结果。已过期的测试结果只作为历史记录。
- `FR-008`: Executor 给每张 Ticket 分配独立工作目录。首次启动且目录尚不存在时，读取操作者为该仓库设置的 `executor.prepare`。有命令时，在执行根下以该 Ticket 的目录、标识和短名作为上下文运行，限时 10 分钟；配置为空时创建空目录。准备成功后校验目录归属和 Worker 可访问性，才交给 Worker。后续 Assignment 复用已准备目录，保留其中未提交的改动。命令失败或超时须记录原因及经脱敏的输出，中止本次启动，清理此次失败留下的空目录，保留非空目录供检查。准备失败不触发模型服务的自动重试。
- `FR-009`: 提供 Git worktree 准备配置示例。对需要 Git checkout 的 Ticket，用户未指定分支时，从绑定仓库获取远端默认分支及其提交，用该提交建立 Ticket 专属分支和 worktree，记录起点，并将 PR 目标设为同一默认分支。空工作目录本身不提供 Git checkout 或 PR 基线。
- `BR-001`: 只有用户明确交代的目标可以开启新工作。测试结果和其他反馈只能推动已关联工作。
- `BR-002`: 自动推送并发起 PR 须针对预先授权的目标仓库。未授权时在远端写入前暂停。
- `BR-007`: 同一后台实例的全部 Ticket 均在启动时配置的工作仓库内执行，每个 Ticket 的执行目录归属于该仓库。客户端当前目录或消息中提到的其他仓库均不能重新绑定实例。
- `BR-003`: 常规 Eval 以 Thread 为串行边界，同一 Thread 上后到的待评估 Trigger 进入下一批。Policy 变化导致进行中的旧版本 Eval 结果失效。
- `BR-004`: 只有经 Gate 的 `accept` 可以创建 Ticket。重复接受同一 Trigger 必须返回原结果，且不产生额外 Ticket 或首个 Assignment。
- `BR-005`: 人的追问由有效的 Subscription 投递给 Ticket。只关注上下文的 Subscription 和 Thread 间 Correlation 不授予执行权限。hand-back 必须保留原 Trigger，且不可把它重新 attach 给交回它的 Ticket。
- `BR-006`: `accept` 生成不可变的 Mandate。已有 Ticket 收到超范围请求时，扩大后的工作须由明确的用户请求经 Eval 与 `accept` 获得新 Mandate 和新 Ticket。正常结束的 Ticket 在重新唤醒前按当前 Policy 复核原 Mandate。用户明确 `stop` 撤回授权，旧 Ticket 不会因后续订阅消息自动重启。

- `FR-012`: Ticket 创建过 PR 时，只计入它自己创建并绑定的 PR；没有自建 PR 时，计入它所跟踪的所有 PR。计入集合非空且全部关闭或合并，并且没有原型结束规则所指的未完成工作时，Engine 将 Ticket 标为 ended，结局取最后一个相关关闭事实的实际时间和结果（merged 或 closed）。已恢复或重试的工作尚未完成，或 Worker 已接手且仍在处理人工追问时，先记录关闭事实并保持 open，工作收尾后再判定。重复读取同一事实只产生一次结束和一次终端结果通知。

- `FR-013`: 后台重新启动并取得该仓库的唯一实例锁后，按接单先后检查 open Ticket。对被中断且仍应推进的工作，结束旧 Assignment 并记录宿主重启原因，为原 Ticket 创建一个新 Assignment，复用原 Worker Session、工作目录、分支与已绑定 PR；尚未启动的 pending Assignment 按原记录重新排队。等待、待评审、blocked 或 failed 且没有更新 Input 的 Ticket 保持原状态，有合资格的新 Input 时按正常唤醒规则调度。用户明确暂停的 Ticket 继续等待本人解除暂停，已结束的 Ticket 遵循 BR-006。恢复需遵守相同的授权与槽位限制。

## Architecture Overview

Source 接收 Trigger，Engine 调用 Assessor、Executor 和 Outbox 的端口。Engine 负责领域规则和事务；Main Session 做路由判断；Executor 负责把 Ticket 的 Assignment 落到 Worker Session 和工作目录；Channel 交付回执、答复、结果和 Attention。常驻后台持有这些组件，终端可独立退出与重连。

### 领域对象与原型落点

| 对象 | 首版职责与关系 | 原型落点 |
|---|---|---|
| Source / Channel | Source 将终端事件转为 Trigger。Channel 是回到来源会话的地址，收到确认、答复、结果或人工问题 | `src/sources/kind.ts`、`src/core/replies.ts` |
| Trigger / Disposition | Trigger 保存不可变的原始事件、来源身份、时间和 Thread 归属。去重、过滤、投递、Eval、Decision、hand-back 记在 Disposition | `src/core/model.ts`、`src/core/intake.ts` |
| Thread / Correlation / Subscription | Thread 是来源对话，也是 Eval 串行边界；它保存待处理 Trigger、当前 Eval 与对 Ticket 的多对多订阅。Correlation 只扩展上下文。同一个终端入口可以呈现多个 Ticket | `src/core/model.ts`、`src/core/intake.ts` |
| Policy / Gate / Assessment | Policy 有版本。Gate 确定性判定准入与强度。Assessment 在需要模型判断时提供上下文和研判。首版只允许明确的用户请求获得新工作授权 | `src/policy.ts`、`src/app/assessment.ts` |
| Eval / Candidate / Decision | Eval 对 Thread 上的一批 Trigger 作判断。Candidate 包含批次、相关 Ticket 和 Policy 版本。Decision 记录 `accept`、`stop`、`ignore` 或 `unavailable` 及理由。`attach` 是 Engine 命令：单条 Trigger 的 Eval 以 `ignore` 和 `routed` 原因结束；同批还有其他 Trigger 时剩余项重新排队 | `src/core/evals.ts`、`src/core/engine.ts`、`src/app/tools/main.ts` |
| Mandate / Ticket | `accept` 生成不可变的 Mandate，记录 `actor`、`scope`、`strength`、`policyVersion` 和 `basis`。`basis` 记录 Gate 的准入方式以及适用的来源、发送人和规则依据。Ticket 持有 Mandate，关联作出授权的 Decision，并继续持有 Inputs、Assignments 和 Channels | `src/core/model.ts`、`src/core/evals.ts`、`src/core/tickets.ts` |
| Assignment / Executor / Worker Session | Assignment 将 Ticket 交给一次执行实例，允许一个 Ticket 随时间拥有多个 Assignment；Executor 管理每个 Ticket 的受管 Codex Worker Session 和工作目录。Codex thread ID 属于执行映射 | `src/core/assignments.ts`、`src/executor/dsh.ts` |
| Input / Report / Attention | Input 记录交给 Ticket 的原始 Trigger 或上下文。Worker 报告进展、等待、就绪、受阻、失败或无需处理。Attention 保存需要用户回答的具体问题 | `src/core/model.ts`、`src/core/assignments.ts`、`src/app/tools/executor.ts` |
| Store / Effects / Outbox | Store 保存领域记录；Effects 登记评估、启动、投递和通信等待执行的操作；Outbox 按 Channel 保存待发与已发回执 | `src/app/store.ts`、`src/app/effects.ts`、`src/app/outbox.ts` |

## Tenancy and Isolation Model

首版供一个用户在本机使用。每张 Ticket 独占一个工作目录；Git worktree 示例为每张 Ticket 分配专属分支。本文其他条款中的 worktree 指采用该 Git 准备配置时的 Ticket 工作目录。创建失败或已有目录的分支归属无法确认时，Executor 记录原因并保留现有文件，待该 Ticket 获得正确目录后再启动 Worker。已结束的 Ticket 收到合资格追问时，先按 BR-006 复核恢复资格，再检查原目录。目录仍在且归属正确则复用；若用户已清理目录，恢复说明须明确标出现场缺失，并核对原分支及已保存的提交。已提交的内容可据 Git 状态验证，无法核实的未提交工作须作为缺失项呈现。Git worktree 之间共享部分仓库元数据，运行环境负责执行权限。远端写入凭据由本地宿主持有，具体隔离机制待验证。SQLite 业务历史的保留见 DR-007。[Git worktree 文档](https://git-scm.com/docs/git-worktree#_description)

## Technology Stack

| 层 | 当前状态 | 提议及取舍 |
|---|---|---|
| 本地入口 | 已确认 | 一个本地终端入口连接后台，与工作执行各自拥有独立生命周期 |
| 编排与存储 | 已确认 | 本地后台以 TypeScript 编写，在 Node.js 中运行。SQLite 持久化领域状态、待执行操作及交付回执，供 Engine 更新和终端重连查询 |
| 执行集成 | Codex App Server 已确认 | 宿主按角色管理 Session。每张活跃 Ticket 的 Worker App Server 在本 Ticket 的 Linux 容器内运行，宿主按实例、threadId 和 turnId 关联执行事件 |
| 工作目录与交付 | 已确认 | Executor 支持仓库级准备命令，提供 Git worktree 配置示例。代码 Ticket 仍按 FR-009 记录提交基线和 PR 目标 |
| 命令与测试环境 | 已确认 | 绑定仓库时由用户指定已准备好的固定版本开发镜像。每张活跃 Ticket 的容器使用该工具链，Worker 按仓库锁文件及网络授权安装项目依赖 |

### 仓库准备配置示例

对于 Git 仓库，准备命令接收 Ticket 的目标目录、短名及已解析的基线提交。示例按已确认的远端基线创建专属分支，并将该分支检出到目标目录。参考配置及具体 Git 命令见 [原型部署示例](../../deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md#settings)。本地适配中，操作者管理准备配置，Trigger、Worker 和目标仓库里的文本均无权改写它。准备所需的仓库操作受既有目录与凭据权限约束；具体怎样向准备环境提供受限的 Git 操作仍待设计验证。

## Application and Service Architecture

终端 Source 和 Channel 可断开或重连。常驻 Runtime 组合 Engine、Store、Effects、Sessions、Assessor、Executor 和 Outbox。测试与 Codex turn 有各自的标识，验收时可证明后台反馈来自哪次运行。同一 Assignment 中串行交付会改变代码的 Inputs，暂停时校验待执行的 Effects。后台重新启动后的对账、接续和等待状态见 FR-013 与 IR-008。

## Data and Storage Architecture

- `DR-001`: Store 须按 Ticket 关联 Trigger、Disposition、来源 Thread、Decision、Mandate、Assignment、Input、Report、受管 Worker Session 和交付证据，使终端重连后可回溯。
- `DR-002`: Engine 在同一个 SQLite 事务中记录接单 Decision、Mandate、Ticket、首个 Assignment、Subscription 以及相应的待启动操作和待发回执。事务回滚时这些变更全部撤销。Executor 启动与 Channel 发送只在提交成功后执行。
- `DR-003`: Store 按测试运行标识分别保存摘要，关联 Ticket、Assignment、实际测试命令、受测代码版本与退出状态。工作目录有未提交改动时在版本记录中注明。失败的运行额外保存有长度上限的错误输出片段，并标记是否发生截断。复测生成独立记录。编排程序的持久化测试记录限于摘要与失败片段；命令和片段写入前须处理敏感凭据。
- `DR-004`: 限长的失败片段随所属 Ticket 保留，Ticket 结束和经过固定天数均不触发自动清理。用户可主动清理指定 Ticket 的已保存失败片段。清理完成后仍可查询各次运行摘要，其余 Ticket 的片段继续保留。
- `DR-005`: Ticket 结束（包括关闭、合并或用户 stop）后，其专属工作目录、未提交改动和复现材料保留在宿主，清理时机由用户决定。退出或回收执行容器时同样保留该目录。手动清理目录的作用范围仅为选定目录，Ticket、Mandate、Subscription、Report、测试记录和远端 PR 的生命周期分别管理。
- `DR-007`: SQLite 持续保存已经形成的完整业务历史，包括 Trigger 原文及来源、Disposition、Thread 和订阅关系、Eval 的 Decision 及其理由、Mandate、Ticket 的 Assignments、Inputs、Reports、Attention 和各次交付回执。Ticket 结束或记录年限增长均不触发自动删除或摘要替换。宿主用稳定标识关联这些记录，供复盘与重复投递、恢复对账查询。
- Store 保存领域记录，Codex 持有会话历史，Main Session 通过只读资源查询工作状态。原型 Store 有 `trigger`、`disposition`、`thread`、`ticket`、`decision`、`effect`、`outbox` 等记录。接单 Decision 和对应 Ticket 保存 Mandate。Main Session 的标识由 `KV.runtime.masterId` 保存，读取面由 `orchestrator_read` 提供。

## Identity, Access, and Authorization

- `SEC-001`: 只有项目发起人能发起或暂停工作以及修改仓库授权。远端写入执行前须校验目标仓库的当前授权。
- `SEC-003`: 发起远端写入必须同时满足 Ticket 的 Mandate 范围和当前的目标仓库授权。Subscription、Input 和 Worker Report 可提供上下文或证据，不能扩大授权。
- `SEC-004`: 本地宿主持有远端写入凭据并执行远端操作。Worker、其 shell 以及测试子进程均不得读取、继承或调用这些凭据，包括可代为签名的 SSH agent 或 Git credential helper。宿主返回执行结果和 PR 引用。凭据不得进入工具结果、模型上下文或日志。
- 宿主从自身保存的 Ticket、Assignment、绑定仓库和授权记录解析目标，校验请求中的分支、提交和 PR 归属。推送与创建 PR 是两次独立写入，各自在发出前重新检查暂停与撤权状态。
- `SEC-010`: 宿主以绑定仓库配置的 agent 专用 GitHub 账号执行推送和 PR 写入。启动时读取实际登录身份、GitHub 返回的仓库全名及该账号的推送权限。身份或权限校验失败时，远端写入保持阻塞，终端显示原因；宿主不得回退到操作者的个人登录。启动检查和每次写入前的仓库预授权检查均须满足。
- 专用账号的登录凭据由宿主配置的独立 GitHub CLI 登录环境管理。配置只记录专用入口及其绑定身份；凭据不得复制到 SQLite、Worker 容器或测试日志。终端入口通过本机 HTTP 访问，文件隔离机制待验证。Worker 项目源码边界见 `SEC-008`。Worker 出网按 `SEC-006` 执行。

## Integrations and Tools

- `IR-001`: Executor 接收测试完成事件时，须辨认其 Ticket、Assignment、测试运行和成功、失败或无有效结果的状态。
- `IR-002`: 本地后台作为 Codex App Server 客户端，为 Main Session 和各 Ticket 的 Worker Session 分别保存 Codex thread ID。Executor 在创建 Worker 时使用 `thread/start` 返回的 `thread.id`，需要恢复已保存的会话时以该 ID 调用 `thread/resume`。终端重连复用后台持有的会话绑定。
- `IR-003`: 先核对 Ticket、当前 Assignment、暂停标记与运行资格，再将测试反馈通过 `turn/start` 送入对应的空闲 Worker，记录返回的 turn ID。收到 `turn/completed` 时按 thread 与 turn 归属更新执行记录；业务上的 `ready` 仍须由 Worker 报告。
- `IR-004`: 暂停期间先冻结新动作。有活跃 turn 时，Executor 使用记录的 `threadId` 与 `turnId` 发送 `turn/interrupt`。中断回执表示请求已受理，后台以对应 turn 的终态确认执行已停止，再按暂停规则释放槽位。如果 turn 恰好已自然结束，记录其实际终态并保持 Ticket 暂停。连接中断造成状态未知时，需要先核对已有 turn 状态再决定是否重新投递。
- 宿主从绑定仓库读取 Worker 所报的真实 PR。对于本 Ticket 新建的 PR，须核对作者是已验证的 agent 账号、head 分支属于该 Ticket，且该 PR 未被另一张开放 Ticket 占用；通过后才绑定。对于以 PR 为来源的任务，原型另行核对原始 Trigger 中的 PR 身份，本地终端报告一个 PR 编号本身不足以取得该例外。对写入结果未知的处理见 IR-008。

- `IR-007`: 宿主后台主动轮询仍开放的 Ticket 所绑定、尚待确认最终结果的 PR。按仓库和 PR 编号去重读取，首次启动或重启也走同一核对路径。终端未连接时照常轮询。读取权限限于查询，读取成功时将关闭时间、是否合并及归属交给 Engine，按 FR-012 幂等处理。读取失败时保留最近已知状态并重试。PR 关闭事实只用于生命周期更新。
- 常规 PR 轮询间隔默认为 60 秒；GitHub 要求更长等待时，下一轮查询遵守更长间隔。参考原型 `src/sources/github.ts` 的配置和轮询循环。

- `IR-008`: 恢复前核对旧 turn、容器与在途操作，确保旧 Assignment 的迟到报告不能写入新 Assignment。按持久化的 Input 标识、投递记录和可核实的 Session 历史区分已接收与未接收；只向原 Worker 补交未接收的 Input，重复恢复扫描不重复投递或派工。未能核实旧 turn 或 Input 状态时保留记录并显示具体阻塞。对中断的测试，若缺少可核实的结束结果，记录中断或未知。
- 新 Assignment 收到恢复说明，先检查工作目录、Git 历史及绑定 PR。若推送或创建 PR 时回执丢失，宿主先按仓库、Ticket 分支、提交和已有 PR 核对事实；操作已生效就补记结果。只有能确定尚未生效且当前授权仍有效时才可重试。无法判定时保留现场并请求处理。

- `IR-009`: 操作者绑定仓库时指定宿主侧的专用 `gh` 入口。宿主以该入口验证登录、读取绑定仓库及 PR 状态、创建或更新 PR，并以该账号的 Git credential helper 执行受授权的 Git 推送。CLI 入口缺失、退出登录、解析出的账号与绑定身份不符时，保留现场并显示对应错误。Git 和 CLI 的身份来源均限定为该入口，调用环境须排除个人登录或继承的 token 意外覆盖该身份。Worker 通过领域工具请求操作，只接收操作结果与 PR 引用。

- `IR-010`: 宿主仅在回环地址监听管理 HTTP 服务。绑定仓库的后台实例就绪后，在当前操作系统用户私有的实例信息中发布绑定仓库和回环端点。终端重新连接时核对实例身份和就绪状态，再提交消息或查询 Ticket。并发启动按 FR-010 复用同一实例。
- `SEC-011`: 受理创建 Trigger、暂停或恢复 Ticket、授权仓库、更改配置或停止后台等写请求前，宿主须校验当前用户的本地访问凭据。凭据由宿主管理，与专用 GitHub 账号凭据用途独立，限宿主和该用户的终端读取。缺失或无效的凭据导致写请求被拒绝，领域状态保持原值。原型使用回环 HTTP、Host 和 Origin 校验及专用请求头，本地访问凭据是本项目的单用户适配。

## Agent Architecture

- `AI-001`: 系统须为每项新工作自动创建受管 Codex session，并为该工作续接其相关后续输入。用户通过工作标识或自然语言指代工作，无须提供 Codex session ID。
- `AI-003`: Main Session 以结构化命令提交 Candidate 的处理决定。Worker 通过结构化 Report 和 hand-back 反馈。Engine 校验两者的作用范围并保存结果。
- `IR-005`: 创建受管 thread 时，宿主通过 App Server 的 `dynamicTools` 按角色注册领域工具。Main Session 可读取路由上下文并调用 `orchestrator_route`；Worker 可调用 `orchestrator_report`、`orchestrator_trigger_handback` 及请求远端交付的工具。宿主收到 `item/tool/call` 后，按当前连接及协议携带的 `threadId`、`turnId` 解析角色与运行记录，以 `callId` 关联本次调用及响应。Worker 的 Ticket 和 Assignment 来自宿主维护的绑定，Report 参数只提供报告内容。
- `SEC-005`: 对会改变领域状态的 Worker 调用，Engine 提交前须确认该角色可用此工具、该 turn 属于对应 Assignment，并且 Ticket 仍允许此操作。过期 Assignment 的首次调用返回拒绝原因，保留当前 Assignment 的状态。重复到达的已完成调用按原调用记录应答，最多产生一次领域写入。远端请求还须经过 `SEC-003` 和 `SEC-004` 的校验。
- 兼容性依据：在本机 Codex CLI 0.165.0 的实验协议类型中已核对上述字段。升级前需要在隔离的测试会话中验证注册、回调、宿主返回结果以及续接后的实际调用。当前证据限于协议类型。[动态工具协议](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)

## Agent Harness and Orchestration

Assessor 通过 App Server 驱动 Main Session 处理 Candidate，Executor 通过同一协议驱动各自绑定的 Worker Session 处理 Assignment、后续 Input 和后台结果。运行与暂停事件按 `IR-002`、`IR-003`、`IR-004` 确认。断线对账、重复调用及 Worker 瞬态重试分别按 IR-008、SEC-005 和 DEC-035 验收。

## LLM and Model Strategy

- `AI-004`: 新建 Main Session 或 Worker Session 时，后台读取该角色的模型配置。有覆盖值时使用该值，未配置时使用本机 Codex 默认模型。两个角色可分别配置。更改角色配置只影响随后创建的同角色 Session；续接已有 thread 时保留其既有模型选择。
- `OBS-002`: 对每个 Session 记录角色、thread ID、模型选择来源（本机默认或角色覆盖）及 Codex 返回的实际模型标识。用户可据此核对某次配置变更影响了哪些 Session。运行时未能确认实际模型时，显示未确认并保留请求的配置值。
- `AI-005`: Main 和 Worker 遇到可恢复的网络或模型服务故障时，保持本次选择的模型，在有限次数内重试。身份验证失败、模型配置错误和供应方明确返回的硬额度限制需要用户处理。达到重试上限后保留已完成的进展，展示受影响的 Session、失败原因及尝试次数。暂停或撤权后，排队的重试须重新检查执行资格。
- 已发送的 turn 请求如果因断线而结果未知，先按 `IR-004` 核对执行记录。已启动的 turn 继续观察；确认失败且允许接续的，从当前工作状态继续。无法确定是否执行时保留现场并提示用户，防止重复工具调用或远端写入。
- Worker turn 遇到可安全重试的临时模型或网络故障时，首次失败后最多额外尝试 3 次，各次重试前依次等待 15、30、60 秒；耗尽后按 AI-005 保存进展并显示原因。Main Session 处理的 Eval 走自身的评估超时、重新排队和 unavailable 规则。用量展示见 `OBS-004`，Worker 自动读取的本地源码按 `SEC-008` 限定。
- `BR-010`: 已后置。逐 Ticket 设置 token 配额、耗尽后暂停与追加预算留待后续版本。
- `BR-011`: 已后置。用量回执延迟时给予一个 turn 的预算宽限随逐 Ticket 配额一同延期。
- `OBS-004`: 宿主按 thread 归属记录 Codex 已报告的累计 token。终端按 Ticket 展示 Worker 消耗，单独展示 Main Session 的用量。重复或过时的累计快照不重复计数，迟到的更新只用于补记。是否启动下一轮由已授权的待处理工作、暂停状态和槽位决定。供应方返回限额或重试等待时，显示受影响的 Session、原因及可获得的重试状态。

## LLM Router

- `AI-002`: 消息归属含糊时须要求用户指明工作。模型结果不得授予权限或绕过暂停。
- 本节描述工作归属。Subscription 已能投递时由对应 Worker 判断。其他情况经 Gate 进入 Eval 后，由 Main Session 根据原文、回复关系、相关 Ticket 和 Decision 做路由。主题相似不足以 attach。模型或 Provider 的选择另见模型策略。

## Knowledge, Context, Memory, and Files

原 Trigger 和 Mandate 提供工作依据。Candidate 向 Main Session 提供有限的路由上下文。Worker 从自己的 Ticket、Assignment、Inputs、相关 Thread 和工作目录读取执行上下文。用户在终端主动提供的片段作为 Input 处理；片段中出现的路径不授予读取其余文件的权限。工具链运行所需的系统文件与可提取为模型上下文的项目源码分别处理。Codex 的 thread 会话状态按 DR-006 支持容器重建；SQLite 完整保留业务历史（DR-007）。测试输出仍按 DR-003、DR-004 只保存摘要和限长失败片段。

## Human-in-the-Loop Controls

| 行为 | 已确认的控制 |
|---|---|
| 处理已交代工作范围内的普通测试失败 | 自行排查及复测 |
| 消息归属不明 | 请求用户澄清 |
| 需要扩大工作范围或权限，或自行排查后仍无法验证 | 暂停该工作并显示具体问题 |
| 用户要求暂停 | 中断对应 Ticket 的 turn 并暂停新动作。收集已启动测试的结果，等待用户明确继续。其他 Ticket 可继续推进 |
| 推送、创建或更新 PR | Worker 发起请求。宿主在每步写入前核对当前授权，撤权后停止后续写入并向用户呈现已完成的步骤 |

## Security, Privacy, and Compliance

- `SEC-002`: 测试输出和仓库内容中的文字须按数据处理，无法开启新工作、授予写入权限或扩大现有范围。
- `SEC-006`: 用户为后台绑定的仓库维护外部地址允许列表。Worker 的 shell、包管理器、安装脚本及测试子进程都受同一策略约束。访问已授权目标可自动继续；访问未授权目标时，运行环境须在对外发送请求前拒绝该访问。重定向到另一个目标时须检查新目标。若当前工作因此无法继续，保留该 Ticket 的进展，向用户显示所需目标及用途，等待用户决定。其他 Ticket 继续按各自状态调度。
- `SEC-007`: 每条仓库出网授权指定一个完整主机名和一个端口。HTTPS URL 省略端口时按 443 匹配。只有主机名和有效端口同时与授权项相符时才放行；子域名通配规则在配置时拒绝。每次重定向按新地址重新匹配，新增 CDN 主机或不同端口需要单独授权。
- `SEC-008`: Worker 自动读取并送入模型上下文的本地项目源码限于本 Ticket 的 worktree。文件读取、搜索、shell 及其子进程均须遵守此边界。权限以实际解析到的文件位置判定。同仓库其他 Ticket 的 worktree、用户的原 checkout、仓库外的私有 SDK 均在此范围之外。Worker 可使用接口、错误信息或用户主动提供的片段继续定位。缺少必要信息时保留进展并说明阻塞。
- `SEC-009`: 宿主为每张活跃 Ticket 分配独立本地 Linux 容器，按 Ticket 身份挂载其 worktree 供读写。Worker 的文件工具、shell、安装脚本和测试子进程均受同一文件和出网边界约束。宿主原 checkout、其他 Ticket 目录、宿主凭据代理和容器管理套接字不得暴露给这些进程。仅挂载 worktree 不足以确定 Git 操作权限：宿主管理准备配置和工作目录的授权，容器内的 Git 操作须受限于本 Ticket，上述边界也适用于共享 Git 元数据。
- 宿主检查授权后执行远端 Git 写入。Worker 启动的全部子进程使用仓库出网允许列表。容器运行时须在 Ticket 容器内执行 Worker 内置文件及命令工具；出网过滤和文件隔离效果须以 `AC-028` 的隔离结果验证。

## Infrastructure and Deployment

- `IR-006`: 宿主读取绑定仓库配置的开发镜像，在启动 Ticket 容器时核对镜像可用性，并记录本次实际使用的镜像标识，使测试运行能追溯到对应环境。所配置的镜像缺失或无法启动时，保留 Ticket 和 worktree，显示镜像引用及失败原因。Ticket 的准备流程不自动执行仓库 Dockerfile 或回退到宿主机运行项目命令。

首版使用本地终端和后台进程，目标工作负载须能在 Linux 容器中开发与验证。终端按 `FR-010` 启动或连接后台，以绑定的仓库身份识别实例。后台就绪后才接收 Trigger 和派工。关闭终端后后台继续管理各 Ticket 的容器。容器启动失败时保留 Ticket、目录与原因，等待具备可用的容器环境后再执行。Ticket 暂停后若测试仍在收尾，容器须允许该测试结束并回传结果，Worker 槽位按 `NFR-003` 释放。容器退出后，worktree 中的改动及宿主已记录的运行结果继续保留。后台取得唯一实例锁后先恢复已持久化的状态，按 FR-013 调度可继续的工作。显式停机按 `FR-011` 执行。终端使用 IR-010 规定的本机 HTTP 入口。

- `IR-011`: Executor 为每张活跃 Ticket 在其专用镜像内启动 Worker App Server，宿主将与该实例的控制连接绑定到 Ticket。内置文件与命令工具及其测试进程在该容器内运行。领域工具回调仍交给宿主 Engine 校验并执行；SQLite、GitHub CLI、Git 推送和 PR 操作由宿主管理。实际使用的镜像与 Codex 版本可追溯。
- `DR-006`: 除宿主记录的 thread ID 外，恢复所需的 Codex 会话状态须在容器更换后仍可取得，且只绑定到对应 Ticket。重建容器后先恢复该状态并核实 thread 归属，再续接原 thread。会话状态缺失时显示恢复阻塞及可核实的本地进展。
- `SEC-012`: 容器内 App Server 所需的模型身份、私有会话存储、模型服务连接及宿主控制通道，均须与执行仓库命令的进程隔离。shell、安装脚本及测试不得读取或继承模型凭据，也不能借用服务身份调用模型或宿主管理工具。测试进程的出网仍按 SEC-006 和 SEC-007 执行。模型鉴权方式见 SEC-013，服务进程与仓库命令的实际隔离须验证。
- `SEC-013`: Worker App Server 使用本项目专用的模型 API key。宿主管理该凭据，只向受保护的 App Server 服务身份提供模型鉴权。镜像、worktree、SQLite 业务记录、日志及仓库命令的环境均不得包含密钥。模型 API key 与 GitHub 登录及本地管理接口凭据各自独立。鉴权失败时保留 Ticket、thread 和待处理 Input，按 AI-005 显示原因。宿主更新密钥后，恢复执行前先核对原 turn 与外部操作状态。具体密钥存储和进程隔离手段待验证。

## Scalability, Reliability, Performance, and Cost

- `NFR-001`: 一项工作等待用户或被暂停时，另一项可继续处理已授权的工作。
- 已核实的参考行为：`src/policy.ts` 的普通 Worker 默认上限是 3。启动中的 Ticket、执行中的 turn 以及 turn 结束后仍在运行的后台 job 占用槽位，同一 Ticket 只计一次。普通槽位满时，已有 Ticket 可因人的追问额外唤醒一名 Worker。新 Ticket 排队。参见原型 `src/executor/dsh.ts` 的 `WorkerSlots.reserve`。
- `NFR-002`: 每个后台实例提供 3 个普通 Worker 槽位。按 Ticket 对启动预留、活跃 turn 和 turn 后仍在等待的后台测试合并计数。向已占槽的 Ticket 投递 Input 时复用原槽位。普通容量已满时，仅人工追问唤醒已有空闲 Worker 可将占用总数临时提高到 4，分配时须将并发启动预留计入总数。
- `BR-008`: 新 Assignment 启动及普通事件唤醒要求当前占槽数小于 3。人工追问唤醒已有空闲 Worker 时要求占槽数小于 4。四个槽位均占用时，后续唤醒排队；释放一个槽位后，等待的人工追问可先于新 Ticket 取得运行资格。每次唤醒仍须校验 Ticket、当前 Assignment、暂停状态和 Mandate。
- `NFR-003`: 用户暂停 Ticket 后，活跃 turn 中断、暂停生效时，Executor 立即释放该 Ticket 的 Worker 槽位。已启动的测试可在槽位外收尾，完成事件只记录结果。暂停状态下，完成事件不得申请槽位或启动 turn。用户明确继续后，该 Ticket 按 `BR-008` 等待可用槽位。
- `NFR-004`: 对自主执行中的 Ticket，若 Worker 结束 turn 时仍有该 Assignment 的后台测试在运行，Executor 从本次进入等待的时刻开始计时。测试在 turn 内已运行的时间不计入该窗口。到期前重新开始 turn、暂停 Ticket 或替换 Assignment 时，旧窗口失效。到期时只终止仍属于此次等待且仍在运行的测试，按测试运行标识记录超时原因和实际结果。相关进程退出且 Ticket 不再占槽执行其他工作后释放槽位。用户主动暂停后留下的测试按 `NFR-003` 收尾。
- 自主执行中的 Worker 结束 turn 后，后台等待窗口默认为 30 分钟。计时、失效与超时后的处理见 NFR-004；用户主动暂停后的测试收尾见 NFR-003。

## Observability and Operations

- `OBS-001`: 用户可查看工作的当前状态、本地测试结果、后续处理、暂停原因与已交付 PR。
- `OBS-003`: 用户可按 Ticket 查询历次测试摘要，打开某次失败查看其输出片段及截断标记。后续成功的复测保留对先前失败记录的可见性。手动清理后，原失败记录显示「片段已清理」，并保留命令、代码版本和退出状态。单段采用有限字节数并显式标记截断；具体大小作为可调工程参数，以截断与脱敏用例验证。本条约束编排程序保存的测试记录，Codex 会话历史的生命周期单独定义。

## AI Evals and Quality Assurance

首次真实端到端验收使用独立测试仓库。宿主绑定该仓库、核对 agent 专用 GitHub 账号和写入授权。记录仓库标识、实际镜像与 Codex 版本、初始提交，以及用于复现的输入。该选择定义了后续验证环境，具体仓库和凭据在执行验收时提供。

- 领域回归使用受控输入覆盖 accept、attach、hand-back、授权、暂停、重复事件与重启。可控时钟验证超时和重试。通过条件按每条有效 AC 的可观察结果判定。AC-024 和 AC-025 随 Ticket 配额后置。
- 发版证据包括真实 Codex 与 GitHub 的完整链路（AC-046），以及撤权、容器隔离和重启后的防重验证（AC-010、AC-028、AC-036、AC-043、AC-044）。隔离用例使用测试标记，模型只读取为测试准备的源码与输出。
- 记录 Ticket、Assignment、Codex thread 与 turn、测试运行、提交、PR 编号及最终结果。用它们区分正常的多次检查和重复执行同一个动作。参考原型的测试通过情况只作为对照，本项目的执行结果另行记录。

## Compatibility, Migration, Rollout, and Rollback

这是新项目。首版只纳管由本系统创建的会话。后台或集成故障时保留用户已有工作，未确认 PR 成功的工作显示阻塞或交付中。停止执行后的保留与恢复按 FR-011 和 FR-013 验收，已结束 Ticket 的目录保留按 DR-005 验收。首次试用绑定独立测试仓库。发现路由串线、越权写入、凭据泄漏或恢复重复执行时，试用结果为失败；停止该实例、保留可脱敏复盘的记录并核对已发生的外部操作。涉及 SQLite 格式变更的升级须在旧实例停止后保留一致的升级前备份。回退使用兼容版本与对应备份，重放前先对账远端事实。

## Acceptance Scenarios

- `AC-001` verifies `FR-001`, `FR-002`, `BR-005`, `AI-001`, `AI-002`, `AI-003`: 从终端同一 Thread 请求改 follow up，获得 Ticket A。明确追问由订阅送到 A，保留原 Trigger，且不新建 Eval。该 Thread 上提出邮件 bug 时，A 可交回超范围的 Trigger；同一 Trigger 进入 Eval，明确的新请求获得 Ticket B 和独立 Worker Session。两项工作并存时，含糊的补充触发澄清，未执行猜测出的变更。
- `AC-002` verifies `FR-003`, `DR-001`, `IR-001`, `AI-001`, `OBS-001`: 首个 turn 结束后关闭入口，保持后台和测试运行。测试失败后不追加用户消息，观察 Executor 将运行结果交给原 Ticket 的 Worker Session，继续处理并重新验证。该后台结果不触发新的 Eval。重开入口可查看进展。
- `AC-003` verifies `FR-005`, `BR-002`, `SEC-001`: 在预授权仓库，一个受阻的 Ticket 可将有价值的部分改动保存到 draft PR，并报告已运行的检查和剩余问题。后续完成工作、自审和相关检查后，Worker 更新 PR 并报告 `ready`，终端显示待评审，Ticket 保持 open。若另一 Ticket 的仓库授权在推送前撤回，即使检查通过，系统也在写入前暂停。
- `AC-004` verifies `FR-004`, `FR-007`, `NFR-001`: Ticket A 有活跃 turn 和已启动的测试。用户暂停 A 后可观察到 turn 中断，Ticket B 仍能推进。A 的测试结束时结果可查询，A 保持暂停且没有新 turn、修改、复测、推送或 PR。用户明确继续 A 后，Worker 在原 Mandate 下接续并处理仍适用的结果。
- `AC-005` verifies `BR-001`, `SEC-002`: 将请求启动无关工作的指令混入测试输出，系统只将其关联为原工作的证据，未额外启动工作或提升权限。
- `AC-006` verifies `BR-003`, `BR-004`, `DR-002`: 一个 Thread 已有 Eval 时再收到待评估 Trigger，后到消息留到下一批；旧 Policy 版本的结果无法产生新 Ticket。重复接受同一 Trigger 不重复派工；接受事务失败时不留下部分 Ticket、Subscription 或启动 Effect。
- `AC-007` verifies `BR-005`, `AI-003`: 同一条追问送达两个订阅该 Thread 的 Ticket；其中一个交回时，由仍负责的 Worker 处理。所有负责它的 Worker 都交回后，只重新评估一次。同一 Trigger 无法附回已交回它的 Ticket。
- `AC-008` verifies `BR-006`, `SEC-003`: 记录某 Ticket 的原 Mandate。明确提出超范围的新工作并经 `accept` 后，得到新 Ticket 和新 Mandate，原 Mandate 保持原值。分别模拟正常结束后符合 Policy 的续接、Policy 复核失败和用户 `stop` 后的追问，只有第一种可自动唤醒原 Ticket。远端目标未授权时，有效 Mandate 仍不能触发推送。
- `AC-009` verifies `FR-006`, `BR-005`, `BR-007`, `AI-001`: 同一默认 Thread 上有 Ticket A 和 B，各自拥有 Worker Session。退出终端，后台保持运行，从另一个仓库目录重新连接。原 Thread 的历史与订阅可见。明确补充 A 时，A 在原工作目录续接，B 不执行 A 的变更。另提一个独立目标，则新 Ticket 的执行目录仍属于后台绑定的仓库。

- `AC-010` verifies `SEC-001`, `SEC-003`, `SEC-004`: 在测试仓库中，Worker 和测试子进程尝试直接取得或使用宿主凭据时无法完成远端写入。Worker 请求宿主推送，宿主校验后成功；在创建 PR 前撤回授权，宿主记录已推送的提交和暂停原因，未发出创建 PR 请求。终端能够区分这两个结果。

- `AC-011` verifies `NFR-002`, `BR-008`: A、B、C 各占一个槽位，C 正等待后台测试。新 Ticket D 与需要普通事件唤醒的空闲 Ticket 均排队。用户追问已有空闲 Ticket E，E 立即获得第 4 个槽位；再追问另一空闲 Ticket F，F 等待。A 结束后总占用降为 3，F 优先唤醒，总占用回到 4，D 继续等待。已占槽 Ticket 的后续消息复用其槽位，全程峰值为 4。
- `AC-012` verifies `FR-007`, `NFR-002`, `NFR-003`: A、B、C 各占一槽，D 等待启动，A 的测试仍在运行。用户暂停 A，观察其 turn 中断并释放槽位。D 在 A 的测试退出前取得该槽位。随后 A 的测试结果可查询，A 仍暂停，B、C、D 仍是仅有的占槽 Ticket。用户明确继续 A 时按队列规则重新申请槽位。

- `AC-013` verifies `FR-008`: 分别验证三种配置。① 空命令创建空的 Ticket 目录。② 使用 worktree 示例准备 A、B 两张 Ticket，核对各自分支和目录；A 的后续 Assignment 复用原目录，准备命令仅成功运行一次，未提交改动仍在。③ 准备命令失败或超时，Worker 未启动且原因可查询；此次留下的空目录被清理，非空目录中的文件保留。
- `AC-014` verifies `FR-009`: 选用 Git worktree 准备示例，测试仓库的远端默认分支是 `trunk`。用户在本地 `feature/mail` 上有独有提交和未提交改动，从终端发起一个未指定分支的 follow up Ticket。检查 Ticket 分支起点等于准备时获取的远端 `trunk` 提交，用户的 checkout 及未提交改动保留原状。该 Ticket 创建 PR 时，目标分支为 `trunk`。

- `AC-015` verifies `IR-002`, `IR-003`, `IR-004`: 同时运行邮件与 follow up 两张 Ticket，记录各自的 Codex thread 和 turn。邮件的首个 turn 结束后关闭终端，随后让关联测试失败。后台应只在邮件原 thread 开启下一 turn。此时暂停邮件 Ticket，观察中断命中该 turn、其进入终态并释放槽位，follow up 的 turn 不受影响。重开终端能查询同一组执行记录。

- `AC-016` verifies `IR-005`, `SEC-005`, `AI-003`: 邮件和 follow up 两个 Ticket 同时执行。邮件 Worker 调用报告工具时只提供报告内容，宿主依据调用上下文将报告写入邮件 Ticket。重复交付同一调用后仍只有一条报告。替换邮件 Assignment 后，旧 turn 的另一条迟到报告被拒绝。整个过程中 follow up Ticket 的报告和状态保持原值。

- `AC-017` verifies `AI-004`, `OBS-002`: 两个角色均无覆盖时创建 Main 和 Worker A，核对两者使用本机默认模型。仅修改 Worker 的角色模型后创建 Worker B，核对 B 使用覆盖值。续接 A、查询 Main，验证各自保留原模型及其选择记录。对 Main 单独设置覆盖时，验证同样只作用于新建的 Main Session。

- `AC-018` verifies `AI-005`, `OBS-002`, `IR-004`: 模拟模型服务在开始执行前短暂不可用，确认重试仍指向同一模型。持续失败到上限时，用户可见原因和尝试次数，已有工作保留。另模拟请求已发出后连接中断、turn 实际已启动，确认对账后继续观察该 turn，没有第二次启动。

- `AC-019` verifies `DR-003`, `OBS-003`, `SEC-004`: 在终端关闭期间，邮件 Worker 第一次测试产生超过上限的失败输出，修改后复测通过。重连后按同一 Ticket 查到两次运行及各自的命令、代码版本和退出状态；第一次仍显示限长的失败片段和截断标记。用测试用凭据标记检查保存的命令与片段，均不含其明文。编排程序没有另外留下本次测试的完整输出文件。

- `AC-020` verifies `DR-004`, `OBS-003`: 两张 Ticket 均有失败片段。第一张结束超过 30 天后查询，仍可读到其片段。用户仅清理第一张的失败片段，再次查询仍能看到其运行摘要和清理标记；第二张的片段仍可读取。

- `AC-021` verifies `SEC-006`, `SEC-004`, `FR-004`: 在隔离的测试环境中，将模拟包源列入该仓库的允许列表，用安装子进程获取一个缺失依赖并继续测试。再让测试子进程访问另一个未授权目标，或由已授权包源重定向到该目标。目标服务未收到请求，终端可查看被拒绝的目标；若该依赖是继续工作的前提，Ticket 显示具体阻塞。上述进程均未获得宿主的远端写入凭据。

- `AC-022` verifies `SEC-006`, `SEC-007`: 在模拟包源中仅授权 `packages.example.org:443`，HTTPS 请求省略端口时成功。分别改用同主机的 8443 端口、其子域名、以及重定向到 `cdn.example.org:443`，三者均在向新目标发送请求前被拒绝。单独加入 CDN 主机的 443 端口后重试，跳转成功。尝试配置 `*.example.org:443` 时返回配置错误。

- `AC-023` verifies `BR-009`, `FR-004`, `DR-003`: 邮件测试连续三轮失败。第一种序列在第三轮将超时定位到连接池耗尽，且有可区分原因的复现步骤，Worker 记录依据并继续验证。第二种序列反复出现相同错误，已有方法均已尝试且缺少继续定位所需的信息，Worker 暂停该 Ticket、列明尝试及所需信息。两种序列均可回查对应测试摘要。

- `AC-024` verifies `BR-010`：逐 Ticket 配额和追加预算的验收已后置。

- `AC-025` verifies `BR-011`：预算宽限的验收已后置。

- `AC-026` verifies `NFR-004`, `NFR-002`, `NFR-003`: 测试采用 30 分钟窗口。测试在 10:00 启动，Worker 于 10:20 结束 turn 等待。10:30 时测试继续运行。若 10:45 正常完成，记录真实结果；若持续等待至 10:50，终止仍在运行的测试、记录超时并在收尾后释放槽位。另测 10:35 用户暂停 Ticket，旧等待定时器不得在 10:50 终止该暂停 Ticket 的收尾测试。

- `AC-027` verifies `SEC-008`, `FR-004`: 邮件 Worker 能读取自身 worktree 中的实现。在仓库外的测试 SDK 和另一张 Ticket 的源码中分别放入唯一标记。测试 Worker 直接读取、通过 shell 搜索，以及通过其 worktree 内的符号链接读取外部源码时，三个入口都必须执行相同限制。核对返回的内容和发往模型的上下文均未包含外部标记。用户主动提供 SDK 接口片段后，Worker 能据此继续分析。

- `AC-028` verifies `SEC-009`, `SEC-008`, `SEC-006`, `SEC-004`, `FR-008`, `FR-007`: 并行启动两张 Ticket，确认命令和测试在各自独立容器执行。一个 Worker 修改本 Ticket 文件，宿主在对应 worktree 观察到变更。用测试数据分别验证其内置文件工具、shell 和测试子进程无法读取另一 Ticket 的源码或宿主凭据，且子进程的未授权出网被拒绝。容器不可用时显示阻塞，宿主不代跑仓库命令。暂停运行测试的 Ticket 后，已启动测试仍能收尾并留下结果。

- `AC-029` verifies `IR-006`, `SEC-009`: 为仓库指定固定版本的开发镜像，启动两张 Ticket，验证其容器相互独立且实际镜像标识一致，并可从各自的测试记录追溯。另在镜像不可用的条件下启动一张 Ticket，确认终端显示对应镜像和阻塞原因，已有 worktree 保留，项目命令未在宿主执行。

- `AC-030` verifies `FR-010`, `FR-006`, `FR-003`: 一个已配置的仓库当前没有运行中的后台。并发打开两个终端，二者连接同一个就绪实例和默认 Thread。从其中一个终端提交一条明确的新请求，另一个终端能看到同一张 Ticket；宿主只启动一个首个 Assignment。关闭两个终端后触发该 Ticket 的本地测试完成事件，后台继续处理。再次打开终端能查看原 Ticket 的进展。

- `AC-031` verifies `FR-011`, `DR-002`: 在两个 Ticket 分别有运行中的 turn 和后台测试、另有一个 Input 排队时显式停机。观察到停止派工、turn 取消、测试终止、待处理 Input 和本地改动保留。测试中断不会被记录为通过。停机后保留的运行记录用于下次启动时的恢复判断（AC-035）。

- `AC-032` verifies `OBS-004`, `AI-005`: 邮件 Ticket 收到测试失败，上一 turn 的用量更新仍在途中。在其余执行条件满足时继续修复。随后收到两份相同的累计快照，只补记一次；Main Session 的用量单列。再模拟供应方明确返回额度限制，终端显示受影响的 Worker 及等待或需用户处理的原因。

- `AC-033` verifies `FR-012`, `IR-007`: Ticket 自建两个 PR 并跟踪另一上下文 PR。自建 PR 中一个合并后仍为 open，第二个随后关闭且无在途工作时结束为 closed，即使上下文 PR 仍开放。调换消息到达顺序并重放事实，结局仍按实际关闭时间确定且只通知一次。对没有自建 PR 的 Ticket，所有跟踪的 PR 都关闭后再结束。
- `AC-034` verifies `FR-012`, `IR-007`, `FR-003`: Worker 报告 ready 后接手了一条人工追问。关闭终端，再让其唯一绑定 PR 合并。宿主记下 merged，此时 Ticket 仍 open。Worker 处理完并再次报告 ready 后，终端重连可见一次 ended/merged。若宿主暂时读不到 PR，Ticket 保留原状态。

- `AC-035` verifies `FR-013`, `IR-008`, `FR-007`: 准备执行中、排队中、等待人工、待评审和已被用户暂停的 Ticket，在有未提交改动及未读 Input 时重启后台。核对旧 Assignment 的中断原因、新 Assignment 与原 Ticket、Worker thread 和目录的关联；pending 工作只排队一次，未读 Input 只补交一次，已读 Input 不重复出现。反复扫描后各 Ticket 仍只有一个有效执行者，等待与暂停状态按 FR-013 保留。
- `AC-036` verifies `IR-008`, `SEC-001`, `FR-013`: 模拟远端已创建 PR 但宿主未保存回执就退出。重启后查到同一 Ticket 分支对应的 PR，补记其编号并继续跟踪，只存在一个 PR。分别模拟远端状态未知与写入授权已撤回，确认均不会自动重发写入请求。

- `AC-037` verifies `IR-007`, `FR-012`, `FR-013`: 让已绑定 PR 在宿主停机期间合并。后台重新启动后，仅通过主动读取取得 merged 及实际关闭时间，补记结果并按 Ticket 的在途状态判断结束。在一次读取失败后再次取得相同结果，只产生一次结束通知。未绑定的 PR 保持在查询范围之外。

- `AC-038` verifies `AI-005`, `IR-007`, `NFR-004`: 用可控时钟验证普通 PR 轮询间隔为 60 秒，服务要求延长至 120 秒时按 120 秒等待。模拟同一 Worker turn 的可重试故障，核对首次失败后只在分别等待 15、30、60 秒后发起三次额外尝试。后台测试的独立 30 分钟窗口按 AC-026 验收。

- `AC-039` verifies `SEC-010`, `SEC-001`, `SEC-004`: 在同一绑定仓库分别模拟专用账号校验成功、误用了开发者个人登录，以及专用账号只有读权限。后两种情况均可见阻塞原因且没有远端写入。校验成功时，报告一个同分支但作者不符的 PR、一个专用账号创建但属于另一 Ticket 分支的 PR，以及正确的 PR。只有最后一个能作为该 Ticket 自建的 PR 绑定。

- `AC-040` verifies `IR-009`, `SEC-010`, `SEC-004`: 在宿主同时配置个人登录和 agent 专用入口。用后者完成身份检查、推送 Ticket 分支、创建 PR 并轮询同一 PR，验证写入身份为绑定的 agent 账号。再退出专用入口的登录并保留个人登录，确认后续写入报告专用账号未登录，个人账号没有产生写入，Worker 和测试子进程无法取得该 credential helper。

- `AC-041` verifies `DR-005`, `BR-006`, `FR-008`: 在 Ticket A 的工作目录中保留一份未提交的复现材料，让绑定 PR 合并并结束 Ticket。执行容器退出后，材料仍在原目录。对符合恢复条件的人工追问，Worker 复用该目录。另在用户主动清理目录后确认 Ticket 历史、测试摘要与另一张 Ticket 的目录仍可查询；后续恢复时准确呈现原目录缺失，不能声称已恢复该未提交材料。

- `AC-042` verifies `IR-010`, `SEC-011`, `FR-010`: 两个终端为同一绑定仓库获取相同的回环端点并连接同一默认 Thread。持有有效本地凭据的终端发出暂停后，目标 Ticket 显示暂停；分别用缺失凭据与无效凭据请求恢复或修改仓库授权，均被拒绝，Ticket 仍暂停，授权记录保持原值。服务没有对外网卡监听管理端口。

- `AC-043` verifies `IR-011`, `DR-006`, `SEC-012`, `IR-002`: 同时运行两个 Ticket，核对 Worker App Server 及内置命令分别位于各自容器。从 shell 和测试进程读取受保护的模型鉴权测试标记时均无法获取。替换其中一个容器，宿主重新连接该 Ticket 的原 thread 并交付一条新的 Input，核对历史连续、Input 只处理一次，另一 Ticket 状态保持原值。另模拟持久会话状态缺失，确认能够看到恢复阻塞。

- `AC-044` verifies `SEC-013`, `SEC-012`, `AI-005`, `IR-008`: 用隔离的测试凭据验证 Worker App Server 可以调用模型，同容器的 shell、安装脚本与测试进程均无法取得或借用该凭据。模拟凭据失效时，终端报告鉴权阻塞且日志不含密钥。替换凭据后，在满足恢复条件时接续原 Ticket 与 thread；已确认成功的远端操作和已处理 Input 均不重复执行。

- `AC-045` verifies `DR-007`, `DR-004`, `DR-005`, `BR-004`: 选取一张已结束的 Ticket，经过时间推进与一次后台重启后，从终端按原始 Trigger 追溯其投递去向、Decision、Mandate、各次 Assignment、Report 和 PR 回执。用户手动清理该 Ticket 的工作目录与失败片段后，仍可还原这条业务链和运行摘要，已清理的片段仍显示清理标记；重复提交同一 Trigger ID 不产生第二张 Ticket。

- `AC-046` verifies `FR-002`, `FR-003`, `FR-005`, `FR-012`, `IR-003`, `IR-007`, `OBS-001`: 在独立测试仓库创建两张可区分的 Ticket。让其中一张的初次测试在关闭终端后失败，核对只有原 Ticket 的 Worker 接续并完成修复与复测，另一张的工作目录与状态符合各自输入。由专用账号在该测试仓库创建 PR，核对实际提交和验证记录。模拟创建成功但本地回执丢失并重启，确认宿主找回同一个 PR。测试操作者按仓库流程合并，后台轮询后终端出现一次正确的结束结果。保存完整证据链。

## Decision Register

| ID | 决策 | 状态 | 决策人 | 提议或来源 |
|---|---|---|---|---|
| `DEC-001` | 受管会话的来源 | 已确认 | 用户 | 新任务由系统创建并续接各自的会话。用户回复 `1a,2a` 中的 `1a` |
| `DEC-002` | 入口形式 | 已确认 | 用户 | 使用本地终端入口。用户回复 `1a,2a` 中的 `2a` |
| `DEC-003` | Ticket 工作目录与并发边界 | 已修订确认 | 用户 | v0.33 选择 A，提供仓库可配置的 executor.prepare 和 worktree 示例。空命令创建独立空目录。Git 基线见 DEC-015，并发与暂停见 DEC-013、DEC-014 |
| `DEC-004` | 首版产品边界 | 继承 | 用户 | 单用户、工作由用户发起、本地测试接续、授权仓库自动发 PR，来源为已批准意图 |
| `DEC-005` | Worker Report 与 PR 交付 | 已确认交付语义 | 用户 | 按 2026-11-19 的优先级指示，Worker 按 Ticket 及仓库要求验证、自审和发 PR，受阻时可保存草稿。宿主校验仓库写入授权和所报 PR 归属。验证充分是 `ready` 的条件 |
| `DEC-006` | 后台与执行技术栈 | 已确认 | 用户 | 两次分别选择 A，确定以 TypeScript/Node.js 实现本地后台，用 SQLite 保存业务状态，通过 Codex App Server 驱动 Main 和 Worker Session |
| `DEC-007` | 领域与执行架构来源 | 已确认 | 用户 | 用户要求完全借鉴 `dsh-superagent-prototype` 的概念。以原型的领域关系、生命周期和双层 Session 为基线 |
| `DEC-008` | 暂停与 Stop 的映射 | 已确认 | 用户 | 选择 A。暂停时中断当前 turn，已启动的测试跑完并保存结果，用户明确继续后才恢复执行。暂停保留 Mandate，原型的明确 `stop` 撤回 Mandate |
| `DEC-009` | 术语修正 | 已澄清 | 用户 | 用户确认此前拼写指的是原型的 Mandate，已纳入领域基线（`DEC-007`） |
| `DEC-010` | 终端来源 Thread | 已确认 | 用户 | 选择 A，一个持久的默认 Thread。重新打开终端自动接回来源对话，多项 Ticket 共享该来源并分别订阅 |
| `DEC-011` | 工作仓库归属 | 已确认 | 用户 | 选择 A，后台启动时绑定一个工作仓库，所有 Ticket 使用该仓库。推送与发 PR 时仍须检查当前远端授权 |
| `DEC-012` | 远端写入责任 | 已确认 | 用户 | Worker 选择交付时机并发起请求。本地宿主持有写凭据、检查当前授权并执行写入。用户回复「可以的」 |
| `DEC-013` | 满载时的调度 | 已修订确认 | 用户 | v0.32 根据复盘后的用户确认，将 v0.31 及之前的硬上限 3 改为 3 个普通槽位加 1 个人工追问唤醒名额。新 Ticket 和普通事件仅使用普通容量 |
| `DEC-014` | 暂停后测试收尾与槽位释放 | 已确认 | 用户 | 用户选择 A。暂停生效时释放槽位，已有测试在槽位外收尾。因而机器可同时运行三张活跃 Ticket 和此前暂停 Ticket 的收尾测试 |
| `DEC-015` | 未指定分支时的 Ticket 基线及 PR 目标 | 已确认 | 用户 | 用户选择 A。新 worktree 从绑定仓库的远端默认分支起步，PR 以同一分支为目标 |
| `DEC-016` | 领域工具接入方式 | 已确认 | 用户 | 用户选择 A。使用 App Server 的 thread 动态工具，宿主从回调上下文识别调用者并校验角色和 Assignment |
| `DEC-017` | Main 与 Worker 的模型选择 | 已确认 | 用户 | 用户选择 A。默认使用本机 Codex 模型，允许按角色覆盖，配置变更作用于新建的对应 Session。记录每个 Session 实际使用的模型 |
| `DEC-018` | 模型暂时不可用 | 已确认 | 用户 | 用户选择 A。保持当前模型，有限重试，耗尽后保留进展并显示原因。Worker turn 的次数与间隔见 DEC-035 |
| `DEC-019` | 本地测试日志的留存内容 | 已确认 | 用户 | 用户选择 A。逐次保存运行摘要，失败时附限长错误片段，供终端重连后复盘 |
| `DEC-020` | 失败片段保留期限 | 已确认 | 用户 | 用户选择 B。失败片段随 Ticket 保留，由用户手动清理，运行摘要继续保留 |
| `DEC-021` | Worker 和测试子进程出网 | 已确认 | 用户 | 用户选择 B。按仓库预授权外部地址，命中允许列表的依赖获取可自动执行，未授权访问受阻时说明目标及用途 |
| `DEC-022` | 仓库出网授权粒度 | 已确认 | 用户 | 用户选择 A。按完整主机名和端口授权，HTTPS 默认端口为 443，跳转目标逐项匹配 |
| `DEC-023` | 连续修复何时暂停 | 已确认 | 用户 | 用户选择 A。根据可核查的进展和下一次验证的价值判断，反复失败且无法推进时报告阻塞 |
| `DEC-024` | 无人值守时的 Worker 用量 | 已修订确认 | 用户 | v0.34 选择 A。首版展示每张 Ticket 的 Worker 用量与供应方限制状态，Main 单独计量；本地配额延期 |
| `DEC-025` | 预算宽限 | 已后置 | 用户 | 随 DEC-024 延期。首版收到迟到回执只更新统计 |
| `DEC-026` | 后台测试等待时限的起点 | 已确认 | 用户 | 用户选择 B。对自主执行中的 Ticket，从 Worker 结束 turn 并开始等待后台测试时计时 |
| `DEC-027` | Worker 的本地项目源码读取范围 | 已确认 | 用户 | 用户选择 A。首版将自动读取的项目源码限定在当前 Ticket 的 worktree 内，用户可主动提供具体片段 |
| `DEC-028` | 命令与测试的执行环境 | 已确认 | 用户 | 用户选择 A。每张活跃 Ticket 使用独立的本地 Linux 容器。宿主管理 worktree、远端凭据、推送及 PR |
| `DEC-029` | 仓库开发镜像来源 | 已确认 | 用户 | 用户选择 A。仓库绑定时指定预先准备好的开发镜像，工具链升级由用户更新镜像配置，项目依赖由 Worker 在 Ticket 容器内准备 |
| `DEC-030` | 终端与常驻后台的启动关系 | 已确认 | 用户 | 用户选择 A。已绑定仓库的终端入口自动启动或连接唯一后台实例，退出终端时后台继续运行 |
| `DEC-031` | 用户明确停止后台 | 已确认 | 用户 | 用户选择 B。取消活跃执行，终止后台测试，保留排队输入和已完成的工作后退出 |
| `DEC-032` | 已绑定 PR 的结束反馈 | 已确认 | 用户 | 用户明确选择扩大首版范围至绑定 PR 的关闭、合并与 Ticket 收尾。CI、评审评论另行讨论 |
| `DEC-033` | 后台重启后的工作恢复 | 已确认 | 用户 | 用户选择 A。后台重新运行后核对既有工作，使用新 Assignment 接续被中断的原 Ticket。保留人工暂停及等待状态 |
| `DEC-034` | 已绑定 PR 的状态获取方式 | 已确认 | 用户 | 用户选择 A。宿主主动轮询，重启后用同一路径核对停机期间的状态变化。默认轮询周期见 DEC-035 |
| `DEC-035` | 轮询、Worker 重试和后台等待的默认参数 | 已确认 | 用户 | 用户选择 A。PR 轮询 60 秒；Worker turn 最多额外重试 3 次，间隔依次为 15、30、60 秒；turn 结束后的后台等待窗口为 30 分钟 |
| `DEC-036` | GitHub 写入身份 | 已确认 | 用户 | 用户选择 A。宿主使用 agent 专用 GitHub 账号，启动时核实身份和仓库推送权限，绑定新建 PR 时核对仓库、作者和 Ticket 分支 |
| `DEC-037` | GitHub CLI 与 Git 凭据接入 | 已确认 | 用户 | 用户选择 A。绑定仓库时指定独立登录的专用 gh 入口。宿主用它访问 PR，并为 Git 推送使用相同账号的凭据 |
| `DEC-038` | 已结束 Ticket 的工作目录 | 已确认 | 用户 | 用户选择 A。保留目录及未提交文件，由用户手动清理。原型依据为 `prompts/work.md:38` 与 `docs/002-authorization.md:127` |
| `DEC-039` | 终端与宿主的本机连接 | 已确认 | 用户 | 用户选择 A。使用回环 HTTP 连接，写操作校验本地用户访问凭据。多终端发现并连接同一仓库实例 |
| `DEC-040` | Worker App Server 部署位置 | 已确认 | 用户 | 用户选择 A。每张活跃 Ticket 的 Worker App Server 与本 Ticket 的工具执行环境位于同一专属容器，宿主负责领域状态、调度与远端写入 |
| `DEC-041` | Worker 模型鉴权方式 | 已确认 | 用户 | 用户选择 A。Worker App Server 使用宿主管理的专用模型 API key。仓库命令与测试子进程不得读取或使用该凭据 |
| `DEC-042` | SQLite 业务历史保留 | 已确认 | 用户 | 用户选择 A。对已经形成的业务记录长期保留原始内容及关联，不按 Ticket 结束时间自动删减。工作目录及测试片段按各自的手动清理规则处理 |
| `DEC-043` | 首次真实端到端验收环境 | 已确认 | 用户 | 用户选择 A。独立测试仓库承接真实 Codex 和 GitHub 验收，以便可重复制造失败、重放及核对副作用 |

### 2026-11-20 原型对照复盘

对照本地参考仓库 `deepseek-ai/dsh-superagent-prototype`（HEAD `8c32a9d`）。下表评价已选方案和参考实现的对应程度。复盘后已确认的更正列入对应决策；其余建议保留原决策，供后续讨论。以下文件位置均以该参考仓库为根。

| 对照项 | 原型的实际行为与证据 | 当前首版的差异和判断 |
|---|---|---|
| DEC-001、DEC-007、DEC-009 · 领域主线 | Thread 持有订阅和待评估 Trigger，Eval 接受后生成 Decision 与 Mandate，Ticket 经 Assignment 连接持久 Worker。追问直通，所有负责它的 Worker 交回后才重新评估。见 [领域模型](../../deepseek-ai/dsh-superagent-prototype/docs/001-domain.md) 和 `src/core/intake.ts` | 一致。Main、Worker 和 Engine 的职责及工作上下文能覆盖核心学习目标。保留。 |
| DEC-002、DEC-010、DEC-030 · 消息从哪里来 | GitHub Issue、PR、飞书话题等由 Source 定义 Thread。服务由部署入口启停，面板展示待人工处理事项。见 [部署与服务管理](../../deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md) | 终端自动连接后台是本地适配。一个永久默认 Thread 会将人的每条消息扇出给其多个相关订阅者，甚至可能唤醒仍符合恢复条件的已结束 Ticket。保持单一用户入口是正确的；若要学习跨 Thread 的 attach 和 Correlation，需补多来源 Thread 的用例。 |
| DEC-004、DEC-011 · 谁可发起工作 | 一次部署服务一个仓库。明确请求在各模式均有效。推断请求由 Gate、规则和模式控制，默认 observe 仅记录 would-accept；auto 才能授权满足规则的推断工作。见 [准入与模式](../../deepseek-ai/dsh-superagent-prototype/docs/002-authorization.md) | 单仓库一致。只让本人开启新工作是有意裁剪，只覆盖原型自主性的一部分。保留已交代工作的主动接续。若需学习主动发现工作，应另审规则授权和 observe 阶段。 |
| DEC-003、DEC-015 · 目录与基线 | 每 Ticket 一个目录。首次准备可配置命令，默认空命令会得到空目录。部署示例 fetch 来源 PR head 或远端 HEAD 再建 worktree。见 [执行目录](../../deepseek-ai/dsh-superagent-prototype/docs/003-execution.md#preparing-a-ticket-directory) 及 `docs/006-deployment.md` Settings | v0.33 已将内置 worktree 改为按仓库配置 prepare。空配置和 Git 示例各有验收；容器与宿主凭据隔离属于本地适配。 |
| DEC-005、DEC-012 · PR 与执行权 | Worker 用 agent 账号的 Git/gh 实施提交、推送和建 PR，在 Report 中给出实际检查与 PR 编号；宿主校验 PR 归属。开放 PR 上的 ready 表示等待评审，原型还处理 CI、评审和相关 PR 结束。见 [Worker 指令](../../deepseek-ai/dsh-superagent-prototype/prompts/work.md)、`src/sources/github-pull.ts` 和 `docs/003-execution.md` | Worker 判断验证充分性和可交草稿一致。改成宿主持凭据、每次写前核验授权是本地权限设计。v0.35 已接入规格范围中的关闭或合并事实与结束条件（DEC-032）。CI 和评审评论仍是后续范围。 |
| DEC-006、DEC-016 · 运行时 | TypeScript 与 SQLite 承载领域和持久化。DSH 注册有角色作用域的工具并管理 Session。见 `src/app/runtime.ts`、`src/app/store.ts`、`src/app/sessions.ts` | 数据与角色职责对应。Codex App Server、动态工具回调和 thread/turn 标识是替换 DSH 宿主所需的适配，实际端到端可行性待验。 |
| DEC-008、DEC-014 · 单工单暂停与人工交接 | 人明确要求等待确认时，提示词要求持续遵守。Worker 报告问题或交回人工后释放槽位，留下的 job 结束时只登记结果。全局 processing pause 保留正在运行的 turn。见 [角色提示词规则](../../deepseek-ai/dsh-superagent-prototype/docs/004-prompts.md)、`src/executor/dsh.ts:588` 和 `docs/003-execution.md` | 人拥有暂停控制和人工交接释放槽位有对应依据。本地把这些行为组合为硬性单 Ticket 暂停，并中断 turn，是新增控制。明确的 stop 仍撤回 Mandate。 |
| DEC-013 · 满载时的人类追问 | 普通上限默认 3 且可配置；已有工单收到人的消息时能占用上限外的 1 个唤醒槽位。普通新工单仍排队。见 `src/policy.ts:93` 和 [WorkerSlots.reserve](../../deepseek-ai/dsh-superagent-prototype/src/executor/dsh.ts) | 已于 v0.32 修正为 3 个普通槽位加 1 个人工追问唤醒名额。NFR-002、BR-008、AC-011 分别规定计数、资格和满载验收。 |
| DEC-017、DEC-018 · 模型与重试 | 新 Session 可按角色指定模型，已有选择保留。Worker 的瞬态失败有限重试；turn 的等待为 15、30、60 秒。Main 的 Eval 有独立的过期、重排和 unavailable 语义。见 `src/app/role-models.ts`、`src/executor/dsh.ts:545` 和 `src/core/evals.ts:56` | 角色选择及 Worker 策略相符。Worker turn 首版采用上述三次退避；Main 的 Eval 单独处理过期与重排。 |
| DEC-019、DEC-020 · 测试证据和保留 | Worker 要报告实际检查，通过 job 工具读取输出，Store 保存领域记录与回执。原型文档指出多类领域记录持续保留。见 `prompts/work.md:39`、`docs/007-architecture.md:450` | 本地测试运行摘要、限长失败片段和按 Ticket 手动清理是新增的数据契约。原型领域表长期保留不足以证明测试输出也有相同留存规则。 |
| DEC-021、DEC-022、DEC-027、DEC-028、DEC-029 · 执行环境 | Worker 以操作者 OS 用户执行。每个 Ticket 有专属目录和账号工具配置，部署文档建议需要隔离时使用专用 OS 账号。见 [部署权限说明](../../deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md) 和 `src/app/sessions.ts:152` | 精确主机与端口出网规则、限定 worktree 源码、每 Ticket 容器、预制镜像都是本地隔离设计，显著增加工程量。可保留这些明确选择，在实现与验收上独立于 Ticket/Eval 内核。 |
| DEC-023、DEC-026 · 持续执行 | 判断停滞依据是可行尝试与证据。普通 turn 结束后仍有后台工作则继续占槽，等待窗口从此时计算，原型上限 30 分钟。见 [范围判断](../../deepseek-ai/dsh-superagent-prototype/prompts/team/scope.md) 和 `docs/003-execution.md:31` | 关键语义一致。首版聚焦本地测试，原型还管理 shell job、子 agent 等。首版后台等待窗口已确认为 30 分钟。 |
| DEC-024、DEC-025 · 用量预算 | `src/app/retry-health.ts` 投影供应方的预算重试等待。参考仓库的 Engine 和 Executor 中未找到逐 Ticket 配额或回执宽限 | v0.34 已后置这两项。供应方限制状态对应原型，按 Ticket 展示 Codex token 是本地观测能力。 |
| DEC-031 及意图中的重启边界 | Runtime 取消活跃 Session 并保留 inbox；Effects 停止启动新项且等待已发出的操作收尾；Executor 停止后台 job，之后刷新持久化并释放锁。重启时，原型为被打断的活跃工作建立新 Assignment 并提供恢复说明。见 `src/app/runtime.ts:229`、`src/executor/dsh.ts:391` 和 [执行恢复](../../deepseek-ai/dsh-superagent-prototype/docs/003-execution.md#restart) | 停机选择 B 与原型匹配。v0.36 已将后台重新启动后的状态对账、Assignment 替换与防重纳入首版（DEC-033）。开机自启与异常退出后自动拉起进程仍在范围之外。 |

## Constraints, Dependencies, Assumptions, and Risks

- 约束：已批准意图的本地、单用户及按仓库授权边界。
- 依赖：可用的 Codex 登录和执行环境、可在本地运行的项目测试、用户授权的 PR 远端。
- 假设：本机 App Server 可稳定续接后台测试驱动的多轮工作。规格验证应使用独立的测试会话与仓库观测，当前验证只覆盖已有会话的发现与读取。
- 风险：错误关联和重复派工可能改变无关工作。测试输出和 Codex 判断只能进入相应的工作决策，远端目标须由独立授权检查确定。暂无用户接受的新增风险。

## Requirement Traceability

| 已批准的结果 | 规格要求 | 验收 |
|---|---|---|
| 自动交付使用可辨认的专用账号，PR 归属可核验 | `IR-009`, `SEC-010`, `SEC-001`, `SEC-004` | `AC-039`, `AC-040` |
| 无人值守运行的默认时序 | `AI-005`, `IR-007`, `NFR-004` | `AC-038`, `AC-026` |
| 从待评审持续到已绑定 PR 的最终结果 | `FR-012`, `IR-007` | `AC-033`, `AC-034`, `AC-037` |
| 后台重新启动后接续工作并核对外部操作 | `FR-013`, `IR-008`, `SEC-001` | `AC-035`, `AC-036` |
| 整体后台显式停机保留工作 | `FR-011`, `DR-002` | `AC-031` |
| 单一入口、自动管理会话、歧义时澄清 | `FR-001`, `FR-002`, `FR-006`, `FR-010`, `BR-005`, `BR-007`, `AI-001`, `AI-002`, `AI-003` | `AC-001`, `AC-007`, `AC-009`, `AC-030` |
| 关闭入口后自动接续已有工作 | `FR-003`, `DR-001`, `IR-001`, `IR-002`, `IR-003`, `IR-004`, `OBS-001` | `AC-002`, `AC-015` |
| 授权仓库允许草稿 PR，相关检查通过后交付评审 | `FR-005`, `BR-002`, `SEC-001`, `SEC-003`, `SEC-004` | `AC-003`, `AC-008`, `AC-010` |
| 人能暂停、其他任务继续，Worker 按证据判断是否继续修复 | `FR-004`, `FR-007`, `NFR-001`, `BR-009` | `AC-004`, `AC-023` |
| 有界并发下接续已有工作 | `NFR-002`, `NFR-003`, `NFR-004`, `FR-007`, `BR-008` | `AC-011`, `AC-012`, `AC-026` |
| 同仓库中各工作独立执行并保留进展 | `FR-008`, `FR-009`, `DR-001` | `AC-013`, `AC-014` |
| Worker 报告可追溯到正确的 Ticket 与 Assignment | `IR-005`, `SEC-005`, `AI-003` | `AC-016` |
| 区分路由与执行角色，核对模型选择及故障处理 | `AI-004`, `AI-005`, `OBS-002` | `AC-017`, `AC-018` |
| Worker 用量可复盘，供应方限制可定位 | `OBS-004`, `AI-005` | `AC-032` |
| 复盘失败测试及后续验证 | `DR-003`, `DR-004`, `OBS-003`, `SEC-004` | `AC-019`, `AC-020` |
| 在仓库授权范围内自动准备依赖和测试 | `SEC-006`, `SEC-007`, `SEC-004`, `FR-004` | `AC-021`, `AC-022` |
| Worker 的本地项目源码上下文限于当前 Ticket | `SEC-008`, `FR-004` | `AC-027` |
| Ticket 的执行与宿主凭据隔离 | `SEC-009`, `SEC-004`, `SEC-006`, `SEC-008` | `AC-028` |
| 独立测试仓库的真实后台交付与收尾 | `FR-003`, `FR-005`, `FR-012`, `IR-003`, `IR-007` | `AC-046`, `AC-036` |
| 已结束工作可按原始消息复盘、去重与对账 | `DR-007`, `DR-004`, `DR-005`, `BR-004` | `AC-045` |
| Worker 模型鉴权、隔离及换钥后接续 | `SEC-013`, `SEC-012`, `AI-005`, `IR-008` | `AC-044` |
| Worker 容器内执行及重建后的会话连续性 | `IR-011`, `DR-006`, `SEC-012`, `IR-002` | `AC-043` |
| 单用户终端可以重连并提交获准的控制操作 | `IR-010`, `SEC-011`, `FR-010` | `AC-042` |
| Ticket 结束后可检查或接续原工作目录 | `DR-005`, `BR-006`, `FR-008` | `AC-041` |
| Ticket 的工具链环境可追溯 | `IR-006`, `SEC-009` | `AC-029` |
| 仅用户发起新工作，接单可追溯且不重复 | `BR-001`, `BR-003`, `BR-004`, `BR-006`, `DR-002`, `SEC-002` | `AC-005`, `AC-006`, `AC-008` |

## Specification Readiness

- Status: READY FOR HUMAN REVIEW
- Version: 0.46
- 语义评分：85/100。意图、功能与验收可追溯性各 4/4；状态与恢复、技术架构、权限与数据、模型与工具控制、运行与成本各 3/4。评分评价规格充分性。
- 规格层阻塞：无。动态工具、容器内的工具执行、会话续接、模型密钥隔离、网络出站控制和恢复防重均须取得目标环境实测证据，属于发版条件。若已确认的单容器布局无法满足服务身份与项目命令隔离，需要修订并重新批准规格。
- 范围与风险：原型对照复盘和决策表说明已确认的本地适配。没有用户接受的额外风险。CI 和评审评论、自动发现新工作、开机自启、逐 Ticket token 配额已列为后续范围。
- 检查边界：本版定义真实验收环境和通过条件。独立测试仓库的具体名称、失败片段字节上限等工程参数在执行对应验收前确定。

## Open Decisions

- 待验证动态工具在目标 Codex 版本上的注册、实际投递和会话续接。接口选择见 `DEC-016`，验收见 `AC-016`。
- 业务保留语义已由 DEC-042 确定。待验证服务进程与项目命令的权限隔离、密钥供给与网络过滤的接入方式。App Server 的部署边界已由 DEC-040 确定。Ticket 工作目录的保留方式已由 DEC-038 确定。

## Human Approval

- Decision: Pending
- Approver: Pending
- Approved version: Pending
- Approval evidence: Pending
- Conditions and accepted risks: None

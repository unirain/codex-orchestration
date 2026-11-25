# codex-orchestration

本地持续推进的 Codex agent 编排项目：用户从一个终端入口交代、补充、暂停和查询多项开发工作，后台管理 Codex session 并在授权范围内持续推进。

## 文档

- [intent.md](docs/project/intent.md) — 项目意图与范围
- [spec.md](docs/project/spec.md) — 系统规格
- [plan.md](docs/project/plan.md) — 已批准的实施顺序与任务契约
- [验收证据](docs/acceptance.md) — 44 项有效验收的实测环境及复跑入口
- [UML 架构图集](docs/uml/README.md) — 组件、领域对象、消息路由、后台接续、PR 收尾与重启恢复

## 双任务路由演示

使用 Node.js 24.2 或更高版本，从仓库根目录运行。执行 npm ci 安装已锁定版本的 Pi 终端组件；领域演示使用 Node 内置的 TypeScript、SQLite 与测试运行器。

```sh
npm ci
npm test
npm run demo:routing
```

演示依次输入「调整 follow up」「发送邮件有 bug」「刚才的 follow up，先改触发条件」。每一步打印不可变 Trigger 的原文、收到该消息的 Ticket、交回理由、接手者及实际端口调用次数。三步产生的新增 Eval 次数依次为 1、1、0，Worker 启动请求数依次为 1、1、0。Assessor 和 Worker 使用确定的测试应答，Engine、事务、订阅与提交后投递均使用实际实现。[演示入口](examples/routing.ts)

默认演示在临时目录运行。若需在退出后检查 SQLite，传入一个尚未存在的数据库路径。

```sh
npm run demo:routing -- ./routing-review.sqlite
sqlite3 ./routing-review.sqlite 'select id, json(value) from domain_disposition;'
```

来源对话的键为 `terminal:default`。在 `domain_decision` 和 `domain_ticket` 中可核对授权决定及两份 Mandate，在 `domain_effect` 中可核对投递和回执。每次 Engine 写命令及其待发操作共用一个 SQLite 事务，宿主以稳定 Effect ID 对账并执行已提交的操作。

领域代码基于 DeepSeek Harness Team 开源的 dsh-superagent-prototype（修订 `8c32a9d`），采用其 Thread、Eval、Decision、Mandate、Ticket 与 Assignment 模型。本地适配绑定终端操作者和仓库，限制 Gate 的可接单来源，以 SQLite 保存状态、事件历史和待投递记录。[原型源码](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9d/src/core) · [原型 MIT 许可](licenses/deepseek-superagent.txt)

## 启动真实后台

首版在本机 Node、Git、GitHub CLI、Docker 和 Codex App Server 上运行。已验证的主机与容器 Codex 版本为 0.171.0。工作目录和状态目录必须位于 Docker 能挂载的位置。macOS / Colima 下请选用户主目录中的位置。宿主工作树由程序管理，目标仓库的 origin 指向本次绑定的仓库。

先在本机准备一个带 Node、Git 和 Linux Codex 的固定版本开发镜像。测试中使用 `orch-local/codex-node:0.171.0`。仓库内的示例 Dockerfile 供操作者构建自己的可信镜像，Ticket 启动时只使用本机已准备的镜像。[准备镜像的命令](src/executor/container/README.md) · [镜像示例](src/executor/container/Dockerfile.example)

将如下绑定保存在 `~/.config/codex-orchestration/binding.json`，目录归当前用户所有，建议文件权限为 600。改为自己的仓库、路径和服务身份。专用 gh 配置须已登录绑定账号且具备该仓库的推送权限。模型凭据从指定的环境变量读取。

```json
{
  "repository": "OWNER/REPO",
  "repoDir": "/absolute/path/to/checkout",
  "actor": "local-owner",
  "codex": "/absolute/path/to/codex",
  "image": "orch-local/codex-node:0.171.0",
  "prepare": {"kind": "git"},
  "provider": "deepseek",
  "modelKeyEnv": "DEEPSEEK_API_KEY",
  "allow": [],
  "github": {
    "repo": "OWNER/REPO",
    "account": "AGENT-ACCOUNT",
    "gh": "/absolute/path/to/gh",
    "configDir": "/absolute/path/to/dedicated-gh-config"
  }
}
```

`allow` 接受精确的依赖源，例如 `registry.npmjs.org:443`。空列表适用于使用预装工具的项目。Git 准备模式使用远端默认分支。可指定 `baseBranch`，或使用 `{"kind":"empty"}`、`{"kind":"command","command":"…"}`。准备命令仅来自操作者管理的绑定文件。OpenAI 服务可选 `"provider": "openai"` 和相应的凭据变量。模型角色覆盖由 `mainModel`、`workerModel` 设置，新建会话读取对应选择。

```sh
node src/cli.ts grant
node src/cli.ts chat
```

交互终端默认使用 Pi TUI。Enter 发送，Shift+Enter 或 Ctrl+J 换行。后台回执按任务标题显示；/status 列出工单，/show 序号可看详情和来源消息标识，/trace 可查看最近一条可见用户消息的路由。独立运行 say、status、show、trace 时，屏幕显示可读内容，管道和重定向保留 JSON。

有待答问题时按 **Ctrl+R**，用方向键和 Enter 选中问题。编辑器标出目标任务和提交动作。仅因这个问题等待的工单可「回复并继续」，满槽时先排队；用户主动暂停或暂停来源未知时只保存答复。Esc 返回原来的普通草稿；没有选中问题时输入的一律按普通对话分流。/exit 退出界面，宿主继续工作。

重连按本机终端视图和仓库分别记录已读位置，/history 可逐页回看更早的消息。可用 ORCH_VIEW_ID 为同一个阅读视图设置稳定名称；不同并发终端使用各自的视图。旧宿主会显示兼容模式，仍可查看工单或使用原有控制命令。要启用定向答复，在空闲时用同一绑定和状态目录 stop，再用本版本 chat 启动。已有暂停原因无法确认时保留人工恢复。

```sh
node src/cli.ts say '修一下邮件地址校验，先复现问题，再修复并发 PR。'
node src/cli.ts status
node src/cli.ts show TICKET_ID
node src/cli.ts trace TRIGGER_ID
node src/cli.ts reassess TRIGGER_ID
node src/cli.ts track-pr TICKET_ID 123
node src/cli.ts clear-excerpts TICKET_ID
node src/cli.ts role-model worker deepseek-flash
node src/cli.ts revoke
node src/cli.ts stop
```

`track-pr` 将绑定仓库的一个 PR 作为上下文跟踪。已结束工单的原文、Decision、Mandate、报告和交付收据仍能通过 `trace` 查询。推送和建 PR 是独立的宿主写操作，可在两步之间撤权。停止后台后再次连接会触发恢复对账。SQLite 格式升级前，先执行 `stop` 并确认后台退出，再备份该实例的完整状态目录。回退时恢复与程序兼容的备份、绑定配置及会话卷，核对远端已发生的写入后再继续。

默认状态目录为 `~/.local/state/codex-orchestration` 下以仓库标识计算的子目录。同一绑定使用同一个状态根。`ORCH_CONFIG` 或 `--config` 可指定绑定路径，独立验收环境可用 `ORCH_STATE_ROOT` 指向另一处私有状态根。请保留实例信息文件和模型服务目录的原有权限。

## 集成验证

`npm test` 运行离线用例。设置 `CODEX_TEST_BIN` 为已验证的绝对可执行路径可启动真实本机 App Server 并使用可控响应服务。设置 `ORCH_TEST_IMAGE` 可运行真实容器用例。下列完整组合还会使用专用 DeepSeek 凭据发起真实模型调用。

```sh
CODEX_TEST_BIN=/absolute/path/to/codex \
CODEX_LIVE_DEEPSEEK=1 \
ORCH_TEST_IMAGE=orch-local/codex-node:0.171.0 \
ORCH_DEEPSEEK_LIVE=1 npm test
```

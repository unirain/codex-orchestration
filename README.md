# codex-orchestration

本地持续推进的 Codex agent 编排项目：用户从一个终端入口交代、补充、暂停和查询多项开发工作，后台管理 Codex session 并在授权范围内持续推进。

## 文档

- [intent.md](intent.md) — 项目意图与范围
- [spec.md](spec.md) — 系统规格
- [UML 架构图集](docs/uml/README.md) — 组件、领域对象、消息路由、后台接续、PR 收尾与重启恢复

## 双任务路由演示

使用 Node.js 24.2 或更高版本，从仓库根目录运行。测试和演示使用 Node 内置 TypeScript、SQLite 与测试运行器，无需安装软件包。

```sh
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

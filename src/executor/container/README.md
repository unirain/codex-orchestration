# Ticket 开发镜像

操作员在绑定仓库前准备 Linux 镜像。镜像需要 Node、Python 3、OpenSSL、Git、项目工具链，以及带 `app-server` 和 `exec-server` 的 Linux Codex。本项目的执行验收使用 Node 25.9.0 与 Codex 0.171.0。以下命令从仓库根目录运行，在临时构建上下文中准备 arm64 镜像。amd64 镜像将包版本后缀改为 `linux-x64`。

```sh
image_context=$(mktemp -d)
package_file=$(npm pack --silent --ignore-scripts --pack-destination "$image_context" '@openai/codex@0.171.0-linux-arm64')
mv "$image_context/$package_file" "$image_context/codex.tgz"
cp src/executor/container/Dockerfile.example "$image_context/Dockerfile"
docker build --network=none --build-arg BASE_IMAGE=node:25.9.0 \
  -t orch-local/codex-node:0.171.0 "$image_context"
docker image inspect --format '{{.Id}}' orch-local/codex-node:0.171.0
```

宿主按指定引用查找已存在的镜像，按解析出的 image ID 启动每张 Ticket。Git 准备模式从 origin 的真实默认分支取基线；可写的 Ticket 工作目录与宿主专用 Git 元数据分开。自定义准备命令可以读取 `TICKET_DIR`、`TICKET_ID`、`TICKET_SLUG` 和 `REPO_DIR`。

## 容器进程与仓库网络

每张 Ticket 的开发容器只有 loopback 接口。仓库命令由独立的 exec-server 以项目 UID 执行，当前源码只挂载在 `/workspace`。App Server 使用服务 UID 61000 并单独持久化 Ticket 的会话卷。启动时核实远端 exec-server 就绪，服务身份的本地文件及执行接口均已禁用。模型中继使用 UID 61001，通过私有 tmpfs 保存专用模型凭据，服务使用每次启动重新生成的凭证访问中继。

仓库的 HTTP(S) 请求经另一进程过滤，在只读挂载的 Unix 套接字上进入该 Ticket 的出网容器。允许项按完整主机及端口匹配，重新定向和同一 HTTPS 连接上的请求都核对目标。HTTPS 包请求在此受信容器中解密后转发，使用该 Ticket 专属的临时 CA 验证这一段连接。上游连接独立校验远端证书。公开 CA 在项目环境的 TLS 变量中配置，签名私钥只在出网容器 tmpfs 中。依赖客户端须支持显式 HTTP 代理和自定义 CA；要求证书固定或使用其他网络协议的工具会看到连接失败。

## 验证

```sh
ORCH_TEST_IMAGE=orch-local/codex-node:0.171.0 node --test tests/executor-*.test.ts
```

上述命令验证真实 Git 仓库、并行 Linux 容器、依赖安装、网络重定向、测试取消、停止遗留进程和目录保留。额外的 DeepSeek 验收需要专用 `DEEPSEEK_API_KEY`，会验证两次成功的模型 turn 和一次失效凭据的请求。它在容器重建前后检查同一 Codex thread、项目身份和工作目录证据。

```sh
ORCH_DEEPSEEK_LIVE=1 ORCH_TEST_IMAGE=orch-local/codex-node:0.171.0 \
  node --test --test-name-pattern DeepSeek tests/executor-container.test.ts
```

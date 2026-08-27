# dsh-openapi-codex-oauth

[English](README.md) | 简体中文

让 DeepSeek Harness（DSH）使用 ChatGPT 账户中的 Codex 模型与套餐额度。插件把 `openai-codex` 注册成 DSH 原生 LLM Provider；DSH 继续负责 Agent 循环、会话记录和工具执行。

插件使用 OpenAI 官方 `@openai/codex` 包启动本地 Codex App Server，由 App Server 管理 ChatGPT 登录、凭据保存、token 刷新、模型发现和推理请求。它不会把 ChatGPT Cookie 或 OAuth token 转发给 DSH，也不会调用未公开的 ChatGPT 网页接口。

## 环境要求

- Node.js 22.19 或更高版本
- DeepSeek Harness `0.1.1-rc.2`（peer 范围也接受 `0.1.0-rc.6` 起的兼容 RC 版本）
- 一个具有 Codex 使用权限的 ChatGPT 账户

## 安装

### 方式一：使用 npx 安装 Release（推荐）

不需要克隆 DSH 或本插件源码，也不需要全局安装 pnpm。下面的命令从 GitHub Release 临时运行安装器，并把插件注册到 `~/.dsh/profiles/web`：

```sh
PLUGIN_URL='https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.0/dsh-openapi-codex-oauth-0.2.0.tgz'
npx --yes --package="$PLUGIN_URL" dsh-openapi-codex-oauth install --profile web
```

如果访问 npm 官方源超时，可只对本次安装使用 npmmirror：

```sh
PLUGIN_URL='https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.0/dsh-openapi-codex-oauth-0.2.0.tgz'
npm_config_registry=https://registry.npmmirror.com \
  npx --yes --package="$PLUGIN_URL" dsh-openapi-codex-oauth install --profile web
```

安装器固定使用已验证的 `@deepseek-ai/dsh@0.1.1-rc.2`。如果 profile 已经存在，安装器会读取 `node_modules/.modules.yaml` 并使用创建该 profile 的 pnpm 版本，从而避免 `ERR_PNPM_UNEXPECTED_STORE`。

用 npm 版 DSH 启动 Web：

```sh
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 web
```

如果平时从 DSH 源码仓库启动，则继续使用：

```sh
pnpm dsh web
```

### 方式二：从插件源码构建安装

```sh
git clone https://github.com/L-ance/dsh_openapi_codex_oauth.git
cd dsh_openapi_codex_oauth
npm install
npm test
node lib/installer.js install --local --profile web
```

`--local` 会把当前构建目录安装到 DSH profile，适合开发和调试。安装或更新后需要重启正在运行的 DSH 进程。

## 登录 ChatGPT

### Web 界面

1. 启动 `dsh web`。
2. 打开“设置 > OpenAI OAuth”。
3. 选择“浏览器登录”或“设备码登录”。
4. 在 OpenAI 页面完成授权。
5. 回到模型选择器，选择 `openai-codex` 及账户可用的模型。

出于安全考虑，Web 登录、退出与账号状态接口只接受本机回环地址上的同源请求。如果 DSH Web 部署在远程主机，请在该主机终端使用下面的 CLI 登录。

### 终端登录

```sh
PLUGIN_URL='https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.0/dsh-openapi-codex-oauth-0.2.0.tgz'
npx --yes --package="$PLUGIN_URL" dsh-codex-login
```

无浏览器或远程环境可以使用设备码：

```sh
npx --yes --package="$PLUGIN_URL" dsh-codex-login --device-auth
```

登录数据保存在 `~/.deepseek-harness/codex-app-server`，也可以用 `DSH_CODEX_HOME` 指定独立目录。该目录中的文件完全由 Codex 管理。

插件默认运行 `@openai/codex` 捆绑的当前平台二进制。如果部署环境单独管理 Codex，可用 `DSH_CODEX_BINARY` 指定原生可执行文件的绝对路径。

## 设置默认模型

模型列表来自当前 ChatGPT 账户，不在插件代码中写死。可在 DSH 模型选择器中设置，也可以按 DSH 的设置格式配置：

```yaml
agent-default-model:
  provider: openai-codex
  model: gpt-5.6-sol
  reasoningEffort: high
```

具体模型名和推理档位以登录后 App Server 返回的列表为准。

## 架构

```text
DeepSeek Harness agent loop
  ├─ sessions / tools / approvals（仍由 DSH 管理）
  └─ openai-codex LLM Provider（本插件）
       ├─ DSH 消息与流式事件转换
       ├─ DSH 动态工具调用桥接
       └─ official Codex App Server
            ├─ managed ChatGPT OAuth
            ├─ model discovery / rate limits
            └─ Codex model inference
```

Codex 内建的 Shell、浏览器、MCP、插件和多 Agent 能力在此 App Server 实例中被关闭。模型只能调用 DSH 提供的动态工具，避免两个 Harness 同时执行工具或绕过 DSH 权限控制。

## 安全边界

- OAuth 凭据不进入 DSH settings，也不会通过插件 HTTP 接口返回浏览器。
- Web OAuth 控制只允许回环地址、同源请求，并明确拒绝跨站请求。
- App Server 使用隔离的 `CODEX_HOME`，不会读取用户日常 Codex CLI 的登录文件或项目级 `.codex` 配置。
- App Server 以 `approvalPolicy: never`、`sandbox: read-only` 启动推理线程，同时关闭内建执行工具。
- `uninstall` 默认只删除 DSH 插件注册并保留登录；只有显式传入 `--purge-auth` 才会退出并清理隔离的认证目录。

完整卸载：

```sh
PLUGIN_URL='https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.0/dsh-openapi-codex-oauth-0.2.0.tgz'
npx --yes --package="$PLUGIN_URL" dsh-openapi-codex-oauth uninstall --profile web
npx --yes --package="$PLUGIN_URL" dsh-openapi-codex-oauth uninstall --profile web --purge-auth
```

## 已知限制

- 当前只桥接文本输入。插件会向 DSH 声明 text-only，图片会在发送前被拒绝。
- ChatGPT 套餐额度不是 OpenAI API 额度。本项目只通过官方 Codex App Server 使用账号可用的 Codex 能力，不提供通用 OpenAI-compatible HTTP API。
- ChatGPT 套餐和工作区的模型权限、速率限制及服务条款仍然适用。
- DSH 仍处于 RC 阶段，Codex App Server 协议也可能演进；升级任一上游后应重新运行测试。

## 参考

- [OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)

## 许可证

MIT

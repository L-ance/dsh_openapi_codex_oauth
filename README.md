# dsh-openapi-codex-oauth

English | [简体中文](README.zh-CN.md)

Use Codex models and the available Codex allowance from a ChatGPT account in DeepSeek Harness (DSH). The plugin registers `openai-codex` as a native DSH LLM provider, while DSH remains responsible for the agent loop, session log, and tool execution.

The plugin starts the official Codex App Server from `@openai/codex`. App Server owns ChatGPT sign-in, credential persistence, token refresh, model discovery, and inference. The plugin does not forward ChatGPT cookies or OAuth tokens to DSH and does not call unpublished ChatGPT web endpoints.

## Requirements

- Node.js 22.19 or newer
- DeepSeek Harness `0.1.1-rc.2` (the peer range also accepts `0.1.0-rc.6` and newer compatible RCs)
- A ChatGPT account with Codex access

## Installation

### Option 1: install the Release with npx (recommended)

This does not require a DSH or plugin source checkout, or a globally installed pnpm. It runs the installer directly from the GitHub Release and registers the plugin in `~/.dsh/profiles/web`:

```sh
npx --yes --package=https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.1/dsh-openapi-codex-oauth-0.2.1.tgz dsh-openapi-codex-oauth install --profile web
```

The installer repacks the current Release and the native Codex package for your platform into stable local tarballs before registering them with DSH. It pins the tested `@deepseek-ai/dsh@0.1.1-rc.2`; for an existing profile, it also reads `node_modules/.modules.yaml` and runs the pnpm version that created that profile. This prevents both `ERR_PNPM_UNEXPECTED_STORE` and missing remote-tarball integrity entries.

Start the npm-distributed DSH launcher with:

```sh
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 web
```

If you normally launch from a DSH source checkout, keep using:

```sh
pnpm dsh web
```

### Option 2: build and install from plugin source

```sh
git clone https://github.com/L-ance/dsh_openapi_codex_oauth.git
cd dsh_openapi_codex_oauth
npm install
npm test
node lib/installer.js install --local --profile web
```

`--local` packages the current source build and installs it into the DSH profile, which is useful for development. Restart a running DSH process after installing or updating the plugin.

## Sign in to ChatGPT

### Web UI

1. Start `dsh web`.
2. Open Settings > OpenAI OAuth.
3. Choose browser or device-code sign-in.
4. Complete authorization on the OpenAI page.
5. Select `openai-codex` and one of the account's available models in the model picker.

For safety, the Web login, logout, and account-status routes accept only same-origin requests over a local loopback address. When DSH Web runs on a remote host, sign in from that host's terminal instead.

### Terminal

```sh
npx --yes --package=https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.1/dsh-openapi-codex-oauth-0.2.1.tgz dsh-codex-login
```

Use device-code login on a headless or remote machine:

```sh
npx --yes --package=https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.1/dsh-openapi-codex-oauth-0.2.1.tgz dsh-codex-login --device-auth
```

Authentication state is stored under `~/.deepseek-harness/codex-app-server`. Set `DSH_CODEX_HOME` to use another isolated directory. Codex owns every file in that directory.

By default the plugin runs the platform binary bundled with `@openai/codex`. Set `DSH_CODEX_BINARY` to an absolute native Codex executable when a deployment manages that binary separately.

## Select a default model

Models are discovered from the signed-in account rather than hardcoded. Select one in the DSH model picker or use the DSH settings shape:

```yaml
agent-default-model:
  provider: openai-codex
  model: gpt-5.6-sol
  reasoningEffort: high
```

Available model ids and reasoning efforts are whatever App Server reports for the active account.

## Architecture

```text
DeepSeek Harness agent loop
  ├─ sessions / tools / approvals (still owned by DSH)
  └─ openai-codex LLM provider (this plugin)
       ├─ DSH message and streaming-event translation
       ├─ DSH dynamic-tool bridge
       └─ official Codex App Server
            ├─ managed ChatGPT OAuth
            ├─ model discovery / rate limits
            └─ Codex model inference
```

The App Server instance disables Codex's built-in shell, browser, MCP, plugin, and multi-agent capabilities. The model can call only the dynamic tools supplied by DSH, preventing two harnesses from executing tools or bypassing DSH permission controls.

## Security boundaries

- OAuth credentials do not enter DSH settings and are never returned by the plugin's HTTP routes.
- Web OAuth controls require loopback and same-origin requests and reject cross-site requests.
- App Server uses an isolated `CODEX_HOME`; it does not import a normal Codex CLI login or project `.codex` configuration.
- Inference threads use `approvalPolicy: never` and `sandbox: read-only`, with built-in execution tools disabled.
- `uninstall` keeps the isolated login by default. Only an explicit `--purge-auth` signs out and removes the authentication directory.

```sh
npx --yes --omit=optional --package=https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.1/dsh-openapi-codex-oauth-0.2.1.tgz dsh-openapi-codex-oauth uninstall --profile web
npx --yes --package=https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.1/dsh-openapi-codex-oauth-0.2.1.tgz dsh-openapi-codex-oauth uninstall --profile web --purge-auth
```

## Limitations

- This release bridges text input only. It advertises text-only capability so DSH rejects images before making a request.
- ChatGPT allowance is not OpenAI API credit. This plugin uses only the Codex capabilities exposed by the official App Server and does not create a general OpenAI-compatible HTTP API.
- Model availability, rate limits, workspace policy, and plan terms still apply.
- DSH is currently an RC and the App Server protocol can evolve. Run the test suite again after upgrading either upstream.

## References

- [OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)

## License

MIT

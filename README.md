# dsh-codebuddy-link

将腾讯 CodeBuddy CLI 接入 DeepSeek Harness (DSH) 的 Cordis 插件。参考 [amlyczz/dsh-agy-link](https://github.com/amlyczz/dsh-agy-link) 的 CLI provider 桥接思路，Provider 通过 ACP stdio 原生自主执行，独立委派与后台请求保留 `stream-json` 兼容调用。

## 功能

- **模型提供方**：在 DSH 中选择 `codebuddy/default`，优先使用插件保存的授权，否则回退到本机 CodeBuddy CLI 登录态。
- **ACP 原生执行（固定）**：Provider 主调用始终通过 ACP stdio 使用 CodeBuddy CLI 原生完整工具完成读写和命令，DSH 接收进度及最终结果；不再提供 bridge/DSH 工具协议解析模式（旧配置中的 `executionMode` 自动迁移，不可降级回旧模式）。
- **独立委派**：`codebuddy_ask` 接收一个独立问题，不自动发送 DSH 历史，默认关闭原生工具。
- `/codebuddy status`、`/codebuddy models`、`/codebuddy runs`、`/codebuddy help`。
- 主模型与独立委派共享思考强度默认值、进程内 FIFO 并发队列；设置页提供脱敏调用诊断和无进展提醒。
- 文本与思考流、usage、取消、超时、Windows npm 启动器及进程树回收。

## 安装

要求 Node.js **22.18+**，以及支持当前 LlmAdapter API 的 DSH（开发时使用 `@deepseek-ai/dsh-* 0.1.2-rc.1`）。CodeBuddy CLI 需支持 `--acp --acp-transport stdio`（ACP v1，provider 必需）以及独立委派使用的 `--print`、`--output-format stream-json`、`--include-partial-messages`、`--tools` 和 `--no-session-persistence`；本项目在 **2.177.1** 上核验参数和认证失败协议。

### 1. 安装 CodeBuddy CLI

```sh
npm install -g @tencent-ai/codebuddy-code
```

可在普通终端运行 `codebuddy` 完成登录，也可安装插件后在 **设置 → CodeBuddy → 账户登录** 中授权。运行 DSH 的用户必须能找到 CLI；桌面应用 PATH 尚未更新时可显式设置 `codebuddyBin`。本仓库不包含 CodeBuddy 本体。

### 2. 直接从 GitHub 安装（推荐固定版本）

需要本机安装 Git。公开仓库使用 HTTPS，不要求 SSH 密钥。将 `web` 替换成实际使用的 DSH profile：

```sh
dsh plugin --profile web add "git+https://github.com/liubaicai/dsh-codebuddy-link.git#v0.3.20"
```

仓库**包含已构建的 dist**，安装不依赖 TypeScript、开发依赖或安装时构建脚本。CI 会重新构建并检查提交的产物，避免源码与产物不一致。

跟随开发分支（可能包含未发布变化；需要更新时重新执行安装）：

```sh
dsh plugin --profile web add "git+https://github.com/liubaicai/dsh-codebuddy-link.git#main"
```

### 3. 无 Git 安装：使用 Release 包

从 [Releases](https://github.com/liubaicai/dsh-codebuddy-link/releases) 下载对应版本 `.tgz`，可使用同页 `SHA256SUMS.txt` 核对 SHA-256。进入下载目录后执行：

```powershell
dsh plugin --profile web add .\dsh-codebuddy-link-0.3.20.tgz
```

macOS/Linux 使用 `./dsh-codebuddy-link-0.3.20.tgz`。本地文件请带 `./`、`.\` 或使用绝对路径，不要只给裸文件名。

### 4. 启用与升级

安装后完全退出并重启对应 DSH 实例，在 **设置 → CodeBuddy** 获取模型列表，然后选择 `codebuddy/default` 或已启用模型。`/codebuddy status` 检查配置，但不代表认证已成功。升级时安装新的版本标签/安装包，再重启实例。

GitHub 安装或 Actions 不会读取你的 CodeBuddy 凭据；模型请求只在本机 DSH 调用 CLI 时使用配置的授权。插件凭据与 CLI 登录文件均不应提交到仓库。

## 设置面板（0.2.0）

安装并重启后，在 **设置 → CodeBuddy** 或插件详情页打开面板：

- 进入面板自动刷新账户；账户状态为“可用”后自动获取模型列表。也可手动点击“刷新账户”或“获取模型列表”，勾选要启用的模型并选择默认模型；手动输入保留在高级设置中。列表合并中国区、国际区配置和已安装官方 CLI 候选；来源不完整时会明确提示，候选不代表账户调用权限。
- 保存会立即刷新 DSH 模型目录，在会话模型选择器中选择 `codebuddy/<模型ID>`。取消启用的模型即使仍被旧会话选中，也不会继续调用。
- 默认模型用于未显式指定模型的调用（如 `codebuddy_ask`）；不会覆盖会话中明确选择的模型。`default` 特指 CLI 自己的默认模型。
- Provider 固定通过 ACP stdio 原生执行：设置页不再提供执行模式开关。可单独勾选 `--dangerously-skip-permissions`；无论是否勾选，ACP 原生工具都会绕过 DSH 沙箱和逐项确认，仅用于可信任务。
- `dontAsk` / `plan` / `acceptEdits` 对独立委派及未启用权限跳过的 ACP CLI 生效。
- 设置持久化在 `${DSH_HOME}/plugins/dsh-codebuddy-link/settings.json`（默认 `~/.dsh/...`）。面板只保存非敏感的模型和委派设置，不保存凭据。

### 共享积分（实验性，只读）

[官方定价文档](https://www.codebuddy.cn/docs/ide/Account/pricing) 说明 CodeBuddy 与 WorkBuddy 同一账号积分共享。进入设置面板、完成登录/导入或点击“刷新账户”时，插件向中国区官方 `https://www.codebuddy.cn/v2/billing/meter/get-user-resource` 发起只读查询；不轮询，不执行签到、购买、token 刷新或登录写回。仅识别的个人积分资源会显示余额，认证失败、格式变化或结果不完整时显示“需要登录 / 暂不可用”，不会用 token usage 估算积分。

**设置页支持浏览器授权和 JSON 导入（0.3.0）。** 在“账户登录”区域选择：

1. **浏览器登录**：发起授权，打开官方登录链接，完成登录后点击“检查登录结果”。可取消；授权约 10 分钟过期。
2. **JSON 导入**：粘贴 `{"access_token":"…","uid":"…"}` 或 `{"accessToken":"…","uid":"…"}`；也支持下方 CLI 会话结构。导入成功后输入框清空。JSON 必须包含对应的个人账户用户 ID；多余的 refresh token 和个人资料不会保存。

凭据由服务端单独保存到 `${DSH_HOME}/plugins/dsh-codebuddy-link/credentials.json`（默认 `~/.dsh/...`），不随状态接口返回，不保存到浏览器本地存储。文件是明文秘密，创建时使用 0600 权限；Windows 还需通过系统 ACL 保护 DSH 用户目录。不要将其提交仓库或上传聊天。远程访问 DSH 必须使用 HTTPS 和主机认证，禁止在公开未认证实例中使用。

这些授权**用于中国区积分及模型配置查询，不会发送到国际区接口**。自 0.3.9 起，保存的插件凭据还会自动作为 `CODEBUDDY_AUTH_TOKEN` 传给本机 CLI（该变量在 CLI 中的优先级高于其自身登录态），因此即使 CLI 未单独登录，模型调用也能完成；删除插件凭据后回退到 CLI 自身登录。不会自动提取桌面凭据、解密系统凭据库或改动官方客户端登录文件。清除授权只删除插件自己的凭据，不撤销官方会话。

保留管理员文件配置方式：`DSH_CODEBUDDY_CREDENTIALS_FILE`。面板凭据优先；清除后若仍设置此变量，积分查询会回退到该文件。文件使用下列结构（全部为占位值）：

```json
{
  "auth": { "accessToken": "<自己的有效个人账户 access token>", "tokenType": "Bearer" },
  "account": { "uid": "<对应的用户 ID>" }
}
```

在启动 DSH 的环境中设置该变量；更改文件后再次点击刷新即可重新读取。access token 过期时需通过官方登录流程更新，插件不使用 refresh token。暂不支持国际区、企业额度、API Key 或加密凭据文件。

**验证限制：该接口不是公开稳定 SDK 契约。** 请求与字段映射参考公开实现中的协议线索并采用独立实现；自动化测试使用模拟响应，不等于真实账户成功验收。当前环境尚未验证有效账户余额，也尚未在正在运行的 DSH 页面完成安装和视觉验收。上线前必须与同一账户的官方用量页核对；无法匹配时请保留未知状态并反馈脱敏后的字段结构，不要提交 token。

## 配置

Cordis 插件名为 `dsh-codebuddy-link`。优先级为 **面板已保存设置 > 插件 config > 环境变量 > 默认值**。面板允许覆盖模型、权限模式、委派 tools、思考强度、并发数、排队超时和无进展提醒阈值；CLI 路径等仍由插件配置控制。

| config | 环境变量 | 默认值 / 说明 |
| --- | --- | --- |
| `enabled` | `DSH_CODEBUDDY_ENABLED` | `true` |
| `codebuddyBin` | `DSH_CODEBUDDY_BIN` | PATH 中的 `codebuddy`；也可为 CLI JS 或 npm 启动器绝对路径 |
| `defaultModel` | `DSH_CODEBUDDY_DEFAULT_MODEL` | `default`；不传 `--model`，由 CLI 决定 |
| `models` | `DSH_CODEBUDDY_MODELS` | 数组 / 逗号分隔模型 ID；始终包含 `default` |
| `hiddenModels` | `DSH_CODEBUDDY_HIDDEN_MODELS` | 隐藏并禁止调用的模型 ID 数组 / 逗号分隔列表 |
| `workspaceRoot` | `DSH_CODEBUDDY_WORKSPACE_ROOT` | 当前 DSH session 工作目录；ACP 原生执行必需，缺失时拒绝启动 |
| `dangerouslySkipPermissions` | `DSH_CODEBUDDY_DANGEROUSLY_SKIP_PERMISSIONS` | `false`；仅 provider ACP 主调用生效，传入 `--dangerously-skip-permissions`，不影响 `codebuddy_ask` |
| `timeoutMs` | `DSH_CODEBUDDY_TIMEOUT_MS` | `600000`；获得并发槽位后启动 CLI 的执行预算，不含排队时间 |
| `reasoningEffort` | `DSH_CODEBUDDY_REASONING_EFFORT` | `auto`；主模型与独立委派共享默认值，允许 `auto/minimal/low/medium/high/xhigh/max/ultracode` |
| `maxConcurrency` | `DSH_CODEBUDDY_MAX_CONCURRENCY` | `2`；整数 1–16，当前插件实例内共享并发槽位 |
| `queueTimeoutMs` | `DSH_CODEBUDDY_QUEUE_TIMEOUT_MS` | `600000`；整数 1–2147483647，排队预算 |
| `stallWarnMs` | `DSH_CODEBUDDY_STALL_WARN_MS` | `90000`；整数 0–2147483647，0 关闭无进展提醒 |
| `contextWindow` | `DSH_CODEBUDDY_CONTEXT_WINDOW` | `128000`，未发现窗口信息模型的回退值 |
| `modelContext` | `DSH_CODEBUDDY_MODEL_CONTEXT` | 每个模型的上下文窗口（模型发现时从 models.dev 获取并保存），如 `{"hy3": 262144}` |
| `maxPromptChars` | `DSH_CODEBUDDY_MAX_PROMPT_CHARS` | `1000000`；超限报错，不静默截断 |
| `askTool` | `DSH_CODEBUDDY_ASK_TOOL` | `true`，注册独立委派工具 |
| `tools` | `DSH_CODEBUDDY_TOOLS` | 空字符串，禁用 CLI 内置工具；**仅影响 `codebuddy_ask`** |
| `permissionMode` | `DSH_CODEBUDDY_MODE` | `dontAsk`；可选 `plan` / `acceptEdits`；影响 `codebuddy_ask` 和未启用权限跳过的 ACP provider |

示例（放入对应 Cordis 插件条目）：

```yaml
- name: dsh-codebuddy-link
  config:
    codebuddyBin: 'C:\Users\you\AppData\Roaming\npm\codebuddy.cmd'
    models: [default]
    timeoutMs: 600000
    tools: ''
    permissionMode: dontAsk
```

`models` 是已启用列表；设置页可发现候选并保存选择。发现结果不会自动启用，也不会改变 CLI 登录区域或授予跨区调用权限。不要将其他服务的模型名直接当作 CodeBuddy ID。

旧版本插件曾提供 `executionMode`（`bridge`/`autonomous`）开关与 `DSH_CODEBUDDY_EXECUTION_MODE` 环境变量。该配置已退役：保存的旧值在加载时被丢弃并自动迁移到 ACP，设置接口收到的同名键会被忽略且不再持久化，任何旧值都不能把 provider 降级回 DSH 工具协议。

## 思考强度、调用诊断与排队（0.3.18）

思考强度优先级：**本次调用显式值 > 面板/插件默认值 > `auto`**。会话模型的思考等级与 `codebuddy_ask` 的 `reasoningEffort` 参数遵循同一规则；显式 `auto` 不传 `--effort`，不会继承默认的 `high` 等值。无效值直接报错，不静默回退。CLI/具体模型是否支持、是否实际采用该等级仍由上游决定；不保证最大思考或最大上下文。

设置页“运行记录”和 `/codebuddy runs` 区分请求模型、CLI 返回模型（缺失为未知）、请求思考强度、DSH 声明的上下文预算及来源。**上下文预算不是 CLI 上下文覆盖；服务端实际推理强度未确认。** 仅当 CLI 返回有效的 `total_credits` / `total_cost_usd` 时显示积分/美元费用；缺失为未知，真实 0 保留，不按 token 或价格表推算。

队列覆盖主模型和独立委派，先进先出，最多 64 个等待请求；队列满、排队超时、执行超时和取消不会自动重试或切换模型。排队取消不启动 CLI，执行取消/超时回收进程树后才释放槽位。队列只在当前插件实例生效，不提供跨 DSH 进程/多实例的全局限流。调高并发数立即唤醒队列，调低不杀死已有进程；思考强度和排队预算修改只影响新调用，已有请求保留原预算。独立委派的宿主总时限为执行预算 + 排队预算 + 5 秒，最多 2147483647 毫秒；宿主自身更短的截止时间仍可能提前取消。

状态包括排队、启动、等待响应、响应中、完成、失败、取消。无进展时间只由正文/思考/工具事件更新，初始化元数据不算进展；提醒只是“仍在等待”，不是失败，不触发重试。提醒阈值对现有记录立即生效。进入面板时自动查询一次账户，账户可用后自动获取模型列表；手动刷新账户同样按此顺序执行。面板挂载期间每 2 秒只读取本机状态，不轮询账户积分、模型列表或 OAuth，不覆盖未保存设置。

设置页运行记录仅存在进程内存，按调用入队顺序只保留最近 5 条记录（不限状态），重启清空；面板在“保存设置”下方显示，新调用在前。旧记录移出历史不会取消调用或改变队列调度。仅保留白名单元数据，不记录提示词、回复、工作目录、原始 CLI 事件、凭据或原始错误文本。模型标识限制长度/字符并拒绝 URL、绝对路径及遍历片段；这不是能识别伪装成合法模型 ID 的任意秘密的检测器。原有 `/codebuddy status` 仍展示管理员配置（含 CLI/工作目录），分享时请自行检查。

## 工作方式与权限边界

每次调用启动一个新的 CLI 进程，通过 stdin 发送完整、有序的 DSH 对话；不使用 `--resume`，不持久化 CLI session。DSH 历史包含先前工具调用和结果，思考块不回传。这样重试、分叉和压缩后的对话不会与另一套 CLI 会话历史错位。

### ACP 原生执行（provider 固定模式）

Provider 主调用不需要任何开关，始终通过 ACP stdio 原生执行。如需进一步跳过 CLI 权限检查，在设置页勾选危险开关并保存，或配置：

```yaml
dangerouslySkipPermissions: true
```

ACP provider 通过 **ACP stdio**（`--acp --acp-transport stdio --tools default`）接入，使用 JSON-RPC `initialize → session/new → session/prompt`，从 `session/update` 获取原生执行事件；不使用 print 文本流作为 provider 传输，也不会失败后自动回退并重复执行任务。保留 CLI 原生系统提示并追加任务上下文，不发送 DSH 工具 schemas 或要求模型手写调用协议。CLI 自行解析、执行原生工具；插件接收进度、最终文本和错误，绝不把 CLI 已执行的操作重新发给 DSH。ACP 的上下文窗口 `usage_update.used/size` 不能当作计费 token；仅识别 CodeBuddy 扩展中明确的逐消息 token 计数和累计请求积分，按消息/请求 ID 去重。没有完整可靠字段时保持未知，不伪造为 0。过程显示在思考/进度区，完整最终结果单独显示；即使最终文本像 JSON/DSML 也不再解析为 DSH 调用。标题/压缩等带 `purpose` 的后台请求始终关闭原生工具及权限跳过。每轮仍使用新 CLI 进程、新 ACP session 和 DSH 历史，不复用 ACP session/load，避免分叉、重试、压缩时两套历史失配。进程 cwd 与 session/new.cwd 同时绑定会话工作目录。取消时先记录 Windows 子进程身份，再发 session/cancel，以有界等待回收进程树并核对已记录的子进程；无法确认清理成功时报错。CLI 内部逐项工具结果不回传为下一轮历史，重要结论应写入最终回答。

启用权限跳过时只传 `--dangerously-skip-permissions`，不同时传冲突的 `--permission-mode dontAsk`。**CodeBuddy 2.177.1 的帮助明确提示 HIGH/CRITICAL 操作仍可能要求确认**；插件不会另外注入 `CODEBUDDY_IS_SANDBOX=1` 来扩大该授权。ACP 若仍发出 `session/request_permission`，客户端返回取消并报错，不自动批准残余高风险请求。客户端不声明文件/终端代理能力，读写与命令由 CLI 原生执行；未知客户端方法返回 method-not-found。非交互调用如被 CLI 安全策略拦截，会报错而不是伪造成功。工作目录不是隔离边界；此模式允许 CLI 以当前系统用户权限访问文件和运行命令，不经过 DSH 文件沙箱或逐项工具确认。取消/超时可以终止进程，但无法撤销已完成的写入或外部操作。仅用于可信任务。

### 独立委派与后台请求（受限 print 模式）

会话标题与压缩等带 `purpose` 的后台请求始终走 `--print --tools "" --permission-mode dontAsk`，不启用 CLI 原生工具。`codebuddy_ask` 同样走 print，默认关闭工具，但遵循管理员单独配置的 `tools` 与权限模式。两者均不注入 DSH 工具调用协议，也不解析结构化工具调用。

旧版 provider 的 **DSH 工具桥接模式**（NDJSON 工具协议、统一回复归一化器及解析失败诊断）已随固定 ACP 模式移除，不再作为 provider 失败面存在。`codebuddy_ask` 默认同样关闭 CLI 工具。如果管理员显式启用 `tools`，CLI 工具会在独立进程中执行，**不受 DSH 文件沙箱约束，也没有逐项 DSH 工具卡片或确认界面**。不要在不可信任务中启用；不要使用该设置绕过 DSH 的权限限制。启用工具时必须能解析到 session 工作目录，或显式配置 `workspaceRoot`。provider 的权限跳过开关不会隐式赋予 `codebuddy_ask` 权限。

CLI 会自行加载其用户配置、工作目录规则等；插件并非隔离运行 CodeBuddy 的沙箱。发送给 CLI 的对话和工具描述将按 CodeBuddy 服务及账户策略处理。

模型发现会额外匿名请求公共注册表 `https://models.dev/api.json`（`credentials: 'omit'`，不携带任何登录、cookie 或 CodeBuddy 凭据）以获取各模型的上下文窗口；请求失败或离线时使用内置快照，不影响模型发现本身。如需完全离线，可在防火墙拦截该域名，窗口将回退到内置快照与 `contextWindow` 配置。

## 验证范围与限制

- 自动化测试覆盖配置、完整历史投影、流结束与错误、NDJSON/Unicode、usage 去重、argv、超时/取消和子进程树回收。
- 使用 CodeBuddy 2.177.1 验证过启动参数；ACP provider 在临时目录使用 `deepseek-v4.1-flash` 经适配器实测通过原生 `Write / Read / Bash`，核对磁盘随机校验值、命令输出、最终结果及真实用量。另以无推理握手核对 `--model minimax-m3.1-flash --effort high` 的会话配置，并实测在原生 Bash 启动时取消返回 AbortError；Windows 回收覆盖父进程先退出后存活的子/孙进程清理。历史成功/失败样本与自动化模拟测试不代表所有账户、模型和 CLI 版本均已在线验收；请按下方步骤完成自己环境中的工具闭环验证。
- 目前仅支持文本，不支持图片、附件自动上传或原生 CodeBuddy 工具回放。
- 旧版 bridge 工具协议的统一回复归一化器（0.3.14）已不再处于 provider 运行路径；其兼容矩阵与安全边界说明见对应历史版本文档。

- CLI 计费/额度以 CodeBuddy 为准；插件转发 token usage，诊断仅显示 CLI 明确返回的积分/费用，不估算费用。
- `/codebuddy status` 只显示配置，不证明登录成功。
- Windows npm shim 会解析到真实 JS 并以 Node 执行，不把用户输入交给 shell。自定义 shell wrapper 不受支持，应指定真实可执行文件或 CLI JS。

## 开发与发布

```sh
npm ci
npm run check
npm test
npm run verify:package
npm pack
```

`npm test` 会构建源码和浏览器入口。`npm pack` 仅验证并打包现有产物，不负责重新编译；修改源码后必须先运行构建/测试，并将 `dist` 与源码一起提交。`prepack` 仅使用 Node 内置模块，不需要开发依赖；即使安装端禁用生命周期脚本，已提交的产物也可以使用。

- **CI**：main 推送和 Pull Request 在 Linux/Windows、Node 22.18/24 上运行类型检查与测试，检查 dist 一致性，并验证禁用脚本的 Git 安装；上传 `.tgz` 作为构建附件。
- **Release**：更新 package.json、lockfile、CHANGELOG 和安装示例，运行完整测试并提交 dist；推送 `v<版本>` 标签会验证标签与版本一致、重跑测试，生成 GitHub Release、`.tgz` 和 `SHA256SUMS.txt`。不要覆盖已有版本标签。
- 不自动发布 npm，不需要 npm token；Release 使用仓库提供的最小范围 `GITHUB_TOKEN`。
- 不提交 `node_modules`、本地日志、诊断脚本、凭据或个人会话。报告问题时只提供脱敏信息。

### 登录后手动验收

1. `codebuddy` 普通终端问答成功。
2. 在 DSH 选择 `codebuddy/default`，发送简单问题，确认收到回复。
3. 要求读取工作目录中的一个测试文件，确认思考/进度区出现 CodeBuddy 原生工具执行记录（如 `[CodeBuddy 执行: Read]`），随后能总结内容。
4. 取消一轮长任务，确认不再输出且无遗留 CLI 子进程。
5. 切换回其他模型，调用 `codebuddy_ask` 验证独立委派。
6. 设置 → CodeBuddy 中添加账户实际支持的模型 ID，保存并确认会话模型选择器更新；取消启用后旧会话也应拒绝调用该模型。
7. 修改权限模式，确认影响独立委派和未跳过权限检查的 ACP provider；勾选/取消权限跳过开关后发起新调用验证生效，后台请求仍禁用工具。
8. 配置积分凭据文件，点击刷新并与同一账户的官方用量页核对；再使用过期凭据，确认显示认证错误而非 0 积分。

## 开发

```powershell
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
```

源码位于 `src/`，测试位于 `test/`。构建结果位于 `dist/`。`cordis.patch.yml` 提供 DSH bundle 安装入口。MIT 许可证；上游参考及改动说明见 `NOTICE`。

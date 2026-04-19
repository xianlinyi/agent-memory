# Agent Memory Knowledge Graph 使用手册

Agent Memory Knowledge Graph 是一个本地优先的智能体记忆层。它把可编辑的 Obsidian Markdown vault 和可重建的 SQLite FTS5 图谱索引结合起来：Markdown 负责让人能读、能改、能备份；SQLite 负责快速检索和关系扩展；模型提供方负责记忆抽取、查询解释、图谱跳转判断和答案合成。

## 适用场景

- 给 Codex、脚本、自动化任务或长期工作的 agent 提供持久记忆。
- 把对话、文件、命令输出或人工摘要沉淀成实体和关系。
- 在 Obsidian 中人工审阅和编辑记忆，再用 CLI 重建索引。
- 让 Python、Node.js 或 shell 脚本通过 compact JSON 读取结构化记忆。

## 运行要求

- Node.js `>=22.13`
- 可用的 GitHub Copilot CLI / Copilot SDK 鉴权环境，除非你通过 SDK 注入自己的 model provider
- 一个本地目录作为 memory vault，例如 `./memory-vault`

默认 provider 是 `copilot-sdk`。如果 Copilot SDK、认证、模型配置或模型输出不可用，`ingest`、`query`、`compact` 会显式失败，不会写入近似记忆。

默认存储使用 `node:sqlite`。CLI 会在正常导入 SQLite 时过滤 Node 的 SQLite experimental warning，避免它污染等待动画或 JSON 输出。

## 安装

全局安装：

```bash
npm install -g @agent-memory/knowledge-graph
```

不全局安装，直接用 `npx`：

```bash
npx @agent-memory/knowledge-graph init --vault ./memory-vault
```

本仓库开发时可以先构建：

```bash
npm install
npm run build
node dist/src/cli/index.js help
```

## 快速开始

```bash
agent-memory init --vault ./memory-vault
agent-memory doctor --vault ./memory-vault --model
agent-memory ingest "Project Atlas uses Obsidian for local-first memory." --vault ./memory-vault
agent-memory query "How does Atlas store memory?" --vault ./memory-vault
agent-memory query "Atlas memory" --vault ./memory-vault --json
```

初始化后目录大致如下：

```text
memory-vault/
  People/
  Projects/
  Bugs/
  Rules/
  Sessions/
  Concepts/
  Graph/
  Dashboards/
  Templates/
  .kg/
    config.json
    graph.db
```

## Vault 目录说明

- `People/`: 人物实体。
- `Projects/`: 项目实体。
- `Bugs/`: bug、问题、回归、故障等实体。
- `Rules/`: 长期有效的规则、偏好、约束和操作习惯。
- `Concepts/`: 概念、主题、产物、决策和未知类型实体。
- `Sessions/`: 一次对话、文件、命令、导入或人工输入形成的原子观察；来源信息写在 frontmatter 中。
- `Graph/`: 关系笔记和图谱边证据。
- `Dashboards/`: 初始化生成的概览笔记。
- `Templates/`: 初始化生成的 Markdown 模板。
- `.kg/`: 配置、SQLite 数据库、日志和生成状态。

Markdown 是可人工编辑的投影；SQLite 是查询和关系索引层。手动改 Markdown 后运行 `rebuild`，只需要刷新全文搜索索引时运行 `reindex`。

## CLI 总览

```bash
agent-memory init [--vault <path>]
agent-memory ingest <text|file> [--source <label>] [--vault <path>]
agent-memory query <text> [--limit n] [--max-hops n] [--details] [--json] [--answer] [--vault <path>]
agent-memory link --from <id> --to <id> --type <predicate> [--description <text>] [--vault <path>]
agent-memory graph [--entity <id>] [--json] [--vault <path>]
agent-memory rebuild [--vault <path>]
agent-memory reindex [--vault <path>]
agent-memory compact [--vault <path>]
agent-memory import <export.json> [--vault <path>]
agent-memory export [--format json|markdown] [--out <path>] [--vault <path>]
agent-memory doctor [--model] [--json] [--vault <path>]
agent-memory status [--json] [--vault <path>]
agent-memory version [--json]
agent-memory upgrade [--tag <tag>] [--dry-run] [--json]
agent-memory default get [--json]
agent-memory default set <vault-path> [--json]
agent-memory default unset [--json]
agent-memory config get [key] [--json] [--vault <path>]
agent-memory config set <key> <value> [--json] [--vault <path>]
agent-memory config unset <key> [--json] [--vault <path>]
```

全局选项：

- `--verbose`: 把进度日志写到 `stderr`。
- `--log-file <path>`: 把进度日志追加写入文件。

交互式终端中，等待型命令会在 `stderr` 显示 spinner。机器可读输出写到 `stdout`；脚本捕获输出时 spinner 会关闭，所以 `--json` 的 stdout 可以直接解析。

检查当前安装版本：

```bash
agent-memory version
agent-memory version --json
```

升级全局安装的 CLI 包：

```bash
agent-memory upgrade
agent-memory upgrade --tag latest
agent-memory upgrade --dry-run
```

## 默认 Vault 路径

默认路径优先级：

```text
--vault 参数 > 用户设置的默认路径 > ~/agent-memory/MyVault
```

查看当前默认路径：

```bash
agent-memory default get
agent-memory default get --json
```

设置默认路径：

```bash
agent-memory default set /Users/xianlinyi/Documents/MyVault
```

之后可以省略 `--vault`：

```bash
agent-memory init
agent-memory status
agent-memory ingest "今天修了登录 bug"
agent-memory query "登录 bug"
```

恢复内置默认路径：

```bash
agent-memory default unset
```

用户级默认路径配置保存在 `~/.agent-memory/config.json`。测试或隔离环境可以通过 `AGENT_MEMORY_USER_CONFIG` 指定替代路径。

## 初始化与健康检查

初始化 vault：

```bash
agent-memory init --vault ./memory-vault
```

检查 Node、SQLite、vault 和 provider 基础状态：

```bash
agent-memory doctor --vault ./memory-vault
```

额外发送一次短模型请求，确认模型真实可用：

```bash
agent-memory doctor --vault ./memory-vault --model
```

机器可读检查结果：

```bash
agent-memory doctor --vault ./memory-vault --json
```

## 写入记忆

写入直接文本：

```bash
agent-memory ingest "Project Atlas uses Obsidian for local-first memory." --vault ./memory-vault
```

写入文件内容：

```bash
agent-memory ingest ./notes/project-atlas.md --vault ./memory-vault --source "Project notes"
```

`ingest` 的参数既可以是文本，也可以是文件路径。CLI 会先尝试按文件读取；读取失败时把参数当作文本。

使用 `--json` 时，返回结果会包含 `meta.status`：

- `created`: 新增记忆。
- `merged`: 增强合并了已有实体或关系。
- `duplicate`: 完全重复，已复用已有 episode，不再重复存储。

`meta.duplicate` 可以直接判断是否跳过，`meta.entitiesMerged` 和 `meta.relationsMerged` 会给出本次增强的已有记录数量。

写入时模型会抽取：

- `entities`: 人、项目、bug、规则、概念、产物、决策等。
- `relations`: 实体之间的有向关系。
- `episode`: 本次输入形成的原子观察。
- `source`: 可选来源信息。

## 查询记忆

普通文本查询：

```bash
agent-memory query "How does Atlas store memory?" --vault ./memory-vault
```

限制结果数量和图谱跳数：

```bash
agent-memory query "Atlas memory" --vault ./memory-vault --limit 5 --max-hops 1
```

参数含义：

- `--limit n`: 最多返回多少条匹配，默认 `10`。
- `--max-hops n`: 图谱扩展跳数，默认 `2`，最大 `3`，设为 `0` 时只用直接搜索结果。
- `--details`: 文本模式显示查询解释和完整匹配；JSON 模式返回完整 `QueryResult`。
- `--json`: 返回 compact JSON。
- `--answer`: 与 `--json --details` 一起使用时，在完整 JSON 中包含合成答案。

## Compact JSON 输出

默认 `query --json` 返回面向 agent 和脚本的紧凑结构，只保留 assumptions 和 relationships：

```bash
agent-memory query "Atlas memory" --vault ./memory-vault --json
```

示例输出：

```json
{
  "assumptions": ["Project Atlas uses Obsidian"],
  "relationships": [
    {
      "source": "Project Atlas",
      "predicate": "uses",
      "target": "Obsidian",
      "description": "Project Atlas uses Obsidian for local-first memory."
    }
  ]
}
```

字段说明：

- `assumptions`: 从关系中压缩出来的可继续推理事实，最多 5 条。
- `relationships`: 与查询相关的去重关系，最多 8 条。

如果需要完整调试信息：

```bash
agent-memory query "Atlas memory" --vault ./memory-vault --json --details
```

完整 JSON 会包含：

- `query`
- `interpretation`
- `matches`
- `answer`
- `traversal`

## 在 Python 脚本中调用

推荐只解析 `stdout`，把 `stderr` 单独保留给错误和日志：

```python
import json
import subprocess

result = subprocess.run(
    ["agent-memory", "query", "Atlas memory", "--vault", "./memory-vault", "--json"],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    check=True,
)

data = json.loads(result.stdout)
print(data["assumptions"])
```

不要在开启 `--verbose` 时把 `stderr` 合并到 `stdout`，因为日志会写到 `stderr`：

```python
# 不推荐用于 JSON 解析
subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
```

## 关系与图谱

手动建立关系：

```bash
agent-memory link --from entity:a --to entity:b --type related_to --vault ./memory-vault
```

带描述：

```bash
agent-memory link \
  --from entity:a \
  --to entity:b \
  --type caused_by \
  --description "A is caused by B in the current workflow." \
  --vault ./memory-vault
```

查看完整图谱：

```bash
agent-memory graph --vault ./memory-vault --json
```

查看某个实体邻域：

```bash
agent-memory graph --entity entity:a --vault ./memory-vault --json
```

## 重建、重索引、压缩

从 Markdown vault 重建 SQLite 状态：

```bash
agent-memory rebuild --vault ./memory-vault
```

只重建 FTS 搜索索引：

```bash
agent-memory reindex --vault ./memory-vault
```

压缩记忆库：

```bash
agent-memory compact --vault ./memory-vault
```

`compact` 需要模型 provider 可用。它会读取当前记忆并生成压缩结果，适合定期整理长期记忆。

## 导入、导出、状态

导出 JSON 快照：

```bash
agent-memory export --vault ./memory-vault --format json --out ./memory-export.json
```

导出 Markdown 展示格式：

```bash
agent-memory export --vault ./memory-vault --format markdown --out ./memory-export.md
```

导入 JSON 快照：

```bash
agent-memory import ./memory-export.json --vault ./memory-vault
```

查看状态：

```bash
agent-memory status --vault ./memory-vault
agent-memory status --vault ./memory-vault --json
```

## 模型配置

vault 配置文件位于：

```text
memory-vault/.kg/config.json
```

默认形状：

```json
{
  "vaultPath": "/absolute/path/to/memory-vault",
  "databasePath": "/absolute/path/to/memory-vault/.kg/graph.db",
  "model": {
    "provider": "copilot-sdk",
    "model": "gpt-5-mini",
    "timeoutMs": 600000
  }
}
```

常用配置命令：

```bash
agent-memory config get model --vault ./memory-vault --json
agent-memory config set model.model gpt-5-mini --vault ./memory-vault
agent-memory config set model.reasoningEffort medium --vault ./memory-vault
agent-memory config set model.timeoutMs 600000 --vault ./memory-vault
agent-memory config unset model.reasoningEffort --vault ./memory-vault
```

Copilot SDK 可选字段：

- `model.cliPath`
- `model.cliUrl`
- `model.cliArgs`
- `model.cwd`
- `model.configDir`
- `model.traceDir`
- `model.githubToken`
- `model.useLoggedInUser`
- `model.logLevel`

当 `agent-memory` 使用 `copilot-sdk` provider 时，它会自动使用隔离的 Copilot 配置目录，避免嵌套模型调用加载本地 hook 插件。默认会创建 `<vault>/.kg/copilot-isolated/config.json`，其中禁用 hooks 且不安装插件，然后让 Copilot SDK session 使用该目录。CLI 和 TypeScript SDK 都会生效；如果已经显式设置了 `model.configDir`，则尊重用户配置。

也可以显式预先创建或固定这个隔离配置：

```bash
agent-memory copilot isolate --vault ./memory-vault
```

需要自定义目录时可以加 `--config-dir <path>`。如果确实要关闭自动隔离，可以设置 `AGENT_MEMORY_AUTO_COPILOT_ISOLATE=0`。

Copilot SDK 调用默认会 trace 到 `<vault>/.kg/copilot-runs/<session-id>.jsonl`。可以通过 `model.traceDir` 指定其他目录；设置为空字符串可以关闭 trace 文件。

旧的 `copilot-cli` provider 仍可用：

```bash
agent-memory config set model.provider copilot-cli --vault ./memory-vault
agent-memory config set model.command copilot --vault ./memory-vault
agent-memory config set model.args '["ask","{prompt}"]' --vault ./memory-vault
agent-memory config set model.promptInput argument --vault ./memory-vault
```

`model.args` 中的 `{prompt}` 会被替换成生成的 prompt。如果没有 `{prompt}`，可以把 `model.promptInput` 设置为 `argument` 让 prompt 作为最后一个参数追加，或设置为 `stdin` 写入标准输入。

## TypeScript SDK

基础用法：

```ts
import { MemoryEngine } from "@agent-memory/knowledge-graph";

const memory = await MemoryEngine.create({ vaultPath: "./memory-vault" });

try {
  await memory.init();
  const ingest = await memory.ingest({
    text: "Project Atlas uses Obsidian for local-first memory.",
    source: {
      kind: "message",
      label: "Planning chat"
    }
  });
  console.log(ingest.meta.status); // "created"、"merged" 或 "duplicate"

  const result = await memory.query({
    text: "How does Atlas store memory?",
    limit: 5,
    maxHops: 2
  });

  console.log(result.answer);
  console.log(result.matches);
} finally {
  await memory.close();
}
```

`ingest.meta` 用于判断这次写入是新增、合并增强，还是因为完全重复而跳过。`meta.duplicate` 为 `true` 表示规范化后的观察文本已经存在；`meta.entitiesMerged` 和 `meta.relationsMerged` 会返回本次增强了多少已有记录。

查询时关闭答案合成：

```ts
const result = await memory.query({
  text: "Atlas memory",
  synthesize: false
});
```

监听查询进度：

```ts
await memory.query({
  text: "Atlas memory",
  onProgress(event) {
    console.error(event.stage, event.totalMs, event.details);
  }
});
```

注入自定义 provider/store：

```ts
const memory = await MemoryEngine.create({
  vaultPath: "./memory-vault",
  modelProvider: myModelProvider,
  graphStore: myGraphStore,
  vaultStore: myVaultStore,
  embeddingProvider: myEmbeddingProvider,
  vectorStore: myVectorStore
});
```

## 推荐工作流

1. 用 `init` 创建 vault。
2. 用 `doctor --model` 确认 Copilot SDK、认证和模型调用可用。
3. 用 `ingest` 持续写入对话、文件、命令输出或人工摘要。
4. 在 Obsidian 中审阅 `People/Projects/Bugs/Rules/Concepts/Sessions/Graph`。
5. 人工编辑 Markdown 后运行 `rebuild`。
6. 搜索表现不理想但 Markdown 没变时运行 `reindex`。
7. 用 `export --format json` 定期备份结构化快照。
8. 给脚本和 agent 使用 `query --json`，给人阅读使用默认文本输出。

## 常见问题

### 为什么 `query --json` 没有返回原问题？

默认 compact JSON 是给调用方继续处理的结果结构。调用方本来就知道自己问了什么，所以默认不再返回原问题，减少噪声。需要完整调试上下文时使用 `--json --details`。

### Python 下一行拿到的是 JSON 还是等待动画？

按推荐方式捕获 `stdout` 时拿到的是结构化 JSON。等待动画和日志写到 `stderr`，并且在非 TTY 捕获场景下 spinner 会关闭。

### 什么时候会有 `answer`？

文本模式默认会合成答案。`--json` 默认追求紧凑，不合成答案；需要答案时加 `--answer`。

### 为什么手动改了 Markdown 查询不到？

手动编辑 Markdown 后运行：

```bash
agent-memory rebuild --vault ./memory-vault
```

### 只想刷新搜索索引怎么办？

运行：

```bash
agent-memory reindex --vault ./memory-vault
```

### 可以不用 GitHub Copilot 吗？

可以通过 SDK 注入自定义 `modelProvider`。CLI 默认配置面向 Copilot SDK，也保留了旧的 `copilot-cli` provider。

## 注意事项

- 当前不兼容旧布局 `Entities/Relations/Episodes/Sources/.agent-memory`，旧 vault 需要单独迁移。
- `Sources/` 不再作为独立目录存在；来源信息嵌入 `Sessions/` 的 frontmatter。
- SQLite 是查询和关系索引层，Markdown 是人类可编辑投影。
- `agent-memory rebuild` 会从 Markdown 重建 SQLite 状态。
- `agent-memory reindex` 只重建 FTS 搜索索引。
- `export --format markdown` 是展示性导出；可导入格式建议使用 JSON。
- 开启 `--verbose` 时日志写入 `stderr`；脚本解析 JSON 时不要把 `stderr` 合并进 `stdout`。

# 中文使用文档

Agent Memory Knowledge Graph 是一个本地优先的智能体记忆层。它把可编辑的 Obsidian Markdown vault 和 SQLite FTS5 索引结合起来，用 LLM 负责记忆抽取、查询解释和答案合成。

## 运行要求

- Node.js `>=22.13`
- 可用的 GitHub Copilot CLI / Copilot SDK 鉴权环境
- 一个用于保存记忆的本地目录，例如 `./memory-vault`

默认模型提供方是 `copilot-sdk`。如果 Copilot SDK、认证、模型配置或模型输出不可用，`ingest`、`query`、`compact` 会直接失败，不会写入近似记忆。

## 安装与初始化

全局安装：

```bash
npm install -g @agent-memory/knowledge-graph
```

或直接用 `npx` 初始化：

```bash
npx @agent-memory/knowledge-graph init --vault ./memory-vault
```

初始化后 vault 结构如下：

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
    graph.db
    config.json
    logs/
```

如果 `init` 不传 `--vault`，默认会初始化到：

```text
~/agent-memory/MyVault
```

也就是说：

```bash
agent-memory init
```

等价于首次使用内置默认路径。所有命令在没有传 `--vault` 时，也会使用当前的用户默认 vault。

目录含义：

- `People/`: 人物实体。
- `Projects/`: 项目实体。
- `Bugs/`: 缺陷、问题、回归等 bug 实体。
- `Rules/`: 长期有效的规则、偏好、约束。
- `Concepts/`: 概念、主题、产物、决策和未知类型实体。
- `Sessions/`: 一次对话、文件、命令或导入形成的原子观察。来源信息写在 session frontmatter 中。
- `Graph/`: 关系笔记和图谱边证据。
- `Dashboards/`: 初始化生成的概览笔记。
- `Templates/`: 初始化生成的 Markdown 模板。
- `.kg/`: 配置、SQLite 数据库、日志和生成状态。

## 常用 CLI

初始化 vault：

```bash
agent-memory init --vault ./memory-vault
```

检查环境和本地存储：

```bash
agent-memory doctor --vault ./memory-vault
```

额外检查模型调用：

```bash
agent-memory doctor --vault ./memory-vault --model
```

写入一条记忆：

```bash
agent-memory ingest "Project Atlas uses Obsidian for local-first memory." --vault ./memory-vault
```

写入文件内容。参数既可以是文本，也可以是文件路径：

```bash
agent-memory ingest ./notes/project-atlas.md --vault ./memory-vault --source "Project notes"
```

查询记忆：

```bash
agent-memory query "How does Atlas store memory?" --vault ./memory-vault
```

返回结构化 JSON：

```bash
agent-memory query "Atlas memory" --vault ./memory-vault --json
```

限制搜索结果数量和图谱跳数：

```bash
agent-memory query "Atlas memory" --vault ./memory-vault --limit 5 --max-hops 1
```

手动建立关系：

```bash
agent-memory link --from entity:a --to entity:b --type related_to --vault ./memory-vault
```

查看图谱快照：

```bash
agent-memory graph --vault ./memory-vault --json
```

查看某个实体邻域：

```bash
agent-memory graph --entity entity:a --vault ./memory-vault --json
```

从 Markdown vault 重建 SQLite：

```bash
agent-memory rebuild --vault ./memory-vault
```

重建全文搜索索引：

```bash
agent-memory reindex --vault ./memory-vault
```

导出：

```bash
agent-memory export --vault ./memory-vault --format json --out ./memory-export.json
```

导入：

```bash
agent-memory import ./memory-export.json --vault ./memory-vault
```

查看状态：

```bash
agent-memory status --vault ./memory-vault
```

## 默认 Vault 路径

默认路径优先级：

```text
--vault 参数 > 用户设置的默认路径 > ~/agent-memory/MyVault
```

查看当前默认路径：

```bash
agent-memory default get
```

输出 JSON：

```bash
agent-memory default get --json
```

修改默认路径：

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

用户级默认路径配置保存在：

```text
~/.agent-memory/config.json
```

## 配置模型

配置文件位于：

```text
memory-vault/.kg/config.json
```

默认配置形状：

```json
{
  "vaultPath": "/absolute/path/to/memory-vault",
  "databasePath": "/absolute/path/to/memory-vault/.kg/graph.db",
  "model": {
    "provider": "copilot-sdk",
    "model": "gpt-5",
    "timeoutMs": 30000
  }
}
```

通过 CLI 修改配置：

```bash
agent-memory config set model.model gpt-5 --vault ./memory-vault
agent-memory config set model.reasoningEffort medium --vault ./memory-vault
agent-memory config set model.timeoutMs 30000 --vault ./memory-vault
agent-memory config get model --vault ./memory-vault --json
```

Copilot SDK 可选字段包括：

- `model.cliPath`
- `model.cliUrl`
- `model.cliArgs`
- `model.cwd`
- `model.configDir`
- `model.githubToken`
- `model.useLoggedInUser`
- `model.logLevel`

兼容的旧 `copilot-cli` provider 仍可配置：

```bash
agent-memory config set model.provider copilot-cli --vault ./memory-vault
agent-memory config set model.command copilot --vault ./memory-vault
agent-memory config set model.args '["ask","{prompt}"]' --vault ./memory-vault
agent-memory config set model.promptInput argument --vault ./memory-vault
```

## SDK 使用

```ts
import { MemoryEngine } from "@agent-memory/knowledge-graph";

const memory = await MemoryEngine.create({ vaultPath: "./memory-vault" });

try {
  await memory.init();
  await memory.ingest({
    text: "Project Atlas uses Obsidian for local-first memory.",
    source: {
      kind: "message",
      label: "Planning chat"
    }
  });

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

测试或自定义集成可以传入自己的 provider/store：

```ts
const memory = await MemoryEngine.create({
  vaultPath: "./memory-vault",
  modelProvider: myModelProvider,
  graphStore: myGraphStore,
  vaultStore: myVaultStore
});
```

## 推荐工作流

1. 用 `init` 创建 vault。
2. 用 `doctor --model` 确认 Copilot SDK 和模型调用可用。
3. 用 `ingest` 持续写入对话、文件、命令输出或人工摘要。
4. 在 Obsidian 中查看并编辑 `People/Projects/Bugs/Rules/Concepts/Sessions/Graph`。
5. 人工编辑 Markdown 后运行 `rebuild`，让 SQLite 索引重新同步。
6. 搜索效果不理想时运行 `reindex`。
7. 用 `export` 定期备份结构化快照。

## 注意事项

- 当前不兼容旧布局 `Entities/Relations/Episodes/Sources/.agent-memory`，旧 vault 需要单独迁移。
- `Sources/` 不再作为独立目录存在；来源信息嵌入 `Sessions/` 的 frontmatter。
- SQLite 是查询和关系索引层，Markdown 是人类可编辑投影。
- `agent-memory rebuild` 会从 Markdown 重建 SQLite 状态。
- `agent-memory reindex` 只重建 FTS 搜索索引。
- `export --format markdown` 是展示性导出；可导入格式仍建议使用 JSON。

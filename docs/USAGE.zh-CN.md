# 使用指南

## 定位

Agent Memory 现在是 memory-first 运行时记忆系统，不是把输入直接编译成 wiki 的工具。

默认链路分成两条：

```text
memory/raw -> session_summary -> candidate -> long_term entity
wiki/raw -> consolidated wiki entity
```

其中：

- `memory/` 是给系统自己检索、回忆、整合用的运行时记忆层。
- `wiki/` 是给人看的结果层，现在可以由 `wiki/raw/` 自动整理出来。
- `memory/wiki-update-candidates/` 只保留给旧版 vault 的待审核草稿兼容使用。

## 初始化

```bash
amem init --vault ./memory-wiki
```

会创建：

```text
raw/
memory/
  raw/
  session-summaries/
  candidates/
  long/
    episodic/
    semantic/
    procedural/
  wiki-update-candidates/
wiki/
  raw/
  episodes/
  semantic/
  procedures/
schema/
.llm-wiki/
```

## 日常 CLI 流程

### 1. 先写入 raw

```bash
amem ingest "昨天支付凭证发送失败，MQ 超时导致通知没出去" \
  --memory-class episodic \
  --session-id incident-20260503 \
  --vault ./memory-wiki
```

默认会写入 `memory/raw/`，不会直接生成正式 wiki。

如果你希望这条 raw 直接整理成 wiki 实体，用：

```bash
amem ingest "Project Atlas keeps wiki pages human editable." \
  --target wiki \
  --source "Atlas wiki note" \
  --vault ./memory-wiki
```

如果你已经有自己手写的原始文档，也可以直接放进：

- `memory/raw/`
- `wiki/raw/`

raw 不一定是 Markdown，普通 `.txt` 纯文本也可以。只要文件能读成文本，就会进入整理流程；没写 `memory_class` 时，会按内容做启发式推断。

参数说明：

- `--memory-class`：显式标记为 `episodic`、`semantic`、`procedural`。
- `--target`：指定这条 raw 是进入 `memory/raw/` 还是 `wiki/raw/`。
- `--session-id`：把一批 raw 归到同一整理批次；不是必须，但对多线程使用很重要。
- `--event-time`：覆盖事件时间。

如果不传 `--memory-class`，系统会做启发式推断。

### 2. consolidate 自动整理实体

```bash
amem consolidate --session-id incident-20260503 --vault ./memory-wiki
```

这一步会自动：

- 把 `memory/raw/` 整理成：
  `memory/session-summaries/`、`memory/candidates/`、`memory/long/<class>/`
- 把 `wiki/raw/` 直接整理到：
  `wiki/episodes/`、`wiki/semantic/`、`wiki/procedures/`
- 浏览已有 entity；如果 raw 和已有 entity 有关联，会优先把 source 关联进已有 entity，而不是新建重复页面

默认不再需要人工审批。

### 3. 查询

```bash
amem query "支付凭证超时怎么排查" --vault ./memory-wiki
amem query "支付凭证超时怎么排查" --json --vault ./memory-wiki
```

JSON 输出包含：

```json
{
  "answer": "...",
  "pages": [],
  "sources": []
}
```

默认 query 会读取：

- 可查询的 `memory/` 页面，主要是 `long_term`
- `wiki/` 中的正式页面

检索顺序是先 `memory`，再 `wiki`，最后把两边结果合并给模型生成答案。

默认 query 不会读取：

- `memory/session-summaries/`
- `memory/wiki-update-candidates/`
- 已有对应 `long_term` 的重复 `candidate`

### 4. 查看长期记忆

```bash
amem long-memory --vault ./memory-wiki
amem long-memory --memory-class procedural --vault ./memory-wiki
```

### 5. 旧版待审核提案兼容命令

```bash
amem wiki-updates --vault ./memory-wiki
amem wiki-updates --all --json --vault ./memory-wiki
```

这些命令只用于处理旧版 vault 里遗留的 `memory/wiki-update-candidates/` 草稿。新流程默认不会再生成它们。

### 6. 处理旧版遗留提案

批准写入正式 wiki：

```bash
amem approve-wiki-update memory/wiki-update-candidates/payment-proof.md --vault ./memory-wiki
```

拒绝提案，但保留候选记录：

```bash
amem reject-wiki-update memory/wiki-update-candidates/payment-proof.md --vault ./memory-wiki
```

`approve-wiki-update` 和 `reject-wiki-update` 都支持传：

- candidate id
- candidate title
- candidate path

## 常用维护命令

```bash
amem lint --vault ./memory-wiki
amem lint --fix --vault ./memory-wiki
amem reindex --vault ./memory-wiki
amem pages --vault ./memory-wiki
amem sources --vault ./memory-wiki
amem status --json --vault ./memory-wiki
```

`reindex` 可以随时从 Markdown 文件重建 `.llm-wiki/index.db`。

## 作为 SDK 使用

这个包可以直接被别的 Node.js / TypeScript 项目引用：

```ts
import { MemoryEngine, defaultConfig } from "@xianlinyi/agent-memory";

const vaultPath = "./memory-wiki";
const config = defaultConfig(vaultPath);
config.model.provider = "copilot-sdk";

const engine = await MemoryEngine.create({ vaultPath, config });

try {
  await engine.init();

  await engine.ingest({
    text: "Billing export uses reconciliation token to locate PSP callbacks.",
    source: { kind: "message", label: "Ops note" },
    memory: { class: "procedural", sessionId: "ops-20260503" }
  });

  await engine.consolidate({ sessionId: "ops-20260503" });
  const result = await engine.query({ text: "reconciliation token callback" });
  console.log(result.answer);
} finally {
  await engine.close();
}
```

可直接导出的 SDK 入口包括：

- `MemoryEngine`
- `createDefaultEngine`
- `defaultConfig`
- `loadConfig`
- `writeConfig`
- `configPath`
- `createModelProvider`

## 本地测试

先安装依赖：

  npm install

常用本地验证命令：

  npm run typecheck
  npm test

如果只想检查打包内容，但不真正生成 tarball：

  npm pack --dry-run

## 本地打包

生成本地 tarball：

  npm pack

现在项目已经配置了 prepare 和 prepack，所以本地目录安装和 npm pack 都会先自动构建 dist。

生成文件类似：

  xianlinyi-agent-memory-0.1.7.tgz

## 在别的项目中引入

方式 1：从 npm 安装

  npm install @xianlinyi/agent-memory

方式 2：安装本地 tarball

先在本项目里执行：

  npm pack

再在目标项目里执行：

  npm install /绝对路径/xianlinyi-agent-memory-0.1.7.tgz

方式 3：直接引用本地源码目录

在目标项目中执行：

  npm install /绝对路径/agent-memory

或者在目标项目的 package.json 中写：

  {
    "dependencies": {
    "@xianlinyi/agent-memory": "file:../agent-memory"
    }
  }

由于 prepare 会自动构建，直接引用本地目录时也会先生成 SDK 可用的 dist。

作为 SDK 导入：

  import { MemoryEngine, defaultConfig } from "@xianlinyi/agent-memory";

作为 CLI 使用：

  npx amem --help

## 配置 Copilot fine-grained PAT

### 推荐方式：环境变量

```bash
export AGENT_MEMORY_GITHUB_TOKEN="github_pat_your_token"
```

SDK 会按下面顺序取 token：

1. `config.model.githubToken`
2. `AGENT_MEMORY_GITHUB_TOKEN`
3. `GITHUB_TOKEN`

如果存在 token，且没有显式设置 `config.model.useLoggedInUser`，系统会默认优先走 token 鉴权，而不是本地已登录用户。

### 在代码里显式传入

```ts
const config = defaultConfig("./memory-wiki");
config.model.provider = "copilot-sdk";
config.model.githubToken = process.env.AGENT_MEMORY_GITHUB_TOKEN;
config.model.useLoggedInUser = false;
```

### CLI 中写入配置文件

```bash
amem config set model.provider copilot-sdk --vault ./memory-wiki
amem config set model.githubToken github_pat_your_token --vault ./memory-wiki
amem config set model.useLoggedInUser false --vault ./memory-wiki
```

这种方式会把 token 写入 `.llm-wiki/config.json`。对生产环境或共享环境，更建议使用环境变量。

## 一个完整例子

```bash
export AGENT_MEMORY_GITHUB_TOKEN="github_pat_your_token"

amem init --vault ./memory-wiki
amem ingest "支付回调失败，重试前先核对 reconciliation token" \
  --memory-class procedural \
  --session-id payment-ops \
  --vault ./memory-wiki
amem consolidate --session-id payment-ops --vault ./memory-wiki
amem query "支付回调失败怎么查" --vault ./memory-wiki
amem wiki-updates --vault ./memory-wiki
```

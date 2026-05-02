# 使用指南

## 初始化

```bash
amem init --vault ./memory-wiki
```

会创建：

```text
raw/
wiki/
schema/
.llm-wiki/
```

## 写入知识

```bash
amem ingest "Project Atlas uses Obsidian for local-first agent memory." --vault ./memory-wiki
```

每次 ingest 都会先写不可变 raw 文档，再由模型编译或更新 wiki 页面。

## 查询

```bash
amem query "How does Atlas store memory?" --vault ./memory-wiki
amem query "Atlas memory" --json --vault ./memory-wiki
```

JSON 输出包含：

```json
{
  "answer": "...",
  "pages": [],
  "sources": []
}
```

## 维护

```bash
amem lint --vault ./memory-wiki
amem lint --fix --vault ./memory-wiki
amem reindex --vault ./memory-wiki
amem pages --vault ./memory-wiki
amem sources --vault ./memory-wiki
```

`reindex` 可以随时从 `raw/` 和 `wiki/` 重建 `.llm-wiki/index.db`。

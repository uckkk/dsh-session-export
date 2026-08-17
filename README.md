# dsh-session-export · DSH 会话导出/备份工具

[![npm](https://img.shields.io/npm/v/dsh-session-export)](https://www.npmjs.com/package/dsh-session-export)
[![GitHub](https://img.shields.io/github/stars/uckkk/dsh-session-export)](https://github.com/uckkk/dsh-session-export)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把 DeepSeek Harness（DSH）本地保存的会话一键导出为 **Markdown / JSON**，用于备份、分享、整理与迁移。
**Session export & backup tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)** — list local sessions and export any of them to Markdown or JSON, with full chat turns, tool calls and results.

支持 **zstd 压缩**（`.jsonl.zstd`，DSH 默认存储格式）与**明文**（`.jsonl`）两种会话日志。纯 Node 实现，零第三方运行时依赖。

## 功能 Features

| 工具 | 说明 |
|---|---|
| `session_list` | 列出所有本地会话：标题、ID、工作目录、创建时间、大小（支持关键字过滤） |
| `session_export` | 导出指定会话为 **Markdown**（用户/助手消息、工具调用与结果、推理过程）或 **JSON**（结构化数据，便于二次处理） |

- 支持 `outPath` 直接写文件，默认返回全文
- peer-only 依赖（随 DSH 宿主加载，无需额外安装）
- 标题自动取自 DSH 的 `session/title` 记录，无标题时回退到首条用户消息

## 安装 Install

```sh
dsh plugin --profile web add dsh-session-export
# 或任意 profile：dsh plugin --profile <name> add dsh-session-export
```

安装后自动加入 profile 的 `dsh.profile.bundles`，重启/重载即可使用。

## 使用 Usage（agent 工具）

- 「列出我所有的会话」→ 调用 `session_list`
- 「把会话 <id> 导出成 Markdown 存到 ./backup.md」→ 调用 `session_export`
- 「把这个会话导出为 JSON 给我看」→ `session_export` format=json

English: "List all my sessions" → `session_list`; "Export session <id> to Markdown at ./backup.md" → `session_export`.

会话数据来自 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。

## 为什么选它 Why

- **备份防丢失**：对话历史本地落盘，随时导出归档
- **分享与复盘**：导出 Markdown 可直接发文档、贴博客
- **结构化迁移**：JSON 导出便于摘要、统计、知识库入库

## 配套插件 Companion plugins

- [dsh-session-search](https://github.com/uckkk/dsh-session-search) — 跨会话全文搜索
- [dsh-context-dashboard](https://github.com/uckkk/dsh-context-dashboard) — 会话上下文/Token 统计

## License

MIT © istone

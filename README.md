# dsh-session-export · DSH 会话导出/备份工具

把 DeepSeek Harness（DSH）本地保存的会话一键导出为 **Markdown / JSON**，用于备份、分享、整理与迁移。
Session export & backup tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — list local sessions and export any of them to Markdown or JSON.

## 功能 Features

- `session_list` — 列出所有本地会话：标题、ID、工作目录、创建时间、大小
- `session_export` — 导出指定会话为 **Markdown**（含用户/助手消息、工具调用与结果）或 **JSON**（结构化，便于程序处理）
- 支持 `outPath` 直接写文件；默认返回全文
- 纯 Node 实现，零第三方运行时依赖，peer-only 依赖（随 DSH 宿主加载）

## 安装 Install

```sh
dsh plugin --profile web add dsh-session-export
# 或任意 profile：dsh plugin --profile <name> add dsh-session-export
```

安装后会自动加入 profile 的 `dsh.profile.bundles`，重启/重载后即可使用。

## 使用 Usage（agent 工具）

- 「列出我所有的会话」→ 调用 `session_list`
- 「把会话 <id> 导出成 Markdown 存到 ./backup.md」→ 调用 `session_export`
- 「把这个会话导出为 JSON 给我看」→ `session_export` format=json

会话数据来自 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。同时支持**明文**（`.jsonl`）与 **zstd 压缩**（`.jsonl.zstd`，DSH 默认存储格式）两种存储。

## 为什么选它 Why

- 备份防丢失：对话历史本地落盘，随时导出归档
- 分享与复盘：导出 Markdown 可直接发文档、贴博客
- 结构化迁移：JSON 导出便于二次处理（摘要、统计、知识库入库）

## License

MIT © istone

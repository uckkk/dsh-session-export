// dsh-session-export — DSH 会话导出/备份工具（DeepSeek Harness）。
// 列出本地会话（$DSH_HOME/sessions 下的 session.jsonl），把任意会话导出为
// Markdown 或 JSON。纯 Node，无第三方运行时依赖。
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "会话导出";
const inject = ["tools"];

// ---- Zstandard 多帧解码（与 dsh-session-persistence-jsonl 相同的帧布局）----
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

/** 扫描 buffer 中完整的 zstd 帧范围（容错：遇到截断/损坏帧即停止，不抛错）。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** 解码 .jsonl.zstd 文件为明文 JSONL。 */
function decodeZstdFile(path) {
  const buf = readFileSync(path);
  const frames = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("no complete zstd frame found");
  let plain = "";
  for (const f of frames) plain += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
  return plain;
}

/** 会话根目录：$DSH_HOME/sessions（DSH_HOME 未设置时默认 ~/.dsh）。 */
function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** 从单个会话日志的第一行解析 header 元数据。 */
function parseHeaderLine(firstLine) {
  try {
    const h = JSON.parse(firstLine);
    if (h && h.type === "session") return h;
  } catch { /* ignore */ }
  return null;
}

/** 递归收集所有 session.jsonl（.jsonl.zstd 记录但跳过解码）。 */
function findSessionLogs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name === "session.jsonl") out.push(p);
      else if (e.isFile() && e.name === "session.jsonl.zstd") out.push(p);
    }
  };
  walk(root, 0);
  return out.sort();
}

/** 读取日志首行（明文或 zstd 首帧）。 */
function readFirstLine(log) {
  try {
    const fd = openSync(log, "r");
    const buf = Buffer.alloc(1048576);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const head = buf.subarray(0, bytesRead);
    if (log.endsWith(".zstd")) {
      const frames = scanZstdFrames(head);
      if (frames.length === 0) return null;
      return zstdDecompressSync(head.subarray(frames[0].start, frames[0].end)).toString("utf8").split("\n", 1)[0];
    }
    return head.toString("utf8").split("\n", 1)[0];
  } catch { return null; }
}

/** 从日志提取标题：session/title 记录优先，其次第一条用户消息（解码上限约 4MB）。 */
function sessionTitle(log) {
  try {
    let raw = "";
    if (log.endsWith(".zstd")) {
      const buf = readFileSync(log);
      const frames = scanZstdFrames(buf);
      for (const f of frames) {
        raw += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
        if (raw.length > 4194304) break;
      }
    } else {
      const fd = openSync(log, "r");
      const buf = Buffer.alloc(4194304);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      raw = buf.subarray(0, bytesRead).toString("utf8");
    }
    let firstUser = null;
    for (const line of raw.split("\n")) {
      try {
        const rec = JSON.parse(line);
        if (rec?.type === "session/title" && typeof rec.data?.title === "string" && rec.data.title.trim()) {
          return rec.data.title.trim();
        }
        const type = rec?.type;
        const msg = recordMessage(rec);
        if (firstUser === null && (msg?.role === "user" || type === "user/message") && Array.isArray(msg?.content)) {
          const text = msg.content.map((b) => blockText(b, 200)).filter(Boolean).join(" ").trim();
          if (text) firstUser = text.length > 40 ? text.slice(0, 40) + "…" : text;
        }
      } catch { /* next line */ }
    }
    return firstUser;
  } catch { return null; }
}

/** 列出会话：header + 文件统计。 */
function listSessions(root) {
  const logs = findSessionLogs(root);
  const sessions = [];
  for (const log of logs) {
    try {
      const st = statSync(log);
      const firstLine = readFirstLine(log);
      const header = parseHeaderLine(firstLine);
      const rel = relative(root, log).replace(/\\/g, "/");
      const segs = rel.split("/");
      const title = header?.title || sessionTitle(log) || "(untitled)";
      sessions.push({
        id: header?.id ?? (segs.length >= 2 ? segs[segs.length - 2] : rel),
        title,
        project: segs.length >= 3 ? segs[segs.length - 3] : "_no-cwd",
        cwd: header?.cwd ?? "",
        createdAt: header?.createdAt ?? st.mtimeMs,
        bytes: st.size,
        compressed: log.endsWith(".zstd"),
        path: log,
      });
    } catch { /* skip unreadable */ }
  }
  sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return sessions;
}

/** 从一个内容块里尽量提取可读文本（对格式变化宽容）。 */
function blockText(block, maxLen = 4000) {
  if (typeof block === "string") return block;
  if (block === null || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    const t = block.content.map((b) => blockText(b, maxLen)).filter(Boolean).join("\n");
    return t.slice(0, maxLen);
  }
  const json = JSON.stringify(block);
  return json.length > maxLen ? json.slice(0, maxLen) + "…" : json;
}

/** 从记录中取消息体：兼容 `message:{...}` 与 `data:{content:[...]}` 两种持久化形态。 */
function recordMessage(rec) {
  if (rec?.message && typeof rec.message === "object" && !Array.isArray(rec.message)) return rec.message;
  if (rec?.data && typeof rec.data === "object" && !Array.isArray(rec.data) && Array.isArray(rec.data.content)) return rec.data;
  return rec;
}

/** 一条记录 → { role, text, toolCalls, toolResults } 归一化。 */
function normalizeRecord(rec) {
  const type = rec?.type;
  const msg = recordMessage(rec);
  if (!msg || typeof msg !== "object") {
    return { role: null, text: null, raw: rec };
  }
  const role = msg.role ?? (type?.startsWith("assistant") ? "assistant" : type?.startsWith("user") ? "user" : null);
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const textParts = [];
  const toolCalls = [];
  const toolResults = [];
  for (const b of blocks) {
    const bt = b?.type;
    if (bt === "tool-call" || bt === "toolCall" || bt === "tool_use") {
      const name2 = b.name ?? b.toolName ?? (b.tool_call?.name ?? "tool");
      const args = b.arguments ?? b.input ?? b.arguments_json ?? null;
      toolCalls.push({ name: name2, callId: b.callId ?? b.id ?? null, args: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
    } else if (bt === "tool-result" || bt === "toolResult" || bt === "tool_result") {
      toolResults.push({ callId: b.toolCallId ?? b.callId ?? null, content: blockText(b, 3000) });
    } else if (bt === "reasoning") {
      const t = blockText(b, 2000);
      if (t) textParts.push(`> 💭 ${t}`);
    } else {
      const t = blockText(b);
      if (t) textParts.push(t);
    }
  }
  return { role, text: textParts.join("\n") || null, toolCalls, toolResults, raw: null };
}

/** 导出为 Markdown。 */
function toMarkdown(session, records) {
  const lines = [];
  lines.push(`# ${session.title || session.id}`);
  lines.push("");
  lines.push(`> 会话 ID: \`${session.id}\`　|　时间: ${session.createdAt ? new Date(session.createdAt).toLocaleString() : "未知"}　|　工作目录: \`${session.cwd ?? session.project ?? "-"}\``);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const r of records) {
    if (r.raw) {
      lines.push("```json");
      lines.push(JSON.stringify(r.raw).slice(0, 1500));
      lines.push("```");
      lines.push("");
      continue;
    }
    for (const tc of r.toolCalls) {
      lines.push(`### 🔧 工具调用：${tc.name}`);
      if (tc.callId) lines.push(`> callId: \`${tc.callId}\``);
      try {
        const parsed = JSON.parse(tc.args);
        lines.push("```json");
        lines.push(JSON.stringify(parsed, null, 2).slice(0, 2000));
        lines.push("```");
      } catch {
        lines.push("```");
        lines.push(tc.args.slice(0, 2000));
        lines.push("```");
      }
      lines.push("");
    }
    if (r.text) {
      lines.push(`## ${r.role === "user" ? "👤 用户" : r.role === "assistant" ? "🤖 助手" : "📝 消息"}`);
      lines.push("");
      lines.push(r.text);
      lines.push("");
    }
    for (const tr of r.toolResults) {
      lines.push(`### 📦 工具结果${tr.callId ? `（\`${tr.callId}\`）` : ""}`);
      lines.push("");
      lines.push(tr.content.slice(0, 4000));
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** 导出为 JSON（归一化结构）。 */
function toJson(session, records) {
  return {
    exporter: "dsh-session-export",
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      project: session.project,
      createdAt: session.createdAt,
      bytes: session.bytes,
    },
    records: records.map((r) => r.raw ? { raw: r.raw } : {
      role: r.role,
      text: r.text,
      toolCalls: r.toolCalls,
      toolResults: r.toolResults,
    }),
  };
}

async function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "session_list",
    description:
      "列出 DeepSeek Harness 本地保存的所有会话（标题、ID、工作目录、创建时间、大小）。用于会话管理、备份与导出前的查找。`limit` 限制返回条数，默认 50；`keyword` 按标题模糊过滤。",
    parameters: {
      limit: { type: "integer", description: "最多返回多少条，默认 50。" },
      keyword: { type: "string", description: "按标题关键字过滤。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          count: { type: "integer", required: true },
          sessions: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                title: { type: "string", required: true },
                project: { type: "string", required: true },
                cwd: { type: "string", required: true },
                createdAt: { type: "integer", required: true },
                bytes: { type: "integer", required: true },
                compressed: { type: "boolean", required: true },
                path: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `本地会话 ${value.count} 个：\n${value.sessions.map((s) => `  - ${s.id}  ${s.title}  (${s.createdAt ? new Date(s.createdAt).toLocaleString() : "-"}${s.compressed ? " [zstd]" : ""})`).join("\n") || "  （无）"}`,
      }],
    },
    execute: async (args) => {
      const all = listSessions(sessionsRoot());
      const kw = args.keyword?.toLowerCase();
      const filtered = kw ? all.filter((s) => (s.title ?? "").toLowerCase().includes(kw) || (s.id ?? "").toLowerCase().includes(kw)) : all;
      return {
        count: filtered.length,
        sessions: filtered.slice(0, args.limit ?? 50),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "session_export",
    description:
      "把指定 DeepSeek Harness 会话导出为 Markdown 或 JSON。`id` 传会话 ID（可用 session_list 查询）；`format` 可选 md/json，默认 md；`outPath` 可选，给定时把文件写入该路径并返回路径，否则直接在返回内容中给出全文。适合备份、分享、整理对话记录。",
    parameters: {
      id: { type: "string", required: true, description: "会话 ID。" },
      format: { type: "string", description: "md 或 json，默认 md。" },
      outPath: { type: "string", description: "可选的输出文件路径；给定时写入文件。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          id: { type: "string", required: true },
          title: { type: "string", required: true },
          format: { type: "string", required: true },
          charCount: { type: "integer", required: true },
          lineCount: { type: "integer", required: true },
          content: { type: "string", required: true, description: "完整导出内容。" },
          outPath: { type: "string", description: "写入的文件路径（当 outPath 给出时）。" },
          note: { type: "string", description: "提示信息（如 zstd 压缩不支持）。" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.note
          ? `⚠️ ${value.note}`
          : value.outPath
            ? `已导出会话 ${value.id}（${value.format}，${value.charCount} 字符）→ ${value.outPath}`
            : `会话 ${value.id}（${value.format}，${value.charCount} 字符）：\n\n${value.content.slice(0, 6000)}`,
      }],
    },
    execute: async (args) => {
      const root = sessionsRoot();
      const all = listSessions(root);
      const target = all.find((s) => s.id === args.id) ?? all.find((s) => s.path.endsWith(`/${args.id}/session.jsonl`));
      if (!target) {
        return {
          ok: false, id: args.id, title: "", format: args.format ?? "md",
          charCount: 0, lineCount: 0, content: "",
          note: `未找到会话 ${args.id}（会话目录：${root}）。可先用 session_list 查询存在的会话 ID。`,
        };
      }
      if (target.compressed) {
        try {
          const raw = decodeZstdFile(target.path);
          const lines = raw.split("\n").filter((l) => l.trim().length > 0);
          const records = [];
          for (let i = 0; i < lines.length; i++) {
            try {
              const rec = JSON.parse(lines[i]);
              if (i === 0 && rec.type === "session") continue;
              records.push(normalizeRecord(rec));
            } catch { /* skip unparsable line */ }
          }
          const fmt = args.format === "json" ? "json" : "md";
          const content = fmt === "json"
            ? JSON.stringify(toJson(target, records), null, 2)
            : toMarkdown(target, records);
          let outPath = null;
          if (args.outPath) {
            const dir = dirname(args.outPath);
            if (dir && !existsSync(dir)) { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
            writeFileSync(args.outPath, content, "utf8");
            outPath = args.outPath;
          }
          const result = {
            ok: true, id: args.id, title: target.title, format: fmt,
            charCount: content.length,
            lineCount: content.split("\n").length,
            content,
          };
          if (outPath) result.outPath = outPath;
          return result;
        } catch (e) {
          return {
            ok: false, id: args.id, title: target.title, format: args.format ?? "md",
            charCount: 0, lineCount: 0, content: "",
            note: `会话 ${args.id} 是 zstd 压缩存储，解码失败：${e.message}。`,
          };
        }
      }
      const raw = readFileSync(target.path, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const records = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          const rec = JSON.parse(lines[i]);
          if (i === 0 && rec.type === "session") continue;
          records.push(normalizeRecord(rec));
        } catch { /* skip unparsable line */ }
      }
      const fmt = args.format === "json" ? "json" : "md";
      const content = fmt === "json"
        ? JSON.stringify(toJson(target, records), null, 2)
        : toMarkdown(target, records);
      let outPath = null;
      if (args.outPath) {
        const dir = dirname(args.outPath);
        if (dir && !existsSync(dir)) { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
        writeFileSync(args.outPath, content, "utf8");
        outPath = args.outPath;
      }
      const result = {
        ok: true, id: args.id, title: target.title, format: fmt,
        charCount: content.length,
        lineCount: content.split("\n").length,
        content,
      };
      if (outPath) result.outPath = outPath;
      return result;
    },
  }));
}

export { apply, inject, name };

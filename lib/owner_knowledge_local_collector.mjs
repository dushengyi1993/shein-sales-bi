import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isOwnerKnowledgeCandidateText,
  isOwnerKnowledgeDurableText,
} from './owner_knowledge_policy.mjs';

const MAX_SESSION_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_FILES = 240;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePath(value) {
  return path.resolve(String(value || '.')).replace(/\\/g, '/').toLowerCase();
}

function cleanText(value, max = 4_000) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export function redactOwnerKnowledgeSensitiveText(value) {
  return cleanText(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|passwd|pwd|token|api[_-]?key|secret|cookie|authorization)\s*[:=]\s*)[^\s,;，；]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]');
}

function emptyState(projectRoot) {
  return {
    version: 1,
    projectRoot: normalizePath(projectRoot),
    updatedAt: null,
    memoryNotes: {},
    sessions: {},
  };
}

export function normalizeOwnerKnowledgeSyncState(value, projectRoot) {
  const base = emptyState(projectRoot);
  return {
    ...base,
    ...(value && typeof value === 'object' ? value : {}),
    version: 1,
    projectRoot: base.projectRoot,
    memoryNotes: value?.memoryNotes && typeof value.memoryNotes === 'object' ? value.memoryNotes : {},
    sessions: value?.sessions && typeof value.sessions === 'object' ? value.sessions : {},
  };
}

async function listFilesRecursive(root, predicate, out = []) {
  let entries = [];
  try { entries = await fs.readdir(root, {withFileTypes: true}); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await listFilesRecursive(full, predicate, out);
    else if (entry.isFile() && predicate(full, entry)) out.push(full);
  }
  return out;
}

function projectMentioned(text, projectRoot) {
  const normalized = String(text || '').replace(/\\/g, '/').toLowerCase();
  const root = normalizePath(projectRoot);
  return normalized.includes(root) || normalized.includes('shein销售统计') || normalized.includes('shein-sales-bi');
}

function memoryStatements(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  let inUsefulSection = false;
  let paragraph = [];
  const flush = () => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) rows.push(text);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      inUsefulSection = /(?:记忆|规则|经验|结论|learnings?|preferences?|failures?|boundary)/i.test(line);
      continue;
    }
    if (!inUsefulSection) continue;
    if (!line) { flush(); continue; }
    if (/^(?:cwd|updated_at|thread_id|rollout_path)\s*:/i.test(line.replace(/^[-*]\s*/, ''))) continue;
    const bullet = line.match(/^(?:[-*+]\s+|\d+[.)、]\s*)(.+)$/u);
    if (bullet) {
      flush();
      rows.push(bullet[1].trim());
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return rows;
}

function curatedMemoryDurable(text) {
  const temporalSnapshot = /(?:当前|截至|曾有|已进入|已完成|最新|当日|本次|已有|还有|曾经|已\s*\d).{0,80}(?:20\d{2}[-/.年]|\d+\/\d+|\d+\s*店|\d+\s*条|\d+\s*单|=\s*\d+|ready|warning|matched|开启|完成)/iu.test(text);
  const durable = /(?:后续每次|以后|今后|从现在起|默认|必须|一律|永远|不得|不能替代|不要回退|不要再|不再|优先|统一|只允许|不允许|以.+为准|应是)/u.test(text);
  const strongLongTerm = /(?:后续每次|以后|今后|从现在起|默认|永远|长期|一律)/u.test(text);
  return durable && (!temporalSnapshot || strongLongTerm);
}

function isControlOrDelegationPrompt(text) {
  return /(?:<heartbeat>|<automation_id>|<codex_delegation>|工作区\s+.+(?:只读检查|目标是实施)|请(?:继续)?做一次.+(?:补丁|复核)|不要(?:编辑|改文件)|请聚焦:\s*\d|关键函数\/行号|当前已改:\s*\d|subagent|子代理.*只读|^停止继续|^(?:请|继续).{0,50}(?:只读|审查|检查|工作区|文档审计|最终 diff)|##\s*任务\s*\d|修改后的脚本参数|返回请带具体路径)/ium.test(text);
}

function isSessionOwnerDurable(text) {
  return /(?:以后|今后|从现在起|后续每次|每次都|默认|一律|永远|不要再|不再|记住|我的经验|负责人规则|同事.{0,30}(?:不能|不得|不允许).{0,30}(?:同步|覆盖|修改)|所有.{0,30}都必须|统一按|以.+为准)/u.test(text);
}

function isGeneralizedAgentLesson(text) {
  return /(?:根因是|错误原因|失败原因|教训|修复方式|解决办法|后续应|后续必须|以后|默认|不要再|不能再|验证表明|需要固化)/u.test(text);
}

function splitKnowledgeClauses(text) {
  const clauses = String(text || '').split(/[;；]\s*/u).map(item => item.trim()).filter(Boolean);
  return clauses.length > 1 ? clauses : [String(text || '').trim()];
}

async function collectMemoryNotes({codexHome, projectRoot, state}) {
  const dir = path.join(codexHome, 'memories', 'extensions', 'ad_hoc', 'notes');
  const files = (await listFilesRecursive(dir, file => /\.md$/i.test(file))).sort();
  const events = [];
  const next = {...state.memoryNotes};
  for (const file of files) {
    const rel = path.relative(codexHome, file).replace(/\\/g, '/');
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw || !projectMentioned(raw, projectRoot)) continue;
    const digest = hash(raw);
    if (state.memoryNotes[rel] === digest) continue;
    const stat = await fs.stat(file).catch(() => null);
    const sourceAt = raw.match(/^\s*-\s*updated_at:\s*`?([^`\n]+)`?/mi)?.[1]?.trim()
      || stat?.mtime?.toISOString()
      || new Date().toISOString();
    for (const [index, statement] of memoryStatements(raw).entries()) {
      for (const [clauseIndex, clause] of splitKnowledgeClauses(statement).entries()) {
        const text = redactOwnerKnowledgeSensitiveText(clause);
        if (!isOwnerKnowledgeCandidateText(text) && !curatedMemoryDurable(text)) continue;
        const durable = curatedMemoryDurable(text);
        events.push({
          text,
          sourceKind: 'owner_memory_note',
          sourceId: `${rel}:${index}.${clauseIndex}:${hash(text).slice(0, 16)}`,
          sourceAt,
          explicitDurable: durable,
          activation: durable ? 'active' : 'candidate',
        });
      }
    }
    next[rel] = digest;
  }
  return {events, nextMemoryNotes: next};
}

function messageFromEvent(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.type === 'user_message') return payload.message || '';
  if (payload.type === 'agent_message' && String(payload.phase || '') === 'final_answer') return payload.message || '';
  return '';
}

async function readAppendedLines(file, prior = {}) {
  const stat = await fs.stat(file);
  let offset = Number(prior.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) offset = 0;
  if (!offset && stat.size > MAX_SESSION_BOOTSTRAP_BYTES) offset = stat.size - MAX_SESSION_BOOTSTRAP_BYTES;
  const handle = await fs.open(file, 'r');
  try {
    const length = Math.max(0, stat.size - offset);
    if (!length) return {lines: [], nextOffset: stat.size, stat};
    const buffer = Buffer.allocUnsafe(length);
    const {bytesRead} = await handle.read(buffer, 0, length, offset);
    let data = buffer.subarray(0, bytesRead);
    let startsAtLineBoundary = offset === 0;
    if (offset > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      const previous = await handle.read(previousByte, 0, 1, offset - 1);
      startsAtLineBoundary = previous.bytesRead === 1 && previousByte[0] === 0x0a;
    }
    if (offset > 0 && !startsAtLineBoundary) {
      const firstBreak = data.indexOf(0x0a);
      if (firstBreak < 0) return {lines: [], nextOffset: stat.size, stat};
      offset += firstBreak + 1;
      data = data.subarray(firstBreak + 1);
    }
    const lastBreak = data.lastIndexOf(0x0a);
    if (lastBreak < 0) return {lines: [], nextOffset: offset, stat};
    const complete = data.subarray(0, lastBreak + 1);
    const text = complete.toString('utf8');
    const lines = [];
    let cursor = offset;
    for (const line of text.split('\n')) {
      const bytes = Buffer.byteLength(line + '\n');
      if (line.trim()) lines.push({line, offset: cursor});
      cursor += bytes;
    }
    return {lines, nextOffset: offset + complete.length, stat};
  } finally {
    await handle.close();
  }
}

async function collectSessions({codexHome, projectRoot, state}) {
  const root = path.join(codexHome, 'sessions');
  const files = await listFilesRecursive(root, file => /\.jsonl$/i.test(file));
  const withStats = (await Promise.all(files.map(async file => ({file, stat: await fs.stat(file).catch(() => null)}))))
    .filter(row => row.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, MAX_SESSION_FILES);
  const events = [];
  const next = {...state.sessions};
  const expectedRoot = normalizePath(projectRoot);
  for (const {file} of withStats) {
    const rel = path.relative(codexHome, file).replace(/\\/g, '/');
    const prior = state.sessions[rel] && typeof state.sessions[rel] === 'object' ? state.sessions[rel] : {};
    const chunk = await readAppendedLines(file, prior);
    let cwd = String(prior.cwd || '');
    for (const row of chunk.lines) {
      let event;
      try { event = JSON.parse(row.line); } catch { continue; }
      if (event?.type === 'turn_context') {
        cwd = normalizePath(event?.payload?.cwd || cwd);
        continue;
      }
      if (cwd !== expectedRoot) continue;
      const payload = event?.payload;
      const message = redactOwnerKnowledgeSensitiveText(messageFromEvent(payload));
      if (!message || !isOwnerKnowledgeCandidateText(message)) continue;
      const isUser = payload?.type === 'user_message';
      if (isControlOrDelegationPrompt(message)) continue;
      if (!isUser && !isGeneralizedAgentLesson(message)) continue;
      const durable = isUser && isSessionOwnerDurable(message) && isOwnerKnowledgeDurableText(message);
      events.push({
        text: message,
        sourceKind: isUser ? 'owner_codex_user' : 'owner_codex_final',
        sourceId: `${rel}:${row.offset}:${hash(message).slice(0, 16)}`,
        sourceAt: chunk.stat.mtime.toISOString(),
        explicitDurable: durable,
        activation: durable ? 'active' : 'candidate',
      });
    }
    next[rel] = {offset: chunk.nextOffset, cwd, mtimeMs: chunk.stat.mtimeMs};
  }
  return {events, nextSessions: next};
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter(event => {
    const key = `${event.sourceKind}|${event.sourceId}|${hash(event.text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function collectOwnerKnowledgeEvents({codexHome, projectRoot, state: rawState = {}} = {}) {
  if (!codexHome) throw new TypeError('codexHome is required');
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const state = normalizeOwnerKnowledgeSyncState(rawState, projectRoot);
  const [memory, sessions] = await Promise.all([
    collectMemoryNotes({codexHome, projectRoot, state}),
    collectSessions({codexHome, projectRoot, state}),
  ]);
  const events = dedupeEvents([...memory.events, ...sessions.events]);
  return {
    events,
    nextState: {
      ...state,
      memoryNotes: memory.nextMemoryNotes,
      sessions: sessions.nextSessions,
      updatedAt: new Date().toISOString(),
    },
    summary: {
      total: events.length,
      active: events.filter(event => event.activation === 'active').length,
      candidates: events.filter(event => event.activation === 'candidate').length,
      memoryNotes: events.filter(event => event.sourceKind === 'owner_memory_note').length,
      sessionUser: events.filter(event => event.sourceKind === 'owner_codex_user').length,
      sessionFinal: events.filter(event => event.sourceKind === 'owner_codex_final').length,
    },
  };
}

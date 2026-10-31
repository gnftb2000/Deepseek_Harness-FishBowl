/**
 * 鱼缸 · 搬家（导入/导出）与旧会话提炼
 * ============================================================================
 * - 导入：从 dsh-auto-memory 的 MEMORY.md、dsh-mnemon 的 USER.md/MEMORY.md、
 *   SurfCore 的角色/记忆卡（JSON 优先、markdown 兜底）解析成「草稿条目」；
 *   草稿不参与注入，要 /persona approve 才转正。
 * - 导出：把 Soul / relationship / episodes / handoff / MEMORY.md + 结构化 JSON 清单
 *   打成一个目录（默认 ~/Downloads/fishbowl-export-<日期>-<时间>）。
 * - 旧会话提炼：把一段旧会话（已脱敏、无工具流水）交给大模型提炼成「审核提议」，
 *   全部进待审队列，不直接写记忆。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

import { dayKey, hashString, messageText, normStatement, nowIso, trunc } from './util.mjs'
import { isInjectedUserText, redactText } from './text.mjs'

// ---------------------------------------------------------------------------
// 导入：别的插件的记忆 → 草稿条目
// ---------------------------------------------------------------------------

const KIND_RULES = [
  { kind: 'boundary', re: /(雷区|边界|禁忌|不许|不准|不要|避免|禁止|底线)/ },
  { kind: 'ritual', re: /(仪式|节律|习惯|每天|每周|固定|照例)/ },
  { kind: 'promise', re: /(承诺|答应|约定|未完|明天|下次)/ },
  { kind: 'context', re: /(工作|项目|正在|任务|最近)/ },
  { kind: 'open_question', re: /(问题|待定|未定|开放|还没定)/ },
]

export function inferKind(section = '') {
  for (const rule of KIND_RULES) if (rule.re.test(String(section))) return rule.kind
  return 'preference'
}

function dedupeItems(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = normStatement(item.statement)
    if (!key || key.length < 4 || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 通用 markdown：按 heading 推 kind，收集列表项。 */
export function parseMarkdownMemory(markdown, options = {}) {
  const source = options.source || 'markdown'
  const maxItems = options.maxItems ?? 80
  let heading = ''
  const raw = []
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      heading = headingMatch[1].trim()
      continue
    }
    if (/^```/.test(trimmed)) continue
    if (/^https?:\/\//i.test(trimmed)) continue
    const bullet = /^(?:[-*•]|\d+[.、])\s+(.+)$/.exec(trimmed)
    const kv = /^(?:记忆|偏好|边界|雷区|备注|事实|用户)[：:]\s*(.+)$/.exec(trimmed)
    const text = (bullet ? bullet[1] : kv ? kv[1] : '').trim()
    if (!text || text.length < 6 || text.length > 300) continue
    raw.push({
      statement: trunc(redactText(text), 300),
      kind: inferKind(heading),
      source,
      section: heading || undefined,
    })
    if (raw.length >= maxItems * 2) break
  }
  return dedupeItems(raw).slice(0, maxItems)
}

/** SurfCore 卡片：优先 JSON（数组 / {cards}/{memories}/{entries}），失败回落 markdown。 */
export function parseSurfcoreMemory(rawText, options = {}) {
  const source = options.source || 'surfcore'
  const maxItems = options.maxItems ?? 80
  const text = String(rawText || '')
  const jsonStart = text.indexOf('{')
  const jsonArrayStart = text.indexOf('[')
  const start = jsonStart >= 0 && (jsonArrayStart < 0 || jsonStart < jsonArrayStart) ? jsonStart : jsonArrayStart
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start))
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cards)
          ? parsed.cards
          : Array.isArray(parsed?.memories)
            ? parsed.memories
            : Array.isArray(parsed?.entries)
              ? parsed.entries
              : []
      const items = []
      for (const card of list) {
        if (!card) continue
        const statement =
          card.statement || card.text || card.content || card.summary || card.memory || card.value || ''
        if (typeof statement !== 'string' || statement.trim().length < 6) continue
        const section = String(card.kind || card.category || card.tag || card.type || '')
        items.push({
          statement: trunc(redactText(statement.trim()), 300),
          kind: inferKind(section),
          source,
          section: section || undefined,
        })
        if (items.length >= maxItems * 2) break
      }
      if (items.length > 0) return dedupeItems(items).slice(0, maxItems)
    } catch {
      /* 就当 markdown 处理 */
    }
  }
  return parseMarkdownMemory(text, { ...options, source })
}

/** 按格式解析一个文件；format=auto 时按扩展名/内容猜。 */
export function parseMemoryFile({ format = 'auto', raw, source }) {
  const resolved = format === 'auto' ? detectMemoryFormat({ raw, source }) : format
  if (resolved === 'surfcore') return parseSurfcoreMemory(raw, { source })
  return parseMarkdownMemory(raw, { source })
}

export function detectMemoryFormat({ raw, source = '' }) {
  const text = String(raw || '')
  const name = String(source || '').toLowerCase()
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'surfcore'
  if (/surfcore|memory_card|记忆卡/.test(name)) return 'surfcore'
  if (/mnemon/.test(name)) return 'mnemon'
  if (/auto-memory|auto_memory|memory\.md$/.test(name)) return 'auto-memory'
  return 'markdown'
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

function copyIfExists(from, to) {
  if (!existsSync(from)) return false
  copyFileSync(from, to)
  return true
}

/**
 * 校验/准备导出父目录：绝对路径（支持 ~ 开头），不存在就创建，必须是目录且可写。
 * @returns {{ok: true, parent: string} | {ok: false, error: string}}
 */
export function prepareExportParent(input) {
  const raw = String(input || '').trim()
  const fallback = join(homedir(), 'Downloads')
  let expanded = raw || fallback
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2))
  if (!isAbsolute(expanded)) return { ok: false, error: `导出位置必须是绝对路径：${raw || expanded}` }
  try {
    if (existsSync(expanded) && !statSync(expanded).isDirectory()) {
      return { ok: false, error: `这个路径是文件，不是文件夹：${expanded}` }
    }
    mkdirSync(expanded, { recursive: true })
    return { ok: true, parent: expanded }
  } catch (e) {
    return { ok: false, error: `导出位置不可写：${e?.message ?? e}` }
  }
}

/**
 * 打包成一个目录：
 *   soul.md / relationship.md / MEMORY.md / episodes/ / handoff/ / fishbowl-export.json / README.txt
 * - parentDir：父目录（默认 ~/Downloads），会在里面新建 fishbowl-export-<日期-时间>/
 * - outDir：精确目标目录（测试/旧调用用）
 */
export function buildExport({ store, persona, parentDir, outDir, now = new Date() }) {
  const compact = nowIso().replace(/[-:T]/g, '').slice(0, 12)
  const stamp = `${compact.slice(0, 8)}-${compact.slice(8, 12)}`
  let dir
  if (outDir) {
    dir = outDir
    mkdirSync(dir, { recursive: true })
  } else {
    const prepared = prepareExportParent(parentDir)
    if (!prepared.ok) throw new Error(prepared.error)
    const base = join(prepared.parent, `fishbowl-export-${stamp}`)
    dir = base
    for (let index = 2; existsSync(dir); index += 1) dir = `${base}-${index}`
    mkdirSync(dir, { recursive: true })
  }
  const files = []
  for (const name of ['soul.md', 'relationship.md', 'MEMORY.md']) {
    if (copyIfExists(join(store.dir, name), join(dir, name))) files.push(name)
  }
  for (const sub of ['episodes', 'handoff']) {
    const src = join(store.dir, sub)
    if (!existsSync(src)) continue
    const target = join(dir, sub)
    mkdirSync(target, { recursive: true })
    for (const file of readdirSync(src)) {
      if (!file.endsWith('.md')) continue
      if (copyIfExists(join(src, file), join(target, file))) files.push(`${sub}/${file}`)
    }
  }
  const entries = store.readAllEntries()
  const manifest = {
    schema: 'fishbowl/export@1',
    plugin: 'dsh-fishbowl',
    exportedAt: nowIso(),
    persona,
    soulVersion: store.readSoul().meta.version ?? null,
    counts: store.counts(),
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      scope: entry.scope,
      status: entry.status,
      pinned: entry.pinned === true,
      confidence: entry.confidence,
      statement: entry.statement,
      evidence: entry.evidence,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    })),
  }
  writeFileSync(join(dir, 'fishbowl-export.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(dir, 'README.txt'),
    [
      '鱼缸 / Fishbowl 记忆导出包',
      '',
      `导出时间：${nowIso()}`,
      `人设：${persona}`,
      `条目：${entries.length} 条（${files.length} 个数据文件）`,
      '',
      '文件说明：',
      '- soul.md：身份内核（L0，locked，只读）',
      '- relationship.md：关系/偏好/边界/仪式/承诺/近况（markdown + yaml 条目块）',
      '- episodes/：情节卡（按月份）',
      '- handoff/：会话交接条（按工作区，文件里只有工作区名+哈希，没有完整路径）',
      '- MEMORY.md：人类可读索引（只指向，不重复正文）',
      '- fishbowl-export.json：结构化清单，方便脚本导入到别处',
      '',
      '这份包不含 journal/（原始日记）与账号/密钥；路径已脱敏。',
      '',
    ].join('\n'),
    'utf8',
  )
  return { dir, parentDir: dirname(dir), files: files.length, entries: entries.length }
}

// ---------------------------------------------------------------------------
// 旧会话提炼
// ---------------------------------------------------------------------------

export const MINE_SYSTEM_PROMPT = [
  '你是「鱼缸」的历史提炼器（archivist）。任务：从一段旧会话里，提炼值得长期记住的东西，输出结构化 JSON。',
  '',
  '硬规则：',
  '1. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
  '2. 只提炼：用户的偏好/边界/仪式/承诺/近况、你们共同经历的情节。',
  '3. 不写：工具调用流水、命令输出、文件路径、密钥、账号、uid、一次性闲聊、模型自己的猜测。',
  '4. 每条都当成「提议」，用户会审核；Soul 永远不能改。',
  '5. 没有值得记的就返回 {"noop":true}。',
  '',
  '输出格式：',
  '{"noop":false,"ops":[',
  '  {"op":"add","kind":"preference|boundary|ritual|promise|context|open_question|episode","statement":"一句话","confidence":0.7,"reason":"来自哪段对话"}',
  ']}',
  '最多 10 条 op；statement 不超过 300 字。',
].join('\n')

/** 从事件流里拼一段「用户：… / 她：…」的脱敏 transcript。 */
export function buildTranscript(events, options = {}) {
  const maxChars = options.maxChars ?? 8000
  const maxMessages = options.maxMessages ?? 120
  const lines = []
  let used = 0
  for (const event of events || []) {
    if (!event || typeof event.type !== 'string') continue
    const rawMessage =
      event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data?.message : undefined
    if (!rawMessage) continue
    let text = ''
    try {
      text = messageText(rawMessage)
    } catch {
      text = ''
    }
    if (!text) continue
    if (event.type === 'user/message' && isInjectedUserText(text)) continue
    const cleaned = trunc(redactText(text).replace(/\s+/g, ' ').trim(), 600)
    if (!cleaned) continue
    const line = `${event.type === 'user/message' ? '用户' : '她'}：${cleaned}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length
    if (lines.length >= maxMessages) break
  }
  return lines.join('\n')
}

export function buildMineInput({ persona, session, transcript }) {
  return {
    persona,
    session: {
      id: session.id,
      title: session.title || undefined,
      createdAt: session.createdAt || undefined,
    },
    task: '从这段旧会话里提炼值得长期保留的记忆（关系/情节）。只提议，全部进审核队列；没价值就 noop。',
    transcript,
  }
}

/** 导出时的建议文件名（不写完整机器路径）。 */
export function mineReportName(now = new Date()) {
  return `mine-${dayKey(now)}-${hashString(now.toISOString()).slice(0, 4)}.md`
}

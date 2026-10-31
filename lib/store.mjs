/**
 * 鱼缸 · 存储层：persona 家目录、relationship/episodes/handoff、overrides、journal。
 *
 * 文件格式对齐 大纲.md §5 与 示例/*.md：
 *   - relationship.md 与 episodes/YYYY-MM.md 用「markdown + ```yaml 条目块」；
 *   - handoff/<workspace>.md 每个工作区一个文件，最新一条在上，保留最近 N 条；
 *   - journal/YYYY-MM-DD.jsonl 是原始 WAL（不注入）；
 *   - MEMORY.md 只做渲染索引（由 index.js 调 counts() 生成）。
 *
 * 注意：解析器只认自家 schema（顶层 key: value + evidence 列表），不做通用 YAML。
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { dayKey, monthKey, nowIso, normStatement, splitFrontmatter, trunc, workspaceTag } from './util.mjs'

export const RELATIONSHIP_KINDS = ['preference', 'boundary', 'ritual', 'promise', 'context', 'open_question']
export const ALL_KINDS = [...RELATIONSHIP_KINDS, 'episode']
const ENDED_STATUS = new Set(['forgotten', 'superseded', 'stale'])

const KIND_GROUPS = [
  { kinds: ['preference'], title: '一、偏好与习惯' },
  { kinds: ['boundary'], title: '二、雷区与边界' },
  { kinds: ['ritual'], title: '三、仪式与节律' },
  { kinds: ['promise'], title: '四、承诺与未完成' },
  { kinds: ['context'], title: '五、正在做的事' },
  { kinds: ['open_question'], title: '六、开放问题' },
]

// ---------------------------------------------------------------------------
// 极简 YAML 子集：解析 / 渲染
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text === '' || text === '~' || text === 'null') return ''
  if (text === '[]') return []
  if (text === '{}') return {}
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

export function parseYamlBlock(blockText) {
  const out = {}
  let currentKey = null
  const lines = String(blockText ?? '').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    if (indent === 0) {
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed)
      if (!match) continue
      const [, key, value] = match
      if (value === '') {
        out[key] = []
        currentKey = key
      } else {
        out[key] = parseScalar(value)
        currentKey = key
      }
      continue
    }
    // 缩进行：只处理列表 / 列表项的子字段
    if (!currentKey) continue
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = []
      const itemText = trimmed.slice(2).trim()
      const inline = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(itemText)
      if (inline) {
        const item = { [inline[1]]: parseScalar(inline[2]) }
        out[currentKey].push(item)
      } else {
        out[currentKey].push(parseScalar(itemText))
      }
      continue
    }
    const nested = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed)
    if (nested && Array.isArray(out[currentKey]) && out[currentKey].length > 0) {
      const last = out[currentKey][out[currentKey].length - 1]
      if (last && typeof last === 'object' && !Array.isArray(last)) last[nested[1]] = parseScalar(nested[2])
    }
  }
  return out
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  if (text === '') return '""'
  if (text === '[]') return '[]'
  if (/^[A-Za-z0-9_.:@/\-]+$/.test(text) && !/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(text)) return text
  return JSON.stringify(text)
}

export function renderEntryBlock(entry) {
  const lines = []
  const push = (key, value) => lines.push(`${key}: ${yamlScalar(value)}`)
  push('id', entry.id)
  push('kind', entry.kind)
  push('scope', entry.scope)
  push('status', entry.status)
  push('pinned', Boolean(entry.pinned))
  push('confidence', Number(entry.confidence ?? 0.7))
  push('created_at', entry.created_at)
  push('updated_at', entry.updated_at)
  push('statement', entry.statement)
  const evidence = Array.isArray(entry.evidence) ? entry.evidence : []
  if (evidence.length === 0) {
    push('evidence', '[]')
  } else {
    lines.push('evidence:')
    for (const item of evidence) {
      const keys = Object.keys(item || {})
      if (keys.length === 0) continue
      keys.forEach((key, index) => {
        const prefix = index === 0 ? '  - ' : '    '
        lines.push(`${prefix}${key}: ${yamlScalar(item[key])}`)
      })
    }
  }
  const supersedes = Array.isArray(entry.supersedes) ? entry.supersedes : []
  if (supersedes.length === 0) push('supersedes', '[]')
  else {
    lines.push('supersedes:')
    for (const id of supersedes) lines.push(`  - ${yamlScalar(id)}`)
  }
  const conflicts = Array.isArray(entry.conflicts_with) ? entry.conflicts_with : []
  if (conflicts.length === 0) push('conflicts_with', '[]')
  else {
    lines.push('conflicts_with:')
    for (const id of conflicts) lines.push(`  - ${yamlScalar(id)}`)
  }
  return lines.join('\n')
}

function normalizeEntry(raw) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.statement !== 'string') return null
  const statement = raw.statement.trim()
  if (!statement) return null
  const kind = ALL_KINDS.includes(raw.kind) ? raw.kind : 'preference'
  const confidence = Number(raw.confidence)
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => {
          const copy = {}
          for (const key of ['session', 'seq', 'quote', 'source']) {
            if (item[key] !== undefined && item[key] !== '') copy[key] = item[key]
          }
          return copy
        })
        .filter((item) => Object.keys(item).length > 0)
    : []
  return {
    id: raw.id,
    kind,
    scope: typeof raw.scope === 'string' && raw.scope ? raw.scope : 'persona',
    status: typeof raw.status === 'string' && raw.status ? raw.status : 'active',
    pinned: raw.pinned === true || raw.pinned === 'true',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : dayKey(),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : dayKey(),
    statement,
    evidence,
    supersedes: Array.isArray(raw.supersedes) ? raw.supersedes.filter((id) => typeof id === 'string') : [],
    conflicts_with: Array.isArray(raw.conflicts_with) ? raw.conflicts_with.filter((id) => typeof id === 'string') : [],
  }
}

export function parseEntriesFromMarkdown(markdownText) {
  const text = String(markdownText ?? '')
  const entries = []
  const fence = /```ya?ml\r?\n([\s\S]*?)```/g
  let match
  while ((match = fence.exec(text)) !== null) {
    const parsed = normalizeEntry(parseYamlBlock(match[1]))
    if (parsed) entries.push(parsed)
  }
  return entries
}

function shortLabel(statement) {
  return trunc(String(statement).replace(/\s+/g, ' '), 26)
}

function renderEntrySection(entry) {
  return [`### ${entry.id} · ${shortLabel(entry.statement)}`, '', '```yaml', renderEntryBlock(entry), '```', ''].join('\n')
}

export function renderRelationshipMarkdown({ persona, entries, updatedAt = nowIso() }) {
  const activeEntries = entries.filter((entry) => !ENDED_STATUS.has(entry.status))
  const endedEntries = entries.filter((entry) => ENDED_STATUS.has(entry.status))
  const parts = [
    '---',
    'schema: fishbowl/relationship@1',
    `persona: ${yamlScalar(persona)}`,
    `updated_at: ${updatedAt}`,
    'notes: |',
    '  自动维护：关系/偏好/边界/仪式/承诺/上下文。',
    '  status=draft / needs_review 的条目不参与自动注入；Soul 不在这里。',
    '---',
    '',
    `# Relationship · ${persona}`,
    '',
    '> 这一页回答：用户喜欢什么、讨厌什么、你们之间有哪些约定和仪式。',
    '> 不写「她今天做了什么」——那是 episodes 的事。',
    '',
  ]
  for (const group of KIND_GROUPS) {
    const items = activeEntries.filter((entry) => group.kinds.includes(entry.kind))
    if (items.length === 0) continue
    parts.push(`## ${group.title}`, '')
    for (const entry of items) parts.push(renderEntrySection(entry))
  }
  if (endedEntries.length > 0) {
    parts.push('## 七、已归档（保留审计，不注入）', '')
    for (const entry of endedEntries) parts.push(renderEntrySection(entry))
  }
  if (activeEntries.length === 0 && endedEntries.length === 0) {
    parts.push('> 还没有条目。用 `/remember <话>`、或在新会话里说「记住：……」来写入。', '')
  }
  return parts.join('\n')
}

export function renderEpisodesMarkdown({ persona, month, entries, updatedAt = nowIso() }) {
  const sorted = [...entries].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  const parts = [
    '---',
    'schema: fishbowl/episodes@1',
    `persona: ${yamlScalar(persona)}`,
    `month: ${month}`,
    `updated_at: ${updatedAt}`,
    'notes: |',
    '  情节卡：原话短引用 + 场景 + 立场/情绪 + 出处。M1 只搭 schema，写入留给 M2 curator。',
    '---',
    '',
    `# Episodes · ${month}`,
    '',
  ]
  if (sorted.length === 0) parts.push('> 这个月还没有情节卡。', '')
  for (const entry of sorted) parts.push(renderEntrySection(entry))
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Handoff（每个工作区一个文件，最新在上）
// ---------------------------------------------------------------------------

export function parseHandoff(markdownText) {
  const text = String(markdownText ?? '')
  const { meta, body } = splitFrontmatter(text)
  const chunks = body.split(/^## /m)
  const header = chunks.shift() ?? ''
  const entries = []
  for (const chunk of chunks) {
    const [firstLine, ...rest] = chunk.split('\n')
    const at = firstLine.trim()
    if (!at) continue
    const bullet = {}
    for (const line of rest) {
      const m = /^\s*-\s*([^：:]+)[：:]\s*(.*)$/.exec(line)
      if (m) bullet[m[1].trim()] = m[2].trim()
    }
    entries.push({
      at,
      session: bullet['session'] || '',
      summary: bullet['上次停在哪'] || '',
      reply: bullet['我最后回的'] || '',
      promises: bullet['未完成的承诺'] && bullet['未完成的承诺'] !== '无' ? bullet['未完成的承诺'].split('；').filter(Boolean) : [],
    })
  }
  return { meta, header, entries }
}

export function renderHandoff({ persona, workspaceTag, entries, updatedAt = nowIso() }) {
  const parts = [
    '---',
    'schema: fishbowl/handoff@1',
    `persona: ${yamlScalar(persona)}`,
    `scope: workspace:${workspaceTag.hash}`,
    `workspace_name: ${yamlScalar(workspaceTag.name)}`,
    `updated_at: ${updatedAt}`,
    'notes: |',
    '  会话交接条：只写「下次接上需要知道的最小集合」。最新一条在最上面，保留最近 N 条。',
    '---',
    '',
    `# 交接条 · ${workspaceTag.name}`,
    '',
  ]
  for (const entry of entries) {
    parts.push(`## ${entry.at}`, '')
    parts.push(`- session：${entry.session}`)
    parts.push(`- 上次停在哪：${entry.summary || '（无）'}`)
    parts.push(`- 我最后回的：${entry.reply || '（无）'}`)
    parts.push(`- 未完成的承诺：${entry.promises && entry.promises.length > 0 ? entry.promises.join('；') : '无'}`)
    parts.push('')
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  constructor({ dir, persona, log = () => {} }) {
    this.dir = dir
    this.persona = persona
    this.log = log
    this._relationshipCache = { mtimeMs: -1, entries: [] }
    this._episodeCache = new Map()
    this._handoffCache = new Map()
    this._soulCache = { mtimeMs: -1, meta: {}, body: '' }
  }

  get soulPath() {
    return join(this.dir, 'soul.md')
  }
  get relationshipPath() {
    return join(this.dir, 'relationship.md')
  }
  get episodesDir() {
    return join(this.dir, 'episodes')
  }
  get handoffDir() {
    return join(this.dir, 'handoff')
  }
  get journalDir() {
    return join(this.dir, 'journal')
  }
  get overridesPath() {
    return join(this.dir, 'overrides.json')
  }
  get memoryIndexPath() {
    return join(this.dir, 'MEMORY.md')
  }
  get rememberedPath() {
    return join(this.dir, 'remembered.jsonl')
  }
  get statePath() {
    return join(this.dir, 'state.json')
  }
  get queuePath() {
    return join(this.dir, 'review', 'queue.jsonl')
  }
  get reportsDir() {
    return join(this.dir, 'reports')
  }
  get autoLogPath() {
    return join(this.dir, 'review', 'auto-log.jsonl')
  }

  ensureDir(path) {
    mkdirSync(path, { recursive: true })
  }

  ensurePersona({ soulSeedPath } = {}) {
    this.ensureDir(this.dir)
    this.ensureDir(this.journalDir)
    this.ensureDir(this.episodesDir)
    this.ensureDir(this.handoffDir)
    this.ensureDir(this.reportsDir)
    this.ensureDir(join(this.dir, 'review'))
    if (!existsSync(this.soulPath)) {
      if (soulSeedPath && existsSync(soulSeedPath)) {
        copyFileSync(soulSeedPath, this.soulPath)
      } else {
        writeFileSync(
          this.soulPath,
          `---\nschema: fishbowl/soul@1\npersona: ${this.persona}\nlocked: true\nversion: 1\ncreated_at: ${dayKey()}\n---\n\n# Soul\n\n（编辑这一页：写「她是谁 / 怎么说话 / 什么不能做」。插件不会自动改它。）\n`,
          'utf8',
        )
      }
    }
    if (!existsSync(this.relationshipPath)) {
      writeFileSync(this.relationshipPath, renderRelationshipMarkdown({ persona: this.persona, entries: [] }), 'utf8')
    }
    this.pruneJournals()
    return this
  }

  pruneJournals(keepDays = 30) {
    try {
      const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
      for (const file of readdirSync(this.journalDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue
        const full = join(this.journalDir, file)
        try {
          if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
        } catch {
          /* 单文件失败不影响启动 */
        }
      }
    } catch {
      /* journal 目录不存在等 */
    }
  }

  readSoul() {
    try {
      const st = statSync(this.soulPath)
      if (st.mtimeMs !== this._soulCache.mtimeMs) {
        const { meta, body } = splitFrontmatter(readFileSync(this.soulPath, 'utf8'))
        this._soulCache = { mtimeMs: st.mtimeMs, meta, body: body.trim() }
      }
    } catch {
      this._soulCache = { mtimeMs: -1, meta: {}, body: '' }
    }
    return this._soulCache
  }

  // --- relationship -------------------------------------------------------
  readRelationship() {
    try {
      const st = statSync(this.relationshipPath)
      if (st.mtimeMs !== this._relationshipCache.mtimeMs) {
        const raw = readFileSync(this.relationshipPath, 'utf8')
        const entries = parseEntriesFromMarkdown(raw)
        this._relationshipCache = {
          mtimeMs: st.mtimeMs,
          entries,
          // 只有「看起来有 yaml 条目块却一条都没解析出来」才算解析失败；空模板不算
          _parseFailed: raw.length > 200 && entries.length === 0 && /```ya?ml/.test(raw),
        }
      }
    } catch {
      this._relationshipCache = { mtimeMs: -1, entries: [] }
    }
    return this._relationshipCache
  }

  writeRelationship(entries) {
    if (this._relationshipCache._parseFailed) {
      const backup = `${this.relationshipPath}.unparsed-${Date.now()}.bak`
      try {
        writeFileSync(backup, readFileSync(this.relationshipPath, 'utf8'), 'utf8')
        this.log(`relationship.md 解析失败，已备份到 ${backup}`)
      } catch {
        /* 备份失败也继续写，保证功能 */
      }
    }
    const content = renderRelationshipMarkdown({ persona: this.persona, entries })
    this._atomicWrite(this.relationshipPath, content)
    this._relationshipCache = { mtimeMs: statSync(this.relationshipPath).mtimeMs, entries }
  }

  // --- episodes -----------------------------------------------------------
  episodePath(month) {
    return join(this.episodesDir, `${month}.md`)
  }

  readEpisodeFile(month) {
    const file = this.episodePath(month)
    try {
      const st = statSync(file)
      const cached = this._episodeCache.get(file)
      if (cached && cached.mtimeMs === st.mtimeMs) return cached.entries
      const entries = parseEntriesFromMarkdown(readFileSync(file, 'utf8'))
      this._episodeCache.set(file, { mtimeMs: st.mtimeMs, entries })
      return entries
    } catch {
      return []
    }
  }

  writeEpisodeFile(month, entries) {
    const file = this.episodePath(month)
    this.ensureDir(this.episodesDir)
    this._atomicWrite(file, renderEpisodesMarkdown({ persona: this.persona, month, entries }))
    try {
      this._episodeCache.set(file, { mtimeMs: statSync(file).mtimeMs, entries })
    } catch {
      /* 忽略 */
    }
  }

  readEpisodes() {
    try {
      const months = readdirSync(this.episodesDir)
        .filter((file) => /^\d{4}-\d{2}\.md$/.test(file))
        .map((file) => file.slice(0, 7))
        .sort()
      return months.flatMap((month) => this.readEpisodeFile(month))
    } catch {
      return []
    }
  }

  /** relationship + episodes 的合并视图。 */
  readAllEntries() {
    return [...this.readRelationship().entries, ...this.readEpisodes()]
  }

  // --- entry 写入 / 更新 / 遗忘 -------------------------------------------
  _writeEntrySource(entry) {
    if (entry.kind === 'episode') {
      const month = monthKey(new Date(entry.updated_at || entry.created_at || nowIso()))
      const entries = this.readEpisodeFile(month)
      const index = entries.findIndex((item) => item.id === entry.id)
      if (index >= 0) entries[index] = entry
      else entries.push(entry)
      this.writeEpisodeFile(month, entries)
      return
    }
    const entries = [...this.readRelationship().entries]
    const index = entries.findIndex((item) => item.id === entry.id)
    if (index >= 0) entries[index] = entry
    else entries.push(entry)
    this.writeRelationship(entries)
  }

  hasDuplicateStatement(statement) {
    const needle = normStatement(statement)
    if (!needle) return false
    return this.readAllEntries().some(
      (entry) => entry.status !== 'forgotten' && normStatement(entry.statement) === needle,
    )
  }

  /** 新增一条记忆；重复 statement 直接返回已有条目。 */
  addEntry(entry) {
    if (this.hasDuplicateStatement(entry.statement)) {
      const existing = this.readAllEntries().find(
        (item) => item.status !== 'forgotten' && normStatement(item.statement) === normStatement(entry.statement),
      )
      return { entry: existing, added: false }
    }
    const normalized = normalizeEntry({
      ...entry,
      created_at: entry.created_at || dayKey(),
      updated_at: entry.updated_at || entry.created_at || dayKey(),
    })
    if (!normalized) throw new Error('invalid entry')
    this._writeEntrySource(normalized)
    return { entry: normalized, added: true }
  }

  updateEntry(id, patch) {
    const all = this.readAllEntries()
    const existing = all.find((entry) => entry.id === id)
    if (!existing) return null
    const next = normalizeEntry({
      ...existing,
      ...patch,
      id: existing.id,
      created_at: existing.created_at,
      updated_at: dayKey(),
    })
    if (!next) return null
    this._writeEntrySource(next)
    return next
  }

  forgetEntry(id) {
    return this.updateEntry(id, { status: 'forgotten' })
  }

  // --- handoff ------------------------------------------------------------
  handoffPath(cwd) {
    const tag = workspaceTag(cwd)
    return { tag, file: join(this.handoffDir, `${tag.key}.md`) }
  }

  readHandoff(cwd, keep = 3) {
    const { tag, file } = this.handoffPath(cwd)
    try {
      const st = statSync(file)
      const cached = this._handoffCache.get(file)
      let parsed
      if (cached && cached.mtimeMs === st.mtimeMs) parsed = cached.parsed
      else {
        parsed = parseHandoff(readFileSync(file, 'utf8'))
        this._handoffCache.set(file, { mtimeMs: st.mtimeMs, parsed })
      }
      return { ...parsed, tag, file, entries: parsed.entries.slice(0, keep) }
    } catch {
      return { meta: {}, entries: [], tag, file }
    }
  }

  writeHandoff(cwd, entry, keep = 3) {
    const { tag, file } = this.handoffPath(cwd)
    const existing = this.readHandoff(cwd, keep).entries
    const entries = [entry, ...existing].slice(0, keep)
    this.ensureDir(this.handoffDir)
    this._atomicWrite(file, renderHandoff({ persona: this.persona, workspaceTag: tag, entries }))
    try {
      this._handoffCache.set(file, {
        mtimeMs: statSync(file).mtimeMs,
        parsed: parseHandoff(readFileSync(file, 'utf8')),
      })
    } catch {
      /* 忽略 */
    }
    return { tag, file, entries }
  }

  // --- journal ------------------------------------------------------------
  appendJournal(entry) {
    this.ensureDir(this.journalDir)
    appendFileSync(join(this.journalDir, `${dayKey()}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
  }

  journalStats() {
    const days = (() => {
      try {
        return readdirSync(this.journalDir).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).length
      } catch {
        return 0
      }
    })()
    const todayLines = (() => {
      try {
        return readFileSync(join(this.journalDir, `${dayKey()}.jsonl`), 'utf8').split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    })()
    return { days, todayLines }
  }

  // --- overrides（/persona off 的持久化） ----------------------------------
  readOverrides() {
    try {
      const parsed = JSON.parse(readFileSync(this.overridesPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        return parsed
      }
    } catch {
      /* 首次运行 */
    }
    return { sessions: {} }
  }

  writeOverrides(overrides) {
    this._atomicWrite(this.overridesPath, `${JSON.stringify(overrides, null, 2)}\n`)
  }

  isSessionOff(sessionId) {
    return Boolean(this.readOverrides().sessions[String(sessionId)]?.off)
  }

  setSessionOff(sessionId, off) {
    const overrides = this.readOverrides()
    const key = String(sessionId)
    if (off) overrides.sessions[key] = { off: true, at: nowIso() }
    else delete overrides.sessions[key]
    this.writeOverrides(overrides)
  }

  // --- 迁移 / 计数 --------------------------------------------------------
  migrateRemembered() {
    try {
      if (!existsSync(this.rememberedPath)) return 0
      const marker = join(this.dir, '.remembered-migrated')
      if (existsSync(marker)) return 0
      const lines = readFileSync(this.rememberedPath, 'utf8').split('\n').filter(Boolean)
      let added = 0
      for (const line of lines) {
        let item
        try {
          item = JSON.parse(line)
        } catch {
          continue
        }
        if (!item || typeof item.text !== 'string' || !item.text.trim()) continue
        if (item.status === 'forgotten') continue
        const statement = trunc(item.text.trim(), 500)
        if (this.hasDuplicateStatement(statement)) continue
        this.addEntry({
          id: `rel_legacy_${String(item.id || Date.now()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20)}`,
          kind: item.kind && RELATIONSHIP_KINDS.includes(item.kind) ? item.kind : 'preference',
          scope: 'persona',
          status: 'active',
          confidence: 0.8,
          statement,
          created_at: item.at ? item.at.slice(0, 10) : dayKey(),
          evidence: [{ source: 'remembered.jsonl', quote: trunc(statement, 120), ...(item.session ? { session: item.session } : {}) }],
        })
        added += 1
      }
      writeFileSync(marker, nowIso(), 'utf8')
      return added
    } catch {
      return 0
    }
  }

  counts() {
    const relationship = this.readRelationship().entries
    const episodes = this.readEpisodes()
    const status = (value) => relationship.filter((entry) => entry.status === value).length
    const handoffAge = (() => {
      try {
        const files = readdirSync(this.handoffDir).filter((file) => file.endsWith('.md'))
        const latest = files
          .map((file) => statSync(join(this.handoffDir, file)).mtimeMs)
          .sort((a, b) => b - a)[0]
        return latest ? Math.round((Date.now() - latest) / 3600000) : null
      } catch {
        return null
      }
    })()
    return {
      relationship: {
        total: relationship.length,
        active: status('active'),
        pinned: relationship.filter((entry) => entry.pinned === true).length,
        draft: status('draft'),
        needsReview: status('needs_review'),
        forgotten: status('forgotten'),
        byKind: relationship.reduce((acc, entry) => {
          acc[entry.kind] = (acc[entry.kind] || 0) + 1
          return acc
        }, {}),
      },
      episodes: episodes.length,
      handoffHoursAgo: handoffAge,
      journal: this.journalStats(),
    }
  }

  // --- 整理状态 / 审核队列 / 报告（M2） -------------------------------------
  // --- 自动处理日志（safe 模式下自动应用的冲突动作，可撤销） -----------------
  appendAutoAction(action) {
    this.ensureDir(join(this.dir, 'review'))
    appendFileSync(this.autoLogPath, `${JSON.stringify(action)}\n`, 'utf8')
    return action
  }

  readAutoActions(options = {}) {
    const sinceMs = options.sinceMs ?? 0
    const limit = options.limit ?? 100
    try {
      const items = readFileSync(this.autoLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((item) => item && item.id && item.at)
      return items
        .filter((item) => !sinceMs || Date.parse(item.at) >= sinceMs)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, limit)
    } catch {
      return []
    }
  }

  findAutoAction(id) {
    return this.readAutoActions({ limit: 10000 }).find((item) => item.id === id) || null
  }

  updateAutoAction(id, patch) {
    const items = this.readAutoActions({ limit: 10000 })
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return null
    items[index] = { ...items[index], ...patch, updatedAt: nowIso() }
    this.ensureDir(join(this.dir, 'review'))
    this._atomicWrite(this.autoLogPath, items.map((item) => JSON.stringify(item)).join('\n') + '\n')
    return items[index]
  }

  readState() {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 首次运行 */
    }
    return { version: 1, lastConsolidateAt: null, journalCursors: {}, lastReportPath: null }
  }

  writeState(patch) {
    const next = { ...this.readState(), ...patch, version: 1, updatedAt: nowIso() }
    this._atomicWrite(this.statePath, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  readQueue() {
    try {
      const lines = readFileSync(this.queuePath, 'utf8').split('\n').filter(Boolean)
      const items = []
      for (const line of lines) {
        try {
          const item = JSON.parse(line)
          if (item && typeof item === 'object' && item.id) items.push(item)
        } catch {
          /* 跳过坏行 */
        }
      }
      return items
    } catch {
      return []
    }
  }

  _writeQueue(items) {
    this.ensureDir(join(this.dir, 'review'))
    this._atomicWrite(this.queuePath, items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''))
  }

  appendQueue(item) {
    if (this.readQueue().some((existing) => existing.id === item.id)) return item
    this._writeQueue([...this.readQueue(), item])
    return item
  }

  appendQueueMany(items) {
    const all = this.readQueue()
    const seen = new Set(all.map((item) => item.id))
    for (const item of items) {
      if (seen.has(item.id)) continue
      all.push(item)
      seen.add(item.id)
    }
    this._writeQueue(all)
    return all
  }

  updateQueueItem(id, patch) {
    const items = this.readQueue()
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return null
    items[index] = { ...items[index], ...patch, updatedAt: nowIso() }
    this._writeQueue(items)
    return items[index]
  }

  pendingQueue() {
    return this.readQueue().filter((item) => item.status === 'pending')
  }

  /** 写报告（markdown），返回相对路径。 */
  writeReport(name, content) {
    this.ensureDir(this.reportsDir)
    this._atomicWrite(join(this.reportsDir, name), content)
    return join('reports', name)
  }

  listReports() {
    try {
      return readdirSync(this.reportsDir)
        .filter((file) => file.endsWith('.md'))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  readReport(relativePath) {
    try {
      return readFileSync(join(this.dir, relativePath), 'utf8')
    } catch {
      return ''
    }
  }

  readLatestReport() {
    const latest = this.listReports()[0]
    if (!latest) return null
    try {
      const st = statSync(join(this.reportsDir, latest))
      return { file: join('reports', latest), updatedAt: st.mtimeMs, content: readFileSync(join(this.reportsDir, latest), 'utf8') }
    } catch {
      return null
    }
  }

  _atomicWrite(file, content) {
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temp, content, 'utf8')
    renameSync(temp, file)
  }
}

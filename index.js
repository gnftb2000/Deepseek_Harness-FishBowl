/**
 * dsh-fishbowl / 鱼缸 —— Host 半端
 * ============================================================================
 * M0 → M1 增补（按 大纲.md §12）：
 *   - Relationship / Episodic schema：relationship.md、episodes/YYYY-MM.md（yaml 条目块）
 *   - 显式记忆：「记住：……」自动落一条 relationship；`/remember` 手动落一条
 *   - turn 候选：偏好/边界/承诺/节律规则标记，只进 journal（供 curator 消费）
 *   - handoff：每轮 turn-stopping 写「下次接上需要的最小集合」，新会话 session-start 注入
 *   - 召回注入：agent/pre-step 当前输入 → 关键词 top-k 旧记忆（≤3 条 / ≤900 字），动态 context
 *   - 作用域 full / costume / off（workspaceModes 按工作区覆盖）；`/persona off|on` 按会话
 *   - `/forget`、`/why`、`/persona import|review|approve|reject`
 *   - 隐私：journal / 记忆落盘前统一脱敏；过滤宿主注入的 runtime context
 *   - resume 不重复注入 handoff；压缩（source=compact）重新注入
 *
 * M1.5 增补：
 *   - 面板设置表单：`/api/fishbowl/config`（保存）与 `/config/reset`（重置为 patch）
 *   - 设置持久化在 `~/.dsh/persona/<p>/config.json`，优先级高于 profile patch；保存后热重挂注入
 *
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { Store } from './lib/store.mjs'
import {
  asArray,
  asMode,
  clamp,
  dayKey,
  readJsonBody,
  messageText,
  nowIso,
  sendJson,
  splitFrontmatter,
  trunc,
  workspaceTag,
} from './lib/util.mjs'
import {
  detectCandidates,
  extractExplicitMemory,
  extractPromises,
  isInjectedUserText,
  redactText,
  searchEntries,
  stripHarnessBoilerplate,
} from './lib/text.mjs'
import {
  clearConfigFile,
  configFileState,
  editableConfig,
  effectiveConfig,
  normalizeConfig,
  readConfigFile,
  validateConfigInput,
  writeConfigFile,
} from './lib/config.mjs'
import { GitRepo } from './lib/git.mjs'
import { computeHealth, consolidate } from './lib/consolidate.mjs'
import {
  buildCuratorInput,
  callCuratorModel,
  parseCuratorOutput,
  planCuratorOps,
  validateCuratorOutput,
} from './lib/curator.mjs'
import {
  MINE_SYSTEM_PROMPT,
  buildExport,
  buildMineInput,
  buildTranscript,
  mineReportName,
  parseMemoryFile,
  prepareExportParent,
} from './lib/migrate.mjs'

export const name = 'fishbowl'
export const inject = ['webServer', 'commands', 'sessions', 'systemPrompt']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SOUL_SECTION_NAME = 'fishbowl:soul'
const RELATIONSHIP_SECTION_NAME = 'fishbowl:relationship'
const HANDOFF_SECTION_NAME = 'fishbowl:handoff'
const RECALL_CONTEXT_NAME = 'fishbowl:recall'
const SOUL_SECTION_ORDER = 100
const RELATIONSHIP_SECTION_ORDER = 101
const HANDOFF_SECTION_ORDER = 102
const RECALL_CONTEXT_ORDER = 160

const MAX_SOUL_CHARS = 12000
const MAX_RELATIONSHIP_SUMMARY_CHARS = 1400
const MAX_HANDOFF_SECTION_CHARS = 700
const MAX_RECALL_CHARS = 900
const MAX_JOURNAL_TEXT_CHARS = 1200
const MAX_REMEMBER_TEXT_CHARS = 500
const HANDOFF_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Host 插件
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const log = (...args) => {
    try {
      console.log('[fishbowl]', ...args)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  const BASE_CONFIG_RAW = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {}
  const baseCfg = normalizeConfig(BASE_CONFIG_RAW)
  const dshHome = (() => {
    try {
      const p = ctx?.get?.('dshHomePath')
      if (typeof p === 'function') {
        const v = p()
        if (v) return String(v)
      } else if (typeof p === 'string' && p) {
        return p
      }
    } catch {
      /* 兜底到 env */
    }
    return process.env.DSH_HOME || join(homedir(), '.dsh')
  })()

  const personaDir = join(dshHome, 'persona', baseCfg.persona)
  const configFile = join(personaDir, 'config.json')
  const initialConfig = readConfigFile(configFile)
  let cfg = effectiveConfig(BASE_CONFIG_RAW, initialConfig.ok ? initialConfig.config : null)
  const store = new Store({ dir: personaDir, persona: cfg.persona, log })
  const gitRepo = new GitRepo({ dir: personaDir, enabled: cfg.gitEnabled, log })
  const agentById = new Map()

  // --- 配置状态（面板可改，热生效） ------------------------------------------
  const readStoredConfig = () => {
    const read = readConfigFile(configFile)
    if (!read.ok) log(`config.json 读取失败：${read.error}`)
    return read.ok ? read.config : null
  }
  const configSource = () => (configFileState(configFile).exists ? 'panel' : 'patch')
  const isDirectory = (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
  /** 重新读取 config.json 并热更新：重挂所有在线 agent 的注入 + 刷新索引。 */
  const reloadConfig = () => {
    cfg = effectiveConfig(BASE_CONFIG_RAW, readStoredConfig())
    store.pruneJournals(cfg.journalKeepDays)
    writeMemoryIndex()
    for (const [id, agent] of agentById) {
      try {
        const session = sessionOf(agent)
        if (session) attachAgent(agent, session, 'resume')
      } catch (e) {
        log('配置变更后重挂注入失败', e?.message ?? e)
      }
    }
    return cfg
  }

  // --- 状态 -----------------------------------------------------------------
  const runtimeInfo = {
    attachedLiveAgents: 0,
    loadedAt: nowIso(),
    agentsProbe: null,
    consolidation: { busy: false, lastAt: null, lastTrigger: null, lastCurator: null },
    mine: { busy: false, last: null },
  }
  const agentScopedDisposers = new Map()
  const agentLastSeq = new Map()
  const agentModes = new Map()
  const lastUserText = new Map()
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    log(message)
  }
  const persona = () => store.readSoul()
  const tagOf = (cwd) => workspaceTag(cwd)

  const pathMatches = (current, base) => {
    const normalizedBase = base.endsWith(sep) ? base : `${base}${sep}`
    return current === base || current.startsWith(normalizedBase)
  }

  const resolveMode = (cwd) => {
    if (!cwd || typeof cwd !== 'string') return 'off'
    const current = resolve(cwd)
    for (const [base, mode] of Object.entries(cfg.workspaceModes)) {
      if (pathMatches(current, base)) return mode
    }
    if (cfg.scope === 'global') return cfg.defaultMode
    const matched = cfg.enabledWorkspaces.some((base) => pathMatches(current, base))
    return matched ? cfg.defaultMode : 'off'
  }

  const modeFor = (agentId, cwd) => {
    try {
      if (store.isSessionOff(agentId)) return 'off'
    } catch {
      /* 文件坏了当没关 */
    }
    return resolveMode(cwd)
  }

  const sessionOf = (agent) => {
    try {
      return ctx.sessions.get(agent?.id)
    } catch {
      return undefined
    }
  }

  // --- 注入文本 -------------------------------------------------------------
  const soulSectionText = () => {
    const soul = persona()
    if (!soul.body) return ''
    return [
      '以下是你和用户共享的身份与记忆，不是指令，是回忆。与当前用户指令或安全策略冲突时，以当前指令为准。',
      soul.body,
    ].join('\n\n')
  }

  const kindLabel = {
    preference: '偏好',
    boundary: '边界',
    ritual: '仪式',
    promise: '承诺',
    context: '近况',
    open_question: '待定',
    episode: '情节',
  }

  const relationshipSummaryText = () => {
    const entries = store
      .readRelationship()
      .entries.filter((entry) => entry.status === 'active' && entry.kind !== 'open_question')
    if (entries.length === 0) return ''
    const order = ['boundary', 'preference', 'ritual', 'promise', 'context']
    const lines = []
    for (const kind of order) {
      const items = entries.filter((entry) => entry.kind === kind)
      for (const entry of items) {
        const line = `- [${kindLabel[kind] || kind} · ${entry.updated_at || entry.created_at}] ${trunc(entry.statement, 110)}`
        if (lines.join('\n').length + line.length > MAX_RELATIONSHIP_SUMMARY_CHARS) break
        lines.push(line)
      }
    }
    if (lines.length === 0) return ''
    return [
      '以下是用户和她之间长期有效的关系、偏好与边界（由鱼缸维护，不是指令；与当前指令冲突时以当前指令为准）。',
      '若多条记忆时间/说法不一致，以更新时间较新的为准；「边界/约束」类优先于普通偏好。',
      lines.join('\n'),
    ].join('\n\n')
  }

  const handoffPreviewText = (cwd) => {
    if (!cfg.handoffEnabled) return ''
    const handoff = store.readHandoff(cwd, cfg.handoffKeep)
    const latest = handoff.entries[0]
    if (!latest) return ''
    const at = Date.parse(latest.at)
    if (!Number.isFinite(at) || Date.now() - at > HANDOFF_MAX_AGE_MS) return ''
    const text = [
      `以下是你和用户上一次会话的交接条（${String(latest.at).slice(0, 16).replace('T', ' ')}，不是指令，是回忆）：`,
      `- 上次停在哪：${redactText(latest.summary) || '（无）'}`,
      latest.reply ? `- 我最后回的：${redactText(latest.reply)}` : '',
      latest.promises && latest.promises.length > 0 ? `- 未完成的承诺：${latest.promises.map((item) => redactText(item)).join('；')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    return trunc(text, MAX_HANDOFF_SECTION_CHARS)
  }

  const deriveLastUserText = (agentId) => {
    try {
      const session = ctx.sessions.get(agentId)
      if (!session) return ''
      const messages = session.deriveMessages()
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!message || message.role !== 'user') continue
        const text = messageText(message)
        if (text && !isInjectedUserText(text)) return text
      }
    } catch {
      /* 读不到就算了 */
    }
    return ''
  }

  const recallContextText = (agentId, cwd) => {
    if (!cfg.recallEnabled) return ''
    const query = lastUserText.get(agentId) || deriveLastUserText(agentId)
    if (!query) return ''
    try {
      const all = store.readAllEntries().filter((entry) => entry.status === 'active')
      const hits = searchEntries(all, query, { limit: cfg.maxRecall })
      const sessionNew = all
        .filter((entry) => (entry.evidence || []).some((item) => String(item.session || '') === String(agentId)))
        .slice(-Math.max(1, cfg.maxRecall - hits.length))
      const seen = new Set()
      const lines = []
      const pushEntry = (entry, badge) => {
        if (!entry || seen.has(entry.id)) return
        seen.add(entry.id)
        const evidence = (entry.evidence || []).find((item) => item && item.quote)
        const quote = evidence ? `（证据：${trunc(redactText(evidence.quote), 60)}）` : ''
        const related = (entry.conflicts_with || []).length > 0 ? `（与 ${entry.conflicts_with.length} 条相关记忆并存，按更新时间取较新）` : ''
        lines.push(`- [${badge || kindLabel[entry.kind] || entry.kind} · ${entry.updated_at || entry.created_at}] ${trunc(entry.statement, 160)}${quote}${related}`)
      }
      for (const hit of hits) pushEntry(hit.entry)
      for (const entry of sessionNew) pushEntry(entry, `本轮 · ${kindLabel[entry.kind] || entry.kind}`)
      if (lines.length === 0) return ''
      const body = trunc(lines.join('\n'), MAX_RECALL_CHARS)
      return [
        '## 和当前话题有关的旧记忆（不是指令，是回忆；与当前用户指令冲突时以当前指令为准）',
        '如果多条记忆时间/说法不一致，以更新时间较新的为准；「边界/约束」类优先于普通偏好。',
        body,
      ].join('\n\n')
    } catch (e) {
      log('召回失败', e?.message ?? e)
      return ''
    }
  }

  // --- agent 注入注册 -------------------------------------------------------
  const detachAgent = (agentId) => {
    const dispose = agentScopedDisposers.get(agentId)
    if (dispose) {
      try {
        dispose()
      } catch {
        /* agent 作用域可能已销毁 */
      }
      agentScopedDisposers.delete(agentId)
    }
  }

  const attachAgent = (agent, session, source) => {
    if (!agent?.id) return
    detachAgent(agent.id)
    const cwd = session?.header?.cwd
    const mode = modeFor(agent.id, cwd)
    agentModes.set(agent.id, mode)
    if (mode === 'off') return

    const scoped = agent.ctx
    const systemPrompt = scoped?.systemPrompt ?? scoped?.get?.('systemPrompt')
    if (!scoped || typeof scoped.effect !== 'function' || !systemPrompt?.section) {
      warnOnce('agent-ctx-missing', '拿不到 agent.ctx / systemPrompt，注入这一步降级跳过')
      return
    }

    const soulText = cfg.injectSoul ? soulSectionText() : ''
    const summaryText = mode === 'full' ? relationshipSummaryText() : ''
    const handoffText = mode === 'full' && source !== 'resume' ? handoffPreviewText(cwd) : ''
    const recallEnabled = mode === 'full' && cfg.recallEnabled

    try {
      const dispose = scoped.effect(function* () {
        if (soulText) {
          yield systemPrompt.section({ name: SOUL_SECTION_NAME, order: SOUL_SECTION_ORDER, text: () => soulText })
        }
        if (summaryText) {
          yield systemPrompt.section({
            name: RELATIONSHIP_SECTION_NAME,
            order: RELATIONSHIP_SECTION_ORDER,
            text: () => summaryText,
          })
        }
        if (handoffText) {
          yield systemPrompt.section({
            name: HANDOFF_SECTION_NAME,
            order: HANDOFF_SECTION_ORDER,
            text: () => handoffText,
          })
        }
        if (recallEnabled && typeof systemPrompt.context === 'function') {
          yield systemPrompt.context({
            name: RECALL_CONTEXT_NAME,
            order: RECALL_CONTEXT_ORDER,
            text: () => recallContextText(agent.id, cwd),
          })
        }
      }, `fishbowl: agent ${String(agent.id).slice(0, 12)}`)
      agentScopedDisposers.set(agent.id, dispose)
      log(`接管 agent ${String(agent.id).slice(0, 12)}（${mode}${cwd ? ` · ${tagOf(cwd).name}` : ''}）`)
    } catch (e) {
      log('agent 注入注册失败', e?.stack ?? e)
    }
  }

  // --- 记忆写入 -------------------------------------------------------------
  const newEntryId = (prefix = 'rel') => {
    const stamp = dayKey().replace(/-/g, '')
    const rand = Math.random().toString(36).slice(2, 6)
    return `${prefix}_${stamp}_${rand}`
  }

  const rememberStatement = ({ statement, sessionId, seq, source, kind = 'preference', confidence = 0.85, status = 'active' }) => {
    const cleaned = trunc(redactText(String(statement || '').trim()), MAX_REMEMBER_TEXT_CHARS)
    if (cleaned.length < 2) return { added: false, entry: null }
    const evidence = []
    if (sessionId) evidence.push({ session: String(sessionId), ...(seq ? { seq: Number(seq) } : {}), quote: trunc(cleaned, 120) })
    if (source) evidence.push({ source, quote: trunc(cleaned, 120) })
    const { added, entry } = store.addEntry({
      id: newEntryId(kind === 'episode' ? 'ep' : 'rel'),
      kind,
      scope: 'persona',
      status,
      confidence,
      statement: cleaned,
      evidence,
    })
    return { added, entry }
  }

  const writeMemoryIndex = () => {
    try {
      const soul = persona()
      const counts = store.counts()
      const workspaceList =
        cfg.scope === 'global'
          ? 'global（全部工作区）'
          : cfg.enabledWorkspaces.length > 0
            ? cfg.enabledWorkspaces.map((path) => tagOf(path).name).join('、')
            : '（没有启用任何工作区）'
      const relationship = store.readRelationship().entries
      const recent = [...relationship]
        .filter((entry) => entry.status === 'active')
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 8)
      const content = [
        '# 她的记忆索引',
        '',
        '> 自动生成，只做渲染索引（`MEMORY.md` 只有指针，不重复正文）。正文在 `relationship.md` / `episodes/`。',
        '',
        `- 人设 → \`${personaDir}\``,
        `- 身份内核 → \`soul.md\`（version ${soul.meta.version ?? '?'}${soul.meta.locked ? '，locked' : ''}，${soul.body.length} 字）`,
        `- 关系与偏好 → \`relationship.md\`（${counts.relationship.total} 条：active ${counts.relationship.active} / draft ${counts.relationship.draft} / needs_review ${counts.relationship.needsReview} / forgotten ${counts.relationship.forgotten}）`,
        `- 情节卡 → \`episodes/\`（${counts.episodes} 条）`,
        `- 交接条 → \`handoff/\`（最近 ${counts.handoffHoursAgo === null ? '无' : `${counts.handoffHoursAgo} 小时前`}）`,
        `- 近期日记 → \`journal/${dayKey()}.jsonl\`（今日 ${counts.journal.todayLines} 行；共 ${counts.journal.days} 天）`,
        `- 接管范围 → ${cfg.scope} · 默认 ${cfg.defaultMode}：${workspaceList}`,
        `- 审核队列 → ${store.pendingQueue().length} 条待审；最近整理 → ${store.readState().lastConsolidateAt || '还没整理过'}`,
        `- 最新报告 → ${store.readState().lastReportPath || '（还没有）'}`,
        `- 版本 → ${gitRepo.head() ? `git HEAD ${gitRepo.head()}` : 'git 未启用/无提交'}`,
        `- 上次渲染 → ${nowIso()}`,
        '',
        '## 最近 active 记忆',
        '',
        ...(recent.length === 0 ? ['> 还没有。用 `/remember <话>` 或说「记住：……」写入。'] : recent.map((entry) => `- [${entry.kind}] ${trunc(entry.statement, 90)}`)),
        '',
      ].join('\n')
      store._atomicWrite(store.memoryIndexPath, content)
    } catch (e) {
      log('写 MEMORY.md 失败', e?.message ?? e)
    }
  }

  // --- 每轮捕获 -------------------------------------------------------------
  const captureTurn = (payload) => {
    const agent = payload?.agent
    if (!agent?.id) return
    const session = sessionOf(agent)
    if (!session) return
    const cwd = session.header?.cwd
    const mode = modeFor(agent.id, cwd)
    agentModes.set(agent.id, mode)

    const to = Number(session.seq)
    const from = agentLastSeq.has(agent.id) ? agentLastSeq.get(agent.id) : to
    if (!Number.isFinite(to) || !Number.isFinite(from) || to <= from) {
      agentLastSeq.set(agent.id, to)
      return
    }
    let events = []
    try {
      events = session.snapshotEvents(from, to)
    } catch {
      events = []
    }
    agentLastSeq.set(agent.id, to)
    if (mode === 'off') return

    const users = []
    const assistants = []
    const candidates = []
    const explicit = []
    for (const event of events) {
      if (!event || typeof event.type !== 'string') continue
      const rawMessage =
        event.type === 'user/message'
          ? event.data
          : event.type === 'assistant/message'
            ? event.data?.message
            : undefined
      if (!rawMessage) continue
      let text = ''
      try {
        text = messageText(session.deriveEventMessage(event)) || messageText(rawMessage)
      } catch {
        text = messageText(rawMessage)
      }
      if (!text) continue
      if (event.type === 'user/message') {
        if (isInjectedUserText(text)) continue
        const cleaned = trunc(stripHarnessBoilerplate(redactText(text)), MAX_JOURNAL_TEXT_CHARS)
        users.push({ seq: Number(event.seq), text: cleaned })
        for (const statement of extractExplicitMemory(cleaned)) explicit.push({ statement, seq: Number(event.seq) })
        candidates.push(...detectCandidates(cleaned))
      } else {
        assistants.push({ seq: Number(event.seq), text: trunc(redactText(text), MAX_JOURNAL_TEXT_CHARS) })
      }
    }

    if (users.length === 0 && assistants.length === 0) return
    const at = nowIso()
    if (cfg.journalEnabled) {
      try {
        store.appendJournal({
          at,
          session: String(agent.id),
          turn: payload?.turn,
          workspace: cwd ? tagOf(cwd).name : undefined,
          workspaceTag: cwd ? tagOf(cwd).hash : undefined,
          user: users,
          assistant: assistants,
          candidates: candidates.slice(0, 8),
        })
      } catch (e) {
        log('journal 写入失败', e?.message ?? e)
      }
    }

    // 显式「记住：……」→ 立即落一条 active 记忆（下一轮召回生效）
    if (mode === 'full' && explicit.length > 0) {
      let added = 0
      for (const item of explicit) {
        try {
          const result = rememberStatement({
            statement: item.statement,
            sessionId: String(agent.id),
            seq: item.seq,
            confidence: 0.85,
          })
          if (result.added) added += 1
        } catch (e) {
          log('显式记忆写入失败', e?.message ?? e)
        }
      }
      if (added > 0) {
        writeMemoryIndex()
        commitMemory(`auto-remember ${added}`)
        log(`显式记住 ${added} 条`)
      }
    }

    // handoff：只写「下次接上需要知道的最小集合」
    if (cfg.handoffEnabled && users.length + assistants.length > 0) {
      try {
        const lastUser = users[users.length - 1]?.text || ''
        const lastAssistant = assistants[assistants.length - 1]?.text || ''
        store.writeHandoff(
          cwd,
          {
            at,
            session: String(agent.id),
            summary: trunc(lastUser.replace(/\s+/g, ' '), 160),
            reply: trunc(lastAssistant.replace(/\s+/g, ' '), 160),
            promises: extractPromises(lastUser).map((item) => trunc(redactText(item), 120)),
          },
          cfg.handoffKeep,
        )
      } catch (e) {
        log('handoff 写入失败', e?.message ?? e)
      }
    }
  }

  // --- 整理 / curator / 审核队列 / 版本化 ---------------------------------------
  const commitMemory = (reason) => {
    try {
      return gitRepo.commit(`fishbowl: ${reason}`)
    } catch (e) {
      log('git commit 失败', e?.message ?? e)
      return null
    }
  }

  const resolveCuratorSelection = () => {
    if (cfg.curatorProvider && cfg.curatorModel) return { provider: cfg.curatorProvider, model: cfg.curatorModel }
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      const provider = selection?.provider || selection?.providerId
      const model = selection?.model || selection?.modelId
      if (provider && model) return { provider, model }
    } catch {
      /* 拿不到就用兜底 */
    }
    return { provider: cfg.curatorProvider || 'deepseek-account', model: cfg.curatorModel || 'deepseek-flash' }
  }

  /** 应用一条审核队列项（add/update/supersede/forget）。 */
  const applyQueueItem = (item) => {
    if (!item) return { ok: false, error: '没有这条审核项' }
    if (item.op === 'add') {
      if (!item.statement) return { ok: false, error: '审核项缺 statement' }
      const relation = item.relation && item.relation !== 'unrelated' ? item.relation : null
      if (relation && item.target_id) {
        const target = store.readAllEntries().find((entry) => entry.id === item.target_id)
        if (!target) return { ok: false, error: `冲突目标不存在：${item.target_id}` }
        if (target.pinned === true) {
          return { ok: false, error: `目标记忆被钉住了（${target.id}），先 /unpin 再处理这条提议。` }
        }
        if (relation === 'refine') {
          const evidence = [...(target.evidence || [])]
          if (!evidence.some((entry) => entry.quote === trunc(item.statement, 120))) {
            evidence.push({ source: `curator:${item.source || 'review'}`, quote: trunc(item.statement, 120) })
          }
          store.updateEntry(target.id, { statement: item.statement, evidence: evidence.slice(0, 6), status: 'active' })
          return { ok: true, applied: 'refine' }
        }
        if (relation === 'constrain') {
          const createdId = newEntryId(item.kind === 'episode' ? 'ep' : 'rel')
          store.addEntry({
            id: createdId,
            kind: item.kind || 'context',
            scope: 'persona',
            status: 'active',
            confidence: Number.isFinite(item.confidence) ? item.confidence : 0.7,
            statement: item.statement,
            evidence: [{ source: `curator:${item.source || 'review'}`, quote: trunc(item.statement, 120) }],
            conflicts_with: [target.id],
          })
          store.updateEntry(target.id, {
            conflicts_with: [...(target.conflicts_with || []).filter((entryId) => entryId !== createdId), createdId],
          })
          return { ok: true, applied: 'constrain' }
        }
        if (relation === 'supersede' || relation === 'correct') {
          const createdId = newEntryId('rel')
          store.addEntry({
            id: createdId,
            kind: item.kind || target.kind,
            scope: 'persona',
            status: 'active',
            confidence: Number.isFinite(item.confidence) ? item.confidence : 0.7,
            statement: item.statement,
            supersedes: [target.id],
            evidence: [{ source: `curator:${item.source || 'review'}`, quote: trunc(item.statement, 120) }],
          })
          store.updateEntry(target.id, { status: 'superseded' })
          return { ok: true, applied: relation }
        }
      }
      store.addEntry({
        id: newEntryId(item.kind === 'episode' ? 'ep' : 'rel'),
        kind: item.kind || 'preference',
        scope: 'persona',
        status: 'active',
        confidence: Number.isFinite(item.confidence) ? item.confidence : 0.7,
        statement: item.statement,
        evidence: [{ source: `curator:${item.source || 'review'}`, quote: trunc(item.statement, 120) }],
      })
      return { ok: true, applied: 'add' }
    }
    const target = item.target_id ? store.readAllEntries().find((entry) => entry.id === item.target_id) : null
    if (!target) return { ok: false, error: `目标不存在：${item.target_id}` }
    if (target.pinned === true) {
      return { ok: false, error: `这条记忆被钉住了（${target.id}），整理/审核都不能自动改它；先 /unpin 再操作。` }
    }
    if (item.op === 'update') {
      store.updateEntry(target.id, {
        ...(item.statement ? { statement: item.statement } : {}),
        ...(item.kind ? { kind: item.kind } : {}),
        ...(Number.isFinite(item.confidence) ? { confidence: item.confidence } : {}),
        status: 'active',
      })
      return { ok: true, applied: 'update' }
    }
    if (item.op === 'supersede') {
      if (item.statement) {
        const createdId = newEntryId('rel')
        store.addEntry({
          id: createdId,
          kind: item.kind || target.kind,
          scope: 'persona',
          status: 'active',
          confidence: Number.isFinite(item.confidence) ? item.confidence : 0.7,
          statement: item.statement,
          supersedes: [target.id],
          evidence: [{ source: `curator:${item.source || 'review'}`, quote: trunc(item.statement, 120) }],
        })
      }
      store.updateEntry(target.id, { status: 'superseded' })
      return { ok: true, applied: 'supersede' }
    }
    if (item.op === 'forget') {
      store.updateEntry(target.id, { status: 'forgotten' })
      return { ok: true, applied: 'forget' }
    }
    return { ok: false, error: `未知审核操作：${item.op}` }
  }

  // --- 冲突自动处理（safe/balanced） ----------------------------------------
  const newAutoId = () => `auto_${dayKey().replace(/-/g, '')}_${Math.random().toString(36).slice(2, 6)}`

  /** 应用一条自动冲突动作，写 auto-log（带撤销所需的反向信息）。 */
  const applyAutoConflict = (item) => {
    const target = item.target_id ? store.readAllEntries().find((entry) => entry.id === item.target_id) : null
    const base = {
      id: newAutoId(),
      at: nowIso(),
      relation: item.relation,
      kind: item.kind,
      statement: trunc(item.statement, 300),
      targetId: target?.id,
      target_snapshot: item.target_snapshot || null,
      confidence: item.confidence,
      reason: item.reason || '',
      mode: cfg.conflictAutoMode,
      status: 'active',
    }
    if (item.relation === 'refine' && target) {
      const before = { statement: target.statement, kind: target.kind, evidence: (target.evidence || []).slice(0, 6) }
      const evidence = [...(target.evidence || [])]
      if (!evidence.some((entry) => entry.quote === trunc(item.statement, 120))) {
        evidence.push({ source: 'curator:auto', quote: trunc(item.statement, 120) })
      }
      store.updateEntry(target.id, {
        statement: item.statement,
        ...(item.kind ? { kind: item.kind } : {}),
        ...(Number.isFinite(item.confidence) ? { confidence: item.confidence } : {}),
        evidence: evidence.slice(0, 6),
      })
      return store.appendAutoAction({ ...base, before })
    }
    if (item.relation === 'constrain') {
      const createdId = newEntryId(item.kind === 'episode' ? 'ep' : 'rel')
      store.addEntry({
        id: createdId,
        kind: item.kind,
        scope: 'persona',
        status: 'active',
        confidence: item.confidence,
        statement: item.statement,
        evidence: [{ source: 'curator:auto', quote: trunc(item.statement, 120) }],
        conflicts_with: target ? [target.id] : [],
      })
      if (target) {
        const linked = [...(target.conflicts_with || []).filter((id) => id !== createdId), createdId]
        store.updateEntry(target.id, { conflicts_with: linked })
      }
      return store.appendAutoAction({ ...base, createdId })
    }
    if ((item.relation === 'correct' || item.relation === 'supersede') && target) {
      const before = { status: target.status, statement: target.statement }
      const createdId = newEntryId('rel')
      store.addEntry({
        id: createdId,
        kind: item.kind,
        scope: 'persona',
        status: 'active',
        confidence: item.confidence,
        statement: item.statement,
        supersedes: [target.id],
        evidence: [{ source: 'curator:auto', quote: trunc(item.statement, 120) }],
      })
      store.updateEntry(target.id, { status: 'superseded' })
      return store.appendAutoAction({ ...base, createdId, before })
    }
    return null
  }

  const isoWeekOf = (date = new Date()) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
    const day = d.getUTCDay() || 7
    d.setUTCDate(d.getUTCDate() + 4 - day)
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
  }

  /** 把「本周自动处理」小节同步进周报（存在才更新，不额外创建文件）。 */
  const syncWeeklyAutoSection = () => {
    try {
      const week = isoWeekOf(new Date())
      const reportName = `${week}.md`
      if (!store.listReports().includes(reportName)) return null
      const relative = `reports/${reportName}`
      const existing = store.readReport(relative)
      const marker = '## 自动处理（本周，自动生成）'
      const base = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)) : existing
      const actions = store.readAutoActions({ sinceMs: Date.now() - 7 * 86400000, limit: 500 })
      const counts = actions.reduce((acc, action) => {
        const key = action.status === 'undone' ? '已撤销' : action.relation
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {})
      const section = [
        marker,
        '',
        `- 近 7 天自动处理：${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(' / ') || '无'}`,
        '- 明细与撤销：设置 → 鱼缸 →「冲突与自动处理」，或 `/persona auto`',
        '',
      ].join('\n')
      store.writeReport(reportName, `${base.trimEnd()}\n\n${section}`)
      return relative
    } catch (e) {
      log('同步周报自动处理小节失败', e?.message ?? e)
      return null
    }
  }

  /** 撤销一条自动处理（反向操作 + git commit）。 */
  const undoAutoAction = (id) => {
    const action = store.findAutoAction(id)
    if (!action) return { ok: false, error: `没有这条自动处理：${id}` }
    if (action.status !== 'active') return { ok: false, error: '这条已经撤销过了' }
    try {
      if (action.relation === 'refine' && action.targetId && action.before) {
        store.updateEntry(action.targetId, {
          statement: action.before.statement,
          ...(action.before.kind ? { kind: action.before.kind } : {}),
          evidence: action.before.evidence,
        })
      } else if (action.relation === 'constrain') {
        if (action.createdId) store.updateEntry(action.createdId, { status: 'forgotten' })
        if (action.targetId) {
          const target = store.readAllEntries().find((entry) => entry.id === action.targetId)
          if (target) {
            store.updateEntry(target.id, {
              conflicts_with: (target.conflicts_with || []).filter((entryId) => entryId !== action.createdId),
            })
          }
        }
      } else if ((action.relation === 'correct' || action.relation === 'supersede') && action.targetId) {
        if (action.createdId) store.updateEntry(action.createdId, { status: 'forgotten' })
        store.updateEntry(action.targetId, { status: action.before?.status || 'active' })
      } else {
        return { ok: false, error: '这条动作没有可撤销的反向操作' }
      }
      store.updateAutoAction(id, { status: 'undone', undoneAt: nowIso() })
      writeMemoryIndex()
      commitMemory(`undo-auto ${id}`)
      return { ok: true, action: store.findAutoAction(id) }
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  /**
   * 跑一次整理：规则型 consolidation 一定跑；LLM curator 可选（失败降级，不打断规则结果）。
   */
  const runConsolidation = async ({ dryRun = false, trigger = 'manual', allowLlm = true } = {}) => {
    if (runtimeInfo.consolidation.busy) return { ok: false, error: '整理正在进行中，稍等。' }
    runtimeInfo.consolidation.busy = true
    try {
      const rule = consolidate({ store, cfg, now: new Date(), dryRun, log })
      let curator = { status: 'off', ops: 0, queued: 0, episodes: 0, skipped: 0 }
      const shouldCurate =
        !dryRun && allowLlm && cfg.curatorUseLlm && rule.journalLines >= (cfg.curatorMinJournalLines ?? 1)
      if (!dryRun && allowLlm && cfg.curatorUseLlm && !shouldCurate) {
        curator = { status: 'skipped', ops: 0, queued: 0, episodes: 0, skipped: 0, reason: 'journal 没有新行（省 token）' }
      }
      if (shouldCurate) {
        const selection = resolveCuratorSelection()
        const llm = ctx.get?.('llm')
        const input = buildCuratorInput({
          persona: cfg.persona,
          existing: store.readAllEntries(),
          journal: (rule.slices || []).flatMap((slice) => slice.entries),
          queue: store.pendingQueue(),
        })
        const call = await callCuratorModel({ llm: llm, selection, input, log, maxTokens: 2000 })
        if (!call.ok) {
          curator = { status: 'error', error: call.error, ops: 0, queued: 0, episodes: 0, skipped: 0, ...selection }
        } else {
          const parsed = parseCuratorOutput(call.text)
          let validated = parsed.ok ? validateCuratorOutput(parsed.value) : { ok: false, error: parsed.error }
          let lastRaw = call.text
          // 模型输出不合法 → 纠错重试一次（只多花一次调用，失败就降级）
          if (!validated.ok) {
            const retry = await callCuratorModel({
              llm: llm,
              selection,
              maxTokens: 3000,
              input: {
                ...input,
                correction: `上一次输出不合法：${validated.error}。请只输出合法 JSON，ops 里每条 add 必须带 kind（preference/boundary/ritual/promise/context/open_question/episode）；update/supersede/forget 必须带 target_id。`,
              },
              log,
            })
            if (retry.ok) {
              lastRaw = retry.text
              const retryParsed = parseCuratorOutput(retry.text)
              validated = retryParsed.ok ? validateCuratorOutput(retryParsed.value) : { ok: false, error: retryParsed.error }
            }
          }
          if (!validated.ok) {
            curator = {
              status: 'invalid',
              error: validated.error,
              rawPreview: trunc(String(lastRaw || ''), 600),
              ops: 0,
              queued: 0,
              episodes: 0,
              skipped: 0,
              ...selection,
            }
          } else if (validated.value.noop) {
            curator = { status: 'noop', ops: 0, queued: 0, episodes: 0, skipped: 0, ...selection }
          } else {
            const plan = planCuratorOps({
              store,
              ops: validated.value.ops,
              now: new Date(),
              mode: cfg.conflictAutoMode,
              threshold: cfg.conflictAutoMinConfidence,
            })
            for (const entry of plan.episodes) {
              store.addEntry({ ...entry, updated_at: entry.created_at })
            }
            if (plan.queueItems.length > 0) store.appendQueueMany(plan.queueItems)
            const autoApplied = []
            for (const item of plan.autoItems) {
              try {
                const action = applyAutoConflict(item)
                if (action) autoApplied.push(action)
              } catch (e) {
                log('自动处理冲突失败', e?.message ?? e)
              }
            }
            curator = {
              status: 'ok',
              ops: validated.value.ops.length,
              queued: plan.queueItems.length,
              episodes: plan.episodes.length,
              skipped: plan.skipped.length,
              auto: autoApplied.length,
              autoByRelation: autoApplied.reduce((acc, action) => {
                acc[action.relation] = (acc[action.relation] || 0) + 1
                return acc
              }, {}),
              ...selection,
            }
            if (rule.reportPath) {
              try {
                const existing = store.readReport(rule.reportPath)
                const section = [
                  '',
                  '## Curator（大模型）',
                  '',
                  `- 状态：${curator.status}，ops ${curator.ops}，入队列 ${curator.queued}，情节卡 ${curator.episodes}，跳过 ${curator.skipped}`,
                  `- 模型：${selection.provider}/${selection.model}`,
                  ...(autoApplied.length
                    ? ['- 自动处理：', ...autoApplied.map((action) => `  - ${action.id} · ${action.relation} · ${trunc(action.statement, 80)}（可撤销）`)]
                    : []),
                  ...(plan.skipped.length ? ['- 跳过原因：', ...plan.skipped.map((reason) => `  - ${reason}`)] : []),
                  '',
                ].join('\n')
                store.writeReport(rule.reportPath.replace(/^reports\//, ''), existing + section)
              } catch (e) {
                log('追加 curator 报告失败', e?.message ?? e)
              }
            }
          }
        }
        runtimeInfo.consolidation.lastCurator = curator
      }
      // 整理后计数快照：写进本次整理报告/周报，避免报告里的计数落后于 curator 结果
      if (!dryRun) {
        try {
          const countsNow = store.counts()
          const snapshot = [
            '',
            '## 整理后计数快照',
            '',
            `- active ${countsNow.relationship.active}；待审 ${store.pendingQueue().length}；情节卡 ${countsNow.episodes}；条目总计 ${countsNow.relationship.total}`,
            `- 本次自动处理 ${curator.auto || 0} 条（safe=${cfg.conflictAutoMode}）；可在面板「冲突与自动处理」撤销`,
            '',
          ].join('\n')
          for (const reportPath of [rule.reportPath, rule.weeklyPath]) {
            if (!reportPath) continue
            try {
              store.writeReport(reportPath.replace(/^reports\//, ''), store.readReport(reportPath) + snapshot)
            } catch (e) {
              log('追加计数快照失败', e?.message ?? e)
            }
          }
        } catch (e) {
          log('计数快照失败', e?.message ?? e)
        }
      }
      const changed = rule.changed || curator.queued > 0 || curator.episodes > 0 || (curator.auto || 0) > 0
      let commit = null
      if (!dryRun && changed) {
        commit = commitMemory(
          `consolidate ${dayKey()}（queue+${rule.queued} merge+${rule.merged} decay+${rule.decayed}${curator.queued + curator.episodes > 0 ? ` llm+${curator.queued + curator.episodes}` : ''}${curator.auto ? ` auto+${curator.auto}` : ''}）`,
        )
      }
      if (!dryRun) {
        store.writeState({ lastConsolidateAt: nowIso(), lastCurator: curator })
        syncWeeklyAutoSection()
        runtimeInfo.consolidation.lastAt = nowIso()
        runtimeInfo.consolidation.lastTrigger = trigger
        writeMemoryIndex()
      }
      return { ok: true, ...rule, curator, commit, trigger }
    } catch (e) {
      log('整理失败', e?.stack ?? e)
      return { ok: false, error: e?.message ?? String(e) }
    } finally {
      runtimeInfo.consolidation.busy = false
    }
  }

  // --- 旧会话提炼 / 搬家导入导出 -----------------------------------------------
  const sessionQueryService = () => {
    let service
    try {
      service = ctx.get?.('sessionQuery')
    } catch {
      service = undefined
    }
    if (!service) {
      try {
        service = ctx.sessionQuery
      } catch {
        service = undefined
      }
    }
    return service
  }

  const sessionAllowed = (cwd) => {
    if (!cwd) return false
    if (cfg.scope === 'global') return true
    return cfg.enabledWorkspaces.some((base) => pathMatches(resolve(cwd), base))
  }

  /** 列出当前启用工作区的历史会话（只用于「提炼」，不读写会话内容）。 */
  const listMineSessions = async ({ limit = 15 } = {}) => {
    const sq = sessionQueryService()
    if (!sq) return { ok: false, error: 'sessionQuery 服务不可用，读不了旧会话。' }
    const records = new Map()
    try {
      const bases = cfg.enabledWorkspaces.length > 0 ? cfg.enabledWorkspaces : [null]
      for (const base of bases) {
        const filters = base ? [{ kind: 'cwd', values: [base] }] : []
        const list =
          filters.length > 0 && typeof sq.filterSessions === 'function'
            ? await sq.filterSessions(filters)
            : typeof sq.listSessions === 'function'
              ? await sq.listSessions()
              : []
        for (const record of list || []) {
          const header = record?.header
          if (!header?.id) continue
          if (!sessionAllowed(header.cwd)) continue
          if (!records.has(header.id)) records.set(header.id, record)
        }
      }
    } catch (e) {
      log('列旧会话失败', e?.message ?? e)
    }
    const sorted = [...records.values()]
      .sort((a, b) => (b.header?.createdAt || 0) - (a.header?.createdAt || 0))
      .slice(0, limit)
    const titles = new Map()
    try {
      if (typeof sq.readTitleSnapshots === 'function' && sorted.length > 0) {
        const snaps = await sq.readTitleSnapshots(sorted.map((record) => record.header.id))
        for (const item of snaps || []) {
          if (item?.status === 'fulfilled' && item.value?.title?.title) titles.set(item.sessionId, item.value.title.title)
        }
      }
    } catch (e) {
      log('读会话标题失败', e?.message ?? e)
    }
    return {
      ok: true,
      sessions: sorted.map((record) => ({
        id: record.header.id,
        shortId: String(record.header.id).replace(/^session-/, '').slice(0, 12),
        title: titles.get(record.header.id) || '（无标题）',
        createdAt: record.header.createdAt,
        workspace: record.header.cwd ? workspaceTag(record.header.cwd).name : '（未知）',
      })),
    }
  }

  /** 从一段旧会话提炼记忆提议 → 全部进审核队列（不直接写记忆）。 */
  const mineSession = async ({ sessionId } = {}) => {
    if (!sessionId) return { ok: false, error: '缺少 sessionId' }
    if (runtimeInfo.mine.busy) return { ok: false, error: '正在提炼另一段会话，稍等。' }
    runtimeInfo.mine.busy = true
    try {
      const sq = sessionQueryService()
      if (!sq || typeof sq.readSession !== 'function') return { ok: false, error: 'sessionQuery 不可用。' }
      let snapshot
      try {
        snapshot = await sq.readSession(sessionId)
      } catch (e) {
        return { ok: false, error: `读不到这段会话：${e?.message ?? e}` }
      }
      const header = snapshot?.session || snapshot?.header || {}
      const cwd = header.cwd
      if (!sessionAllowed(cwd)) return { ok: false, error: '这段会话不在已启用的工作区里，不提炼。' }
      const transcript = buildTranscript(snapshot?.events || [], { maxChars: cfg.mineMaxChars })
      if (!transcript || transcript.length < 20) return { ok: false, error: '这段会话里可提炼的对话太少（或只有工具流水）。' }
      let title = ''
      try {
        title = (await sq.readTitle?.(sessionId))?.title || ''
      } catch {
        /* 标题可有可无 */
      }
      const selection = resolveCuratorSelection()
      const llm = ctx.get?.('llm')
      const input = buildMineInput({
        persona: cfg.persona,
        session: { id: sessionId, title, createdAt: header.createdAt },
        transcript,
      })
      let call = await callCuratorModel({
        llm,
        selection,
        input,
        system: MINE_SYSTEM_PROMPT,
        timeoutMs: 90000,
        log,
        maxTokens: 4000,
      })
      // 旧会话转录长，推理可能吃掉全部 token：空正文时缩短转录、加大上限再试一次
      if (!call.ok && /没有返回正文/.test(String(call.error || ''))) {
        log(`提炼首次空正文（${call.error}），缩减 transcript 重试`)
        call = await callCuratorModel({
          llm,
          selection,
          input: {
            ...input,
            transcript: trunc(transcript, Math.max(2000, Math.floor(cfg.mineMaxChars / 2))),
          },
          system: MINE_SYSTEM_PROMPT,
          timeoutMs: 90000,
          log,
          maxTokens: 6000,
        })
      }
      if (!call.ok) return { ok: false, error: `提炼模型调用失败：${call.error}` }
      const parsed = parseCuratorOutput(call.text)
      const validated = parsed.ok ? validateCuratorOutput(parsed.value) : { ok: false, error: parsed.error }
      if (!validated.ok) return { ok: false, error: `模型输出不合法：${validated.error}` }
      if (validated.value.noop) {
        const state = store.writeState({ lastMine: { at: nowIso(), sessionId, title, status: 'noop', ops: 0, queued: 0 } })
        runtimeInfo.mine.last = state.lastMine
        return { ok: true, status: 'noop', ops: 0, queued: 0 }
      }
      const ops = validated.value.ops.slice(0, cfg.mineMaxOps)
      const plan = planCuratorOps({ store, ops, now: new Date(), autoEpisodes: false, mode: 'off' })
      for (const item of plan.queueItems) item.source = `mine:${String(sessionId).slice(0, 8)}`
      if (plan.queueItems.length > 0) store.appendQueueMany(plan.queueItems)
      const reportPath = store.writeReport(
        mineReportName(new Date()),
        [
          `# 旧会话提炼 · ${String(sessionId).replace(/^session-/, '').slice(0, 12)}`,
          '',
          `> 自动生成。会话：${title || '（无标题）'}；transcript ${transcript.length} 字。`,
          '',
          '## 提议（全部进待审，未写入记忆）',
          '',
          ...(plan.queueItems.length === 0
            ? ['> 无']
            : plan.queueItems.map((item) => `- \`${item.id}\` [${item.kind}] ${item.statement}（${item.reason || '提炼'}）`)),
          '',
          ...(plan.skipped.length > 0 ? ['## 跳过', '', ...plan.skipped.map((reason) => `- ${reason}`), ''] : []),
        ].join('\n'),
      )
      const lastMine = {
        at: nowIso(),
        sessionId,
        title,
        status: 'ok',
        ops: ops.length,
        queued: plan.queueItems.length,
        skipped: plan.skipped.length,
        reportPath,
      }
      store.writeState({ lastMine })
      runtimeInfo.mine.last = lastMine
      if (plan.queueItems.length > 0) commitMemory(`mine ${String(sessionId).replace(/^session-/, '').slice(0, 12)}（提议 ${plan.queueItems.length}）`)
      return { ok: true, status: 'ok', ...lastMine }
    } catch (e) {
      log('旧会话提炼失败', e?.stack ?? e)
      return { ok: false, error: e?.message ?? String(e) }
    } finally {
      runtimeInfo.mine.busy = false
    }
  }

  /** 导入别的插件的记忆文件 → 草稿（不参与注入）。 */
  const importMemoryFile = (format, path) => {
    if (!path) return { ok: false, error: '用法：/persona import-memory <auto-memory|mnemon|surfcore|md|json|auto> <文件>' }
    if (!existsSync(path)) return { ok: false, error: `文件不存在：${path}` }
    try {
      const raw = readFileSync(path, 'utf8')
      const items = parseMemoryFile({ format: format || 'auto', raw, source: path })
      if (items.length === 0) return { ok: false, error: `没从 ${path} 里解析出可导入的条目。` }
      let added = 0
      for (const item of items) {
        const { added: didAdd } = store.addEntry({
          id: newEntryId('imp'),
          kind: item.kind,
          scope: 'persona',
          status: 'draft',
          confidence: 0.5,
          statement: item.statement,
          evidence: [{ source: `import:${basename(path)}`, quote: trunc(item.statement, 120) }],
        })
        if (didAdd) added += 1
      }
      writeMemoryIndex()
      if (added > 0) commitMemory(`import-memory ${added}`)
      return { ok: true, added, total: items.length }
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  /** 导出记忆包到「用户选的父目录」：会在里面新建 fishbowl-export-<日期-时间>/。 */
  const exportMemoryBundle = (parentDirInput) => {
    try {
      const prepared = prepareExportParent(parentDirInput)
      if (!prepared.ok) return { ok: false, error: prepared.error }
      const result = buildExport({ store, persona: cfg.persona, parentDir: prepared.parent })
      store.writeState({
        lastExport: { at: nowIso(), dir: result.dir, parentDir: prepared.parent, entries: result.entries },
      })
      return { ok: true, ...result, parentDir: prepared.parent }
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  // --- 命令实现 -------------------------------------------------------------
  const invocationContext = (invocation) => {
    const agent = invocation?.agent
    const session = sessionOf(agent)
    const cwd = session?.header?.cwd
    return { agent, session, cwd, mode: modeFor(agent?.id, cwd) }
  }

  const cmdRemember = (invocation) => {
    const raw = String(invocation?.rawInput ?? '').trim()
    if (!raw) return { kind: 'error', text: '用法：/remember <要记住的话>' }
    const { agent, cwd, mode } = invocationContext(invocation)
    if (mode === 'off') {
      return { kind: 'error', text: `鱼缸没接管当前工作区（cwd=${cwd || '未知'}）。先启用工作区，或 /persona on。` }
    }
    try {
      const result = rememberStatement({ statement: raw, sessionId: agent?.id })
      writeMemoryIndex()
      if (result.added) commitMemory('remember')
      const total = store.counts().relationship.active
      if (!result.added) return { kind: 'success', text: `这条已经有了（active ${total} 条）：${trunc(raw, 100)}` }
      return { kind: 'success', text: `记下了（active ${total} 条，下一轮生效）：${trunc(raw, 120)}` }
    } catch (e) {
      return { kind: 'error', text: `记住失败：${e?.message ?? e}` }
    }
  }

  const matchEntries = (queryText) => {
    const all = store.readAllEntries()
    const text = String(queryText || '').trim()
    if (!text) return { all, hits: [] }
    const byId = all.filter((entry) => entry.id === text || entry.id.startsWith(text))
    if (byId.length > 0) return { all, hits: byId }
    const scored = searchEntries(all, text, { limit: 5, threshold: 1 })
    const hits = scored.map((row) => row.entry)
    if (hits.length === 0) {
      // 简单子串兜底（中文不分词时比 token 靠得住）
      const needle = text.toLowerCase()
      const substring = all.filter(
        (entry) =>
          entry.status !== 'forgotten' &&
          (entry.statement.toLowerCase().includes(needle) ||
            (entry.evidence || []).some((item) => String(item.quote || '').toLowerCase().includes(needle))),
      )
      return { all, hits: substring.slice(0, 5) }
    }
    return { all, hits }
  }

  const describeEntry = (entry) => {
    const evidenceLines = (entry.evidence || []).map((item) => {
      const ref = item.session ? `session ${String(item.session).slice(0, 12)}${item.seq ? `#${item.seq}` : ''}` : item.source || '来源'
      return `    - ${ref}：「${trunc(item.quote || '', 100)}」`
    })
    return [
      `● ${entry.id} · ${entry.kind} · ${entry.status} · conf ${entry.confidence}`,
      `  ${trunc(entry.statement, 200)}`,
      ...evidenceLines,
    ].join('\n')
  }

  const cmdWhy = (invocation) => {
    const query = String(invocation?.rawInput ?? '').trim()
    if (!query) return { kind: 'error', text: '用法：/why <关键词或记忆 id>' }
    try {
      const { hits } = matchEntries(query)
      if (hits.length === 0) return { kind: 'success', text: `没找到和「${trunc(query, 40)}」有关的记忆。` }
      return {
        kind: 'success',
        text: [`和「${trunc(query, 40)}」有关的记忆（${hits.length} 条）：`, ...hits.map(describeEntry)].join('\n'),
      }
    } catch (e) {
      return { kind: 'error', text: `查询失败：${e?.message ?? e}` }
    }
  }

  const cmdForget = (invocation) => {
    const query = String(invocation?.rawInput ?? '').trim()
    if (!query) return { kind: 'error', text: '用法：/forget <记忆 id 或关键词>' }
    try {
      const { hits } = matchEntries(query)
      const active = hits.filter((entry) => entry.status !== 'forgotten')
      if (active.length === 0) return { kind: 'success', text: `没找到可遗忘的记忆（关键词：${trunc(query, 40)}）。` }
      if (active.length > 1) {
        return {
          kind: 'error',
          text: [
            `匹配到 ${active.length} 条，请用 id 精确遗忘：`,
            ...active.map((entry) => `- ${entry.id} · ${trunc(entry.statement, 80)}`),
          ].join('\n'),
        }
      }
      const target = active[0]
      if (target.pinned === true) {
        return {
          kind: 'success',
          text: `这条被钉住了，不能直接遗忘：${target.id} · ${trunc(target.statement, 100)}\n先 /unpin <id>，再 /forget。`,
        }
      }
      store.forgetEntry(target.id)
      writeMemoryIndex()
      commitMemory(`forget ${target.id}`)
      return { kind: 'success', text: `已遗忘 ${target.id}：${trunc(target.statement, 120)}\n（只标记 forgotten，不物理删除；有 git 历史可回滚。）` }
    } catch (e) {
      return { kind: 'error', text: `遗忘失败：${e?.message ?? e}` }
    }
  }

  const cmdPin = (invocation, wantPin) => {
    const query = String(invocation?.rawInput ?? '').trim()
    if (!query) return { kind: 'error', text: `用法：/${wantPin ? 'pin' : 'unpin'} <记忆 id 或关键词>` }
    try {
      const { hits } = matchEntries(query)
      const targetable = hits.filter((entry) => entry.status !== 'forgotten')
      if (targetable.length === 0) return { kind: 'success', text: `没找到这条记忆（${trunc(query, 40)}）。先用 /why <关键词> 找。` }
      if (targetable.length > 1) {
        return {
          kind: 'error',
          text: [`匹配到 ${targetable.length} 条，请用 id：`, ...targetable.map((entry) => `- ${entry.id} · ${trunc(entry.statement, 80)}`)].join('\n'),
        }
      }
      const target = targetable[0]
      store.updateEntry(target.id, { pinned: wantPin })
      writeMemoryIndex()
      commitMemory(`${wantPin ? 'pin' : 'unpin'} ${target.id}`)
      return {
        kind: 'success',
        text: wantPin
          ? `已钉住 ${target.id}：${trunc(target.statement, 120)}\n（整理时不会合并、不会衰减；/forget 也会先拦一下。）`
          : `已取消钉住 ${target.id}：${trunc(target.statement, 120)}\n（之后会正常参与合并/衰减。）`,
      }
    } catch (e) {
      return { kind: 'error', text: `操作失败：${e?.message ?? e}` }
    }
  }

  const importErrorMessage = (error) => `导入失败：${error?.message ?? error}`

  const parseImportedPersona = (text) => {
    let heading = ''
    const drafts = []
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const headingMatch = /^#{1,6}\s+(.+)$/.exec(line)
      if (headingMatch) {
        heading = headingMatch[1].trim()
        continue
      }
      if (/^```/.test(line)) continue
      const bulletMatch = /^(?:[-*•]|\d+[.、])\s+(.+)$/.exec(line)
      if (!bulletMatch) continue
      const statement = bulletMatch[1].trim()
      if (statement.length < 4 || statement.length > 300) continue
      if (/^https?:\/\//i.test(statement) || statement.startsWith('```')) continue
      drafts.push({ heading, statement })
      if (drafts.length >= 60) break
    }
    const kindOf = (section) => {
      if (/(雷区|边界|禁忌|不许|不要|避免)/.test(section)) return 'boundary'
      if (/(仪式|节律|习惯|每天|节拍)/.test(section)) return 'ritual'
      if (/(承诺|答应|约定|未完)/.test(section)) return 'promise'
      if (/(工作|项目|正在|任务)/.test(section)) return 'context'
      if (/(问题|待定|未定|开放)/.test(section)) return 'open_question'
      return 'preference'
    }
    return drafts.map((draft) => ({ ...draft, kind: kindOf(draft.heading) }))
  }

  const resolveInputPath = (pathArg, cwd) => {
    const text = String(pathArg || '').trim().replace(/^["'「]|["'」]$/g, '')
    if (!text) return ''
    if (text.startsWith('/') || /^[A-Za-z]:\\/.test(text)) return text
    return resolve(cwd || process.cwd(), text)
  }

  const cmdPersona = (invocation) => {
    const raw = String(invocation?.rawInput ?? '').trim()
    const [subcommandRaw, ...rest] = raw.split(/\s+/)
    const subcommand = (subcommandRaw || 'status').toLowerCase()
    const context = invocationContext(invocation)

    if (subcommand === 'status' || subcommand === '') {
      const counts = store.counts()
      const handoff = context.cwd ? store.readHandoff(context.cwd, cfg.handoffKeep) : { entries: [] }
      const override = context.agent?.id ? store.readOverrides().sessions[String(context.agent.id)] : undefined
      return {
        kind: 'success',
        text: [
          `鱼缸 · persona=${cfg.persona} · scope=${cfg.scope} · 默认模式=${cfg.defaultMode}`,
          `本会话：${context.cwd || '(未知 cwd)'} → ${context.mode}${override?.off ? '（/persona off 覆盖中）' : ''}`,
          `记忆：active ${counts.relationship.active} / draft ${counts.relationship.draft} / needs_review ${counts.relationship.needsReview} / forgotten ${counts.relationship.forgotten}；情节 ${counts.episodes} 条`,
          `交接：${counts.handoffHoursAgo === null ? '暂无' : `最近 ${counts.handoffHoursAgo} 小时前（${handoff.entries.length} 条）`}；今日 journal ${counts.journal.todayLines} 行`,
          `配置来源：${configSource() === 'panel' ? '面板设置（config.json）' : 'profile patch'}；面板：设置 → 鱼缸`,
          `审核队列：${store.pendingQueue().length} 条待审；最近整理：${store.readState().lastConsolidateAt || '还没整理过'}`,
          `版本：${gitRepo.head() ? `git HEAD ${gitRepo.head()}` : '未启用/无提交'}；体检：${computeHealth({ store }).score} 分`,
          `冲突自动处理：${cfg.conflictAutoMode}（阈值 ${cfg.conflictAutoMinConfidence}）；/persona auto 看最近自动动作`,
          `旧会话提炼 / 搬家：/persona mine list · /persona export [目录] · /persona import-memory <auto-memory|mnemon|surfcore|md|json> <文件>`,
          `家目录：${personaDir}`,
          '',
          '用法：/remember <话> · /why <关键词|id> · /forget <id|关键词> · /persona off|on · /persona import <文件> · /persona consolidate [dry] · /persona review|approve|reject [id|all] · /persona health|report|log|rollback <sha>',
        ].join('\n'),
      }
    }

    if (subcommand === 'off') {
      if (!context.agent?.id) return { kind: 'error', text: '拿不到当前会话 id。' }
      store.setSessionOff(context.agent.id, true)
      detachAgent(context.agent.id)
      agentModes.set(context.agent.id, 'off')
      return { kind: 'success', text: '鱼缸已在本会话关闭：不注入、不捕获、不整理。`/persona on` 恢复。' }
    }

    if (subcommand === 'on') {
      if (!context.agent?.id) return { kind: 'error', text: '拿不到当前会话 id。' }
      store.setSessionOff(context.agent.id, false)
      attachAgent(context.agent, context.session, 'resume')
      const mode = agentModes.get(context.agent.id) || 'off'
      return {
        kind: 'success',
        text: mode === 'off'
          ? '本会话恢复记录已设置，但这个工作区没启用（scope=workspace）。'
          : `鱼缸已恢复接管（${mode}）：下一条消息起会带上身份与相关记忆。`,
      }
    }

    if (subcommand === 'import') {
      const path = resolveInputPath(rest.join(' '), context.cwd)
      if (!path) return { kind: 'error', text: '用法：/persona import <绝对路径或相对当前会话的文件>' }
      try {
        if (!existsSync(path)) return { kind: 'error', text: `文件不存在：${path}` }
        const drafts = parseImportedPersona(readFileSync(path, 'utf8'))
        if (drafts.length === 0) {
          return { kind: 'error', text: `没从 ${path} 里解析到可导入的条目（只认 heading + 列表项）。` }
        }
        let added = 0
        for (const draft of drafts) {
          const { added: didAdd } = store.addEntry({
            id: newEntryId('imp'),
            kind: draft.kind,
            scope: 'persona',
            status: 'draft',
            confidence: 0.5,
            statement: trunc(redactText(draft.statement), MAX_REMEMBER_TEXT_CHARS),
            evidence: [{ source: `import:${path.split(/[\\/]/).pop()}`, quote: trunc(redactText(draft.statement), 120) }],
          })
          if (didAdd) added += 1
        }
        writeMemoryIndex()
        if (added > 0) commitMemory(`import ${added} drafts`)
        return {
          kind: 'success',
          text: `导入 ${added} 条草稿（来源 ${path.split(/[\\/]/).pop()}），不参与自动注入。\n/persona review 看草稿，/persona approve 转正，/persona reject 丢弃。`,
        }
      } catch (e) {
        return { kind: 'error', text: importErrorMessage(e) }
      }
    }

    if (subcommand === 'review') {
      const drafts = store.readRelationship().entries.filter((entry) => entry.status === 'draft' || entry.status === 'needs_review')
      const queue = store.pendingQueue()
      if (drafts.length === 0 && queue.length === 0) return { kind: 'success', text: '没有待审项。' }
      const lines = [`待审 ${drafts.length + queue.length} 条：`]
      for (const entry of drafts.slice(0, 12)) lines.push(`- ${entry.id} · [${entry.kind}] ${trunc(entry.statement, 100)}（草稿）`)
      for (const item of queue.slice(0, 12)) {
        const badge = item.source === 'curator' ? '大模型提议' : '规则候选'
        lines.push(`- ${item.id} · ${item.op}/${item.kind}（${badge}）`)
        if (item.target_snapshot) {
          lines.push(`    旧：${trunc(item.target_snapshot.statement, 100)}${item.target_snapshot.pinned ? '（📌 钉住）' : ''}`)
          lines.push(`    新：${item.op === 'forget' ? '（遗忘）' : trunc(item.statement || '', 100)}`)
        } else {
          lines.push(`    ${trunc(item.statement || '', 100)}`)
        }
      }
      lines.push('', '/persona approve [id|all] · /persona reject [id|all]；不带参数 = 全部')
      return { kind: 'success', text: lines.join('\n') }
    }

    if (subcommand === 'approve' || subcommand === 'reject') {
      const approve = subcommand === 'approve'
      const arg = rest.join(' ').trim()
      const queue = store.pendingQueue()
      const drafts = store.readRelationship().entries.filter((entry) => entry.status === 'draft' || entry.status === 'needs_review')
      const targetQueue = arg && arg !== 'all' ? queue.filter((item) => item.id === arg || item.id.startsWith(arg)) : queue
      const targetDrafts = arg && arg !== 'all' ? drafts.filter((entry) => entry.id === arg || entry.id.startsWith(arg)) : drafts
      if (targetQueue.length === 0 && targetDrafts.length === 0) return { kind: 'error', text: '没有匹配的待审项。' }
      const decided = []
      for (const item of targetQueue) {
        if (approve) {
          const result = applyQueueItem(item)
          if (!result.ok) return { kind: 'error', text: result.error }
        }
        store.updateQueueItem(item.id, { status: approve ? 'applied' : 'rejected', decidedAt: nowIso() })
        decided.push(`${approve ? '＋' : '－'} ${item.id}`)
      }
      for (const draft of targetDrafts) {
        store.updateEntry(draft.id, { status: approve ? 'active' : 'forgotten' })
        decided.push(`${approve ? '＋' : '－'} ${draft.id}`)
      }
      writeMemoryIndex()
      commitMemory(`${approve ? 'approve' : 'reject'} ${decided.length} 条`)
      return {
        kind: 'success',
        text: [`${approve ? '通过' : '丢弃'} ${decided.length} 条：`, ...decided.slice(0, 20)].join('\n'),
      }
    }

    if (subcommand === 'consolidate') {
      const dry = rest.some((token) => token === 'dry' || token === '--dry')
      return runConsolidation({ dryRun: dry, trigger: 'command', allowLlm: !dry }).then((result) => {
        if (!result.ok) return { kind: 'error', text: `整理失败：${result.error}` }
        const curator = result.curator || {}
        return {
          kind: 'success',
          text: [
            `${dry ? '（dry-run，未落盘）' : ''}整理完成：`,
            `- journal 新行：${result.journalLines}`,
            `- 入审核队列：${result.queued}；合并：${result.merged}；衰减：${result.decayed}；stale：${result.staled}`,
            `- curator：${curator.status || 'off'}${curator.ops !== undefined ? `（ops ${curator.ops}，入队 ${curator.queued ?? 0}，情节 ${curator.episodes ?? 0}，跳过 ${curator.skipped ?? 0}）` : ''}${curator.error ? `：${curator.error}` : ''}`,
            result.commit ? `- commit：${result.commit.sha}` : '- 没有改动，不 commit',
            result.reportPath ? `- 报告：${result.reportPath}` : '',
            `- 体检得分：${result.health?.score ?? '?'}`,
          ]
            .filter(Boolean)
            .join('\n'),
        }
      })
    }

    if (subcommand === 'log') {
      const commits = gitRepo.log(Number(rest[0]) || 10)
      if (commits.length === 0) return { kind: 'success', text: '还没有 git 提交（或 git 未启用）。' }
      return {
        kind: 'success',
        text: ['最近提交：', ...commits.map((commit) => `- ${commit.sha} · ${commit.date} · ${commit.message}`)].join('\n'),
      }
    }

    if (subcommand === 'rollback') {
      const sha = String(rest[0] || '').trim()
      if (!sha) return { kind: 'error', text: '用法：/persona rollback <commit sha（/persona log 可查）>' }
      const result = gitRepo.restore(sha)
      if (!result.ok) return { kind: 'error', text: `回滚失败：${result.error}` }
      writeMemoryIndex()
      return {
        kind: 'success',
        text: `已回滚记忆文件到 ${result.restoredTo}${result.commit ? `，并记录 rollback commit ${result.commit.sha}` : ''}。`,
      }
    }

    if (subcommand === 'health') {
      const health = computeHealth({ store, now: new Date() })
      return {
        kind: 'success',
        text: [`身份体检：${health.score} 分`, ...health.checks.map((check) => `- ${check.ok ? '✅' : '⚠️'} ${check.label}（${check.detail}）`)].join('\n'),
      }
    }

    if (subcommand === 'report') {
      const latest = store.readLatestReport()
      if (!latest) return { kind: 'success', text: '还没有整理报告（跑一次 /persona consolidate）。' }
      return { kind: 'success', text: `最新报告：${latest.file}\n\n${trunc(latest.content, 3000)}` }
    }

    if (subcommand === 'auto') {
      const actions = store.readAutoActions({ limit: 15 })
      if (actions.length === 0) {
        return { kind: 'success', text: `还没有自动处理记录（模式：${cfg.conflictAutoMode}）。` }
      }
      const stats = store.readAutoActions({ sinceMs: Date.now() - 7 * 86400000, limit: 500 })
      const byRelation = stats.reduce((acc, action) => {
        const key = action.status === 'undone' ? '已撤销' : action.relation
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {})
      return {
        kind: 'success',
        text: [
          `冲突自动处理（模式 ${cfg.conflictAutoMode} · 阈值 ${cfg.conflictAutoMinConfidence}）`,
          `近 7 天：${Object.entries(byRelation).map(([key, value]) => `${key} ${value}`).join(' / ') || '无'}`,
          '最近动作：',
          ...actions.map(
            (action) =>
              `- ${action.id} · ${action.relation} · ${action.status === 'undone' ? '已撤销' : '生效中'} · ${trunc(action.statement, 80)}`,
          ),
          '',
          '撤销：/persona undo-auto <id>（或面板「冲突与自动处理」）。',
        ].join('\n'),
      }
    }

    if (subcommand === 'undo-auto') {
      const id = String(rest[0] || '').trim()
      if (!id) return { kind: 'error', text: '用法：/persona undo-auto <auto 动作 id>' }
      const result = undoAutoAction(id)
      if (!result.ok) return { kind: 'error', text: `撤销失败：${result.error}` }
      return { kind: 'success', text: `已撤销 ${id}（改动已回滚，git 里有记录）。` }
    }

    if (subcommand === 'mine') {
      const arg = String(rest[0] || 'list').trim()
      if (!arg || arg === 'list') {
        return listMineSessions({ limit: 12 }).then((listed) => {
          if (!listed.ok) return { kind: 'error', text: listed.error }
          if (listed.sessions.length === 0) {
            return { kind: 'success', text: '没找到可提炼的旧会话（只扫描已启用工作区）。先用面板或配置启用工作区。' }
          }
          return {
            kind: 'success',
            text: [
              `可提炼的旧会话 ${listed.sessions.length} 段（只列不读内容）：`,
              ...listed.sessions.map(
                (item) =>
                  `- ${item.shortId} · ${new Date(item.createdAt || 0).toISOString().slice(0, 10)} · ${item.workspace} · ${trunc(item.title, 60)}`,
              ),
              '',
              '用法：/persona mine <id 前缀> —— 提炼这一段（结果全部进审核队列，不会直接写记忆）',
            ].join('\n'),
          }
        })
      }
      return listMineSessions({ limit: 50 }).then((listed) => {
        if (!listed.ok) return { kind: 'error', text: listed.error }
        const target = listed.sessions.find(
          (item) => item.id === arg || String(item.id).startsWith(arg) || item.shortId.startsWith(arg),
        )
        if (!target) return { kind: 'error', text: `没找到这段会话：${arg}（先 /persona mine list）` }
        return mineSession({ sessionId: target.id }).then((result) => {
          if (!result.ok) return { kind: 'error', text: `提炼失败：${result.error}` }
          if (result.status === 'noop') return { kind: 'success', text: '这段旧会话里没提炼出值得记的东西（noop）。' }
          return {
            kind: 'success',
            text: [
              `提炼完成：${target.shortId} · ${trunc(target.title, 40)}`,
              `- 提议 ${result.queued} 条（全部进审核队列，未写入记忆）`,
              `- 跳过 ${result.skipped ?? 0} 条（重复/目标不存在）`,
              result.reportPath ? `- 报告：${result.reportPath}` : '',
              '',
              '去 /persona review 逐条通过或丢弃；面板「待审」里也能点。',
            ]
              .filter(Boolean)
              .join('\n'),
          }
        })
      })
    }

    if (subcommand === 'export') {
      const result = exportMemoryBundle(rest.join(' ').trim() || undefined)
      if (!result.ok) return { kind: 'error', text: `导出失败：${result.error}` }
      return {
        kind: 'success',
        text: `已导出记忆包：${result.dir}\n（在 ${result.parentDir} 下新建的 fishbowl-export-<日期-时间> 文件夹里）\n包含 ${result.files} 个文件、${result.entries} 条记忆（含 fishbowl-export.json 清单）。\n不含 journal、账号、密钥；工作区只写名字+哈希。`,
      }
    }

    if (subcommand === 'import-memory') {
      const formats = ['auto-memory', 'mnemon', 'surfcore', 'md', 'markdown', 'json', 'auto']
      let format = 'auto'
      let pathArg = rest.join(' ').trim()
      if (formats.includes(String(rest[0] || '').toLowerCase())) {
        format = String(rest[0]).toLowerCase()
        pathArg = rest.slice(1).join(' ').trim()
      }
      const path = resolveInputPath(pathArg, context.cwd)
      if (!path) return { kind: 'error', text: '用法：/persona import-memory <auto-memory|mnemon|surfcore|md|json|auto> <文件>' }
      const result = importMemoryFile(format, path)
      if (!result.ok) return { kind: 'error', text: `导入失败：${result.error}` }
      return {
        kind: 'success',
        text: `导入 ${result.added} 条草稿（解析到 ${result.total} 条，来源 ${basename(path)}）。\n草稿不参与注入：/persona review 查看，/persona approve 转正，/persona reject 丢弃。`,
      }
    }

    return {
      kind: 'error',
      text: '用法：/persona [status|off|on|import <文件>|consolidate [dry]|review|approve [id|all]|reject [id|all]|health|report|log|rollback <sha>|mine [list|<id>]|export [父目录]|import-memory <格式> <文件>|auto|undo-auto <id>]',
    }
  }

  // --- 事件 -----------------------------------------------------------------
  ctx.effect(
    () => () => {
      for (const dispose of agentScopedDisposers.values()) {
        try {
          dispose()
        } catch {
          /* 已清理 */
        }
      }
      agentScopedDisposers.clear()
      agentById.clear()
      agentLastSeq.clear()
      agentModes.clear()
      lastUserText.clear()
    },
    'fishbowl: 卸载时清理 agent 注册',
  )

  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent?.id) return
      const session = sessionOf(agent)
      if (!session) return
      agentById.set(agent.id, agent)
      agentLastSeq.set(agent.id, Number(session.seq) || 0)
      attachAgent(agent, session, payload?.source)
    } catch (e) {
      // agent/created 是 serial 事件：抛错会打断创建，必须吞掉
      log('agent/created 处理失败', e?.stack ?? e)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (!id) return
    detachAgent(id)
    agentById.delete(id)
    agentLastSeq.delete(id)
    agentModes.delete(id)
    lastUserText.delete(id)
  })

  // 记录最近一条非注入 user 文本，供动态召回（emit 事件，安全）
  ctx.on('session/event', (session, event) => {
    try {
      if (!session?.id || !event || event.type !== 'user/message') return
      const text = messageText(event.data)
      if (!text || isInjectedUserText(text)) return
      lastUserText.set(session.id, stripHarnessBoilerplate(text))
    } catch {
      /* 缓存失败不影响主流程 */
    }
  })

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      captureTurn(payload)
    } catch (e) {
      log('turn 捕获失败', e?.stack ?? e)
    }
  })

  // --- 命令注册 -------------------------------------------------------------
  ctx.commands.register({
    name: 'remember',
    description: '鱼缸：把一句话记进长期记忆（下一轮就能想起来）',
    input: { hint: '要她记住的话' },
    handler: cmdRemember,
  })
  ctx.commands.register({
    name: 'forget',
    description: '鱼缸：忘掉一条记忆（钉住的要先 /unpin）',
    input: { hint: '记忆 id 或关键词' },
    handler: cmdForget,
  })
  ctx.commands.register({
    name: 'pin',
    description: '鱼缸：钉住一条记忆（整理时不合并不衰减，/forget 会先拦）',
    input: { hint: '记忆 id 或关键词' },
    handler: (invocation) => cmdPin(invocation, true),
  })
  ctx.commands.register({
    name: 'unpin',
    description: '鱼缸：取消钉住，让这条记忆重新参与整理',
    input: { hint: '记忆 id 或关键词' },
    handler: (invocation) => cmdPin(invocation, false),
  })
  ctx.commands.register({
    name: 'why',
    description: '鱼缸：这条记忆是从哪句话来的（看证据/出处）',
    input: { hint: '关键词或记忆 id' },
    handler: cmdWhy,
  })
  ctx.commands.register({
    name: 'persona',
    description: '鱼缸：状态 / 开关 / 整理记忆 / 审核提议 / 体检 / 版本历史',
    input: { hint: 'status | off | on | import <文件> | consolidate [dry] | review | approve [id|all] | reject [id|all] | health | report | log | rollback <sha>' },
    handler: cmdPersona,
  })
  ctx.commands.register({
    name: 'fishbowl',
    description: '鱼缸：查看接管状态（同 /persona status）',
    handler: (invocation) => cmdPersona({ ...invocation, rawInput: 'status' }),
  })

  // --- 只读 API（面板） ------------------------------------------------------
  const pluginVersion = (() => {
    try {
      return String(JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '?')
    } catch {
      return '?'
    }
  })()

  const statusPayload = () => {
    const soul = persona()
    const counts = store.counts()
    const recent = [...store.readRelationship().entries]
      .filter((entry) => entry.status === 'active')
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 8)
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        statement: trunc(entry.statement, 140),
        confidence: entry.confidence,
        updated_at: entry.updated_at,
        pinned: entry.pinned === true,
      }))
    const drafts = store
      .readRelationship()
      .entries.filter((entry) => entry.status === 'draft' || entry.status === 'needs_review')
      .slice(0, 8)
      .map((entry) => ({ id: entry.id, kind: entry.kind, statement: trunc(entry.statement, 120), status: entry.status }))
    const queue = store.pendingQueue()
    const state = store.readState()
    const health = computeHealth({ store, now: new Date() })
    const latestReport = store.readLatestReport()
    return {
      ok: true,
      plugin: 'dsh-fishbowl',
      version: pluginVersion,
      stage: 'stable',
      persona: {
        id: cfg.persona,
        name: soul.meta.persona ?? cfg.persona,
        dir: personaDir,
        soulVersion: soul.meta.version ?? null,
        soulBytes: soul.body.length,
        locked: soul.meta.locked === true,
      },
      scope: {
        mode: cfg.scope,
        defaultMode: cfg.defaultMode,
        enabledWorkspaces: cfg.enabledWorkspaces,
        workspaceModes: cfg.workspaceModes,
      },
      caps: {
        soul: cfg.injectSoul,
        journal: cfg.journalEnabled,
        handoff: cfg.handoffEnabled,
        recall: cfg.recallEnabled,
        maxRecall: cfg.maxRecall,
      },
      config: {
        source: configSource(),
        file: configFile,
        updatedAt: configFileState(configFile).updatedAt,
        effective: editableConfig(cfg),
        base: editableConfig(baseCfg),
      },
      counts,
      recent,
      drafts,
      m1: ['relationship', 'episodes', 'handoff', 'recall', 'forget', 'why', 'persona-off', 'import-draft', 'redaction'],
      m15: ['settings-form', 'config-file', 'hot-reload', 'reattach-live-agents'],
      m2: ['consolidation', 'curator-llm', 'review-queue', 'decay', 'git-versioning', 'weekly-report', 'identity-health'],
      m3: ['mine-old-sessions', 'import-memory', 'export-bundle', 'curator-cost-gate'],
      conflict: {
        mode: cfg.conflictAutoMode,
        threshold: cfg.conflictAutoMinConfidence,
        autoActions: store.readAutoActions({ limit: 10 }).map((action) => ({
          id: action.id,
          at: action.at,
          relation: action.relation,
          kind: action.kind,
          statement: trunc(action.statement || '', 140),
          targetId: action.targetId || null,
          targetStatement: trunc(action.target_snapshot?.statement || '', 140),
          status: action.status || 'active',
          mode: action.mode,
        })),
        stats7d: store
          .readAutoActions({ sinceMs: Date.now() - 7 * 86400000, limit: 500 })
          .reduce((acc, action) => {
            const key = action.status === 'undone' ? 'undone' : action.relation
            acc[key] = (acc[key] || 0) + 1
            return acc
          }, {}),
      },
      review: {
        pending: queue.length + drafts.length,
        queue: queue.slice(-10).map((item) => ({
          id: item.id,
          op: item.op,
          kind: item.kind,
          statement: trunc(item.statement || item.target_id || '', 140),
          reason: item.reason,
          source: item.source,
          relation: item.relation || null,
          target_snapshot: item.target_snapshot
            ? {
                ...item.target_snapshot,
                statement: trunc(item.target_snapshot.statement || '', 140),
                pinned: item.target_snapshot.pinned === true,
              }
            : null,
        })),
        drafts: drafts.slice(0, 10),
      },
      consolidation: {
        busy: runtimeInfo.consolidation.busy,
        lastAt: state.lastConsolidateAt || null,
        lastTrigger: runtimeInfo.consolidation.lastTrigger,
        lastCurator: state.lastCurator || runtimeInfo.consolidation.lastCurator || null,
        intervalHours: cfg.curatorIntervalHours,
        reportPath: state.lastReportPath || null,
        weeklyReportPath: state.lastWeeklyReportPath || null,
        journalCursor: state.journalCursors || {},
      },
      git: {
        enabled: cfg.gitEnabled,
        available: gitRepo.available,
        head: gitRepo.head(),
        commits: gitRepo.log(8),
      },
      reports: {
        latest: latestReport
          ? { file: latestReport.file, updatedAt: latestReport.updatedAt, preview: trunc(latestReport.content, 600) }
          : null,
      },
      health,
      m3Info: {
        sessionQuery: Boolean(sessionQueryService()),
        lastMine: state.lastMine || runtimeInfo.mine.last || null,
        lastExport: state.lastExport || null,
        mineMaxChars: cfg.mineMaxChars,
        mineMaxOps: cfg.mineMaxOps,
        defaultExportParent: join(homedir(), 'Downloads'),
        busy: runtimeInfo.mine.busy,
      },
      curator: {
        useLlm: cfg.curatorUseLlm,
        selection: resolveCuratorSelection(),
        autoConsolidate: cfg.autoConsolidate,
        decayEnabled: cfg.decayEnabled,
        weeklyReport: cfg.weeklyReport,
      },
      runtime: {
        loadedAt: runtimeInfo.loadedAt,
        attachedLiveAgents: runtimeInfo.attachedLiveAgents,
        agentsProbe: runtimeInfo.agentsProbe,
      },
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/api/fishbowl',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            if (req.method === 'GET' && (url.pathname === '/api/fishbowl' || url.pathname === '/api/fishbowl/status')) {
              sendJson(res, 200, statusPayload())
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/config') {
              let body
              try {
                body = await readJsonBody(req)
              } catch (e) {
                sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${e?.message ?? e}` })
                return
              }
              const payload =
                body && typeof body === 'object' && body.config && typeof body.config === 'object' ? body.config : body
              const result = validateConfigInput(payload, { isDirectory })
              if (!result.ok) {
                sendJson(res, 400, { ok: false, error: result.error })
                return
              }
              writeConfigFile(configFile, result.value)
              reloadConfig()
              log(`面板配置已保存：${JSON.stringify(result.value)}`)
              sendJson(res, 200, { ...statusPayload(), saved: true })
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/config/reset') {
              const cleared = clearConfigFile(configFile)
              reloadConfig()
              log('面板配置已重置为 patch 配置')
              sendJson(res, 200, { ...statusPayload(), reset: cleared })
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/consolidate') {
              let body = {}
              try {
                body = await readJsonBody(req)
              } catch {
                body = {}
              }
              const dry = body?.dry === true
              const result = await runConsolidation({ dryRun: dry, trigger: 'api', allowLlm: !dry })
              if (!result.ok) {
                sendJson(res, 500, { ok: false, error: result.error })
                return
              }
              sendJson(res, 200, { ...statusPayload(), consolidated: result })
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/review') {
              let body = {}
              try {
                body = await readJsonBody(req)
              } catch {
                body = {}
              }
              const id = String(body?.id || '')
              const action = body?.action === 'reject' ? 'reject' : body?.action === 'approve' ? 'approve' : ''
              if (!id || !action) {
                sendJson(res, 400, { ok: false, error: '需要 id 和 action=approve|reject' })
                return
              }
              const queueItem = store.pendingQueue().find((item) => item.id === id)
              if (queueItem) {
                if (action === 'approve') {
                  const applied = applyQueueItem(queueItem)
                  if (!applied.ok) {
                    sendJson(res, 400, { ok: false, error: applied.error })
                    return
                  }
                }
                store.updateQueueItem(id, { status: action === 'approve' ? 'applied' : 'rejected', decidedAt: nowIso() })
              } else {
                const draft = store
                  .readRelationship()
                  .entries.find((entry) => entry.id === id && (entry.status === 'draft' || entry.status === 'needs_review'))
                if (!draft) {
                  sendJson(res, 404, { ok: false, error: `没有待审项：${id}` })
                  return
                }
                store.updateEntry(id, { status: action === 'approve' ? 'active' : 'forgotten' })
              }
              writeMemoryIndex()
              commitMemory(`${action} ${id}`)
              sendJson(res, 200, { ...statusPayload(), decided: { id, action } })
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/pin') {
              let body = {}
              try {
                body = await readJsonBody(req)
              } catch {
                body = {}
              }
              const id = String(body?.id || '')
              const pinned = body?.pinned !== false
              if (!id) {
                sendJson(res, 400, { ok: false, error: '需要记忆 id' })
                return
              }
              const entry = store.readAllEntries().find((item) => item.id === id)
              if (!entry) {
                sendJson(res, 404, { ok: false, error: `没有这条记忆：${id}` })
                return
              }
              store.updateEntry(id, { pinned })
              writeMemoryIndex()
              commitMemory(`${pinned ? 'pin' : 'unpin'} ${id}`)
              sendJson(res, 200, { ...statusPayload(), pinned: { id, pinned } })
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/auto-log') {
              let body = {}
              try {
                body = await readJsonBody(req)
              } catch {
                body = {}
              }
              const id = String(body?.id || '')
              if (!id || body?.action !== 'undo') {
                sendJson(res, 400, { ok: false, error: '需要 id 和 action=undo' })
                return
              }
              const result = undoAutoAction(id)
              if (!result.ok) {
                sendJson(res, 400, { ok: false, error: result.error })
                return
              }
              sendJson(res, 200, { ...statusPayload(), undone: result.action })
              return
            }
            if (req.method === 'GET' && url.pathname === '/api/fishbowl/mine') {
              const listed = await listMineSessions({ limit: 20 })
              if (!listed.ok) {
                sendJson(res, 503, { ok: false, error: listed.error })
                return
              }
              sendJson(res, 200, { ok: true, sessions: listed.sessions, at: nowIso() })
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/mine') {
              let body = {}
              try {
                body = await readJsonBody(req)
              } catch {
                body = {}
              }
              const sessionId = String(body?.sessionId || '')
              if (!sessionId) {
                sendJson(res, 400, { ok: false, error: '需要 sessionId（先 GET /api/fishbowl/mine 列表）' })
                return
              }
              const result = await mineSession({ sessionId })
              if (!result.ok) {
                sendJson(res, 400, { ok: false, error: result.error })
                return
              }
              sendJson(res, 200, { ...statusPayload(), mined: result })
              return
            }
            if (req.method === 'POST' && url.pathname === '/api/fishbowl/export') {
              let body = {}
              try {
                body = await readJsonBody(req)
              } catch {
                body = {}
              }
              const input =
                typeof body?.parentDir === 'string'
                  ? body.parentDir
                  : typeof body?.dir === 'string'
                    ? body.dir
                    : undefined
              const result = exportMemoryBundle(input)
              if (!result.ok) {
                sendJson(res, 400, { ok: false, error: result.error })
                return
              }
              sendJson(res, 200, { ...statusPayload(), exported: result })
              return
            }
            sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${url.pathname}` })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
          }
        },
      }),
    'fishbowl: /api/fishbowl 路由',
  )

  // --- 插件重载时的在线 agent 补挂 ------------------------------------------
  // 重载插件（disable/enable）不会重发 agent/created；不补挂的话旧会话要重启才恢复注入。
  const attachLiveAgents = () => {
    try {
      // 注意：ctx 上没有 inject 'agents' 时，直接摸 ctx.agents 可能抛错；优先用 ctx.get。
      let agentsService
      try {
        agentsService = ctx.get?.('agents')
      } catch {
        agentsService = undefined
      }
      if (!agentsService) {
        try {
          agentsService = ctx.agents
        } catch {
          agentsService = undefined
        }
      }
      const canList = typeof agentsService?.list === 'function'
      const live = canList ? agentsService.list() : []
      runtimeInfo.agentsProbe = {
        found: Boolean(agentsService),
        hasList: canList,
        count: canList ? live.length : null,
        at: nowIso(),
      }
      let attached = 0
      for (const agent of live) {
        if (!agent?.id || agentById.has(agent.id)) continue
        const session = sessionOf(agent)
        if (!session) continue
        agentById.set(agent.id, agent)
        agentLastSeq.set(agent.id, Number(session.seq) || 0)
        attachAgent(agent, session, 'resume')
        attached += 1
      }
      runtimeInfo.attachedLiveAgents += attached
      if (attached > 0) log(`重载后补挂在线 agent ${attached} 个`)
    } catch (e) {
      log('补挂在线 agent 失败', e?.message ?? e)
    }
  }

  // --- 启动 -----------------------------------------------------------------
  store.ensurePersona({ soulSeedPath: join(PLUGIN_DIR, 'assets', 'soul.seed.md') })
  const migrated = store.migrateRemembered()
  writeMemoryIndex()
  attachLiveAgents()
  // apply 当口服务/agent 可能尚未就绪：800ms 后再补挂一次（插件卸载时清掉定时器）
  try {
    const timer = setTimeout(() => {
      try {
        attachLiveAgents()
      } catch (e) {
        log('延迟补挂失败', e?.message ?? e)
      }
    }, 800)
    ctx.effect(() => () => clearTimeout(timer), 'fishbowl: 延迟补挂在线 agent')
  } catch (e) {
    log('设置延迟补挂失败', e?.message ?? e)
  }
  // git 初始化（无远端，只做本地版本）+ 自动整理调度
  if (cfg.gitEnabled) {
    if (gitRepo.ensure()) {
      const head = gitRepo.head()
      const commit = commitMemory(head ? 'snapshot on load' : 'init persona memory')
      log(
        commit
          ? `${head ? '加载时快照' : 'git 初始'} commit ${commit.sha}`
          : `git 已就绪（HEAD ${head || '空仓库'}）`,
      )
    }
  } else {
    log('git 版本化已关闭（config.gitEnabled=false）')
  }
  if (cfg.autoConsolidate) {
    const startupState = store.readState()
    const lastAt = startupState.lastConsolidateAt ? Date.parse(startupState.lastConsolidateAt) : 0
    const due = !Number.isFinite(lastAt) || lastAt === 0 || Date.now() - lastAt >= cfg.curatorIntervalHours * 3600000
    if (due) {
      try {
        const timer = setTimeout(() => {
          runConsolidation({ trigger: 'auto' }).catch((e) => log('自动整理失败', e?.message ?? e))
        }, 5000)
        ctx.effect(() => () => clearTimeout(timer), 'fishbowl: 自动整理调度')
        log(`自动整理已排队（间隔 ${cfg.curatorIntervalHours}h，5s 后跑）`)
      } catch (e) {
        log('自动整理调度失败', e?.message ?? e)
      }
    }
  }
  log(
    `已挂载：persona=${cfg.persona} scope=${cfg.scope} 默认模式=${cfg.defaultMode} 工作区=${cfg.enabledWorkspaces.length} 个` +
      ` 配置来源=${configSource()} git=${cfg.gitEnabled ? 'on' : 'off'} 自动整理=${cfg.autoConsolidate ? 'on' : 'off'}` +
      (migrated > 0 ? `（迁移 remembered ${migrated} 条）` : ''),
  )
}

/**
 * 鱼缸 · 规则型 consolidation（M2）
 * ============================================================================
 * 不做大模型也能跑的部分：
 *   1. 读 journal 游标之后的新行，把候选（candidates）聚合 → 审核队列（needs_review 提案）
 *   2. 同 kind 近似条目去重合并（supersede 旧的）
 *   3. 衰减：按 kind 半衰期给 active 条目降 confidence；低于 0.3 且非 boundary → stale
 *   4. 生成整理报告 + 周报 + 身份体检
 * 大模型 curator 在 lib/curator.mjs（可选，失败降级到本文件）。
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { dayKey, hashString, normStatement, nowIso, trunc } from './util.mjs'
import { redactText, tokenize } from './text.mjs'

const DECAY_HALF_LIFE_DAYS = {
  context: 14,
  open_question: 30,
  promise: 21,
  ritual: 120,
  preference: 90,
  boundary: 180,
  episode: 365,
}

/** token 集合相似度：Jaccard 与 containment 取大（短句被长句包含时也能判重）。 */
export function similarity(a, b) {
  const setA = new Set(tokenize(String(a || '')).filter((token) => token.length >= 2))
  const setB = new Set(tokenize(String(b || '')).filter((token) => token.length >= 2))
  if (setA.size < 3 || setB.size < 3) return 0
  let intersection = 0
  for (const token of setA) if (setB.has(token)) intersection += 1
  const union = setA.size + setB.size - intersection
  const jaccard = union > 0 ? intersection / union : 0
  const containment = intersection / Math.min(setA.size, setB.size)
  return Math.max(jaccard, containment * 0.95)
}

/** 读 journal 游标之后的新行；返回待处理切片和推进后的游标。 */
export function readJournalSlices({ journalDir, cursors = {}, maxLines = 80 }) {
  const slices = []
  const nextCursors = { ...cursors }
  let budget = Math.max(1, maxLines)
  let files = []
  try {
    files = readdirSync(journalDir)
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort()
  } catch {
    return { slices, nextCursors }
  }
  for (const file of files) {
    const date = file.slice(0, 10)
    let lines = []
    try {
      lines = readFileSync(join(journalDir, file), 'utf8').split('\n').filter(Boolean)
    } catch {
      continue
    }
    const cursor = Number(nextCursors[date] || 0)
    if (lines.length <= cursor) {
      nextCursors[date] = lines.length
      continue
    }
    const take = Math.min(lines.length - cursor, budget)
    if (take <= 0) continue
    const entries = []
    for (const line of lines.slice(cursor, cursor + take)) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        /* 跳过坏行 */
      }
    }
    slices.push({ date, entries })
    nextCursors[date] = cursor + take
    budget -= take
    if (budget <= 0) break
  }
  return { slices, nextCursors }
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 身份体检：不给大模型，只看数据是否齐全/新鲜。 */
export function computeHealth({ store, now = new Date() }) {
  const soul = store.readSoul()
  const relationship = store.readRelationship().entries
  const active = relationship.filter((entry) => entry.status === 'active')
  const drafts = relationship.filter((entry) => entry.status === 'draft' || entry.status === 'needs_review')
  const pending = store.pendingQueue().length + drafts.length
  const handoffAt = (() => {
    try {
      const files = readdirSync(store.handoffDir).filter((file) => file.endsWith('.md'))
      if (files.length === 0) return null
      return Math.max(...files.map((file) => statSync(join(store.handoffDir, file)).mtimeMs))
    } catch {
      return null
    }
  })()
  const state = store.readState()
  const checks = [
    { id: 'soul', label: 'Soul 身份内核在', ok: soul.body.length >= 100, detail: `${soul.body.length} 字` },
    { id: 'memories', label: '≥3 条 active 记忆', ok: active.length >= 3, detail: `${active.length} 条` },
    {
      id: 'boundary',
      label: '至少 1 条边界',
      ok: active.some((entry) => entry.kind === 'boundary'),
      detail: `${active.filter((entry) => entry.kind === 'boundary').length} 条`,
    },
    {
      id: 'handoff',
      label: '7 天内有交接条',
      ok: handoffAt !== null && now.getTime() - handoffAt < 7 * 86400000,
      detail: handoffAt ? `${Math.round((now.getTime() - handoffAt) / 3600000)} 小时前` : '无',
    },
    { id: 'review', label: '审核队列不积压（≤5）', ok: pending <= 5, detail: `${pending} 条待审` },
    {
      id: 'consolidate',
      label: '48 小时内整理过',
      ok: state.lastConsolidateAt ? now.getTime() - Date.parse(state.lastConsolidateAt) < 48 * 3600000 : false,
      detail: state.lastConsolidateAt || '还没整理过',
    },
  ]
  return { score: Math.round((checks.filter((check) => check.ok).length / checks.length) * 100), checks }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 跑一次规则型整理。
 * @returns 汇总（dryRun 时不落盘）
 */
export function consolidate({ store, cfg, now = new Date(), dryRun = false, log = () => {} }) {
  const state = store.readState()
  const { slices, nextCursors } = readJournalSlices({
    journalDir: store.journalDir,
    cursors: state.journalCursors || {},
    maxLines: cfg.curatorMaxJournalLines || 80,
  })
  const journalLines = slices.reduce((sum, slice) => sum + slice.entries.length, 0)

  const allEntries = store.readAllEntries()
  const active = allEntries.filter((entry) => entry.status === 'active')
  const pending = store.pendingQueue()

  // 1) journal 候选 → 审核队列
  const queuePlans = []
  const candidateMap = new Map()
  for (const slice of slices) {
    for (const entry of slice.entries) {
      for (const candidate of entry.candidates || []) {
        const text = String(candidate?.text || '').trim()
        const key = normStatement(text)
        if (!key || key.length < 4) continue
        const row = candidateMap.get(key) || { kind: candidate.kind || 'preference', text, count: 0, sessions: new Set() }
        row.count += 1
        if (entry.session) row.sessions.add(String(entry.session))
        candidateMap.set(key, row)
      }
    }
  }
  const knownStatements = [...allEntries.filter((entry) => entry.status !== 'forgotten'), ...pending]
    .map((item) => normStatement(item.statement || ''))
    .filter(Boolean)
  for (const [key, row] of candidateMap) {
    if (knownStatements.some((known) => known === key || similarity(known, row.text) >= 0.86)) continue
    queuePlans.push({
      id: `rv_${dayKey(now).replace(/-/g, '')}_${hashString(key).slice(0, 6)}`,
      at: nowIso(),
      status: 'pending',
      op: 'add',
      kind: ['preference', 'boundary', 'ritual', 'promise', 'context', 'open_question'].includes(row.kind) ? row.kind : 'preference',
      statement: redactText(trunc(row.text, 300)),
      confidence: Math.min(0.85, 0.5 + 0.05 * row.count),
      reason: `规则候选×${row.count}`,
      source: 'rule',
      sessions: [...row.sessions].slice(0, 3),
    })
    if (queuePlans.length >= 10) break
  }

  // 2) 同 kind 近似条目合并（保留长的，supersede 短的）
  const mergePlans = []
  const mergedDropIds = new Set()
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]
      const b = active[j]
      if (!a || !b || a.kind !== b.kind || a.kind === 'episode') continue
      if (mergedDropIds.has(a.id) || mergedDropIds.has(b.id)) continue
      if (a.pinned === true || b.pinned === true) continue // 钉住的条目不参与自动合并
      const score = similarity(a.statement, b.statement)
      if (score < 0.86) continue
      const keep = a.statement.length >= b.statement.length ? a : b
      const drop = keep === a ? b : a
      const evidence = [...(keep.evidence || [])]
      for (const item of drop.evidence || []) {
        if (!evidence.some((current) => JSON.stringify(current) === JSON.stringify(item))) evidence.push(item)
      }
      mergePlans.push({
        keepId: keep.id,
        dropId: drop.id,
        similarity: Number(score.toFixed(2)),
        patch: {
          statement: keep.statement,
          confidence: Math.max(a.confidence, b.confidence),
          evidence: evidence.slice(0, 6),
          status: 'active',
        },
      })
      mergedDropIds.add(drop.id)
      if (mergePlans.length >= 5) break
    }
    if (mergePlans.length >= 5) break
  }

  // 3) 衰减（只算计划，dryRun 不落盘）
  const decayPlans = []
  if (cfg.decayEnabled) {
    for (const entry of active) {
      if (mergedDropIds.has(entry.id)) continue
      if (entry.pinned === true) continue // 钉住的条目永不衰减
      const halfLife = DECAY_HALF_LIFE_DAYS[entry.kind] || 90
      const base = Date.parse(entry.updated_at || entry.created_at)
      if (!Number.isFinite(base)) continue
      const ageDays = Math.max(0, (now.getTime() - base) / 86400000)
      if (ageDays < halfLife) continue
      const nextConfidence = Number((entry.confidence * 0.5 ** (ageDays / halfLife)).toFixed(2))
      if (nextConfidence >= entry.confidence - 0.01) continue
      const next = { id: entry.id, from: entry.confidence, to: nextConfidence }
      if (nextConfidence < 0.3 && entry.kind !== 'boundary') {
        next.status = 'stale'
        decayPlans.push({ ...next, staled: true })
      } else {
        decayPlans.push(next)
      }
    }
  }

  const changed = queuePlans.length > 0 || mergePlans.length > 0 || decayPlans.length > 0

  // 4) 落盘
  let reportPath = null
  let weeklyPath = null
  let health = computeHealth({ store, now })
  if (!dryRun) {
    if (queuePlans.length > 0) store.appendQueueMany(queuePlans)
    for (const plan of mergePlans) {
      store.updateEntry(plan.dropId, { status: 'superseded' })
      store.updateEntry(plan.keepId, plan.patch)
    }
    for (const plan of decayPlans) {
      store.updateEntry(plan.id, { confidence: plan.to, ...(plan.status ? { status: plan.status } : {}) })
    }
    health = computeHealth({ store, now })
    const summary = {
      at: nowIso(),
      dryRun: false,
      journalLines,
      queued: queuePlans.length,
      merged: mergePlans.length,
      decayed: decayPlans.filter((plan) => !plan.staled).length,
      staled: decayPlans.filter((plan) => plan.staled).length,
      health,
    }
    reportPath = store.writeReport(`consolidate-${dayKey(now)}.md`, renderConsolidationReport({ summary, queuePlans, mergePlans, decayPlans, store }))
    if (cfg.weeklyReport) {
      const week = isoWeek(now)
      const weeklyName = `${week}.md`
      const weeklyFull = join(store.dir, 'reports', weeklyName)
      if (!existsSync(weeklyFull)) {
        weeklyPath = store.writeReport(weeklyName, renderWeeklyReport({ store, now, week, summary }))
      }
    }
    store.writeState({
      lastConsolidateAt: nowIso(),
      journalCursors: nextCursors,
      lastReportPath: reportPath,
      lastWeeklyReportPath: weeklyPath || store.readState().lastWeeklyReportPath || null,
    })
    log(
      `整理完成：journal ${journalLines} 行，入审核队列 ${queuePlans.length}，合并 ${mergePlans.length}，衰减 ${decayPlans.length}`,
    )
  }

  return {
    at: nowIso(),
    dryRun,
    changed,
    journalLines,
    queued: queuePlans.length,
    merged: mergePlans.length,
    decayed: decayPlans.filter((plan) => !plan.staled).length,
    staled: decayPlans.filter((plan) => plan.staled).length,
    queuePlans,
    mergePlans,
    decayPlans,
    slices,
    health,
    reportPath,
    weeklyPath,
  }
}

// ---------------------------------------------------------------------------
// 报告渲染
// ---------------------------------------------------------------------------

function renderConsolidationReport({ summary, queuePlans, mergePlans, decayPlans, store }) {
  const counts = store.counts()
  const lines = [
    `# 整理报告 · ${summary.at.slice(0, 10)}`,
    '',
    `> 自动生成（规则型 consolidation）。本次 dryRun=${summary.dryRun}`,
    '',
    '## 本次动作',
    '',
    `- 新 journal 行：${summary.journalLines}`,
    `- 入审核队列：${summary.queued}`,
    `- 合并近似条目：${summary.merged}`,
    `- 衰减：${summary.decayed}；转 stale：${summary.staled}`,
    '',
    '## 审核队列新增',
    '',
    ...(queuePlans.length === 0
      ? ['> 无']
      : queuePlans.map((plan) => `- \`${plan.id}\` [${plan.kind}] ${plan.statement}（${plan.reason}）`)),
    '',
    '## 合并',
    '',
    ...(mergePlans.length === 0
      ? ['> 无']
      : mergePlans.map((plan) => `- ${plan.dropId} → ${plan.keepId}（相似度 ${plan.similarity}）`)),
    '',
    '## 衰减',
    '',
    ...(decayPlans.length === 0
      ? ['> 无']
      : decayPlans.map((plan) => `- ${plan.id}：${plan.from} → ${plan.to}${plan.staled ? '（stale）' : ''}`)),
    '',
    '## 当前计数',
    '',
    `- active ${counts.relationship.active} / draft ${counts.relationship.draft} / needs_review ${counts.relationship.needsReview} / forgotten ${counts.relationship.forgotten}`,
    `- 情节卡 ${counts.episodes}；交接 ${counts.handoffHoursAgo === null ? '无' : `${counts.handoffHoursAgo} 小时前`}`,
    '',
    '## 身份体检',
    '',
    `- 得分：${summary.health.score}`,
    ...summary.health.checks.map((check) => `- ${check.ok ? '✅' : '⚠️'} ${check.label}（${check.detail}）`),
    '',
  ]
  return lines.join('\n')
}

function renderWeeklyReport({ store, now, week, summary }) {
  const counts = store.counts()
  const state = store.readState()
  const lines = [
    `# 周报 · ${week}`,
    '',
    `> 自动生成于 ${nowIso()}。`,
    '',
    '## 这一周的数字',
    '',
    `- active 记忆 ${counts.relationship.active} 条（按 kind：${Object.entries(counts.relationship.byKind || {}).map(([kind, count]) => `${kind} ${count}`).join(' / ') || '无'}）`,
    `- 待审：${store.pendingQueue().length} 条审核队列 + ${counts.relationship.draft + counts.relationship.needsReview} 条草稿`,
    `- 情节卡 ${counts.episodes} 条；journal ${counts.journal.days} 天`,
    `- 交接：${counts.handoffHoursAgo === null ? '无' : `最近 ${counts.handoffHoursAgo} 小时前`}`,
    '',
    '## 身份体检',
    '',
    `- 得分 ${summary.health.score}`,
    ...summary.health.checks.map((check) => `- ${check.ok ? '✅' : '⚠️'} ${check.label}（${check.detail}）`),
    '',
    '## 下次整理',
    '',
    `- 上次整理：${state.lastConsolidateAt || '还没整理过'}`,
    '',
  ]
  return lines.join('\n')
}

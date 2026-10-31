/**
 * 鱼缸 · 大模型 curator（隔离总结器）
 * ============================================================================
 * 输入：已脱敏的 journal 切片 + 现有记忆（id/kind/statement）+ 审核队列摘要
 * 输出：严格 JSON（noop / ops），host 校验后：
 *   - episode 新增 → 直接 active（可撤销）
 *   - 关系类 add/update/supersede/forget → 进审核队列 needs_review（用户确认才落库）
 *   - Soul 永远不碰；工具调用/路径/密钥在 prompt 前已脱敏
 * 模型调用失败 → 返回 {ok:false}，由 index 降级为规则型整理。
 * ============================================================================
 */
import { hashString, normStatement, nowIso, trunc } from './util.mjs'
import { redactText } from './text.mjs'
import { similarity } from './consolidate.mjs'

export const CURATOR_SYSTEM_PROMPT = [
  '你是「鱼缸」的记忆整理器（curator）。你的任务是从对话日记里提炼值得长期记住的东西，输出结构化 JSON。',
  '',
  '硬规则：',
  '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要解释。',
  '2. 不要写工具调用流水、命令输出、文件路径、密钥、账号、uid；不要写一次性闲聊。',
  '3. 不写「她今天做了什么」；情节只写「原话短引用 + 场景 + 立场/情绪 + 出处」。',
  '4. 关系/偏好/边界/承诺/近况类的改动只做「提议」，由用户审核；Soul 永远不能改。',
  '5. 没有值得记的东西就返回 {"noop":true}。',
  '',
  '输出格式：',
  '{"noop":false,"ops":[',
  '  {"op":"add","kind":"preference|boundary|ritual|promise|context|open_question|episode","statement":"一句话","confidence":0.7,"reason":"为什么值得记"},',
  '  {"op":"update","target_id":"rel_xxx","kind":"preference","statement":"修正后的一句话","confidence":0.8,"reason":"..."},',
  '  {"op":"supersede","target_id":"rel_xxx","reason":"被新事实取代"},',
  '  {"op":"forget","target_id":"rel_xxx","reason":"用户明确说记错了/不重要"}',
  ']}',
  '最多 12 条 op；statement 不超过 300 字。',
].join('\n')

/** 构造 curator 的 user 输入（已脱敏）。 */
export function buildCuratorInput({ persona, now = new Date(), existing, journal, queue }) {
  return {
    persona,
    now: now.toISOString(),
    task: '从 journal 里提炼值得长期保留的记忆；关系类只提议，episode 可直接写；没价值就 noop。',
    existing: (existing || []).slice(0, 40).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      confidence: entry.confidence,
      statement: trunc(entry.statement, 200),
    })),
    journal: (journal || []).slice(0, 80).map((line) => ({
      at: line.at,
      workspace: line.workspace,
      user: (line.user || []).map((item) => trunc(redactText(item.text), 300)),
      assistant: (line.assistant || []).map((item) => trunc(redactText(item.text), 300)),
      candidates: (line.candidates || []).map((item) => ({ kind: item.kind, text: trunc(redactText(item.text), 160) })),
    })),
    review_queue: (queue || []).slice(0, 20).map((item) => ({
      id: item.id,
      op: item.op,
      kind: item.kind,
      statement: trunc(item.statement || '', 160),
      reason: item.reason,
    })),
  }
}

/** 把输入塞进一条 user message（GenerateOptions.messages 的形状）。 */
export function buildCuratorMessages(input) {
  return [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }]
}

/** 从模型文本里抠 JSON（容忍代码块/前后废话）。 */
export function parseCuratorOutput(text) {
  const raw = String(text || '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: '没有 JSON 对象' }
  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) }
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e?.message ?? e}` }
  }
}

const VALID_OPS = ['add', 'update', 'supersede', 'forget']
const VALID_KINDS = ['preference', 'boundary', 'ritual', 'promise', 'context', 'open_question', 'episode']

/** 严格校验 curator 输出；返回规范化后的 {noop, ops} 或 error。 */
export function validateCuratorOutput(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '输出不是对象' }
  if (obj.noop === true) return { ok: true, value: { noop: true, ops: [] } }
  if (!Array.isArray(obj.ops)) return { ok: false, error: '缺 ops 数组' }
  if (obj.ops.length > 12) return { ok: false, error: 'ops 超过 12 条' }
  const ops = []
  for (const raw of obj.ops) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'op 不是对象' }
    if (!VALID_OPS.includes(raw.op)) return { ok: false, error: `未知 op：${raw.op}` }
    const hasKind = raw.kind !== undefined && raw.kind !== null && raw.kind !== ''
    if (hasKind && !VALID_KINDS.includes(raw.kind)) return { ok: false, error: `未知 kind：${raw.kind}` }
    // add 必须能分类；update/supersede/forget 的 kind 可以省略（从目标条目推断）
    const kind = hasKind ? raw.kind : raw.op === 'add' ? 'preference' : undefined
    const statement = typeof raw.statement === 'string' ? trunc(redactText(raw.statement.trim()), 300) : ''
    if (raw.op === 'add' && statement.length < 2) return { ok: false, error: 'add 缺 statement' }
    if (raw.op !== 'add' && (typeof raw.target_id !== 'string' || !raw.target_id.trim())) {
      return { ok: false, error: `${raw.op} 缺 target_id` }
    }
    const confidence = Number(raw.confidence)
    ops.push({
      op: raw.op,
      kind,
      statement: statement || undefined,
      target_id: typeof raw.target_id === 'string' ? raw.target_id.trim() : undefined,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
      reason: typeof raw.reason === 'string' ? trunc(redactText(raw.reason), 160) : '',
    })
  }
  if (ops.length === 0) return { ok: false, error: '没有有效 op' }
  return { ok: true, value: { noop: false, ops } }
}

/**
 * 把校验后的 ops 变成落盘计划：
 *   { episodes: [entry], queueItems: [queue item], skipped: [reason] }
 * 关系类一律进审核队列，不直接落库。
 */
export function planCuratorOps({ store, ops, now = new Date(), autoEpisodes = true }) {
  const all = store.readAllEntries()
  const byId = new Map(all.map((entry) => [entry.id, entry]))
  const pending = store.pendingQueue()
  const existingStatements = all.filter((entry) => entry.status !== 'forgotten').map((entry) => entry.statement)
  const pendingStatements = pending.map((item) => item.statement || '')
  const today = now.toISOString().slice(0, 10)
  const stamp = nowIso().replace(/[-:T.Z]/g, '').slice(0, 12)
  const episodes = []
  const queueItems = []
  const skipped = []

  for (const op of ops) {
    if (op.op === 'add') {
      const statement = op.statement
      if (!statement) {
        skipped.push('add 缺 statement')
        continue
      }
      if (
        existingStatements.some((known) => normStatement(known) === normStatement(statement) || similarity(known, statement) >= 0.86) ||
        pendingStatements.some((known) => similarity(known, statement) >= 0.86)
      ) {
        skipped.push(`已存在相似记忆：${trunc(statement, 40)}`)
        continue
      }
      if (op.kind === 'episode' && autoEpisodes) {
        episodes.push({
          id: `ep_${stamp}_${hashString(statement).slice(0, 4)}`,
          kind: 'episode',
          scope: 'persona',
          status: 'active',
          confidence: op.confidence,
          statement,
          evidence: [{ source: 'curator:llm', quote: trunc(statement, 120) }],
          created_at: today,
        })
        continue
      }
      queueItems.push({
        id: `rv_${stamp}_${hashString(statement).slice(0, 4)}`,
        at: nowIso(),
        status: 'pending',
        op: 'add',
        kind: op.kind,
        statement,
        confidence: op.confidence,
        reason: op.reason || 'curator 提议',
        source: 'curator',
        target_id: undefined,
      })
      continue
    }

    const target = byId.get(op.target_id)
    if (!target) {
      skipped.push(`目标不存在：${op.target_id}`)
      continue
    }
    if (target.kind === 'episode' && op.op === 'forget') {
      // 情节卡遗忘也走审核（避免误删）
    }
    queueItems.push({
      id: `rv_${stamp}_${hashString(`${op.op}:${op.target_id}`).slice(0, 4)}`,
      at: nowIso(),
      status: 'pending',
      op: op.op,
      kind: op.kind || target.kind,
      statement: op.statement || trunc(target.statement, 200),
      confidence: op.confidence,
      reason: op.reason || `curator 提议 ${op.op}`,
      source: 'curator',
      target_id: op.target_id,
      target_snapshot: {
        id: target.id,
        kind: target.kind,
        status: target.status,
        confidence: target.confidence,
        statement: trunc(target.statement, 200),
        pinned: target.pinned === true,
      },
    })
  }
  return { episodes, queueItems, skipped }
}

/**
 * 真正调模型。llm 是 ctx.get('llm')（可选），selection={provider, model}。
 * 返回 {ok:true, text} / {ok:false, error}；失败不抛，交给调用方降级。
 */
export async function callCuratorModel({ llm, selection, input, timeoutMs = 45000, log = () => {}, system = CURATOR_SYSTEM_PROMPT, maxTokens = 1200 }) {
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm 服务不可用' }
  if (!selection?.provider || !selection?.model) return { ok: false, error: '没有可用的 curator 模型（provider/model 未配置）' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('curator 超时')), timeoutMs)
  try {
    const messages = buildCuratorMessages(input)
    let text = ''
    let reasoningChars = 0
    let finishKind = ''
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      system,
      messages,
      maxTokens,
      temperature: 0.2,
      signal: controller.signal,
    })) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') text += chunk.text || ''
      if (chunk.type === 'reasoning-delta') reasoningChars += String(chunk.text || '').length
      if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        finishKind = kind || ''
        if (kind === 'error' || kind === 'aborted') {
          return { ok: false, error: `模型返回 ${kind}：${chunk.reason?.failure?.message || ''}` }
        }
      }
    }
    if (!text.trim()) {
      return {
        ok: false,
        error: `模型没有返回正文（finish=${finishKind || '?'}，reasoning ${reasoningChars} 字；可能是 maxTokens=${maxTokens} 全用在推理上了）`,
      }
    }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
  }
}

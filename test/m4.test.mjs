/**
 * 鱼缸 · 语义冲突判断 + safe 自动处理
 * 运行：node --test test/m1.test.mjs test/m15.test.mjs test/m2.test.mjs test/m3.test.mjs test/m4.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/store.mjs'
import { CURATOR_SYSTEM_PROMPT, buildCuratorInput, decideConflictAction, planCuratorOps, validateCuratorOutput } from '../lib/curator.mjs'
import { MINE_SYSTEM_PROMPT } from '../lib/migrate.mjs'
import { apply } from '../index.js'

function entry(overrides = {}) {
  return {
    id: `rel_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'preference',
    scope: 'persona',
    status: 'active',
    confidence: 0.9,
    created_at: '2026-10-01',
    updated_at: '2026-10-01',
    statement: '用户喜欢冰美式',
    evidence: [{ source: 'test', quote: '用户喜欢冰美式' }],
    supersedes: [],
    conflicts_with: [],
    pinned: false,
    ...overrides,
  }
}

function makeStore(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-m4-'))
  const store = new Store({ dir, persona: 'test', log: () => {} })
  store.ensurePersona()
  for (const item of overrides.entries || []) store.addEntry(item)
  return { dir, store }
}

// ---------------------------------------------------------------------------
// prompt 细节（从 mem0 借鉴：时间锚定 / 自包含）
// ---------------------------------------------------------------------------

test('prompt：curator 与旧会话提炼都要求时间锚定 + 自包含', () => {
  for (const prompt of [CURATOR_SYSTEM_PROMPT, MINE_SYSTEM_PROMPT]) {
    assert.match(prompt, /时间锚定/)
    assert.match(prompt, /自包含/)
    assert.match(prompt, /具体日期/)
  }
  const input = buildCuratorInput({ persona: 'p', now: new Date('2026-06-15T00:00:00.000Z'), existing: [], journal: [] })
  assert.equal(input.now, '2026-06-15T00:00:00.000Z')
  assert.match(input.task, /时间一律锚定成具体日期/)
})

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

test('conflict policy：safe / balanced / off 与身份保护', () => {
  const target = entry({ id: 'rel_target' })
  const ctx = { target, confidence: 0.9 }
  assert.equal(decideConflictAction({ ...ctx, relation: 'duplicate', kind: 'preference', mode: 'safe' }), 'ignore')
  assert.equal(decideConflictAction({ ...ctx, relation: 'refine', kind: 'preference', mode: 'safe' }), 'auto')
  assert.equal(decideConflictAction({ ...ctx, relation: 'constrain', kind: 'context', mode: 'safe' }), 'auto')
  assert.equal(decideConflictAction({ ...ctx, relation: 'correct', kind: 'preference', mode: 'safe' }), 'auto')
  assert.equal(decideConflictAction({ ...ctx, relation: 'supersede', kind: 'preference', mode: 'safe' }), 'review')
  assert.equal(decideConflictAction({ ...ctx, relation: 'supersede', kind: 'preference', mode: 'balanced' }), 'auto')
  assert.equal(decideConflictAction({ ...ctx, relation: 'supersede', kind: 'preference', mode: 'off' }), 'review')
  assert.equal(decideConflictAction({ ...ctx, relation: 'refine', kind: 'boundary', mode: 'balanced' }), 'review')
  assert.equal(decideConflictAction({ ...ctx, relation: 'refine', kind: 'preference', mode: 'off' }), 'review')
  assert.equal(
    decideConflictAction({ relation: 'supersede', kind: 'preference', target: entry({ pinned: true }), confidence: 0.99, mode: 'balanced' }),
    'review',
  )
  assert.equal(decideConflictAction({ ...ctx, relation: 'refine', kind: 'preference', mode: 'safe', confidence: 0.7 }), 'review')
})

test('curator 校验：add 带 relation 必须有 target_id', () => {
  const withTarget = validateCuratorOutput({
    noop: false,
    ops: [{ op: 'add', kind: 'preference', statement: '用户现在不喝咖啡了', relation: 'supersede', target_id: 'rel_1', confidence: 0.9 }],
  })
  assert.equal(withTarget.ok, true)
  assert.equal(withTarget.value.ops[0].relation, 'supersede')
  assert.equal(withTarget.value.ops[0].target_id, 'rel_1')

  const missingTarget = validateCuratorOutput({
    noop: false,
    ops: [{ op: 'add', kind: 'preference', statement: '用户现在不喝咖啡了', relation: 'supersede' }],
  })
  assert.equal(missingTarget.ok, false)

  const badRelation = validateCuratorOutput({
    noop: false,
    ops: [{ op: 'add', kind: 'preference', statement: 'x', relation: 'explode', target_id: 'rel_1' }],
  })
  assert.equal(badRelation.ok, false)
})

test('planCuratorOps：safe 下 refine/constrain 自动，supersede 进审核', () => {
  const { dir, store } = makeStore({ entries: [entry({ id: 'rel_coffee' })] })
  try {
    const refine = planCuratorOps({
      store,
      ops: [{ op: 'add', kind: 'preference', statement: '用户喜欢冰美式（只喝冰的）', relation: 'refine', target_id: 'rel_coffee', confidence: 0.9 }],
      now: new Date('2026-10-31T00:00:00.000Z'),
      mode: 'safe',
    })
    assert.equal(refine.autoItems.length, 1)
    assert.equal(refine.queueItems.length, 0)

    const supersede = planCuratorOps({
      store,
      ops: [{ op: 'add', kind: 'preference', statement: '用户现在不喝咖啡了', relation: 'supersede', target_id: 'rel_coffee', confidence: 0.9 }],
      now: new Date('2026-10-31T00:00:00.000Z'),
      mode: 'safe',
    })
    assert.equal(supersede.autoItems.length, 0)
    assert.equal(supersede.queueItems.length, 1)
    assert.equal(supersede.queueItems[0].relation, 'supersede')
    assert.equal(supersede.queueItems[0].target_snapshot.statement, '用户喜欢冰美式')

    const balanced = planCuratorOps({
      store,
      ops: [{ op: 'add', kind: 'preference', statement: '用户现在不喝咖啡了', relation: 'supersede', target_id: 'rel_coffee', confidence: 0.9 }],
      now: new Date('2026-10-31T00:00:00.000Z'),
      mode: 'balanced',
    })
    assert.equal(balanced.autoItems.length, 1)

    const duplicate = planCuratorOps({
      store,
      ops: [{ op: 'add', kind: 'preference', statement: '用户喜欢冰美式', relation: 'duplicate', target_id: 'rel_coffee', confidence: 0.9 }],
      now: new Date('2026-10-31T00:00:00.000Z'),
      mode: 'safe',
    })
    assert.equal(duplicate.autoItems.length, 0)
    assert.equal(duplicate.queueItems.length, 0)
    assert.equal(duplicate.skipped.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// apply harness：真实链路（fake LLM）+ 撤销 + 读侧标注
// ---------------------------------------------------------------------------

function createSession(id, cwd) {
  return {
    id,
    header: { cwd },
    seq: 0,
    events: [],
    push(event) {
      this.events.push(event)
      this.seq = this.events.length
    },
    snapshotEvents(from = 0, to = this.seq) {
      return this.events.slice(from, to)
    },
    deriveMessages() {
      return []
    },
    deriveEventMessage() {
      return null
    },
  }
}

function createScopedAgent(id) {
  const sections = []
  const contexts = []
  const scoped = {
    effect(fn) {
      const ret = fn()
      const disposers = []
      if (ret && typeof ret.next === 'function') {
        let step = ret.next()
        while (!step.done) {
          if (typeof step.value === 'function') disposers.push(step.value)
          step = ret.next()
        }
        return () => disposers.forEach((dispose) => dispose())
      }
      return typeof ret === 'function' ? ret : () => {}
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      context(context) {
        contexts.push(context)
        return () => {
          const index = contexts.indexOf(context)
          if (index >= 0) contexts.splice(index, 1)
        }
      },
    },
  }
  return { agent: { id, ctx: scoped }, sections, contexts }
}

function createHarness({ home, rawConfig, llm, sessionQuery }) {
  const listeners = new Map()
  const commands = new Map()
  const routes = []
  const sessions = new Map()
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return (...segments) => join(home, ...segments)
      if (name === 'llm') return llm
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(callback)
      return () => {}
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    sessions: { get: (id) => sessions.get(id) },
    agents: { list: () => [] },
  }
  const callRoute = async (method, url, body) => {
    const route = routes.find((item) => item.path === '/api/fishbowl')
    assert.ok(route)
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      end(payload) {
        if (payload !== undefined) this.body = String(payload)
      },
    }
    const req = { method, url }
    req[Symbol.asyncIterator] = async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    }
    await route.handler(req, res)
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
  }
  const emit = (name, ...args) => {
    for (const callback of listeners.get(name) || []) callback(...args)
  }
  return { ctx, emit, commands, routes, sessions, callRoute }
}

test('apply：safe 自动 refine/constrain、supersede 进审核、可撤销、读侧带日期', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fishbowl-m4-apply-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  let nextOps = []
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify(nextOps.length ? { noop: false, ops: nextOps } : { noop: true }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const rawConfig = {
    persona: 'm4persona',
    scope: 'workspace',
    enabledWorkspaces: [workspace],
    defaultMode: 'full',
    autoConsolidate: false,
    curatorUseLlm: true,
    curatorMinJournalLines: 0,
    conflictAutoMode: 'safe',
    conflictAutoMinConfidence: 0.85,
    gitEnabled: true,
  }
  try {
    const harness = createHarness({ home, rawConfig, llm: fakeLlm })
    apply(harness.ctx, rawConfig)
    const personaDir = join(home, 'persona', 'm4persona')
    const journal = join(personaDir, 'journal', '2026-10-31.jsonl')
    const writeJournal = (text) =>
      appendFileSync(
        journal,
        `${JSON.stringify({
          at: '2026-10-31T01:00:00.000Z',
          session: 's1',
          user: [{ seq: 1, text }],
          assistant: [{ seq: 2, text: '好' }],
          candidates: [],
        })}\n`,
      )

    // 先手动写一条记忆（/remember 命令）
    const session = createSession('session-m4', workspace)
    harness.sessions.set('session-m4', session)
    const agent = { id: 'session-m4' }
    const remembered = await harness.commands.get('remember').handler({ agent, rawInput: '用户喜欢冰美式' })
    assert.equal(remembered.kind, 'success')
    let status = await harness.callRoute('GET', '/api/fishbowl/status')
    const coffee = status.json.recent.find((item) => item.statement.includes('冰美式'))

    // refine：safe → 自动改 statement
    nextOps = [
      { op: 'add', kind: 'preference', statement: '用户喜欢冰美式（只喝冰的）', relation: 'refine', target_id: coffee.id, confidence: 0.9, reason: '补充细节' },
    ]
    writeJournal('用户说只喝冰的咖啡')
    let run = await harness.callRoute('POST', '/api/fishbowl/consolidate', {})
    assert.equal(run.status, 200)
    assert.equal(run.json.consolidated.curator.auto, 1)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.equal(status.json.recent.find((item) => item.id === coffee.id).statement, '用户喜欢冰美式（只喝冰的）')
    const refineAction = status.json.conflict.autoActions.find((action) => action.relation === 'refine')
    assert.ok(refineAction)
    assert.equal(refineAction.status, 'active')

    // 撤销 refine
    const undone = await harness.callRoute('POST', '/api/fishbowl/auto-log', { id: refineAction.id, action: 'undo' })
    assert.equal(undone.status, 200)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.equal(status.json.recent.find((item) => item.id === coffee.id).statement, '用户喜欢冰美式')
    assert.equal(status.json.conflict.autoActions.find((action) => action.id === refineAction.id).status, 'undone')

    // constrain：safe → 自动新增约束并互相建立 conflicts_with
    nextOps = [
      { op: 'add', kind: 'context', statement: '用户胃不好，医生建议近期少喝咖啡', relation: 'constrain', target_id: coffee.id, confidence: 0.9, reason: '约束不是取代' },
    ]
    writeJournal('用户说胃不好，医生建议少喝咖啡')
    run = await harness.callRoute('POST', '/api/fishbowl/consolidate', {})
    assert.equal(run.status, 200)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    const boundary = status.json.recent.find((item) => item.statement.includes('医生建议'))
    assert.ok(boundary, '约束条目已自动写入')
    // 两条都还在 active；关系里能查到链接（通过 /why 或 entry 渲染）
    const relationshipMd = readFileSync(join(personaDir, 'relationship.md'), 'utf8')
    assert.match(relationshipMd, /conflicts_with:/)
    assert.match(relationshipMd, /医生建议近期少喝咖啡/)

    // supersede：safe → 进审核队列，不自动改
    nextOps = [
      { op: 'add', kind: 'preference', statement: '用户现在不喝咖啡了', relation: 'supersede', target_id: coffee.id, confidence: 0.9, reason: '情况变化' },
    ]
    writeJournal('用户说现在不喝咖啡了')
    run = await harness.callRoute('POST', '/api/fishbowl/consolidate', {})
    assert.equal(run.status, 200)
    assert.equal(run.json.consolidated.curator.auto, 0)
    assert.ok(run.json.consolidated.curator.queued >= 1)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    const proposal = status.json.review.queue.find((item) => item.relation === 'supersede' && item.target_snapshot?.id === coffee.id)
    assert.ok(proposal, 'supersede 提议在审核队列')
    // 审核通过后才取代
    const approved = await harness.callRoute('POST', '/api/fishbowl/review', { id: proposal.id, action: 'approve' })
    assert.equal(approved.status, 200)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.ok(!status.json.recent.some((item) => item.id === coffee.id), '旧条目不在了 active')
    assert.ok(status.json.recent.some((item) => item.statement.includes('现在不喝咖啡了')))

    // 读侧标注：喂给模型的召回/摘要带日期与优先级规则
    const scoped = createScopedAgent('session-readside')
    harness.sessions.set('session-readside', createSession('session-readside', workspace))
    harness.emit('agent/created', { agent: scoped.agent, source: 'startup' })
    const summary = scoped.sections.find((section) => section.name === 'fishbowl:relationship')
    assert.ok(summary, '关系摘要 section 已注册')
    const summaryText = summary.text()
    assert.match(summaryText, /以更新时间较新的为准/)
    assert.match(summaryText, /· 2026-/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

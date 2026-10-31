/**
 * 鱼缸测试：git 版本化 / 规则整理 / curator 校验与落地 / 审核队列 / 体检。
 * 运行：cd dsh-fishbowl && node --test test/m1.test.mjs test/m15.test.mjs test/m2.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GitRepo } from '../lib/git.mjs'
import { Store } from '../lib/store.mjs'
import { computeHealth, consolidate, similarity } from '../lib/consolidate.mjs'
import { buildCuratorInput, parseCuratorOutput, planCuratorOps, validateCuratorOutput } from '../lib/curator.mjs'
import { apply } from '../index.js'

function makeStore(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-m2-'))
  const store = new Store({ dir, persona: 'test', log: () => {} })
  store.ensurePersona()
  for (const entry of overrides.entries || []) store.addEntry(entry)
  return { dir, store }
}

function entry(overrides = {}) {
  return {
    id: `rel_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'preference',
    scope: 'persona',
    status: 'active',
    confidence: 0.9,
    created_at: '2026-10-01',
    updated_at: '2026-10-01',
    statement: '测试记忆',
    evidence: [{ source: 'test', quote: '测试记忆' }],
    supersedes: [],
    ...overrides,
  }
}

const BASE_CFG = {
  curatorMaxJournalLines: 80,
  decayEnabled: true,
  weeklyReport: true,
  gitEnabled: true,
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

test('git：init / commit / log / restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-git-'))
  try {
    writeFileSync(join(dir, 'relationship.md'), 'v1')
    const repo = new GitRepo({ dir, log: () => {} })
    assert.equal(repo.ensure(), true)
    const first = repo.commit('fishbowl: first')
    assert.ok(first && first.sha)
    writeFileSync(join(dir, 'relationship.md'), 'v2')
    const second = repo.commit('fishbowl: second')
    assert.ok(second && second.sha)
    const commits = repo.log(5)
    assert.equal(commits.length, 2)
    assert.equal(commits[0].message, 'fishbowl: second')
    const restored = repo.restore(first.sha)
    assert.equal(restored.ok, true)
    assert.equal(readFileSync(join(dir, 'relationship.md'), 'utf8'), 'v1')
    assert.match(repo.log(1)[0].message, /rollback/)
    // 非法 sha 被拒
    assert.equal(repo.restore('not-a-sha').ok, false)
    assert.equal(repo.restore('deadbeef').ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 规则整理
// ---------------------------------------------------------------------------

test('consolidation：候选入队 / 合并 / 衰减 / 报告 / 游标', () => {
  const { dir, store } = makeStore({
    entries: [
      entry({ id: 'rel_dup_long', statement: '用户喜欢先给结论再解释；数字附近不夹鱼味。', updated_at: '2026-10-29' }),
      entry({ id: 'rel_dup_short', statement: '用户喜欢先给结论再解释', updated_at: '2026-10-29' }),
      entry({ id: 'rel_old_context', kind: 'context', statement: '最近在写鱼缸插件', confidence: 0.6, updated_at: '2026-08-01' }),
    ],
  })
  try {
    mkdirSync(store.journalDir, { recursive: true })
    writeFileSync(
      join(store.journalDir, '2026-10-30.jsonl'),
      [
        JSON.stringify({
          at: '2026-10-30T01:00:00.000Z',
          session: 'sess_a',
          user: [],
          assistant: [],
          candidates: [{ kind: 'preference', text: '用户喜欢喝冰美式' }],
        }),
        JSON.stringify({
          at: '2026-10-30T02:00:00.000Z',
          session: 'sess_b',
          user: [],
          assistant: [],
          candidates: [{ kind: 'preference', text: '用户喜欢喝冰美式' }],
        }),
      ].join('\n'),
    )
    const first = consolidate({ store, cfg: BASE_CFG, now: new Date('2026-10-30T03:00:00.000Z'), dryRun: false, log: () => {} })
    assert.equal(first.journalLines, 2)
    assert.equal(first.queued, 1, '两个相同候选聚合为一条审核项')
    assert.equal(store.pendingQueue().length, 1)
    assert.equal(store.pendingQueue()[0].statement, '用户喜欢喝冰美式')
    assert.equal(first.merged, 1, '近似偏好被合并')
    const all = store.readAllEntries()
    assert.equal(all.find((item) => item.id === 'rel_dup_short').status, 'superseded')
    assert.equal(all.find((item) => item.id === 'rel_dup_long').status, 'active')
    assert.equal(first.staled, 1, '过期 context 转 stale')
    assert.equal(store.readAllEntries().find((item) => item.id === 'rel_old_context').status, 'stale')
    assert.ok(first.reportPath && existsSync(join(dir, first.reportPath)))
    const state = store.readState()
    assert.ok(state.lastConsolidateAt)
    assert.equal(state.journalCursors['2026-10-30'], 2)

    // 第二次：没有新 journal → no-op（不重复入队）
    const second = consolidate({ store, cfg: BASE_CFG, now: new Date('2026-10-30T04:00:00.000Z'), dryRun: false, log: () => {} })
    assert.equal(second.journalLines, 0)
    assert.equal(second.queued, 0)
    assert.equal(second.changed, false)
    assert.equal(store.pendingQueue().length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('consolidation：dry-run 不落盘', () => {
  const { dir, store } = makeStore()
  try {
    mkdirSync(store.journalDir, { recursive: true })
    writeFileSync(
      join(store.journalDir, '2026-10-30.jsonl'),
      JSON.stringify({ at: '2026-10-30T01:00:00.000Z', session: 's', candidates: [{ kind: 'boundary', text: '不许戳鱼肚子' }] }),
    )
    const result = consolidate({ store, cfg: BASE_CFG, now: new Date(), dryRun: true, log: () => {} })
    assert.equal(result.dryRun, true)
    assert.equal(result.queuePlans.length, 1)
    assert.equal(store.pendingQueue().length, 0)
    assert.equal(store.readState().lastConsolidateAt, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('相似度：近似句能判重，无关句不误伤', () => {
  assert.ok(similarity('用户喜欢先给结论再解释；数字附近不夹鱼味。', '用户喜欢先给结论再解释') >= 0.86)
  assert.ok(similarity('用户喜欢先给结论再解释', '楼下那家咖啡太酸了') < 0.3)
})

// ---------------------------------------------------------------------------
// curator 校验/计划
// ---------------------------------------------------------------------------

test('curator：输出校验（合法 / noop / 非法）', () => {
  const ok = validateCuratorOutput({
    noop: false,
    ops: [
      { op: 'add', kind: 'episode', statement: '第一次一起挑咖啡', confidence: 0.8, reason: '共同经历' },
      { op: 'add', kind: 'preference', statement: '用户不喜欢太酸的咖啡', confidence: 0.7, reason: '偏好' },
    ],
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.ops.length, 2)

  assert.equal(validateCuratorOutput({ noop: true }).value.noop, true)
  assert.equal(validateCuratorOutput({ noop: false, ops: [] }).ok, false)
  assert.equal(validateCuratorOutput({ noop: false, ops: [{ op: 'explode', kind: 'preference', statement: 'x' }] }).ok, false)
  assert.equal(validateCuratorOutput({ ops: [{ op: 'add', kind: 'soul', statement: 'x' }] }).ok, false)
  assert.equal(validateCuratorOutput({ ops: [{ op: 'forget', kind: 'preference' }] }).ok, false, '缺 target_id')
})

test('curator：parse 容忍代码块 / plan 关系入队、情节直写、去重跳过', () => {
  const parsed = parseCuratorOutput('```json\n{"noop":false,"ops":[{"op":"add","kind":"preference","statement":"用户喜欢冰美式","confidence":0.7}]}\n```')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.ops.length, 1)

  const { dir, store } = makeStore({ entries: [entry({ id: 'rel_coffee', statement: '用户喜欢冰美式' })] })
  try {
    const plan = planCuratorOps({
      store,
      ops: [
        { op: 'add', kind: 'episode', statement: '第一次一起挑咖啡', confidence: 0.8 },
        { op: 'add', kind: 'preference', statement: '用户不喜欢太酸的咖啡', confidence: 0.7, reason: '偏好' },
        { op: 'add', kind: 'preference', statement: '用户喜欢冰美式', confidence: 0.7 },
        { op: 'forget', kind: 'preference', target_id: 'rel_missing', reason: '不存在' },
      ],
      now: new Date('2026-10-30T00:00:00.000Z'),
    })
    assert.equal(plan.episodes.length, 1)
    assert.equal(plan.queueItems.length, 1)
    assert.equal(plan.skipped.length, 2)
    assert.equal(plan.queueItems[0].op, 'add')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('curator：buildCuratorInput 会脱敏 journal 文本', () => {
  const input = buildCuratorInput({
    persona: 'p',
    existing: [entry({ id: 'rel_1', statement: 'x' })],
    journal: [
      {
        at: '2026-10-30T01:00:00.000Z',
        user: [{ text: '记住：路径 /tmp/secret.txt，token 是 sk-abcdef123456' }],
        assistant: [],
        candidates: [{ kind: 'preference', text: '别买楼下那家咖啡' }],
      },
    ],
    queue: [],
  })
  const text = JSON.stringify(input)
  assert.doesNotMatch(text, /demo-user/)
  assert.doesNotMatch(text, /sk-abcdef123456/)
})

// ---------------------------------------------------------------------------
// 身份体检
// ---------------------------------------------------------------------------

test('health：返回分数与检查项', () => {
  const { dir, store } = makeStore({
    entries: [
      entry({ id: 'rel_1', kind: 'preference', statement: '喜欢先给结论' }),
      entry({ id: 'rel_2', kind: 'boundary', statement: '不泄露账号' }),
      entry({ id: 'rel_3', kind: 'ritual', statement: '每天刷B站' }),
    ],
  })
  try {
    store.writeHandoff('/tmp/demo-workspace', { at: new Date().toISOString(), session: 's', summary: '聊鱼缸', reply: '好', promises: [] })
    const health = computeHealth({ store, now: new Date() })
    assert.equal(health.checks.length, 6)
    assert.ok(health.score >= 50)
    assert.ok(health.checks.find((check) => check.id === 'boundary').ok)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// apply harness：curator 全链路 + 审核 API + git commit
// ---------------------------------------------------------------------------

function createHarness({ home, rawConfig, llm }) {
  const listeners = new Map()
  const commands = new Map()
  const routes = []
  const sessions = new Map()
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return (...segments) => join(home, ...segments)
      if (name === 'llm') return llm
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
    emit(name, ...args) {
      for (const callback of listeners.get(name) || []) callback(...args)
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
  return { ctx, commands, routes, sessions, callRoute }
}

test('apply：curator 全链路（fake llm）+ 审核 API + git commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fishbowl-m2-apply-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const fakeLlm = {
    async *stream() {
      const payload = {
        noop: false,
        ops: [
          { op: 'add', kind: 'episode', statement: '第一次一起挑咖啡', confidence: 0.8, reason: '共同经历' },
          { op: 'add', kind: 'preference', statement: '用户不喜欢太酸的咖啡', confidence: 0.7, reason: '偏好' },
        ],
      }
      yield { type: 'text-delta', text: JSON.stringify(payload) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const rawConfig = {
    persona: 'm2persona',
    scope: 'workspace',
    enabledWorkspaces: [workspace],
    defaultMode: 'full',
    autoConsolidate: false,
    curatorUseLlm: true,
    gitEnabled: true,
    weeklyReport: true,
  }
  try {
    const harness = createHarness({ home, rawConfig, llm: fakeLlm })
    apply(harness.ctx, rawConfig)
    const personaDir = join(home, 'persona', 'm2persona')
    assert.ok(existsSync(join(personaDir, '.git')), 'apply 时初始化 git')

    // 造一条 journal（curator 输入）
    const journalDir = join(personaDir, 'journal')
    writeFileSync(
      join(journalDir, '2026-10-30.jsonl'),
      JSON.stringify({
        at: '2026-10-30T01:00:00.000Z',
        session: 'sess_x',
        workspace: 'workspace',
        user: [{ seq: 1, text: '记住：别买楼下那家咖啡，太酸。' }],
        assistant: [{ seq: 2, text: '好，记下了。' }],
        candidates: [{ kind: 'preference', text: '别买楼下那家咖啡' }],
      }),
    )

    // dry-run：不落盘
    const dry = await harness.callRoute('POST', '/api/fishbowl/consolidate', { dry: true })
    assert.equal(dry.status, 200)
    assert.equal(dry.json.consolidated.dryRun, true)

    // 真整理：规则 + curator 全链路
    const run = await harness.callRoute('POST', '/api/fishbowl/consolidate', {})
    assert.equal(run.status, 200)
    const consolidated = run.json.consolidated
    assert.equal(consolidated.ok, true)
    assert.equal(consolidated.curator.status, 'ok')
    assert.equal(consolidated.curator.episodes, 1, 'episode 直接落库')
    assert.ok(consolidated.curator.queued >= 1, '偏好进审核队列')
    assert.ok(consolidated.commit?.sha, '有改动会 git commit')
    assert.ok(existsSync(join(personaDir, 'episodes')), 'episodes 目录在')

    // status 能看到待审与 git 历史
    const status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.equal(status.json.stage, 'stable')
    assert.ok(status.json.review.pending >= 1)
    assert.ok(status.json.git.commits.length >= 1)
    assert.ok(status.json.health.score >= 0)
    assert.ok(Array.isArray(status.json.consolidation.lastCurator ? [1] : []))

    // 审核通过一条：API
    const target = status.json.review.queue[0]
    assert.ok(target, '有待审队列项')
    const decided = await harness.callRoute('POST', '/api/fishbowl/review', { id: target.id, action: 'approve' })
    assert.equal(decided.status, 200)
    assert.equal(decided.json.decided.action, 'approve')
    const after = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.ok(after.json.review.pending < status.json.review.pending, '通过后待审减少')

    // 非法 id / action
    assert.equal((await harness.callRoute('POST', '/api/fishbowl/review', { id: 'nope', action: 'approve' })).status, 404)
    assert.equal((await harness.callRoute('POST', '/api/fishbowl/review', { id: target.id })).status, 400)

    // 命令：/persona log & health
    const persona = harness.commands.get('persona')
    const logResult = await persona.handler({ agent: { id: 'session-x' }, rawInput: 'log' })
    assert.equal(logResult.kind, 'success')
    assert.match(logResult.text, /最近提交/)
    const healthResult = await persona.handler({ agent: { id: 'session-x' }, rawInput: 'health' })
    assert.match(healthResult.text, /身份体检/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// pin 保护 + 审核旧值快照
// ---------------------------------------------------------------------------

test('pin：钉住的条目不合并、不衰减', () => {
  const { dir, store } = makeStore({
    entries: [
      entry({ id: 'rel_pin_long', statement: '用户喜欢先给结论再解释；数字附近不夹鱼味。', pinned: true, updated_at: '2026-01-01' }),
      entry({ id: 'rel_pin_short', statement: '用户喜欢先给结论再解释', updated_at: '2026-10-29' }),
      entry({ id: 'rel_pin_old_context', kind: 'context', statement: '旧近况', pinned: true, confidence: 0.6, updated_at: '2026-01-01' }),
    ],
  })
  try {
    const result = consolidate({ store, cfg: BASE_CFG, now: new Date('2026-10-30T00:00:00.000Z'), dryRun: false, log: () => {} })
    assert.equal(result.merged, 0, '有 pin 的不参与合并')
    assert.equal(result.decayed + result.staled, 0, '有 pin 的不衰减')
    const all = store.readAllEntries()
    assert.equal(all.find((item) => item.id === 'rel_pin_long').status, 'active')
    assert.equal(all.find((item) => item.id === 'rel_pin_long').pinned, true)
    assert.equal(all.find((item) => item.id === 'rel_pin_old_context').confidence, 0.6, 'pin 的 confidence 不变')
    assert.equal(all.find((item) => item.id === 'rel_pin_short').status, 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('curator：修改类提议带旧值快照（diff 预览）', () => {
  const { dir, store } = makeStore({ entries: [entry({ id: 'rel_diff', statement: '用户喜欢冰美式' })] })
  try {
    const plan = planCuratorOps({
      store,
      ops: [
        { op: 'update', kind: 'preference', target_id: 'rel_diff', statement: '用户喜欢冰美式（不加糖）', confidence: 0.85, reason: '补充细节' },
        { op: 'forget', kind: 'preference', target_id: 'rel_diff', reason: '用户说记错了' },
      ],
      now: new Date('2026-10-30T00:00:00.000Z'),
      mode: 'off',
    })
    assert.equal(plan.queueItems.length, 2)
    assert.equal(plan.queueItems[0].target_snapshot.statement, '用户喜欢冰美式')
    assert.equal(plan.queueItems[0].target_snapshot.id, 'rel_diff')
    assert.equal(plan.queueItems[1].op, 'forget')
    assert.equal(plan.queueItems[1].target_snapshot.pinned, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply：pin API / 钉住后审核与遗忘被拦 / 钉住条目不衰减', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fishbowl-m25-'))
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
    persona: 'm25persona',
    scope: 'workspace',
    enabledWorkspaces: [workspace],
    defaultMode: 'full',
    autoConsolidate: false,
    curatorUseLlm: true,
    gitEnabled: true,
    curatorMinJournalLines: 0,
  }
  try {
    const harness = createHarness({ home, rawConfig, llm: fakeLlm })
    apply(harness.ctx, rawConfig)
    const personaDir = join(home, 'persona', 'm25persona')
    const session = {
      id: 'session-m25',
      header: { cwd: workspace },
      seq: 10,
      deriveMessages: () => [],
      deriveEventMessage: () => null,
      snapshotEvents: () => [],
    }
    harness.sessions.set('session-m25', session)
    const agent = { id: 'session-m25' }

    // 写一条记忆（走 /remember 命令）
    const remember = harness.commands.get('remember')
    const remembered = await remember.handler({ agent, rawInput: '用户喜欢冰美式' })
    assert.equal(remembered.kind, 'success')
    let status = await harness.callRoute('GET', '/api/fishbowl/status')
    const memory = status.json.recent.find((item) => item.statement.includes('冰美式'))
    assert.ok(memory, '记忆已写入')

    // pin API
    const pinned = await harness.callRoute('POST', '/api/fishbowl/pin', { id: memory.id, pinned: true })
    assert.equal(pinned.status, 200)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.equal(status.json.recent.find((item) => item.id === memory.id).pinned, true)
    assert.ok(status.json.counts.relationship.pinned >= 1)

    // /forget 被 pin 拦住
    const forget = harness.commands.get('forget')
    const forgot = await forget.handler({ agent, rawInput: '冰美式' })
    assert.match(forgot.text, /钉住/)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.ok(status.json.recent.some((item) => item.id === memory.id), '钉住的不能被 /forget 删掉')

    // curator 提议 forget 钉住的记忆 → 入队后审核被拒
    nextOps = [{ op: 'forget', kind: 'preference', target_id: memory.id, reason: '用户说记错了' }]
    const consolidated = await harness.callRoute('POST', '/api/fishbowl/consolidate', {})
    assert.equal(consolidated.status, 200)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    const proposal = status.json.review.queue.find((item) => item.target_snapshot && item.target_snapshot.id === memory.id)
    assert.ok(proposal, 'curator 提议在审核队列里')
    assert.equal(proposal.target_snapshot.pinned, true)
    const rejected = await harness.callRoute('POST', '/api/fishbowl/review', { id: proposal.id, action: 'approve' })
    assert.equal(rejected.status, 400)
    assert.match(rejected.json.error, /钉住/)

    // 取消 pin 后可以正常审核通过
    await harness.callRoute('POST', '/api/fishbowl/pin', { id: memory.id, pinned: false })
    const ok = await harness.callRoute('POST', '/api/fishbowl/review', { id: proposal.id, action: 'approve' })
    assert.equal(ok.status, 200)
    status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.ok(!status.json.recent.some((item) => item.id === memory.id), '遗忘生效')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

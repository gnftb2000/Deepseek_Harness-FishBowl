/**
 * 鱼缸测试：搬家导入导出 + 旧会话提炼 + curator 成本门。
 * 运行：node --test test/m1.test.mjs test/m15.test.mjs test/m2.test.mjs test/m3.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/store.mjs'
import { planCuratorOps } from '../lib/curator.mjs'
import {
  buildExport,
  buildMineInput,
  buildTranscript,
  detectMemoryFormat,
  parseMarkdownMemory,
  parseMemoryFile,
  parseSurfcoreMemory,
  prepareExportParent,
} from '../lib/migrate.mjs'
import { apply } from '../index.js'

function makeStore(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-m3-'))
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

// ---------------------------------------------------------------------------
// 导入解析
// ---------------------------------------------------------------------------

test('migrate：markdown 解析 + 标题推 kind + 去重 + 脱敏', () => {
  const md = [
    '# 用户偏好',
    '- 喜欢先给结论再解释',
    '- 喜欢先给结论再解释', // 重复
    '## 雷区',
    '- 不许提烟味 /tmp/secret.txt',
    '## 每天的习惯',
    '- 每天 22 点收工',
    '> 引用不算',
  ].join('\n')
  const items = parseMarkdownMemory(md, { source: 'MEMORY.md' })
  assert.equal(items.length, 3)
  assert.equal(items[0].kind, 'preference')
  assert.equal(items[1].kind, 'boundary')
  assert.match(items[1].statement, /\[已脱敏:路径\]/, '路径被脱敏')
  assert.equal(items[2].kind, 'ritual')
})

test('migrate：SurfCore JSON 卡片解析 + auto 检测', () => {
  const json = JSON.stringify({
    cards: [
      { text: '用户喜欢冰美式', kind: 'preference' },
      { content: '不许半夜发消息', category: '边界' },
      { summary: '一起挑过咖啡豆', type: 'episode' },
    ],
  })
  const items = parseSurfcoreMemory(json, { source: 'surfcore/cards.json' })
  assert.equal(items.length, 3)
  assert.equal(items[0].kind, 'preference')
  assert.equal(items[1].kind, 'boundary')
  assert.equal(detectMemoryFormat({ raw: json, source: 'x.json' }), 'surfcore')
  assert.equal(detectMemoryFormat({ raw: '# hi\n- 一条记忆内容', source: 'MEMORY.md' }), 'auto-memory')

  const auto = parseMemoryFile({ format: 'auto', raw: '# 偏好\n- 喜欢安静地看海', source: 'MEMORY.md' })
  assert.equal(auto[0].kind, 'preference')
})

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

test('migrate：导出记忆包（文件 + manifest + 不含 journal）', () => {
  const { dir, store } = makeStore({
    entries: [entry({ id: 'rel_export_1', statement: '用户喜欢冰美式', pinned: true })],
  })
  try {
    store.writeEpisodeFile('2026-10', [entry({ id: 'ep_1', kind: 'episode', statement: '第一次一起挑咖啡' })])
    const out = join(dir, 'export-out')
    const result = buildExport({ store, persona: 'test', outDir: out, now: new Date('2026-10-31T00:00:00.000Z') })
    assert.equal(result.dir, out)
    assert.ok(existsSync(join(out, 'soul.md')))
    assert.ok(existsSync(join(out, 'relationship.md')))
    assert.ok(existsSync(join(out, 'episodes', '2026-10.md')))
    assert.ok(existsSync(join(out, 'fishbowl-export.json')))
    assert.ok(existsSync(join(out, 'README.txt')))
    assert.ok(!existsSync(join(out, 'journal')), '不导出 journal')
    const manifest = JSON.parse(readFileSync(join(out, 'fishbowl-export.json'), 'utf8'))
    assert.equal(manifest.schema, 'fishbowl/export@1')
    assert.equal(manifest.persona, 'test')
    assert.ok(manifest.entries.some((item) => item.id === 'rel_export_1' && item.pinned === true))
    assert.doesNotMatch(JSON.stringify(manifest), /journal\//)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrate：导出父目录校验 + 自动在父目录里建子目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'fishbowl-export-parent-'))
  try {
    // 相对路径 / 文件路径被拒
    assert.equal(prepareExportParent('relative/dir').ok, false)
    const file = join(root, 'not-a-dir.txt')
    writeFileSync(file, 'x')
    assert.equal(prepareExportParent(file).ok, false)
    // 不存在就创建
    const parent = join(root, '我的导出')
    const prepared = prepareExportParent(parent)
    assert.equal(prepared.ok, true)
    assert.ok(existsSync(parent))
    // buildExport 建子目录
    const { dir, store } = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'fishbowl-export-store-'))
      const store = new Store({ dir, persona: 'test', log: () => {} })
      store.ensurePersona()
      return { dir, store }
    })()
    try {
      const result = buildExport({ store, persona: 'test', parentDir: parent })
      assert.ok(result.dir.startsWith(parent))
      assert.match(result.dir, /fishbowl-export-\d{8}-\d{4}(-\d+)?$/)
      assert.ok(existsSync(join(result.dir, 'fishbowl-export.json')))
      assert.equal(result.parentDir, parent)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 旧会话 transcript
// ---------------------------------------------------------------------------

test('migrate：transcript 过滤注入文本 / 脱敏 / 截断', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n...' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '记住：我的路径 /tmp/secret.txt 不要外传' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，记住了。' }] } } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
  ]
  const transcript = buildTranscript(events, { maxChars: 500 })
  assert.match(transcript, /^用户：记住/)
  assert.match(transcript, /\[已脱敏:路径\]/)
  assert.doesNotMatch(transcript, /demo-user/)
  assert.doesNotMatch(transcript, /runtime context/i)
  assert.doesNotMatch(transcript, /bash/)
  assert.match(transcript, /她：好的/)

  const long = buildTranscript(
    [{ type: 'user/message', data: { content: [{ type: 'text', text: '字'.repeat(2000) }] } }],
    { maxChars: 100 },
  )
  assert.ok(long.length <= 100 + 10)

  const input = buildMineInput({ persona: 'p', session: { id: 's' }, transcript })
  assert.equal(input.transcript, transcript)
})

test('curator：autoEpisodes=false 时情节也进审核队列', () => {
  const { dir, store } = makeStore()
  try {
    const plan = planCuratorOps({
      store,
      ops: [{ op: 'add', kind: 'episode', statement: '第一次一起挑咖啡', confidence: 0.7 }],
      now: new Date('2026-10-31T00:00:00.000Z'),
      autoEpisodes: false,
    })
    assert.equal(plan.episodes.length, 0)
    assert.equal(plan.queueItems.length, 1)
    assert.equal(plan.queueItems[0].kind, 'episode')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// apply harness：mine / export / import-memory / 成本门
// ---------------------------------------------------------------------------

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
  return { ctx, commands, routes, sessions, callRoute }
}

test('apply：mine / export / import-memory / 成本门', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fishbowl-m3-apply-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const oldSessionId = 'session-old-0001'
  const sessionRecords = [
    { header: { id: oldSessionId, cwd: workspace, createdAt: '2026-10-20T00:00:00.000Z' } },
    { header: { id: 'session-other-2', cwd: '/tmp/not-enabled', createdAt: '2026-10-21T00:00:00.000Z' } },
  ]
  const sessionEvents = {
    [oldSessionId]: [
      { type: 'user/message', data: { content: [{ type: 'text', text: '记住：用户喜欢冰美式。' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好，记住了。' }] } } },
    ],
  }
  const fakeSessionQuery = {
    async filterSessions(filters) {
      const values = filters?.find((filter) => filter.kind === 'cwd')?.values || []
      return sessionRecords.filter((record) => values.includes(record.header.cwd))
    },
    async listSessions() {
      return sessionRecords
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: '旧会话里聊了咖啡' } } }))
    },
    async readSession(sessionId) {
      const record = sessionRecords.find((item) => item.header.id === sessionId)
      return { session: record.header, events: sessionEvents[sessionId] || [] }
    },
    async readTitle() {
      return { title: '旧会话里聊了咖啡' }
    },
  }
  let llmCalls = 0
  const fakeLlm = {
    async *stream() {
      llmCalls += 1
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          noop: false,
          ops: [{ op: 'add', kind: 'preference', statement: '用户喜欢冰美式', confidence: 0.8, reason: '旧会话里说过' }],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const rawConfig = {
    persona: 'm3persona',
    scope: 'workspace',
    enabledWorkspaces: [workspace],
    defaultMode: 'full',
    autoConsolidate: false,
    curatorUseLlm: true,
    gitEnabled: true,
  }
  try {
    const harness = createHarness({ home, rawConfig, llm: fakeLlm, sessionQuery: fakeSessionQuery })
    apply(harness.ctx, rawConfig)
    const persona = harness.commands.get('persona')

    // --- mine list：只列启用工作区；命令 ---
    const listed = await persona.handler({ agent: { id: 'x' }, rawInput: 'mine list' })
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /old-0001|session-/)
    assert.doesNotMatch(listed.text, /session-other-2/, '不在启用工作区的会话不列')

    // --- API 列表 ---
    const apiList = await harness.callRoute('GET', '/api/fishbowl/mine')
    assert.equal(apiList.status, 200)
    assert.equal(apiList.json.sessions.length, 1)
    assert.equal(apiList.json.sessions[0].id, oldSessionId)

    // --- 提炼：全部进审核队列（含 episode 也不直写） ---
    const mine = await harness.callRoute('POST', '/api/fishbowl/mine', { sessionId: oldSessionId })
    assert.equal(mine.status, 200)
    assert.equal(mine.json.mined.status, 'ok')
    assert.equal(mine.json.mined.queued, 1)
    assert.equal(llmCalls, 1)
    const statusAfterMine = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.equal(statusAfterMine.json.review.pending, 1)
    assert.equal(statusAfterMine.json.m3Info.lastMine.status, 'ok')

    // --- 成本门：journal 没新行 → 不调 curator ---
    const consolidateRes = await harness.callRoute('POST', '/api/fishbowl/consolidate', {})
    assert.equal(consolidateRes.status, 200)
    assert.equal(consolidateRes.json.consolidated.curator.status, 'skipped')
    assert.equal(llmCalls, 1, '没有新 journal 不消耗模型调用')

    // --- 导出命令：所选目录是父目录，里面新建 fishbowl-export-* ---
    const exportParent = join(root, 'exported')
    const exported = await persona.handler({ agent: { id: 'x' }, rawInput: `export ${exportParent}` })
    assert.equal(exported.kind, 'success')
    assert.match(exported.text, /已导出记忆包/)
    const exportDirs = readdirSync(exportParent).filter((name) => name.startsWith('fishbowl-export-'))
    assert.equal(exportDirs.length, 1, '在父目录里新建一个导出文件夹')
    const exportDir = join(exportParent, exportDirs[0])
    assert.ok(existsSync(join(exportDir, 'fishbowl-export.json')))
    assert.ok(existsSync(join(exportDir, 'soul.md')))
    const manifest = JSON.parse(readFileSync(join(exportDir, 'fishbowl-export.json'), 'utf8'))
    assert.ok(manifest.entries.length >= 0)

    // --- 导出 API：自定义父目录 / 非法路径 ---
    const apiParent = join(root, 'api-export')
    const apiExport = await harness.callRoute('POST', '/api/fishbowl/export', { parentDir: apiParent })
    assert.equal(apiExport.status, 200)
    assert.ok(apiExport.json.exported.dir.startsWith(apiParent))
    const badExport = await harness.callRoute('POST', '/api/fishbowl/export', { parentDir: 'relative/place' })
    assert.equal(badExport.status, 400)
    assert.match(badExport.json.error, /绝对路径/)

    // --- 导入别的插件记忆 → 草稿 ---
    const memoryFile = join(root, 'MEMORY.md')
    writeFileSync(
      memoryFile,
      ['# 用户偏好', '- 用户喜欢先给结论再解释', '## 雷区', '- 不许提账号密码'].join('\n'),
    )
    const imported = await persona.handler({ agent: { id: 'x' }, rawInput: `import-memory auto-memory ${memoryFile}` })
    assert.equal(imported.kind, 'success')
    assert.match(imported.text, /导入 2 条草稿/)
    const statusAfterImport = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.ok(statusAfterImport.json.review.drafts.length >= 2, '导入条目在草稿区')

    // --- 审核通过导出的提议 ---
    const pendingItem = statusAfterImport.json.review.queue[0]
    assert.ok(pendingItem)
    const approved = await harness.callRoute('POST', '/api/fishbowl/review', { id: pendingItem.id, action: 'approve' })
    assert.equal(approved.status, 200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

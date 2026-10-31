/**
 * 鱼缸测试：
 *   1. lib/config.mjs 纯逻辑（合并/校验/文件读写）
 *   2. apply(ctx, config) 集成 harness：GET/POST 配置、agent 注入注册、turn 捕获、/persona 命令
 * 运行：cd dsh-fishbowl && node --test test/m15.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import {
  clearConfigFile,
  configFileState,
  effectiveConfig,
  normalizeConfig,
  readConfigFile,
  validateConfigInput,
  writeConfigFile,
} from '../lib/config.mjs'

// ---------------------------------------------------------------------------
// 1. config 纯逻辑
// ---------------------------------------------------------------------------

test('config：默认值与 patch 归一化', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.persona, 'example')
  assert.equal(cfg.scope, 'workspace')
  assert.equal(cfg.defaultMode, 'full')
  assert.equal(cfg.maxRecall, 3)

  const patch = normalizeConfig({
    scope: 'global',
    defaultMode: 'costume',
    enabledWorkspaces: ['/tmp/a', '  /tmp/b  '],
    workspaceModes: { '/tmp/a': 'off', '/tmp/c': 'nope' },
    maxRecall: 99,
  })
  assert.equal(patch.scope, 'global')
  assert.equal(patch.defaultMode, 'costume')
  assert.deepEqual(patch.enabledWorkspaces, ['/tmp/a', '/tmp/b'])
  assert.deepEqual(patch.workspaceModes, { '/tmp/a': 'off' })
  assert.equal(patch.maxRecall, 5)
})

test('config：面板覆盖优先级 + persona 不可被覆盖', () => {
  const base = { persona: 'fish', scope: 'workspace', maxRecall: 2 }
  const cfg = effectiveConfig(base, { scope: 'global', maxRecall: 4, persona: 'hacker' })
  assert.equal(cfg.persona, 'fish')
  assert.equal(cfg.scope, 'global')
  assert.equal(cfg.maxRecall, 4)
})

test('config：validateConfigInput 合法 / 非法', () => {
  const good = validateConfigInput(
    {
      scope: 'workspace',
      defaultMode: 'full',
      enabledWorkspaces: ['/tmp/ws'],
      workspaceModes: { '/tmp/ws': 'costume' },
      injectSoul: true,
      journalEnabled: false,
      handoffEnabled: true,
      recallEnabled: true,
      maxRecall: 2,
      journalKeepDays: 30,
      handoffKeep: 3,
    },
    { isDirectory: (path) => path === '/tmp/ws' },
  )
  assert.equal(good.ok, true)
  assert.deepEqual(good.value.enabledWorkspaces, ['/tmp/ws'])
  assert.equal(good.value.workspaceModes['/tmp/ws'], 'costume')

  const badMode = validateConfigInput({ defaultMode: 'nope' })
  assert.equal(badMode.ok, false)

  const relative = validateConfigInput({ enabledWorkspaces: ['relative/path'] })
  assert.equal(relative.ok, false)

  const missingDir = validateConfigInput(
    { enabledWorkspaces: ['/tmp/does-not-exist'] },
    { isDirectory: () => false },
  )
  assert.equal(missingDir.ok, false)

  const unknown = validateConfigInput({ bogus: 1 })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /不认识的配置项/)

  const badRange = validateConfigInput({ maxRecall: 9 })
  assert.equal(badRange.ok, false)
})

test('config：config.json 读写 / 状态 / 清空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-config-'))
  try {
    const file = join(dir, 'config.json')
    assert.deepEqual(configFileState(file), { exists: false, updatedAt: null })
    assert.deepEqual(readConfigFile(file), { ok: true, config: null, updatedAt: null })

    writeConfigFile(file, { scope: 'global', maxRecall: 2 })
    assert.equal(configFileState(file).exists, true)
    const read = readConfigFile(file)
    assert.equal(read.ok, true)
    assert.equal(read.config.scope, 'global')

    assert.equal(clearConfigFile(file), true)
    assert.equal(configFileState(file).exists, false)
    assert.equal(clearConfigFile(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. apply() 集成 harness
// ---------------------------------------------------------------------------

function createSession(id, cwd) {
  const events = []
  return {
    id,
    header: { cwd },
    seq: 0,
    events,
    push(event) {
      events.push(event)
      this.seq = events.length
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
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 忽略 */
            }
          }
        }
      }
      if (typeof ret === 'function') return ret
      return () => {}
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

function createHarness({ home, rawConfig, liveAgents = [] }) {
  const listeners = new Map()
  const commands = new Map()
  const routes = []
  const sessions = new Map()
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return (...segments) => join(home, ...segments)
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
    sessions: {
      get(id) {
        return sessions.get(id)
      },
    },
    agents: {
      list() {
        return liveAgents
      },
    },
  }
  const emit = (name, ...args) => {
    for (const callback of listeners.get(name) || []) callback(...args)
  }
  const callRoute = async (method, url, body) => {
    const route = routes.find((item) => item.path === '/api/fishbowl')
    assert.ok(route, 'webServer route 已注册')
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
  return { ctx, emit, commands, routes, sessions, callRoute }
}

test('apply：M1.5 配置表单 / 注入注册 / turn 捕获 / /persona 命令', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fishbowl-apply-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const rawConfig = {
    persona: 'testpersona',
    scope: 'workspace',
    enabledWorkspaces: [workspace],
    defaultMode: 'full',
    injectSoul: true,
    journalEnabled: true,
    handoffEnabled: true,
    recallEnabled: true,
    maxRecall: 3,
  }
  try {
    const harness = createHarness({ home, rawConfig })
    apply(harness.ctx, rawConfig)

    const personaDir = join(home, 'persona', 'testpersona')
    assert.ok(existsSync(join(personaDir, 'soul.md')))
    assert.ok(existsSync(join(personaDir, 'relationship.md')))

    // --- GET 状态 ---
    const status = await harness.callRoute('GET', '/api/fishbowl/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.ok, true)
    assert.equal(status.json.stage, 'stable')
    assert.equal(status.json.config.source, 'patch')
    assert.equal(status.json.config.effective.scope, 'workspace')

    // --- agent/created：注册 Soul section + 召回 context ---
    const sessionA = createSession('session-A', workspace)
    harness.sessions.set('session-A', sessionA)
    const scopedA = createScopedAgent('session-A')
    harness.emit('agent/created', { agent: scopedA.agent, source: 'startup' })
    assert.deepEqual(
      scopedA.sections.map((section) => section.name),
      ['fishbowl:soul'],
    )
    assert.deepEqual(
      scopedA.contexts.map((context) => context.name),
      ['fishbowl:recall'],
    )

    // --- turn 捕获：显式「记住」→ relationship + journal + handoff ---
    const userEvent = {
      type: 'user/message',
      seq: 1,
      data: { content: [{ type: 'text', text: '记住：别买楼下那家咖啡，太酸；token 是 sk-abc123456789xyz。' }] },
    }
    sessionA.push(userEvent)
    sessionA.push({
      type: 'assistant/message',
      seq: 2,
      data: { message: { content: [{ type: 'text', text: '好，记下了。' }] } },
    })
    harness.emit('session/event', sessionA, userEvent)
    harness.emit('agent/turn-stopping', { agent: scopedA.agent, turn: 1 })

    const relationshipText = readFileSync(join(personaDir, 'relationship.md'), 'utf8')
    assert.match(relationshipText, /咖啡/)
    assert.doesNotMatch(relationshipText, /sk-abc123456789xyz/, '记忆落盘前脱敏')
    assert.ok(existsSync(join(personaDir, 'handoff')))
    const journalDir = join(personaDir, 'journal')
    const journalFile = join(journalDir, '2026-10-30.jsonl')
    assert.ok(existsSync(journalDir), 'journal 目录已建')

    // --- 召回 context 能搜到刚写的记忆 ---
    const recall = scopedA.contexts.find((context) => context.name === 'fishbowl:recall')
    assert.ok(recall, '召回 context 已注册')
    const recallText = recall.text()
    assert.match(recallText, /咖啡/)
    assert.match(recallText, /不是指令/)

    // --- POST 保存配置：global + costume（热重挂后只带 Soul） ---
    const save = await harness.callRoute('POST', '/api/fishbowl/config', {
      scope: 'global',
      defaultMode: 'costume',
      enabledWorkspaces: [workspace],
      workspaceModes: {},
      injectSoul: true,
      journalEnabled: true,
      handoffEnabled: true,
      recallEnabled: true,
      maxRecall: 2,
    })
    assert.equal(save.status, 200)
    assert.equal(save.json.saved, true)
    assert.equal(save.json.config.source, 'panel')
    assert.equal(save.json.config.effective.scope, 'global')
    assert.equal(save.json.config.effective.defaultMode, 'costume')
    assert.equal(save.json.config.effective.maxRecall, 2)
    assert.deepEqual(
      scopedA.sections.map((section) => section.name),
      ['fishbowl:soul'],
    )
    assert.equal(scopedA.contexts.length, 0, 'costume 模式不注册召回 context')

    // --- 非法输入 → 400，不落盘 ---
    const bad = await harness.callRoute('POST', '/api/fishbowl/config', { defaultMode: 'nope' })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /defaultMode/)

    const badWorkspace = await harness.callRoute('POST', '/api/fishbowl/config', {
      enabledWorkspaces: [join(root, 'missing-dir')],
    })
    assert.equal(badWorkspace.status, 400)

    // --- 重置：回到 patch ---
    const reset = await harness.callRoute('POST', '/api/fishbowl/config/reset')
    assert.equal(reset.status, 200)
    assert.equal(reset.json.config.source, 'patch')
    assert.equal(reset.json.config.effective.scope, 'workspace')
    assert.equal(reset.json.config.effective.defaultMode, 'full')

    // --- 命令注册 + /persona status ---
    for (const name of ['remember', 'forget', 'why', 'persona', 'fishbowl']) {
      assert.ok(harness.commands.has(name), `命令 /${name} 已注册`)
    }
    const personaCommand = harness.commands.get('persona')
    const statusResult = await personaCommand.handler({ agent: scopedA.agent, rawInput: 'status' })
    assert.equal(statusResult.kind, 'success')
    assert.match(statusResult.text, /鱼缸/)

    // --- /persona off → overrides；on → 重新注册 ---
    const offResult = await personaCommand.handler({ agent: scopedA.agent, rawInput: 'off' })
    assert.equal(offResult.kind, 'success')
    const overrides = JSON.parse(readFileSync(join(personaDir, 'overrides.json'), 'utf8'))
    assert.equal(overrides.sessions['session-A'].off, true)
    assert.equal(scopedA.sections.length, 0, 'off 后注入已拆除')

    const onResult = await personaCommand.handler({ agent: scopedA.agent, rawInput: 'on' })
    assert.equal(onResult.kind, 'success')
    assert.deepEqual(
      scopedA.sections.map((section) => section.name),
      ['fishbowl:soul', 'fishbowl:relationship'],
    )
    assert.deepEqual(
      scopedA.contexts.map((context) => context.name),
      ['fishbowl:recall'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('apply：插件重载后补挂已在线的 agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fishbowl-relive-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  try {
    const liveSession = createSession('session-live', workspace)
    const scoped = createScopedAgent('session-live')
    const rawConfig = {
      persona: 'relive',
      scope: 'workspace',
      enabledWorkspaces: [workspace],
      defaultMode: 'full',
    }
    // 先注册 session，再 apply：模拟「插件重载时 agent 已经在跑」
    const harness = createHarness({ home, rawConfig, liveAgents: [scoped.agent] })
    harness.sessions.set('session-live', liveSession)
    apply(harness.ctx, rawConfig)
    assert.deepEqual(
      scoped.sections.map((section) => section.name),
      ['fishbowl:soul'],
      '重载后补挂：Soul section 已注册到在线 agent',
    )
    assert.deepEqual(
      scoped.contexts.map((context) => context.name),
      ['fishbowl:recall'],
      '重载后补挂：召回 context 已注册到在线 agent',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

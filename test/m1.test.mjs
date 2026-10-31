/**
 * 鱼缸纯逻辑单测（不碰 DSH、不碰真实 persona 目录）。
 * 运行：cd dsh-fishbowl && node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Store,
  parseEntriesFromMarkdown,
  parseHandoff,
  renderEpisodesMarkdown,
  renderHandoff,
  renderRelationshipMarkdown,
} from '../lib/store.mjs'
import {
  detectCandidates,
  extractExplicitMemory,
  extractPromises,
  isInjectedUserText,
  redactText,
  searchEntries,
} from '../lib/text.mjs'
import { normStatement, workspaceTag } from '../lib/util.mjs'

const coffeeEntry = (overrides = {}) => ({
  id: 'rel_20261030_coffee',
  kind: 'preference',
  scope: 'persona',
  status: 'active',
  confidence: 0.9,
  created_at: '2026-10-30',
  updated_at: '2026-10-30',
  statement: '别买楼下那家咖啡，太酸了',
  evidence: [{ session: 'sess_abc', seq: 42, quote: '别买楼下那家咖啡，太酸了' }],
  supersedes: [],
  ...overrides,
})

test('relationship yaml 条目 round-trip', () => {
  const entries = [
    coffeeEntry(),
    {
      id: 'rel_boundary_1',
      kind: 'boundary',
      scope: 'persona',
      status: 'active',
      confidence: 0.95,
      created_at: '2026-10-20',
      updated_at: '2026-10-29',
      statement: '不泄露账号、uid、路径、密钥',
      evidence: [{ source: 'AGENTS.md', quote: '账号、uid、机器路径、聊天记录、密钥 —— 一个字都不进评论。' }],
      supersedes: [],
    },
  ]
  const md = renderRelationshipMarkdown({ persona: '示例角色', entries, updatedAt: '2026-10-30T00:00:00.000Z' })
  assert.match(md, /# Relationship · 示例角色/)
  assert.match(md, /别买楼下那家咖啡/)
  const parsed = parseEntriesFromMarkdown(md)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, 'rel_20261030_coffee')
  assert.equal(parsed[0].evidence.length, 1)
  assert.equal(parsed[0].evidence[0].session, 'sess_abc')
  assert.equal(parsed[0].evidence[0].seq, 42)
  assert.equal(parsed[1].kind, 'boundary')
  assert.equal(parsed[1].evidence[0].source, 'AGENTS.md')
})

test('关系摘要之外：已归档条目保留状态', () => {
  const md = renderRelationshipMarkdown({ persona: 'p', entries: [coffeeEntry({ status: 'forgotten' })] })
  assert.match(md, /七、已归档/)
  assert.match(md, /status: forgotten/)
})

test('episodes 文件 round-trip', () => {
  const md = renderEpisodesMarkdown({
    persona: 'p',
    month: '2026-10',
    entries: [coffeeEntry({ id: 'ep_1', kind: 'episode', statement: '第一次一起挑咖啡' })],
  })
  const parsed = parseEntriesFromMarkdown(md)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].kind, 'episode')
})

test('handoff round-trip（最新在上）', () => {
  const tag = workspaceTag('/tmp/fishbowl-demo-workspace')
  const md = renderHandoff({
    persona: 'p',
    workspaceTag: tag,
    entries: [
      { at: '2026-10-30T03:00:00.000Z', session: 'sess_new', summary: '聊到咖啡', reply: '劝用户别买', promises: ['明天再看一家'] },
      { at: '2026-10-29T03:00:00.000Z', session: 'sess_old', summary: '聊到大纲', reply: '写完了', promises: [] },
    ],
  })
  assert.doesNotMatch(md, /\/Users\/demo-user/, 'handoff 不应写入完整机器路径')
  assert.match(md, /workspace_name: "?fishbowl-demo-workspace"?/)
  const parsed = parseHandoff(md)
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0].session, 'sess_new')
  assert.deepEqual(parsed.entries[0].promises, ['明天再看一家'])
})

test('脱敏：路径 / 密钥 / 邮箱 / uid', () => {
  const input =
    '我的 token 是 sk-abcd1234efgh5678，路径 /tmp/secret.txt，邮箱 a.b@example.com，uid: 123456789'
  const out = redactText(input)
  assert.doesNotMatch(out, /demo-user/)
  assert.doesNotMatch(out, /sk-abcd/)
  assert.doesNotMatch(out, /a\.b@example\.com/)
  assert.doesNotMatch(out, /123456789/)
  assert.match(out, /\[已脱敏:路径\]/)
  assert.match(out, /\[已脱敏:密钥\]/)
})

test('过滤宿主注入的 runtime context', () => {
  assert.equal(isInjectedUserText('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n...'), true)
  assert.equal(isInjectedUserText('<system-reminder>\nA skill is a reusable set...'), true)
  assert.equal(isInjectedUserText('Time sampled while preparing turn 1'), true)
  assert.equal(isInjectedUserText('用户，楼下那家咖啡怎么样？'), false)
})

test('显式「记住：」抽取', () => {
  assert.deepEqual(extractExplicitMemory('记住：别买楼下那家咖啡，太酸。'), ['别买楼下那家咖啡，太酸'])
  assert.deepEqual(extractExplicitMemory('帮我记住：明天下午三点开组会'), ['明天下午三点开组会'])
  assert.deepEqual(extractExplicitMemory('你还记得吗？'), [])
})

test('候选标记与承诺抽取', () => {
  const candidates = detectCandidates('我最讨厌烟味。记得明天交论文。')
  assert.ok(candidates.some((item) => item.kind === 'preference'))
  assert.ok(candidates.some((item) => item.kind === 'promise'))
  assert.deepEqual(extractPromises('明天交论文，回头一起看。'), ['明天交论文，回头一起看'])
})

test('召回：咖啡测试得分 / 无关问题不硬塞', () => {
  const entries = [coffeeEntry()]
  const coffeeHits = searchEntries(entries, '楼下那家咖啡怎么样？', { limit: 3 })
  assert.equal(coffeeHits.length, 1)
  assert.equal(coffeeHits[0].entry.id, 'rel_20261030_coffee')
  const unrelated = searchEntries(entries, '今天天气如何', { limit: 3 })
  assert.equal(unrelated.length, 0)
})

test('Store：新增 / 去重 / 遗忘 / 迁移 remembered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-test-'))
  try {
    const store = new Store({ dir, persona: 'test-persona' })
    store.ensurePersona()
    assert.ok(store.readSoul().meta.locked === true || store.readSoul().body.length >= 0)

    const first = store.addEntry({
      ...coffeeEntry({ id: 'rel_coffee_1' }),
      evidence: [{ session: 'sess_x', seq: 1, quote: '别买楼下那家咖啡，太酸了' }],
    })
    assert.equal(first.added, true)
    assert.equal(store.counts().relationship.active, 1)

    const dup = store.addEntry(coffeeEntry({ id: 'rel_coffee_2' }))
    assert.equal(dup.added, false)
    assert.equal(store.counts().relationship.active, 1)

    // 重复归一化（标点差异）也判重
    assert.equal(normStatement('别买楼下那家咖啡，太酸了'), normStatement(' 别买楼下那家咖啡 太酸了。'))

    store.forgetEntry('rel_coffee_1')
    assert.equal(store.counts().relationship.active, 0)
    assert.equal(store.counts().relationship.forgotten, 1)

    // remembered.jsonl 迁移
    writeFileSync(
      store.rememberedPath,
      `${JSON.stringify({ id: 'rem_1', at: '2026-10-30T00:00:00.000Z', text: '用户喜欢先给结论再解释' })}\n`,
      'utf8',
    )
    const migrated = store.migrateRemembered()
    assert.equal(migrated, 1)
    assert.equal(store.counts().relationship.active, 1)
    assert.equal(store.migrateRemembered(), 0, '迁移标记后不重复导入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Store：handoff 保留最近 N 条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-handoff-'))
  try {
    const store = new Store({ dir, persona: 'p' })
    store.ensurePersona()
    const cwd = '/tmp/fishbowl-demo-workspace'
    for (let i = 0; i < 5; i += 1) {
      store.writeHandoff(cwd, {
        at: `2026-10-30T0${i}:00:00.000Z`,
        session: `sess_${i}`,
        summary: `第 ${i} 轮`,
        reply: `回 ${i}`,
        promises: [],
      })
    }
    const handoff = store.readHandoff(cwd, 3)
    assert.equal(handoff.entries.length, 3)
    assert.equal(handoff.entries[0].session, 'sess_4')
    assert.ok(!JSON.stringify(handoff).includes('/tmp/fishbowl-demo-workspace'), 'handoff 文件不应写完整路径')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

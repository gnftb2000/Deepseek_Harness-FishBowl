/**
 * 鱼缸 · 配置：默认值、patch 合并、面板设置文件（config.json）、输入校验。
 *
 * 优先级：profile cordis.patch.yml 的 config（基底） → ~/.dsh/persona/<p>/config.json（面板写入，覆盖顶层键）
 * 面板只改顶层可编辑键；persona 只能改 patch（改人设要重开插件）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { asMode, clamp, nowIso } from './util.mjs'

export const CONFIG_VERSION = 1

export const DEFAULTS = Object.freeze({
  persona: 'example',
  scope: 'workspace',
  enabledWorkspaces: [],
  workspaceModes: {},
  defaultMode: 'full',
  injectSoul: true,
  journalEnabled: true,
  handoffEnabled: true,
  recallEnabled: true,
  maxRecall: 3,
  journalKeepDays: 30,
  handoffKeep: 3,
  curatorMinJournalLines: 1,
  conflictAutoMode: 'safe',
  conflictAutoMinConfidence: 0.85,
  mineMaxChars: 8000,
  mineMaxOps: 10,
  // M2：整理 / curator / 版本化
  autoConsolidate: true,
  curatorUseLlm: true,
  curatorProvider: '',
  curatorModel: '',
  curatorIntervalHours: 24,
  curatorMaxJournalLines: 80,
  decayEnabled: true,
  weeklyReport: true,
  gitEnabled: true,
})

/** 把「patch 形状」的原始 config 归一化成运行时配置。 */
export function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, enabledWorkspaces: [], workspaceModes: {} }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (typeof src.persona === 'string' && src.persona.trim()) cfg.persona = src.persona.trim()
  if (src.scope === 'global' || src.scope === 'workspace') cfg.scope = src.scope
  if (Array.isArray(src.enabledWorkspaces)) {
    cfg.enabledWorkspaces = src.enabledWorkspaces
      .filter((path) => typeof path === 'string' && path.trim())
      .map((path) => resolve(path.trim()))
  }
  const modeMap = {}
  const addMode = (path, mode) => {
    const normalized = asMode(mode)
    if (typeof path === 'string' && path.trim() && normalized) modeMap[resolve(path.trim())] = normalized
  }
  if (src.workspaceModes && typeof src.workspaceModes === 'object' && !Array.isArray(src.workspaceModes)) {
    for (const [path, mode] of Object.entries(src.workspaceModes)) addMode(path, mode)
  }
  if (Array.isArray(src.workspaceModes)) {
    for (const item of src.workspaceModes) if (item && typeof item === 'object') addMode(item.path, item.mode)
  }
  cfg.workspaceModes = modeMap
  const defaultMode = asMode(src.defaultMode)
  if (defaultMode) cfg.defaultMode = defaultMode
  for (const key of ['injectSoul', 'journalEnabled', 'handoffEnabled']) {
    if (typeof src[key] === 'boolean') cfg[key] = src[key]
  }
  if (typeof src.recallEnabled === 'boolean') cfg.recallEnabled = src.recallEnabled
  // M0 向后兼容：injectRemembered=false 等价于关召回
  if (src.injectRemembered === false) cfg.recallEnabled = false
  if (Number.isFinite(src.maxRecall)) cfg.maxRecall = clamp(Math.trunc(src.maxRecall), 1, 5)
  if (Number.isFinite(src.journalKeepDays)) cfg.journalKeepDays = clamp(Math.trunc(src.journalKeepDays), 1, 365)
  if (Number.isFinite(src.handoffKeep)) cfg.handoffKeep = clamp(Math.trunc(src.handoffKeep), 1, 5)
  for (const key of ['autoConsolidate', 'curatorUseLlm', 'decayEnabled', 'weeklyReport', 'gitEnabled']) {
    if (typeof src[key] === 'boolean') cfg[key] = src[key]
  }
  if (typeof src.curatorProvider === 'string') cfg.curatorProvider = src.curatorProvider.trim()
  if (typeof src.curatorModel === 'string') cfg.curatorModel = src.curatorModel.trim()
  if (Number.isFinite(src.curatorIntervalHours)) cfg.curatorIntervalHours = clamp(Math.trunc(src.curatorIntervalHours), 1, 168)
  if (Number.isFinite(src.curatorMaxJournalLines)) cfg.curatorMaxJournalLines = clamp(Math.trunc(src.curatorMaxJournalLines), 10, 500)
  if (Number.isFinite(src.curatorMinJournalLines)) cfg.curatorMinJournalLines = clamp(Math.trunc(src.curatorMinJournalLines), 0, 500)
  if (Number.isFinite(src.mineMaxChars)) cfg.mineMaxChars = clamp(Math.trunc(src.mineMaxChars), 1000, 40000)
  if (Number.isFinite(src.mineMaxOps)) cfg.mineMaxOps = clamp(Math.trunc(src.mineMaxOps), 1, 20)
  if (src.conflictAutoMode === 'off' || src.conflictAutoMode === 'safe' || src.conflictAutoMode === 'balanced') {
    cfg.conflictAutoMode = src.conflictAutoMode
  }
  if (Number.isFinite(src.conflictAutoMinConfidence)) {
    cfg.conflictAutoMinConfidence = clamp(Number(src.conflictAutoMinConfidence), 0.5, 1)
  }
  return cfg
}

/** 面板可编辑的顶层键（persona 除外）。 */
const EDITABLE_KEYS = [
  'scope',
  'enabledWorkspaces',
  'workspaceModes',
  'defaultMode',
  'injectSoul',
  'journalEnabled',
  'handoffEnabled',
  'recallEnabled',
  'maxRecall',
  'journalKeepDays',
  'handoffKeep',
  'autoConsolidate',
  'curatorUseLlm',
  'curatorProvider',
  'curatorModel',
  'curatorIntervalHours',
  'curatorMaxJournalLines',
  'curatorMinJournalLines',
  'conflictAutoMode',
  'conflictAutoMinConfidence',
  'mineMaxChars',
  'mineMaxOps',
  'decayEnabled',
  'weeklyReport',
  'gitEnabled',
]

/** 运行时配置 → patch 形状（给面板和 API 用）。 */
export function editableConfig(cfg) {
  return {
    scope: cfg.scope,
    enabledWorkspaces: [...cfg.enabledWorkspaces],
    workspaceModes: { ...cfg.workspaceModes },
    defaultMode: cfg.defaultMode,
    injectSoul: cfg.injectSoul,
    journalEnabled: cfg.journalEnabled,
    handoffEnabled: cfg.handoffEnabled,
    recallEnabled: cfg.recallEnabled,
    maxRecall: cfg.maxRecall,
    journalKeepDays: cfg.journalKeepDays,
    handoffKeep: cfg.handoffKeep,
    autoConsolidate: cfg.autoConsolidate,
    curatorUseLlm: cfg.curatorUseLlm,
    curatorProvider: cfg.curatorProvider,
    curatorModel: cfg.curatorModel,
    curatorIntervalHours: cfg.curatorIntervalHours,
    curatorMaxJournalLines: cfg.curatorMaxJournalLines,
    curatorMinJournalLines: cfg.curatorMinJournalLines,
    conflictAutoMode: cfg.conflictAutoMode,
    conflictAutoMinConfidence: cfg.conflictAutoMinConfidence,
    mineMaxChars: cfg.mineMaxChars,
    mineMaxOps: cfg.mineMaxOps,
    decayEnabled: cfg.decayEnabled,
    weeklyReport: cfg.weeklyReport,
    gitEnabled: cfg.gitEnabled,
  }
}

/** 基底 patch + 面板覆盖 → 运行时配置；persona 永远以 patch 为准。 */
export function mergePatch(baseRaw, overridePatch) {
  const base = baseRaw && typeof baseRaw === 'object' && !Array.isArray(baseRaw) ? baseRaw : {}
  const override = overridePatch && typeof overridePatch === 'object' && !Array.isArray(overridePatch) ? overridePatch : {}
  const merged = { ...base, ...override }
  if (base.persona !== undefined) merged.persona = base.persona
  return merged
}

export function effectiveConfig(baseRaw, overridePatch) {
  return normalizeConfig(mergePatch(baseRaw, overridePatch))
}

// ---------------------------------------------------------------------------
// config.json 读写（面板设置）
// ---------------------------------------------------------------------------

export function readConfigFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, config: null, updatedAt: null, error: 'config.json 不是对象' }
    }
    const config = parsed.config ?? null
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
      return { ok: false, config: null, updatedAt: null, error: 'config.json 的 config 字段不合法' }
    }
    return { ok: true, config, updatedAt: parsed.updatedAt ?? null }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, config: null, updatedAt: null }
    return { ok: false, config: null, updatedAt: null, error: e?.message ?? String(e) }
  }
}

export function configFileState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { exists: true, updatedAt: parsed?.updatedAt ?? null }
  } catch {
    return { exists: false, updatedAt: null }
  }
}

export function writeConfigFile(file, patchConfig) {
  mkdirSync(dirname(file), { recursive: true })
  const payload = { version: CONFIG_VERSION, updatedAt: nowIso(), config: patchConfig }
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
  return payload
}

export function clearConfigFile(file) {
  try {
    unlinkSync(file)
    return true
  } catch (e) {
    if (e && e.code === 'ENOENT') return false
    throw e
  }
}

// ---------------------------------------------------------------------------
// 面板输入校验
// ---------------------------------------------------------------------------

function asInt(value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  const int = Math.trunc(n)
  if (int < lo || int > hi) return undefined
  return int
}

/**
 * 校验面板提交的 patch。
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateConfigInput(input, options = {}) {
  const isDirectory = typeof options.isDirectory === 'function' ? options.isDirectory : () => true
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置必须是 JSON 对象' }
  }
  const errors = []
  const patch = {}

  if ('scope' in input) {
    if (input.scope === 'workspace' || input.scope === 'global') patch.scope = input.scope
    else errors.push('scope 只能是 workspace / global')
  }
  if ('defaultMode' in input) {
    const mode = asMode(input.defaultMode)
    if (mode) patch.defaultMode = mode
    else errors.push('defaultMode 只能是 full / costume / off')
  }
  if ('enabledWorkspaces' in input) {
    if (!Array.isArray(input.enabledWorkspaces)) {
      errors.push('enabledWorkspaces 必须是数组')
    } else {
      const paths = []
      for (const raw of input.enabledWorkspaces) {
        if (typeof raw !== 'string' || !raw.trim()) {
          errors.push('工作区路径必须是非空字符串')
          continue
        }
        const path = resolve(raw.trim())
        if (!isAbsolute(raw.trim())) {
          errors.push(`工作区必须是绝对路径：${raw}`)
          continue
        }
        if (options.requireExistingDirectory !== false && !isDirectory(path)) {
          errors.push(`工作区不存在或不是目录：${path}`)
          continue
        }
        if (!paths.includes(path)) paths.push(path)
      }
      patch.enabledWorkspaces = paths
    }
  }
  if ('workspaceModes' in input) {
    const map = input.workspaceModes
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      errors.push('workspaceModes 必须是对象（路径 → 模式）')
    } else {
      const normalized = {}
      for (const [rawPath, rawMode] of Object.entries(map)) {
        const path = String(rawPath || '').trim()
        const mode = asMode(rawMode)
        if (!path || !isAbsolute(path)) {
          errors.push(`workspaceModes 的路径必须是绝对路径：${rawPath}`)
          continue
        }
        if (!mode) {
          errors.push(`workspaceModes 的模式只能是 full / costume / off：${rawPath}`)
          continue
        }
        normalized[resolve(path)] = mode
      }
      patch.workspaceModes = normalized
    }
  }
  for (const key of [
    'injectSoul',
    'journalEnabled',
    'handoffEnabled',
    'recallEnabled',
    'autoConsolidate',
    'curatorUseLlm',
    'decayEnabled',
    'weeklyReport',
    'gitEnabled',
  ]) {
    if (!(key in input)) continue
    if (typeof input[key] === 'boolean') patch[key] = input[key]
    else errors.push(`${key} 必须是布尔值`)
  }
  for (const key of ['curatorProvider', 'curatorModel']) {
    if (!(key in input)) continue
    if (typeof input[key] === 'string') patch[key] = input[key].trim()
    else errors.push(`${key} 必须是字符串`)
  }
  if ('curatorIntervalHours' in input) {
    const value = asInt(input.curatorIntervalHours, 1, 168)
    if (value === undefined) errors.push('curatorIntervalHours 必须是 1–168 的整数')
    else patch.curatorIntervalHours = value
  }
  if ('curatorMaxJournalLines' in input) {
    const value = asInt(input.curatorMaxJournalLines, 10, 500)
    if (value === undefined) errors.push('curatorMaxJournalLines 必须是 10–500 的整数')
    else patch.curatorMaxJournalLines = value
  }
  if ('curatorMinJournalLines' in input) {
    const value = asInt(input.curatorMinJournalLines, 0, 500)
    if (value === undefined) errors.push('curatorMinJournalLines 必须是 0–500 的整数')
    else patch.curatorMinJournalLines = value
  }
  if ('conflictAutoMode' in input) {
    if (/^(off|safe|balanced)$/.test(String(input.conflictAutoMode))) patch.conflictAutoMode = String(input.conflictAutoMode)
    else errors.push('conflictAutoMode 只能是 off / safe / balanced')
  }
  if ('conflictAutoMinConfidence' in input) {
    const value = Number(input.conflictAutoMinConfidence)
    if (!Number.isFinite(value) || value < 0.5 || value > 1) errors.push('conflictAutoMinConfidence 必须是 0.5–1 的数字')
    else patch.conflictAutoMinConfidence = value
  }
  if ('mineMaxChars' in input) {
    const value = asInt(input.mineMaxChars, 1000, 40000)
    if (value === undefined) errors.push('mineMaxChars 必须是 1000–40000 的整数')
    else patch.mineMaxChars = value
  }
  if ('mineMaxOps' in input) {
    const value = asInt(input.mineMaxOps, 1, 20)
    if (value === undefined) errors.push('mineMaxOps 必须是 1–20 的整数')
    else patch.mineMaxOps = value
  }
  if ('maxRecall' in input) {
    const value = asInt(input.maxRecall, 1, 5)
    if (value === undefined) errors.push('maxRecall 必须是 1–5 的整数')
    else patch.maxRecall = value
  }
  if ('journalKeepDays' in input) {
    const value = asInt(input.journalKeepDays, 1, 365)
    if (value === undefined) errors.push('journalKeepDays 必须是 1–365 的整数')
    else patch.journalKeepDays = value
  }
  if ('handoffKeep' in input) {
    const value = asInt(input.handoffKeep, 1, 5)
    if (value === undefined) errors.push('handoffKeep 必须是 1–5 的整数')
    else patch.handoffKeep = value
  }

  for (const key of Object.keys(input)) {
    if (!EDITABLE_KEYS.includes(key)) errors.push(`不认识的配置项：${key}`)
  }

  if (errors.length > 0) return { ok: false, error: errors.join('；') }
  if (Object.keys(patch).length === 0) return { ok: false, error: '没有可保存的配置项' }
  return { ok: true, value: patch }
}

/** 给单测/排查用：config.json 是否存在。 */
export function configFileExists(file) {
  return existsSync(file)
}

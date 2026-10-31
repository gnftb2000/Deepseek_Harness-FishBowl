/**
 * 鱼缸 · 文本处理：脱敏、注入消息过滤、记忆意图识别、候选标记、召回打分。
 * 全部纯函数，无 IO —— 便于单测（见 test/m1.test.mjs）。
 */

const PATH_RE = /(?:[~]|\/(?:Users|home|private|var|Volumes|Applications|opt|tmp))\/(?:[^\s，。；：、"'“”‘’（）()\[\]【】<>《》,;!?！？]+)/g
const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s，。；：、"']+/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const SECRET_RE = /\b(?:sk|ak|pk|ghp|gho|glpat)[-_][A-Za-z0-9_-]{8,}/gi
const SECRET_KV_RE = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|凭证|密钥|密码|验证码)\s*[:=：]\s*[^\s，。；、]+/gi
const UID_KV_RE = /(?:uid|mid|qq号|qq|微信id|手机号)\s*[:=：]?\s*\d{5,}/gi

/** 记忆/日志落盘前的统一脱敏。 */
export function redactText(input) {
  let text = String(input ?? '')
  if (!text) return ''
  text = text.replace(PATH_RE, '[已脱敏:路径]')
  text = text.replace(WIN_PATH_RE, '[已脱敏:路径]')
  text = text.replace(EMAIL_RE, '[已脱敏:邮箱]')
  text = text.replace(SECRET_RE, '[已脱敏:密钥]')
  text = text.replace(SECRET_KV_RE, '[已脱敏:密钥]')
  text = text.replace(UID_KV_RE, '[已脱敏:账号]')
  return text
}

const INJECTED_PREFIXES = [
  'Current runtime context.',
  '<system-reminder>',
  'Time sampled while preparing',
  'Your parent agent id is',
  'The working directory changed from',
  'Approval prompts are disabled',
  'You are a delegated subagent',
  'Delegation depth for',
  '# Current runtime context',
]

/** 判断这条 user 文本是不是宿主/框架注入的上下文（Journal 不收）。 */
export function isInjectedUserText(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (INJECTED_PREFIXES.some((prefix) => t.startsWith(prefix))) return true
  if (t.includes('This snapshot supersedes earlier runtime-context snapshots')) return true
  if (t.startsWith('A skill is a reusable set of task-specific instructions')) return true
  return false
}

/** 去掉宿主/子 agent 追加在 user 文本尾部的样板指令（journal/handoff 用）。 */
export function stripHarnessBoilerplate(input) {
  let text = String(input ?? '')
  const cuts = [
    'Your parent agent id is',
    'Before you finish, send your result to that agent',
    'The parent shares your workspace but does not automatically receive',
  ]
  for (const marker of cuts) {
    const index = text.indexOf(marker)
    if (index >= 0) text = text.slice(0, index)
  }
  return text.replace(/\s+$/g, '')
}

/** 把一段话拆成句子（中英文标点 + 换行）。 */
export function sentences(text) {
  return String(text ?? '')
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 找出「明确要求记住」的句子，返回要记住的正文（已去前缀）。 */
export function extractExplicitMemory(userText) {
  const text = String(userText ?? '')
  const out = []
  const re = /(?:记住|要记住|帮我记住|记一下|记下来|别忘了|记得)[：:，,]\s*([^\n。！？!?]{4,200})/g
  let match
  while ((match = re.exec(text)) !== null) {
    const statement = match[1].trim().replace(/^[「“"']+|[」”"']+$/g, '')
    if (statement.length >= 4) out.push(statement)
  }
  // “记住；xxx”“记住 - xxx” 之类
  const re2 = /记住[；;\-—\s]+([^\n。！？!?]{6,200})/g
  while ((match = re2.exec(text)) !== null) {
    const statement = match[1].trim()
    if (statement.length >= 6) out.push(statement)
  }
  return [...new Set(out)].slice(0, 5)
}

const CANDIDATE_RULES = [
  { kind: 'preference', reason: '偏好词', re: /(我喜欢|我不喜欢|我最喜欢|我最讨厌|我讨厌|别买|不要买|不用买|爱吃|不爱吃|喜欢)/ },
  { kind: 'boundary', reason: '边界词', re: /(不许|不准|别提|别说|不要问|别再|禁止|雷区|不能碰)/ },
  { kind: 'promise', reason: '承诺/时间词', re: /(答应|说好|讲好|明天|下次|回头|晚点|等我|约好|之后要)/ },
  { kind: 'ritual', reason: '节律词', re: /(每天|每次|每周|固定|习惯|仪式|照例)/ },
]

/** 规则型候选标记（不落库，只进 journal，M2 curator 消费）。 */
export function detectCandidates(userText) {
  const found = []
  for (const sentence of sentences(userText)) {
    for (const rule of CANDIDATE_RULES) {
      if (rule.re.test(sentence)) {
        found.push({ kind: rule.kind, text: sentence.slice(0, 200), reason: rule.reason })
        break
      }
    }
    if (found.length >= 5) break
  }
  return found
}

const PROMISE_RE = /(答应|说好|讲好|明天|下次|回头|晚点|等我|约好|之后要)/

/** 从用户话里抽「未完成承诺」句子（handoff 用）。 */
export function extractPromises(userText) {
  return sentences(userText)
    .filter((sentence) => PROMISE_RE.test(sentence))
    .map((sentence) => sentence.slice(0, 120))
    .slice(0, 3)
}

// ---------------------------------------------------------------------------
// 召回：中文 bigram + 拉丁词，简单加权；无 embedding（M1 口径）
// ---------------------------------------------------------------------------

export function tokenize(query) {
  const text = String(query ?? '').toLowerCase()
  const tokens = new Set()
  for (const word of text.match(/[a-z0-9_]{2,}/g) || []) tokens.add(word)
  for (const run of text.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    if (!run) continue
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
    // 三字以上再加一个重叠 trigram，帮助「咖啡店」这类词
    if (run.length >= 3) tokens.add(run.slice(0, 3))
  }
  return [...tokens]
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export function scoreEntry(entry, tokens) {
  if (!entry || typeof entry.statement !== 'string') return 0
  const hay = [
    entry.statement,
    ...(entry.evidence || []).map((item) => item?.quote || ''),
    String(entry.kind || ''),
  ]
    .join(' ')
    .toLowerCase()
  let score = 0
  for (const token of tokens) {
    const hits = countOccurrences(hay, token)
    if (hits > 0) score += 1 + Math.min(hits - 1, 2) * 0.25
  }
  if (entry.kind === 'boundary') score += 0.5
  if (entry.kind === 'preference') score += 0.25
  return score
}

/** 在 active 条目里找 top-k；threshold 默认 1（至少要命中一个词）。 */
export function searchEntries(entries, query, options = {}) {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const limit = options.limit ?? 3
  const threshold = options.threshold ?? 1
  return entries
    .filter((entry) => entry && entry.status === 'active' && entry.kind !== 'open_question')
    .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter((row) => row.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** 鱼缸 · 小工具（纯函数，无 fs 依赖，便于测试）。 */

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

export function trunc(s, max) {
  const text = String(s ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function nowIso() {
  return new Date().toISOString()
}

export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function monthKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

export function splitFrontmatter(raw) {
  const text = String(raw ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    meta[m[1]] = m[2].trim()
  }
  if (meta.version !== undefined) {
    const n = Number(meta.version)
    if (Number.isFinite(n)) meta.version = n
  }
  if (meta.locked === 'true') meta.locked = true
  if (meta.locked === 'false') meta.locked = false
  return { meta, body: text.slice(match[0].length) }
}

/** 从 Message 里抽纯文本（容器形状不同版本可能不同，全部兼容）。 */
export function messageText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (content && typeof content.text === 'string') return content.text.trim()
  if (typeof message.text === 'string') return message.text.trim()
  return ''
}

export function sendJson(res, status, body) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
  } catch {
    try {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"error":"serialize failed"}')
    } catch {
      /* 客户端已断开 */
    }
  }
}

export function hashString(input) {
  let h = 5381
  const text = String(input ?? '')
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/** 工作区标识：basename + 路径 hash（不把完整机器路径写进记忆文件）。 */
export function workspaceTag(cwd) {
  const text = String(cwd ?? '').replace(/[\\/]+$/, '')
  const base = text.split(/[\\/]/).filter(Boolean).pop() || 'workspace'
  const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 24) || 'workspace'
  return { name: safe, hash: hashString(text), key: `${safe}-${hashString(text)}` }
}

/** 语句归一化：去空白/标点，用于粗判重。 */
export function normStatement(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。；：,.;:!?！？、"'“”‘’`（）()\[\]【】<>《》\-—_~·]+/g, '')
}

export function uniq(list) {
  return [...new Set(list)]
}

export function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}

/** 读取对象里的模式值（full / costume / off），非法值返回 undefined。 */
export function asMode(value) {
  return value === 'full' || value === 'costume' || value === 'off' ? value : undefined
}

/** 读取 HTTP 请求 JSON body（限制体积，防误发大包）。 */
export async function readJsonBody(req, maxBytes = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 鱼缸 · git 版本化：persona 目录本地 git（无远端），支持 diff / 回滚。
 *
 * 原则：
 *   - 只在 persona 家目录里 init，绝不 push；
 *   - journal/、config.json、state.json、overrides.json 不进库（隐私 + 太吵）；
 *   - 任何一次记忆写入后 commit（commit message 以 `fishbowl:` 开头）；
 *   - 回滚 = `git restore --source=<sha>` 再提交一个 rollback commit（不改写历史）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GITIGNORE = [
  '# 鱼缸：不版本化的运行时文件',
  'journal/',
  'config.json',
  'state.json',
  'overrides.json',
  '.remembered-migrated',
  '*.tmp-*',
  '*.bak',
  '*.unparsed-*',
  '',
].join('\n')

const TRACKED_PATHS = ['relationship.md', 'episodes', 'handoff', 'reports', 'soul.md', 'MEMORY.md', '.gitignore']

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fishbowl',
  GIT_AUTHOR_EMAIL: 'fishbowl@local',
  GIT_COMMITTER_NAME: 'fishbowl',
  GIT_COMMITTER_EMAIL: 'fishbowl@local',
  GIT_CONFIG_NOSYSTEM: '1',
}

export class GitRepo {
  constructor({ dir, enabled = true, log = () => {} }) {
    this.dir = dir
    this.enabled = enabled
    this._log = log
    this._available = null
  }

  _run(args, timeout = 15000) {
    try {
      return spawnSync('git', args, { cwd: this.dir, encoding: 'utf8', env: ENV, timeout })
    } catch (e) {
      return { status: -1, stderr: String(e?.message ?? e), stdout: '' }
    }
  }

  get available() {
    if (this._available !== null) return this._available
    if (!this.enabled) return (this._available = false)
    const probe = this._run(['--version'], 5000)
    if (probe.status !== 0) {
      this._available = false
      this._log('git 不可用，版本化降级关闭')
      return false
    }
    this._available = true
    return true
  }

  /** 确保家目录里有 git 仓库和 .gitignore（幂等）。 */
  ensure() {
    if (!this.available) return false
    try {
      if (!existsSync(join(this.dir, '.git'))) {
        const init = this._run(['init', '-q'])
        if (init.status !== 0) {
          this._available = false
          this._log(`git init 失败：${init.stderr?.trim() || init.status}`)
          return false
        }
      }
      const ignorePath = join(this.dir, '.gitignore')
      if (!existsSync(ignorePath)) writeFileSync(ignorePath, GITIGNORE, 'utf8')
      return true
    } catch (e) {
      this._log(`git ensure 失败：${e?.message ?? e}`)
      return false
    }
  }

  /** 有改动才 commit；返回 {sha, message} 或 null。 */
  commit(message) {
    if (!this.ensure()) return null
    const add = this._run(['add', '-A'])
    if (add.status !== 0) {
      this._log(`git add 失败：${add.stderr?.trim() || add.status}`)
      return null
    }
    const staged = this._run(['diff', '--cached', '--quiet'])
    if (staged.status === 0) return null
    const commit = this._run(['commit', '-q', '-m', message])
    if (commit.status !== 0) {
      this._log(`git commit 失败：${commit.stderr?.trim() || commit.status}`)
      return null
    }
    const head = this._run(['rev-parse', '--short', 'HEAD'])
    return { sha: head.stdout?.trim() || '', message }
  }

  log(n = 10) {
    if (!this.ensure()) return []
    const result = this._run(['log', `-n${Math.max(1, Math.min(50, n))}`, '--pretty=format:%h%x09%ad%x09%s', '--date=format:%Y-%m-%d %H:%M'])
    if (result.status !== 0) return []
    return String(result.stdout || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, date, ...rest] = line.split('\t')
        return { sha, date, message: rest.join('\t') }
      })
  }

  /** 把记忆文件恢复到某个 commit，再记一个 rollback commit。 */
  restore(sha) {
    if (!this.ensure()) return { ok: false, error: 'git 不可用' }
    if (!/^[0-9a-f]{4,40}$/i.test(String(sha || ''))) return { ok: false, error: 'sha 不合法' }
    const verify = this._run(['cat-file', '-e', `${sha}^{commit}`])
    if (verify.status !== 0) return { ok: false, error: `没有这个 commit：${sha}` }
    // 只回滚「目标 commit 里确实存在」的记忆文件（否则 pathspec 会报错）
    const tree = this._run(['ls-tree', '-r', '--name-only', sha])
    const paths = String(tree.stdout || '')
      .split('\n')
      .filter(Boolean)
      .filter((file) => TRACKED_PATHS.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)))
    if (paths.length === 0) return { ok: false, error: `commit ${sha} 里没有可回滚的记忆文件` }
    const restore = this._run(['restore', '--source', sha, '--', ...paths])
    if (restore.status !== 0) return { ok: false, error: restore.stderr?.trim() || 'git restore 失败' }
    const commit = this.commit(`fishbowl: rollback to ${String(sha).slice(0, 8)}`)
    return { ok: true, restoredTo: sha, commit }
  }

  head() {
    if (!this.ensure()) return null
    const result = this._run(['rev-parse', '--short', 'HEAD'])
    return result.status === 0 ? String(result.stdout || '').trim() : null
  }
}

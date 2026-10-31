/**
 * dsh-fishbowl / 鱼缸 —— 客户端（设置表单 + 只读面板）
 * ============================================================================
 * 位置：设置 → 鱼缸（settings.section slot）。
 * 数据：GET  /api/fishbowl/status（状态 + 生效配置）
 *       POST /api/fishbowl/config（保存面板设置，立即生效）
 *       POST /api/fishbowl/config/reset（丢弃面板设置，回到 profile patch）
 * 命令仍走 /remember /why /forget /persona。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-fishbowl',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MODE_OPTIONS = [
      { value: 'full', label: '完整（身份 + 记忆 + 召回）' },
      { value: 'costume', label: '工作人格（只带 Soul）' },
      { value: 'off', label: '关闭（不注入不捕获）' },
    ]

    const CSS = `
.fb-panel { --fb-ink: var(--dsw-alias-label-primary, light-dark(#101418, #f4f6f8));
  --fb-muted: var(--dsw-alias-label-secondary, light-dark(#61666b, #cfd3d6));
  --fb-line: var(--dsw-alias-border-l2, light-dark(#0000001a, #ffffff1f));
  --fb-card: var(--dsw-alias-bg-module-platform, light-dark(#f8f9fa, #2f3033));
  --fb-hover: var(--dsw-alias-interactive-bg-hover, light-dark(#2631480f, #ffffff14));
  color: var(--fb-ink); font-size: 13px; line-height: 20px; padding: 4px 2px 24px; max-width: 860px; }
.fb-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.fb-title { font-size: 16px; font-weight: 600; }
.fb-sub { color: var(--fb-muted); font-size: 12px; flex: 1; }
.fb-btn { border: 1px solid var(--fb-line); background: transparent; color: var(--fb-ink);
  border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
.fb-btn:hover { background: var(--fb-hover); }
.fb-btn.primary { background: var(--dsw-alias-brand-primary, var(--fb-ink)); color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent; }
.fb-btn:disabled { opacity: .5; cursor: default; }
.fb-badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px;
  padding: 1px 10px; font-size: 12px; border: 1px solid var(--fb-line); color: var(--fb-muted); }
.fb-dot { width: 7px; height: 7px; border-radius: 50%; background: #3c9d64; }
.fb-card { margin-top: 12px; border: 1px solid var(--fb-line); border-radius: 12px; background: var(--fb-card); padding: 12px 14px; }
.fb-form-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.fb-form-head strong { font-size: 14px; }
.fb-source { color: var(--fb-muted); font-size: 12px; flex: 1; text-align: right; }
.fb-field { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--fb-line); align-items: flex-start; }
.fb-field:last-child { border-bottom: 0; }
.fb-field-label { width: 116px; flex: none; color: var(--fb-muted); padding-top: 4px; }
.fb-field-body { flex: 1; min-width: 0; }
.fb-field-hint { color: var(--fb-muted); font-size: 12px; margin-top: 4px; }
.fb-input, .fb-select { box-sizing: border-box; border: 1px solid var(--fb-line); background: transparent;
  color: var(--fb-ink); border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 13px; max-width: 100%; }
.fb-input { width: 100%; }
.fb-select { min-width: 180px; }
.fb-toggle-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
.fb-toggle-row input { accent-color: var(--dsw-alias-brand-primary, #2478c9); width: 15px; height: 15px; margin: 0; }
.fb-ws { border: 1px solid var(--fb-line); border-radius: 10px; padding: 8px 10px; margin: 6px 0; }
.fb-ws-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.fb-ws-path { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.fb-ws-empty { color: var(--fb-muted); font-size: 12px; }
.fb-ws-add { display: flex; gap: 8px; margin-top: 8px; }
.fb-ws-add .fb-input { flex: 1; }
.fb-mini { border: 1px solid var(--fb-line); background: transparent; color: var(--fb-muted);
  border-radius: 7px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
.fb-mini:hover { background: var(--fb-hover); color: var(--fb-ink); }
.fb-actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.fb-msg { margin-top: 8px; font-size: 12px; }
.fb-msg.ok { color: #2f8a55; }
.fb-msg.err { color: #c0392b; white-space: pre-wrap; }
.fb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 10px; }
.fb-stat { border: 1px solid var(--fb-line); border-radius: 10px; padding: 8px 12px; background: var(--fb-card); }
.fb-stat-num { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.fb-stat-label { color: var(--fb-muted); font-size: 12px; }
.fb-section-title { font-weight: 600; margin: 16px 0 2px; }
.fb-empty { color: var(--fb-muted); }
.fb-list { margin: 4px 0 0; padding-left: 18px; }
.fb-list li { margin: 3px 0; overflow-wrap: anywhere; }
.fb-kind { display: inline-block; min-width: 44px; color: var(--fb-muted); font-size: 12px; }
.fb-foot { margin-top: 14px; color: var(--fb-muted); font-size: 12px; }
.fb-error { color: #c0392b; white-space: pre-wrap; overflow-wrap: anywhere; }
.fb-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`

    const KIND_LABEL = {
      preference: '偏好',
      boundary: '边界',
      ritual: '仪式',
      promise: '承诺',
      context: '近况',
      open_question: '待定',
      episode: '情节',
    }
    const MODE_LABEL = { full: '完整', costume: '工作人格', off: '关闭' }
    const asText = (value) => (value === null || value === undefined || value === '' ? '—' : String(value))
    const clone = (value) => JSON.parse(JSON.stringify(value))

    const Row = (label, value, hint) =>
      h(
        'div',
        { className: 'fb-field' },
        h('div', { className: 'fb-field-label' }, label),
        h('div', { className: 'fb-field-body' }, value, hint ? h('div', { className: 'fb-field-hint' }, hint) : null),
      )

    const Stat = (num, label) =>
      h('div', { className: 'fb-stat' }, h('div', { className: 'fb-stat-num' }, String(num)), h('div', { className: 'fb-stat-label' }, label))

    const Select = (value, options, onChange) =>
      h(
        'select',
        { className: 'fb-select', value, onChange: (event) => onChange(event.target.value) },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )

    const Toggle = (label, checked, onChange, hint) =>
      h(
        'div',
        null,
        h(
          'label',
          { className: 'fb-toggle-row' },
          h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
          h('span', null, label),
        ),
        hint ? h('div', { className: 'fb-field-hint' }, hint) : null,
      )

    function Panel(props) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [form, setForm] = React.useState(null)
      const [newWorkspace, setNewWorkspace] = React.useState('')
      const [save, setSave] = React.useState({ busy: false, ok: null, error: null })
      const formInitialized = React.useRef(false)

      const applyData = React.useCallback((data) => {
        setState({ phase: 'ready', data, error: null })
        setForm(clone(data.config?.effective || {}))
        formInitialized.current = true
      }, [])

      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/api/fishbowl/status', {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          setState({ phase: 'ready', data, error: null })
          if (!formInitialized.current && data.config?.effective) {
            setForm(clone(data.config.effective))
            formInitialized.current = true
          }
        } catch (error) {
          setState({ phase: 'error', data: null, error: String(error?.message || error) })
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        load()
        const timer = setInterval(() => {
          if (alive) load()
        }, 20000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))

      const saveConfig = async () => {
        if (!form) return
        setSave({ busy: true, ok: null, error: null })
        try {
          const res = await fetch('/api/fishbowl/config', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(form),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          applyData(data)
          setSave({ busy: false, ok: '已保存并生效：新会话立即按新配置接管，在线会话已重挂注入。', error: null })
        } catch (error) {
          setSave({ busy: false, ok: null, error: `保存失败：${String(error?.message || error)}` })
        }
      }

      const resetConfig = async () => {
        setSave({ busy: true, ok: null, error: null })
        try {
          const res = await fetch('/api/fishbowl/config/reset', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          applyData(data)
          setSave({ busy: false, ok: `已重置为 profile patch 配置${data.reset ? '' : '（本来就没有面板设置）'}。`, error: null })
        } catch (error) {
          setSave({ busy: false, ok: null, error: `重置失败：${String(error?.message || error)}` })
        }
      }

      const addWorkspace = () => {
        const path = newWorkspace.trim()
        if (!path) {
          setSave({ busy: false, ok: null, error: '工作区路径不能为空（要绝对路径，比如 /Users/你/Documents/某个目录）。' })
          return
        }
        if ((form.enabledWorkspaces || []).includes(path)) {
          setSave({ busy: false, ok: null, error: '这个工作区已经在列表里了。' })
          return
        }
        update('enabledWorkspaces', [...(form.enabledWorkspaces || []), path])
        setNewWorkspace('')
        setSave({ busy: false, ok: null, error: null })
      }

      const removeWorkspace = (path) => {
        const modes = { ...(form.workspaceModes || {}) }
        delete modes[path]
        setForm((current) => ({
          ...current,
          enabledWorkspaces: (current.enabledWorkspaces || []).filter((item) => item !== path),
          workspaceModes: modes,
        }))
      }

      const setWorkspaceMode = (path, mode) => {
        const modes = { ...(form.workspaceModes || {}) }
        if (mode) modes[path] = mode
        else delete modes[path]
        update('workspaceModes', modes)
      }

      const [m2Busy, setM2Busy] = React.useState('')
      const [m2Msg, setM2Msg] = React.useState(null)
      const refreshData = React.useCallback((data) => setState({ phase: 'ready', data, error: null }), [])
      const runConsolidate = async (dry) => {
        setM2Busy(dry ? 'dry' : 'run')
        setM2Msg(null)
        try {
          const res = await fetch('/api/fishbowl/consolidate', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ dry: Boolean(dry) }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          refreshData(data)
          const result = data.consolidated || {}
          const curator = result.curator || {}
          setM2Msg({
            ok: true,
            text: `${dry ? 'dry-run：' : ''}journal ${result.journalLines ?? 0} 行，入队 ${result.queued ?? 0}，合并 ${result.merged ?? 0}，衰减 ${result.decayed ?? 0}，stale ${result.staled ?? 0}；curator ${curator.status || 'off'}${curator.error ? `（${curator.error}）` : ''}${result.commit ? `；commit ${result.commit.sha}` : ''}`,
          })
        } catch (error) {
          setM2Msg({ ok: false, text: `整理失败：${String(error?.message || error)}` })
        } finally {
          setM2Busy('')
        }
      }
      const decideReview = async (id, action) => {
        setM2Busy(id)
        setM2Msg(null)
        try {
          const res = await fetch('/api/fishbowl/review', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id, action }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          refreshData(data)
          setM2Msg({ ok: true, text: `${action === 'approve' ? '已通过' : '已丢弃'} ${id}` })
        } catch (error) {
          setM2Msg({ ok: false, text: `审核失败：${String(error?.message || error)}` })
        } finally {
          setM2Busy('')
        }
      }
      const decideAll = async (action) => {
        const ids = [
          ...((data.review && data.review.queue) || []).map((item) => item.id),
          ...((data.review && data.review.drafts) || []).map((entry) => entry.id),
        ]
        if (ids.length === 0) return
        setM2Busy('all')
        setM2Msg(null)
        const failed = []
        for (const id of ids) {
          try {
            const res = await fetch('/api/fishbowl/review', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ id, action }),
            })
            const payload = await res.json()
            if (!res.ok || !payload.ok) failed.push(`${id}: ${payload.error || res.status}`)
          } catch (error) {
            failed.push(`${id}: ${String(error?.message || error)}`)
          }
        }
        try {
          const statusRes = await fetch('/api/fishbowl/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
          const statusData = await statusRes.json()
          if (statusData.ok) refreshData(statusData)
        } catch {
          /* 忽略 */
        }
        setM2Msg({ ok: failed.length === 0, text: failed.length === 0 ? `已${action === 'approve' ? '全部通过' : '全部丢弃'} ${ids.length} 条` : `部分失败：${failed.join('；')}` })
        setM2Busy('')
      }

      const [m3Busy, setM3Busy] = React.useState('')
      const [m3Msg, setM3Msg] = React.useState(null)
      const [mineSessions, setMineSessions] = React.useState(null)
      const [exportDir, setExportDir] = React.useState('')
      const pickExportDir = async () => {
        try {
          const dir = props && typeof props.pickDirectory === 'function' ? await props.pickDirectory() : null
          if (dir) {
            setExportDir(dir)
            setM3Msg({ ok: true, text: `导出位置已选：${dir}（会在里面新建一个 fishbowl-export-日期-时间 文件夹）` })
          }
        } catch (error) {
          setM3Msg({ ok: false, text: `选择文件夹失败：${String(error?.message || error)}。也可以直接输入绝对路径。` })
        }
      }
      const scanMine = async () => {
        setM3Busy('scan')
        setM3Msg(null)
        try {
          const res = await fetch('/api/fishbowl/mine', { credentials: 'same-origin', headers: { accept: 'application/json' } })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          setMineSessions(data.sessions || [])
          setM3Msg({ ok: true, text: `扫描到 ${(data.sessions || []).length} 段旧会话（只列标题，不读内容）。` })
        } catch (error) {
          setM3Msg({ ok: false, text: `扫描失败：${String(error?.message || error)}` })
        } finally {
          setM3Busy('')
        }
      }
      const runMine = async (sessionId) => {
        setM3Busy(sessionId)
        setM3Msg(null)
        try {
          const res = await fetch('/api/fishbowl/mine', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          refreshData(data)
          const mined = data.mined || {}
          setM3Msg({
            ok: true,
            text: mined.status === 'noop' ? '这段会话没提炼出值得记的事。' : `提炼完成：提议 ${mined.queued ?? 0} 条，全部进待审（点上方「通过」才写入）。`,
          })
        } catch (error) {
          setM3Msg({ ok: false, text: `提炼失败：${String(error?.message || error)}` })
        } finally {
          setM3Busy('')
        }
      }
      const exportBundle = async () => {
        setM3Busy('export')
        setM3Msg(null)
        try {
          const res = await fetch('/api/fishbowl/export', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(exportDir.trim() ? { parentDir: exportDir.trim() } : {}),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          refreshData(data)
          const exported = data.exported || {}
          if (exported.parentDir) setExportDir(exported.parentDir)
          setM3Msg({ ok: true, text: `已导出到：${exported.dir}（${exported.files ?? 0} 个文件 / ${exported.entries ?? 0} 条记忆）` })
        } catch (error) {
          setM3Msg({ ok: false, text: `导出失败：${String(error?.message || error)}` })
        } finally {
          setM3Busy('')
        }
      }

      const undoAuto = async (id) => {
        setM2Busy(id)
        setM2Msg(null)
        try {
          const res = await fetch('/api/fishbowl/auto-log', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id, action: 'undo' }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          refreshData(data)
          setM2Msg({ ok: true, text: `已撤销 ${id}（改动已回滚，git 有记录）` })
        } catch (error) {
          setM2Msg({ ok: false, text: `撤销失败：${String(error?.message || error)}` })
        } finally {
          setM2Busy('')
        }
      }

      const togglePin = async (id, pinned) => {
        setM2Busy(id)
        setM2Msg(null)
        try {
          const res = await fetch('/api/fishbowl/pin', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id, pinned }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          refreshData(data)
          setM2Msg({ ok: true, text: pinned ? '已钉住：整理时不会合并、不会衰减，/forget 也会先拦一下。' : '已取消钉住：之后正常参与合并和衰减。' })
        } catch (error) {
          setM2Msg({ ok: false, text: `操作失败：${String(error?.message || error)}` })
        } finally {
          setM2Busy('')
        }
      }

      const head = h(
        'div',
        { className: 'fb-head' },
        h('div', { className: 'fb-title' }, '鱼缸 / Fishbowl'),
        h('div', { className: 'fb-sub' }, state.data ? `v${asText(state.data.version)} · ${asText(state.data.stage)}` : 'v0.3.1'),
        h('button', { className: 'fb-btn', onClick: load, type: 'button' }, '刷新'),
      )

      if (state.phase === 'loading') {
        return h('div', { className: 'fb-panel' }, head, h('div', { className: 'fb-card fb-empty' }, '咕噜… 正在问 Host 要状态。'))
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'fb-panel' },
          head,
          h(
            'div',
            { className: 'fb-card' },
            h('div', { className: 'fb-error' }, `面板拿不到 Host 状态：${state.error}`),
            h('div', { className: 'fb-foot' }, 'M1.5 代码需要重载插件后才生效；仍失败看 Host 日志里以 [fishbowl] 开头的行。'),
          ),
        )
      }

      if (!form) {
        return h('div', { className: 'fb-panel' }, head, h('div', { className: 'fb-card fb-empty' }, '正在加载配置…'))
      }

      const data = state.data
      const soul = data.persona || {}
      const counts = data.counts || {}
      const rel = counts.relationship || {}
      const journal = counts.journal || {}
      const config = data.config || {}
      const effective = config.effective || {}
      const recent = data.recent || []
      const drafts = data.drafts || []
      const review = data.review || { pending: 0, queue: [], drafts: [] }
      const consolidation = data.consolidation || {}
      const git = data.git || { commits: [] }
      const reports = data.reports || {}
      const health = data.health || { score: null, checks: [] }
      const curator = data.curator || {}
      const m3Info = data.m3Info || {}
      const conflict = data.conflict || { mode: 'safe', threshold: 0.85, autoActions: [], stats7d: {} }
      const globalScope = effective.scope === 'global'
      const workspaces = effective.enabledWorkspaces || []
      const modes = effective.workspaceModes || {}
      const dirty = form && JSON.stringify(form) !== JSON.stringify(effective)

      return h(
        'div',
        { className: 'fb-panel' },
        head,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '2px', flexWrap: 'wrap' } },
          h('span', { className: 'fb-badge' }, h('span', { className: 'fb-dot' }), globalScope ? '全局作用域' : `${workspaces.length} 个工作区`),
          h('span', { className: 'fb-badge' }, `默认 ${MODE_LABEL[effective.defaultMode] || asText(effective.defaultMode)}`),
          h('span', { className: 'fb-badge' }, `配置 ${config.source === 'panel' ? '面板' : 'patch'}`),
          h('span', { className: 'fb-badge' }, `召回 ${effective.recallEnabled ? '开' : '关'}`),
          h('span', { className: 'fb-badge' }, `整理 ${consolidation.lastAt ? '有' : '未'}`),
          h('span', { className: 'fb-badge' }, `📌 ${rel.pinned ?? 0} 钉住`),
          h('span', { className: 'fb-badge' }, `待审 ${review.pending ?? 0}`),
        ),
        h(
          'div',
          { className: 'fb-card' },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '鱼缸在做什么'),
          h(
            'div',
            { className: 'fb-field-hint', style: { fontSize: '13px', lineHeight: '22px' } },
            '一句话：让她换窗口、换项目、换模型之后还是她。① 记住她是谁（Soul 身份证）② 记住你们之间的事（关系/情节/交接条）③ 聊天时按话题把相关旧事捞出来给她看（召回）。',
          ),
          h(
            'div',
            { className: 'fb-field-hint', style: { marginTop: '4px' } },
            '下面的设置只决定「怎么记、记多深、记完怎么整理」，不影响上面的身份本身；Soul 只能由你改。',
          ),
        ),
        h(
          'div',
          { className: 'fb-card fb-form' },
          h(
            'div',
            { className: 'fb-form-head' },
            h('strong', null, '接管设置'),
            h(
              'span',
              { className: 'fb-source' },
              config.updatedAt ? `面板保存于 ${String(config.updatedAt).slice(0, 16).replace('T', ' ')}` : '由 profile patch 提供默认值',
            ),
          ),
          Row(
            '作用域',
            Select(
              form.scope,
              [
                { value: 'workspace', label: '按工作区（推荐）' },
                { value: 'global', label: '全局（所有工作区）' },
              ],
              (value) => update('scope', value),
            ),
            '按工作区：只有列表里的工作区会被接管；全局：所有会话都接管。',
          ),
          Row(
            '默认模式',
            Select(form.defaultMode, MODE_OPTIONS, (value) => update('defaultMode', value)),
            '没有单独设置的工作区用这个模式；full 注入身份+记忆+召回，costume 只带 Soul，off 完全不碰。',
          ),
          h(
            'div',
            { className: 'fb-field' },
            h('div', { className: 'fb-field-label' }, '工作区'),
            h(
              'div',
              { className: 'fb-field-body' },
              workspaces.length === 0
                ? h('div', { className: 'fb-ws-empty' }, '还没有工作区。加一个绝对路径才能开始接管。')
                : h(
                    'div',
                    { className: 'fb-ws' },
                    workspaces.map((path) =>
                      h(
                        'div',
                        { className: 'fb-ws-row', key: path },
                        h('span', { className: 'fb-ws-path' }, path),
                        h(
                          'select',
                          {
                            className: 'fb-select',
                            style: { minWidth: '132px' },
                            value: modes[path] || '',
                            onChange: (event) => setWorkspaceMode(path, event.target.value),
                          },
                          h('option', { value: '' }, '用默认模式'),
                          MODE_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
                        ),
                        h('button', { className: 'fb-mini', type: 'button', onClick: () => removeWorkspace(path) }, '移除'),
                      ),
                    ),
                  ),
              h(
                'div',
                { className: 'fb-ws-add' },
                h('input', {
                  className: 'fb-input',
                  placeholder: '/Users/you/Documents/your-workspace',
                  value: newWorkspace,
                  onChange: (event) => setNewWorkspace(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') addWorkspace()
                  },
                }),
                h('button', { className: 'fb-btn', type: 'button', onClick: addWorkspace }, '加工作区'),
              ),
              h('div', { className: 'fb-field-hint' }, '工作区必须是已存在的目录；保存时 Host 会校验。'),
            ),
          ),
          Row(
            '注入开关',
            h(
              'div',
              null,
              Toggle('Soul 身份注入', form.injectSoul, (value) => update('injectSoul', value), 'Soul = 她的身份证：她是谁、怎么说话、什么不能做。关掉就等于「她失忆了」，一般别关。'),
              Toggle('每轮 journal 捕获', form.journalEnabled, (value) => update('journalEnabled', value), '每轮把对话原文存一份日记（只存本机、不注入，整理时从这里提炼）。关掉就不存了。'),
              Toggle('交接条 handoff', form.handoffEnabled, (value) => update('handoffEnabled', value), '交接条 = 每次会话结束写一张「上次停在哪」的小纸条，下次新会话开头自动读给她，换窗口不断片。关掉就不写也不读。'),
              Toggle('相关旧记忆召回', form.recallEnabled, (value) => update('recallEnabled', value), '聊天时按当前话题，从记忆库里捞最相关的几条旧事给她看（是回忆，不是指令）。'),
            ),
          ),
          Row(
            '召回条数',
            Select(
              String(form.maxRecall),
              [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} 条／轮` })),
              (value) => update('maxRecall', Number(value)),
            ),
            '默认 3 条；召回总量还有 900 字上限。',
          ),
          Row(
            '整理与版本',
            h(
              'div',
              null,
              Toggle('自动整理', form.autoConsolidate, (value) => update('autoConsolidate', value), '到点自动整理：把日记压成记忆卡片（规则整理）+ 让大模型提炼要点（curator），结果先进待审队列，不会直接改她。'),
              Toggle('大模型 curator', form.curatorUseLlm, (value) => update('curatorUseLlm', value), '用大模型从聊天日记里提炼值得记的事。它只提议：关系类记忆要你审核通过才生效；失败自动降级为只做规则整理。'),
              Toggle('置信度衰减', form.decayEnabled, (value) => update('decayEnabled', value), '记忆会变旧：久没被提起的条目慢慢降权，太旧的标成 stale 不再注入，但不会删；钉住的永不衰减。'),
              Toggle('周报', form.weeklyReport, (value) => update('weeklyReport', value), '每周生成一页总结：新记住什么、哪些待审、体检多少分。'),
              Toggle('git 本地版本化', form.gitEnabled, (value) => update('gitEnabled', value), '给记忆文件夹装存档：每次改动存一版，/persona log 看历史、/persona rollback 退回旧版。'),
            ),
            '改完点「保存并生效」。',
          ),
          Row(
            '整理间隔',
            Select(
              String(form.curatorIntervalHours),
              [6, 12, 24, 48, 168].map((n) => ({ value: String(n), label: `每 ${n} 小时` })),
              (value) => update('curatorIntervalHours', Number(value)),
            ),
            '多久自动整理一次；默认 24 小时。到点后下次启动或保存配置时补跑。',
          ),
          Row(
            '冲突自动处理',
            Select(
              form.conflictAutoMode,
              [
                { value: 'off', label: 'off · 全部人工审核' },
                { value: 'safe', label: 'safe · 低风险自动（推荐）' },
                { value: 'balanced', label: 'balanced · 再加高置信取代' },
              ],
              (value) => update('conflictAutoMode', value),
            ),
            '整理时发现记忆互相矛盾：safe 自动处理「去重/补细节/新增约束/明确纠错」，称呼、边界、低置信仍进待审；balanced 再把高置信「新事实取代旧事实」也自动处理。自动动作都可撤销。',
          ),
          h(
            'div',
            { className: 'fb-actions' },
            h(
              'button',
              { className: 'fb-btn primary', type: 'button', disabled: save.busy || !dirty, onClick: saveConfig },
              save.busy ? '保存中…' : dirty ? '保存并生效' : '没有改动',
            ),
            h('button', { className: 'fb-btn', type: 'button', disabled: save.busy, onClick: resetConfig }, '重置为 patch'),
            dirty ? h('span', { className: 'fb-foot' }, '有未保存改动') : null,
          ),
          save.ok ? h('div', { className: 'fb-msg ok' }, save.ok) : null,
          save.error ? h('div', { className: 'fb-msg err' }, save.error) : null,
          h(
            'div',
            { className: 'fb-field-hint', style: { marginTop: '10px' } },
            `设置文件：${asText(config.file)}（面板写入，优先级高于 profile patch；担心的话随时「重置为 patch」）`,
          ),
        ),
        h(
          'div',
          { className: 'fb-card' },
          h(
            'div',
            { className: 'fb-form-head' },
            h('strong', null, '自动整理 · 记忆审核 · 版本存档'),
            h(
              'span',
              { className: 'fb-source' },
              `自动整理 ${curator.autoConsolidate ? '开' : '关'} · 每 ${curator.intervalHours || 24}h · curator ${curator.useLlm ? 'LLM' : '仅规则'}`,
            ),
          ),
          Row(
            '整理',
            consolidation.lastAt ? `${String(consolidation.lastAt).slice(0, 16).replace('T', ' ')} · ${consolidation.lastTrigger || ''}` : '还没整理过',
            consolidation.lastCurator
              ? `上次 curator：${consolidation.lastCurator.status}${consolidation.lastCurator.error ? `（${consolidation.lastCurator.error}）` : ''} · ${consolidation.lastCurator.provider || ''}/${consolidation.lastCurator.model || ''}`
              : 'curator 还没跑过',
          ),
          h(
            'div',
            { className: 'fb-actions' },
            h('button', { className: 'fb-btn primary', type: 'button', disabled: Boolean(m2Busy), onClick: () => runConsolidate(false) }, m2Busy === 'run' ? '整理中…' : '立即整理'),
            h('button', { className: 'fb-btn', type: 'button', disabled: Boolean(m2Busy), onClick: () => runConsolidate(true) }, m2Busy === 'dry' ? 'dry-run…' : 'dry-run'),
          ),
          h(
            'div',
            { className: 'fb-field-hint', style: { marginTop: '6px' } },
            '整理 = 把日记压成记忆卡片（规则整理），再让大模型提炼要点（curator）；结果先进待审队列，不会直接改她。立即整理 = 现在跑一次；dry-run = 只预览会做什么，不落盘、不调模型、不花钱。',
          ),
          m2Msg ? h('div', { className: m2Msg.ok ? 'fb-msg ok' : 'fb-msg err' }, m2Msg.text) : null,
          Row(
            '身份体检',
            `${health.score ?? '?'} 分`,
            `体检 = 用 6 条硬指标看她的连续性还在不在。${(health.checks || []).map((check) => `${check.ok ? '✅' : '⚠️'} ${check.label}（${check.detail}）`).join('；')}`,
          ),
          Row(
            '报告',
            reports.latest ? reports.latest.file : '还没有',
            `报告 = 每次整理的动作清单（改了啥、为什么）；周报 = 每周一页总结。都是给你看的，不会注入给她。${reports.latest ? `本次预览：${String(reports.latest.preview || '').slice(0, 180)}` : '跑一次整理就会生成。'}`,
          ),
          Row(
            '版本',
            git.available ? `git 可用 · HEAD ${git.head || '空'}` : git.enabled ? 'git 不可用' : 'git 已关闭',
            `版本 = 记忆文件的存档历史，出问题能退回旧版。${(git.commits || []).slice(0, 5).map((commit) => `${commit.sha} ${commit.message}`).join('；') || '还没有提交'}`,
          ),
          h('div', { className: 'fb-section-title' }, `待审（${review.pending ?? 0}）`),
          h(
            'div',
            { className: 'fb-field-hint' },
            '审核 = 整理/大模型提议的改动先放这里等你点头：通过才写进她的记忆，丢弃就作废。带「旧 → 新」的是修改类提议。',
          ),
          (review.queue || []).length + (review.drafts || []).length === 0
            ? h('div', { className: 'fb-empty' }, '没有待审项。')
            : h(
                'ul',
                { className: 'fb-list' },
                (review.queue || []).map((item) =>
                  h(
                    'li',
                    { key: item.id },
                    h('span', { className: 'fb-kind' }, `${item.relation ? `${item.relation} · ` : ''}${item.op}/${item.kind}`),
                    `${item.id} · `,
                    item.target_snapshot
                      ? h(
                          'span',
                          null,
                          `旧：${item.target_snapshot.statement}${item.target_snapshot.pinned ? '（📌 钉住）' : ''} → 新：${item.op === 'forget' ? '（遗忘）' : item.statement}`,
                        )
                      : item.statement,
                    `（${item.source === 'curator' ? '大模型提议' : '规则候选'}） `,
                    h('button', { className: 'fb-mini', type: 'button', disabled: Boolean(m2Busy), onClick: () => decideReview(item.id, 'approve') }, '通过'),
                    h('button', { className: 'fb-mini', type: 'button', disabled: Boolean(m2Busy), onClick: () => decideReview(item.id, 'reject') }, '丢弃'),
                  ),
                ),
                (review.drafts || []).map((entry) =>
                  h(
                    'li',
                    { key: entry.id },
                    h('span', { className: 'fb-kind' }, `草稿/${entry.kind}`),
                    `${entry.id} · ${entry.statement} `,
                    h('button', { className: 'fb-mini', type: 'button', disabled: Boolean(m2Busy), onClick: () => decideReview(entry.id, 'approve') }, '通过'),
                    h('button', { className: 'fb-mini', type: 'button', disabled: Boolean(m2Busy), onClick: () => decideReview(entry.id, 'reject') }, '丢弃'),
                  ),
                ),
              ),
          (review.pending ?? 0) > 0
            ? h(
                'div',
                { className: 'fb-actions' },
                h('button', { className: 'fb-btn', type: 'button', disabled: Boolean(m2Busy), onClick: () => decideAll('approve') }, '全部通过'),
                h('button', { className: 'fb-btn', type: 'button', disabled: Boolean(m2Busy), onClick: () => decideAll('reject') }, '全部丢弃'),
              )
            : null,
        ),
        h(
          'div',
          { className: 'fb-card' },
          h(
            'div',
            { className: 'fb-form-head' },
            h('strong', null, '搬家与提炼'),
            h(
              'span',
              { className: 'fb-source' },
              m3Info.sessionQuery ? '旧会话接口可用' : '旧会话接口不可用（无法提炼）',
            ),
          ),
          h(
            'div',
            { className: 'fb-field-hint' },
            '旧会话提炼 = 从以前的工作区会话里提炼记忆（结果全部进待审，不直接写）；导出 = 把 Soul/关系/情节/交接打包成一个目录，方便备份或搬去别的地方；导入 = 用命令把别的插件的记忆文件变成草稿。',
          ),
          Row(
            '旧会话提炼',
            h(
              'div',
              null,
              h('button', { className: 'fb-btn', type: 'button', disabled: Boolean(m3Busy), onClick: scanMine }, m3Busy === 'scan' ? '扫描中…' : '扫描旧会话'),
              mineSessions === null
                ? h('span', { className: 'fb-field-hint' }, ' 先扫描；只列已启用工作区的会话标题，不读内容。')
                : h(
                    'ul',
                    { className: 'fb-list', style: { maxHeight: '220px', overflow: 'auto' } },
                    mineSessions.map((item) =>
                      h(
                        'li',
                        { key: item.id },
                        h('span', { className: 'fb-kind' }, item.workspace || ''),
                        `${item.shortId} · ${String(item.title || '').slice(0, 48)} `,
                        h(
                          'button',
                          { className: 'fb-mini', type: 'button', disabled: Boolean(m3Busy), onClick: () => runMine(item.id) },
                          m3Busy === item.id ? '提炼中…' : '提炼',
                        ),
                      ),
                    ),
                  ),
            ),
            m3Info.lastMine
              ? `上次提炼：${m3Info.lastMine.status} · 提议 ${m3Info.lastMine.queued ?? 0} 条 · ${String(m3Info.lastMine.at || '').slice(0, 16).replace('T', ' ')}`
              : '提炼结果会进上方「待审」，你点通过才写进记忆。',
          ),
          Row(
            '导出',
            h(
              'div',
              null,
              h(
                'div',
                { className: 'fb-ws-add' },
                h('input', {
                  className: 'fb-input',
                  placeholder: '导出到哪个文件夹（绝对路径；留空 = ~/Downloads）',
                  value: exportDir || m3Info.defaultExportParent || '',
                  onChange: (event) => setExportDir(event.target.value),
                }),
                h('button', { className: 'fb-btn', type: 'button', disabled: Boolean(m3Busy), onClick: pickExportDir }, '选择文件夹…'),
                h('button', { className: 'fb-btn primary', type: 'button', disabled: Boolean(m3Busy), onClick: exportBundle }, m3Busy === 'export' ? '导出中…' : '导出记忆包'),
              ),
            ),
            m3Info.lastExport
              ? `上次导出：${m3Info.lastExport.dir}（${m3Info.lastExport.entries ?? 0} 条记忆）`
              : '会在你选的文件夹里新建 fishbowl-export-<日期-时间>/；含 fishbowl-export.json 清单，不含 journal/账号/密钥。',
          ),
          Row(
            '导入',
            h('span', { className: 'fb-code' }, '/persona import-memory <auto-memory|mnemon|surfcore|md|json> <文件>'),
            '导入的是「草稿」，不参与注入；确认没问题后 /persona approve 转正。',
          ),
          m3Msg ? h('div', { className: m3Msg.ok ? 'fb-msg ok' : 'fb-msg err' }, m3Msg.text) : null,
        ),
        h(
          'div',
          { className: 'fb-card' },
          h(
            'div',
            { className: 'fb-form-head' },
            h('strong', null, '冲突与自动处理'),
            h(
              'span',
              { className: 'fb-source' },
              `模式 ${conflict.mode || 'safe'} · 阈值 ${conflict.threshold ?? 0.85} · 近 7 天 ${Object.entries(conflict.stats7d || {}).map(([key, value]) => `${key} ${value}`).join(' / ') || '无'}`,
            ),
          ),
          h(
            'div',
            { className: 'fb-field-hint' },
            '自动处理 = 整理发现记忆矛盾时，低风险改动直接应用（去重、补细节、新增约束、明确纠错），并在这里留记录；称呼/边界/低置信仍进「待审」。每一条都能撤销。',
          ),
          (conflict.autoActions || []).length === 0
            ? h('div', { className: 'fb-empty' }, '还没有自动处理记录。')
            : h(
                'ul',
                { className: 'fb-list' },
                (conflict.autoActions || []).map((action) =>
                  h(
                    'li',
                    { key: action.id },
                    h('span', { className: 'fb-kind' }, action.relation),
                    `${action.id} · ${action.status === 'undone' ? '已撤销' : '生效中'} · ${action.statement}`,
                    action.targetStatement ? h('div', { className: 'fb-field-hint' }, `旧：${action.targetStatement}`) : null,
                    action.status === 'undone'
                      ? null
                      : h(
                          'button',
                          { className: 'fb-mini', type: 'button', disabled: Boolean(m2Busy), onClick: () => undoAuto(action.id) },
                          '撤销',
                        ),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'fb-grid' },
          Stat(rel.active ?? 0, 'active 记忆'),
          Stat(rel.draft ?? 0, '草稿待审'),
          Stat(rel.needsReview ?? 0, 'needs_review'),
          Stat(counts.episodes ?? 0, '情节卡'),
          Stat(journal.todayLines ?? 0, '今日 journal 行'),
          Stat(counts.handoffHoursAgo === null || counts.handoffHoursAgo === undefined ? '—' : counts.handoffHoursAgo, '交接（小时前）'),
        ),
        h(
          'div',
          { className: 'fb-card' },
          Row('人设', asText(soul.name || soul.id), `persona 目录：${asText(soul.dir)}（persona 只能改 profile patch）`),
          Row('Soul', `v${asText(soul.soulVersion)} · ${asText(soul.soulBytes)} 字`, '注入在 agent 作用域；字节稳定，换会话不重复堆叠。'),
          Row('本会话开关', '/persona off · /persona on', '会话级关闭/恢复，持久化在 overrides.json；面板这里是全局设置，不改会话级覆盖。'),
          Row(
            '交接 / 日记',
            `handoff ${counts.handoffHoursAgo === null || counts.handoffHoursAgo === undefined ? '无' : `${counts.handoffHoursAgo} 小时前`} · journal ${journal.days ?? 0} 天`,
            'handoff 在新会话 session-start 注入；resume 不重复注入。',
          ),
        ),
        h('div', { className: 'fb-section-title' }, `最近 active 记忆（${rel.active ?? 0}）`),
        h(
          'div',
          { className: 'fb-card' },
          recent.length === 0
            ? h('div', { className: 'fb-empty' }, '还没有。试一句：/remember 用户喜欢先给结论再解释。')
            : h(
                'ul',
                { className: 'fb-list' },
                recent.map((entry) =>
                  h(
                    'li',
                    { key: entry.id },
                    h('span', { className: 'fb-kind' }, KIND_LABEL[entry.kind] || entry.kind),
                    entry.pinned ? '📌 ' : '',
                    entry.statement,
                    h('span', { className: 'fb-foot' }, `  · conf ${entry.confidence} · ${entry.updated_at} `),
                    h(
                      'button',
                      { className: 'fb-mini', type: 'button', disabled: Boolean(m2Busy), onClick: () => togglePin(entry.id, !entry.pinned) },
                      entry.pinned ? '取消钉住' : '钉住',
                    ),
                  ),
                ),
              ),
        ),
        drafts.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'fb-section-title' }, `待审草稿（${rel.draft ?? 0} + ${rel.needsReview ?? 0}）`),
              h(
                'div',
                { className: 'fb-card' },
                h(
                  'ul',
                  { className: 'fb-list' },
                  drafts.map((entry) =>
                    h('li', { key: entry.id }, h('span', { className: 'fb-kind' }, KIND_LABEL[entry.kind] || entry.kind), entry.statement),
                  ),
                ),
                h('div', { className: 'fb-foot' }, '会话里发 /persona review 看全量、/persona approve 转正、/persona reject 丢弃。'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'fb-foot' },
          '命令：/remember · /why · /forget · /pin · /unpin · /persona off|on|consolidate|review|approve|reject|auto|undo-auto|mine|export|import-memory|health|report|log|rollback。Soul 只能由用户改。',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-fishbowl')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(
          () => () => {
            style.remove()
          },
          'dsh-fishbowl: 面板样式',
        )

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        // 原生文件夹选择器（Client uiWorkspace 服务）；拿不到就退化成手输绝对路径
        const pickDirectory = async () => {
          try {
            const workspaceService =
              (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined) || ctx.uiWorkspace
            if (workspaceService && typeof workspaceService.pickDirectory === 'function') {
              return await workspaceService.pickDirectory()
            }
          } catch {
            /* 没有选择器就让用户手输 */
          }
          return null
        }
        ctx.effect(
          () =>
            slots.inject('settings.section', () =>
              slots.register({ name: 'settings.section', id: 'fishbowl', order: 45, label: '鱼缸' }, () =>
                h(Panel, { pickDirectory }),
              ),
            ),
          'dsh-fishbowl: 设置页',
        )
      },
    }
  },
})

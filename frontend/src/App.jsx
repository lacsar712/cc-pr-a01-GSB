import { useEffect, useState } from 'react'

export default function App() {
  const [username, setUsername] = useState('printer')
  const [password, setPassword] = useState('print123456')
  const [token, setToken] = useState(localStorage.getItem('print_token') || '')
  const [role, setRole] = useState(localStorage.getItem('print_role') || '')
  const [page, setPage] = useState('queue')
  const [rows, setRows] = useState([])
  const [machines, setMachines] = useState([])
  const [sheet, setSheet] = useState('封面-01')
  const [cyan, setCyan] = useState('0.05')
  const [magenta, setMagenta] = useState('-0.04')
  const [machineId, setMachineId] = useState('')
  const [newMachine, setNewMachine] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const isWriter = role === 'writer'

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || '请求失败')
    return data
  }

  async function loadJobs() {
    setRows(await api('/api/jobs'))
  }

  async function loadMachines() {
    const list = await api('/api/machines')
    setMachines(list)
    setMachineId((prev) => {
      if (prev) return prev // 已选则保留：机台被停用后仍挂着，再送会被退回
      const first = list.find((m) => m.active)
      return first ? String(first.id) : ''
    })
  }

  useEffect(() => {
    if (!token) return
    loadJobs()
    loadMachines()
    const timer = setInterval(() => {
      loadJobs()
      loadMachines()
    }, 1000)
    return () => clearInterval(timer)
  }, [token])

  async function enter() {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    localStorage.setItem('print_token', data.access_token)
    localStorage.setItem('print_role', data.role)
    setToken(data.access_token)
    setRole(data.role)
    setPage('queue')
  }

  async function send() {
    setError('')
    setNotice('')
    if (!machineId) {
      setError('缺机台：送复核前必须挑选一台仍可使用的机台')
      return
    }
    try {
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          sheet,
          cyan_mm: Number(cyan),
          magenta_mm: Number(magenta),
          machine_id: Number(machineId),
        }),
      })
      setNotice('已入待处理队列')
    } catch (err) {
      setError(err.message)
    }
  }

  async function registerMachine() {
    setError('')
    setNotice('')
    try {
      const m = await api('/api/machines', {
        method: 'POST',
        body: JSON.stringify({ name: newMachine }),
      })
      setNewMachine('')
      setMachineId(String(m.id))
      setNotice(`已登记机台：${m.name}`)
      await loadMachines()
    } catch (err) {
      setError(err.message)
    }
  }

  async function stopMachine(id) {
    setError('')
    setNotice('')
    try {
      const m = await api(`/api/machines/${id}/stop`, { method: 'POST' })
      setNotice(`机台「${m.name}」已停用，旧任务上的冻结称呼不变`)
      await loadMachines()
    } catch (err) {
      setError(err.message)
    }
  }

  function leave() {
    localStorage.clear()
    setToken('')
    setRole('')
  }

  if (!token) {
    return (
      <main>
        <h1>印刷套准复核台</h1>
        <p>先有机台名册，再送复核：入队必须挑一台仍可使用的机台，机台称呼随任务冻结。</p>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={enter}>登录</button>
        <p>printer / print123456 可登记机台、送复核；checker / check123456 只可翻看名册与冻结称呼</p>
      </main>
    )
  }

  const activeMachines = machines.filter((m) => m.active)
  const stoppedMachines = machines.filter((m) => !m.active)

  function rosterState(machineName) {
    const m = machines.find((x) => x.name === machineName)
    if (!m) return '名册已无此称呼'
    return m.active ? '仍可使用' : '已停用'
  }

  return (
    <main>
      <h1>印刷套准复核台</h1>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <button disabled={page === 'queue'} onClick={() => setPage('queue')}>复核队列</button>
        <button disabled={page === 'roster'} onClick={() => setPage('roster')}>机台名册</button>
        <span style={{ marginLeft: 'auto' }}>
          {username}（{isWriter ? '印刷员' : '只读账号'}）<button onClick={leave}>退出</button>
        </span>
      </nav>

      {notice && <p style={{ color: 'green' }}>{notice}</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {page === 'queue' && (
        <section>
          {isWriter && (
            <p>
              <input value={sheet} onChange={(e) => setSheet(e.target.value)} />
              <input value={cyan} onChange={(e) => setCyan(e.target.value)} />
              <input value={magenta} onChange={(e) => setMagenta(e.target.value)} />
              <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                <option value="">— 挑选可使用机台 —</option>
                {machines.map((m) => (
                  <option key={m.id} value={String(m.id)} disabled={!m.active}>
                    {m.name}{m.active ? '' : '（已停用）'}
                  </option>
                ))}
              </select>
              <button onClick={send}>送复核</button>
            </p>
          )}
          {!isWriter && <p>只读账号：可翻看名册与任务上的冻结称呼，不能登记机台，也不能送复核。</p>}
          <table border={1} cellPadding={4}>
            <thead>
              <tr><th>印张</th><th>机台称呼（冻结）</th><th>青</th><th>品</th><th>状态</th><th>结论</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.sheet}</td>
                  <td>{row.machine_name || '—'}</td>
                  <td>{row.cyan_mm}</td>
                  <td>{row.magenta_mm}</td>
                  <td>{row.status === 'pending' ? '待处理' : row.status === 'running' ? '复核中' : row.status}</td>
                  <td>{row.verdict || '等待'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {page === 'roster' && (
        <section>
          <h2>可使用机台</h2>
          {isWriter && (
            <p>
              <input
                placeholder="登记机台称呼，如：甲机"
                value={newMachine}
                onChange={(e) => setNewMachine(e.target.value)}
              />
              <button onClick={registerMachine}>登记机台</button>
            </p>
          )}
          <table border={1} cellPadding={4}>
            <thead>
              <tr><th>机台称呼</th><th>登记人</th><th>登记时间</th>{isWriter && <th>操作</th>}</tr>
            </thead>
            <tbody>
              {activeMachines.length === 0 && (
                <tr><td colSpan={isWriter ? 4 : 3}>暂无可使用机台</td></tr>
              )}
              {activeMachines.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.created_by}</td>
                  <td>{new Date(m.created_at).toLocaleString()}</td>
                  {isWriter && (
                    <td><button onClick={() => stopMachine(m.id)}>停用</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={{ marginTop: 24 }}>停用记录与已冻结样张</h2>
          <h3>停用记录</h3>
          <table border={1} cellPadding={4}>
            <thead>
              <tr><th>机台称呼</th><th>登记人</th><th>停用时间</th></tr>
            </thead>
            <tbody>
              {stoppedMachines.length === 0 && (
                <tr><td colSpan={3}>尚无停用记录</td></tr>
              )}
              {stoppedMachines.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.created_by}</td>
                  <td>{m.deactivated_at ? new Date(m.deactivated_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>已冻结样张（任务上的称呼不随后续停用改变）</h3>
          <table border={1} cellPadding={4}>
            <thead>
              <tr><th>印张</th><th>冻结称呼</th><th>名册现态</th><th>送复核人</th><th>状态</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.sheet}</td>
                  <td>{row.machine_name || '—'}</td>
                  <td>{row.machine_name ? rosterState(row.machine_name) : '—'}</td>
                  <td>{row.created_by}</td>
                  <td>{row.status === 'pending' ? '待处理' : row.status === 'running' ? '复核中' : row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!isWriter && <p>只读账号可查看以上全部记录，但没有登记、停用与送复核入口。</p>}
        </section>
      )}
    </main>
  )
}

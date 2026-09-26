import { useEffect, useState } from 'react'

export default function App() {
  const [username, setUsername] = useState('printer')
  const [password, setPassword] = useState('print123456')
  const [token, setToken] = useState(localStorage.getItem('print_token') || '')
  const [role, setRole] = useState(localStorage.getItem('print_role') || '')
  const [tab, setTab] = useState('jobs')
  const [rows, setRows] = useState([])
  const [machines, setMachines] = useState([])
  const [sheet, setSheet] = useState('封面-02')
  const [cyan, setCyan] = useState('0.08')
  const [magenta, setMagenta] = useState('0.02')
  const [machineId, setMachineId] = useState('')
  const [error, setError] = useState('')
  const [machineName, setMachineName] = useState('')
  const [machineUsable, setMachineUsable] = useState('usable')
  const [rosterError, setRosterError] = useState('')

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

  async function load() {
    const [jobs, roster] = await Promise.all([api('/api/jobs'), api('/api/machines')])
    setRows(jobs)
    setMachines(roster)
  }

  useEffect(() => {
    if (!token) return
    load()
    const timer = setInterval(load, 1000)
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
  }

  async function send() {
    setError('')
    try {
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          sheet,
          cyan_mm: Number(cyan),
          magenta_mm: Number(magenta),
          machine_id: machineId ? Number(machineId) : null,
        }),
      })
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function register() {
    setRosterError('')
    try {
      await api('/api/machines', {
        method: 'POST',
        body: JSON.stringify({ name: machineName, usable: machineUsable === 'usable' }),
      })
      setMachineName('')
      await load()
    } catch (err) {
      setRosterError(err.message)
    }
  }

  async function toggle(id, usable) {
    setRosterError('')
    try {
      await api(`/api/machines/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ usable }),
      })
      await load()
    } catch (err) {
      setRosterError(err.message)
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
        <p>先在机台名册登记机台，送复核时挑一台仍可使用的机台入队。另一进程领走偏差并写结论，页面轮询到结论出现。</p>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={enter}>登录</button>
        <p>printer / print123456 可登记机台、送复核；checker / check123456 只能翻看</p>
      </main>
    )
  }

  const usable = machines.filter((m) => m.usable)
  const stopped = machines.filter((m) => !m.usable)
  const frozen = rows.filter((row) => row.machine_name)

  return (
    <main>
      <h1>印刷套准复核台</h1>
      <nav>
        <button disabled={tab === 'jobs'} onClick={() => setTab('jobs')}>复核队列</button>
        <button disabled={tab === 'machines'} onClick={() => setTab('machines')}>机台名册</button>
        <button onClick={leave}>退出</button>
      </nav>

      {tab === 'jobs' && (
        <section>
          {role === 'writer' && (
            <p>
              <input value={sheet} onChange={(e) => setSheet(e.target.value)} />
              <input value={cyan} onChange={(e) => setCyan(e.target.value)} />
              <input value={magenta} onChange={(e) => setMagenta(e.target.value)} />
              <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                <option value="">选择机台</option>
                {usable.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <button onClick={send}>送复核</button>
            </p>
          )}
          {error && <p>{error}</p>}
          <table>
            <thead>
              <tr><th>印张</th><th>青</th><th>品</th><th>机台</th><th>状态</th><th>结论</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.sheet}</td>
                  <td>{row.cyan_mm}</td>
                  <td>{row.magenta_mm}</td>
                  <td>{row.machine_name || '—'}</td>
                  <td>{row.status}</td>
                  <td>{row.verdict || '等待'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'machines' && (
        <section>
          {role === 'writer' && (
            <p>
              <input
                placeholder="机台称呼"
                value={machineName}
                onChange={(e) => setMachineName(e.target.value)}
              />
              <select value={machineUsable} onChange={(e) => setMachineUsable(e.target.value)}>
                <option value="usable">可使用</option>
                <option value="stopped">停用</option>
              </select>
              <button onClick={register}>登记机台</button>
            </p>
          )}
          {rosterError && <p>{rosterError}</p>}

          <h2>可使用机台</h2>
          <table>
            <thead>
              <tr><th>称呼</th><th>登记人</th>{role === 'writer' && <th>操作</th>}</tr>
            </thead>
            <tbody>
              {usable.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.created_by}</td>
                  {role === 'writer' && (
                    <td><button onClick={() => toggle(m.id, false)}>停用</button></td>
                  )}
                </tr>
              ))}
              {usable.length === 0 && <tr><td colSpan="3">名册中暂无可使用机台</td></tr>}
            </tbody>
          </table>

          <h2>停用记录</h2>
          <table>
            <thead>
              <tr><th>称呼</th><th>登记人</th>{role === 'writer' && <th>操作</th>}</tr>
            </thead>
            <tbody>
              {stopped.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.created_by}</td>
                  {role === 'writer' && (
                    <td><button onClick={() => toggle(m.id, true)}>重新启用</button></td>
                  )}
                </tr>
              ))}
              {stopped.length === 0 && <tr><td colSpan="3">暂无停用机台</td></tr>}
            </tbody>
          </table>

          <h2>已冻结样张</h2>
          <p>机台称呼写入任务即冻结，之后名册停用也改不掉这些旧任务上的称呼。</p>
          <table>
            <thead>
              <tr><th>印张</th><th>冻结称呼</th><th>状态</th><th>结论</th></tr>
            </thead>
            <tbody>
              {frozen.map((row) => (
                <tr key={row.id}>
                  <td>{row.sheet}</td>
                  <td>{row.machine_name}</td>
                  <td>{row.status}</td>
                  <td>{row.verdict || '等待'}</td>
                </tr>
              ))}
              {frozen.length === 0 && <tr><td colSpan="4">暂无带机台称呼的样张</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </main>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/opt'
const columns = [
  "建议编号",
  "目标查询",
  "优化类型",
  "当前耗时",
  "预计提速",
  "优化方案",
  "执行状态",
  "建议时间"
]
const statuses = [
  "待采纳",
  "已采纳",
  "已执行",
  "已关闭"
]
// 每个状态只暴露单向推进的下一格动作，非法/倒序/重复动作在界面上就不可点。
const nextActionByStatus: Record<string, string> = {
  "待采纳": "采纳建议",
  "已采纳": "标记执行",
  "已执行": "关闭建议",
}
const registerFields = [
  "建议编号",
  "目标查询",
  "优化类型",
  "当前耗时",
  "预计提速",
  "优化方案"
] as const
type RegisterField = (typeof registerFields)[number]

type Trail = {
  动作: string
  原状态: string | null
  新状态: string
  说明: string
  时间: string
}
type Row = Record<string, string | number | null> & {
  status?: string
  状态轨迹?: Trail[]
}

export default function OptView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [infoMessage, setInfoMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showRegister, setShowRegister] = useState(false)
  const [detail, setDetail] = useState<Row | null>(null)
  const [registerForm, setRegisterForm] = useState<Record<RegisterField, string>>({
    建议编号: '',
    目标查询: '',
    优化类型: '',
    当前耗时: '',
    预计提速: '',
    优化方案: '',
  })
  // 后端只支持 keyword（匹配建议编号/目标查询）与 status 两个过滤参数。
  const keywordPlaceholder = "按建议编号 / 目标查询检索"

  const reload = useCallback(async () => {
    setErrorMessage('')
    const params = new URLSearchParams()
    if (filters.keyword) {
      params.set('keyword', filters.keyword)
    }
    if (filters.status) {
      params.set('status', filters.status)
    }
    try {
      const response = await request(`${ENDPOINT}?${params.toString()}`)
      if (!response.ok) {
        throw new Error('优化建议列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '查询优化建议列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  const stats = useMemo(() => [
    { label: "优化建议总数", value: rows.length },
    { label: "已采纳建议", value: rows.filter((row) => row.status === '已采纳' || row.status === '已执行' || row.status === '已关闭').length },
    { label: "已执行建议", value: rows.filter((row) => row.status === '已执行' || row.status === '已关闭').length },
    { label: "已关闭建议", value: rows.filter((row) => row.status === '已关闭').length },
  ], [rows])

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    setInfoMessage('')
    try {
      // 后端动作契约是 { values: { action } }，之前直接发 { action } 会导致动作根本没进业务规则。
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ values: { action } }),
      })
      const payload = await response.json()
      if (!response.ok || !payload.ok) {
        setErrorMessage(payload.message || '查询优化建议动作未生效，请稍后重试')
        return
      }
      setInfoMessage(payload.message)
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '查询优化建议操作失败')
    }
  }

  async function submitRegister() {
    setErrorMessage('')
    setInfoMessage('')
    try {
      const response = await request(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ values: registerForm }),
      })
      const payload = await response.json()
      if (!response.ok || !payload.ok) {
        // 字段没有完整落库时后端会拒绝，这里把缺失原因直接展示，不显示成功。
        setErrorMessage(payload.message || '优化建议登记失败')
        return
      }
      setInfoMessage(payload.message)
      setShowRegister(false)
      setRegisterForm({
        建议编号: '',
        目标查询: '',
        优化类型: '',
        当前耗时: '',
        预计提速: '',
        优化方案: '',
      })
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '优化建议登记失败')
    }
  }

  return (
    <section className="page" data-module="opt">
      <header className="page-head">
        <div>
          <h2>查询优化建议管理</h2>
          <p className="page-desc">维护查询优化的瓶颈分析、提速预估与方案记录，状态按 待采纳 → 已采纳 → 已执行 → 已关闭 单向推进，每次流转都留下审计轨迹。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => { setErrorMessage(''); setShowRegister(true) }}>
            登记优化建议
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出查询优化建议清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        <label className="filter-item">
          <span>关键字</span>
          <input
            value={filters.keyword ?? ''}
            placeholder={keywordPlaceholder}
            onChange={(event) => setFilters((prev) => ({ ...prev, keyword: event.target.value }))}
          />
        </label>
        <label className="filter-item">
          <span>执行状态</span>
          <select
            value={filters.status ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))}
          >
            <option value="">全部状态</option>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const nextAction = row.status ? nextActionByStatus[row.status] : undefined
            return (
              <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td className="row-actions">
                  {nextAction ? (
                    <button className="link" type="button" onClick={() => void runAction(nextAction, row)}>
                      {nextAction}
                    </button>
                  ) : (
                    <span className="muted-text">已到终态，无可用动作</span>
                  )}
                  <button className="link" type="button" onClick={() => setDetail(row)}>
                    查看轨迹
                  </button>
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 1}>暂无查询优化建议数据，可先登记优化建议</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条查询优化建议记录</span>
        {infoMessage && <span className="info-text">{infoMessage}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>

      {showRegister && (
        <div className="modal-mask" role="presentation" onClick={() => setShowRegister(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <strong>登记优化建议</strong>
              <button className="link" type="button" onClick={() => setShowRegister(false)}>关闭</button>
            </div>
            <div className="modal-body">
              {registerFields.map((field) => (
                <label key={field} className="modal-field">
                  <span>{field}<i className="required-mark">*</i></span>
                  {field === '优化方案' || field === '目标查询' ? (
                    <textarea
                      rows={3}
                      value={registerForm[field]}
                      onChange={(event) => setRegisterForm((prev) => ({ ...prev, [field]: event.target.value }))}
                    />
                  ) : (
                    <input
                      value={registerForm[field]}
                      onChange={(event) => setRegisterForm((prev) => ({ ...prev, [field]: event.target.value }))}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" type="button" onClick={() => setShowRegister(false)}>取消</button>
              <button className="btn primary" type="button" onClick={() => void submitRegister()}>提交登记</button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="modal-mask" role="presentation" onClick={() => setDetail(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <strong>优化建议明细 · {String(detail['建议编号'] ?? '')}</strong>
              <button className="link" type="button" onClick={() => setDetail(null)}>关闭</button>
            </div>
            <div className="modal-body">
              <dl className="detail-grid">
                {columns.map((column) => (
                  <div key={column} className="detail-item">
                    <dt>{column}</dt>
                    <dd>{detail[column] ?? '—'}</dd>
                  </div>
                ))}
              </dl>
              <h4 className="trail-title">状态审计轨迹（单向推进，不可回退）</h4>
              <ol className="trail-list">
                {(detail.状态轨迹 ?? []).map((step, index) => (
                  <li key={`${step.时间}-${index}`} className="trail-item">
                    <span className="trail-time">{step.时间}</span>
                    <span className="trail-action">{step.动作}</span>
                    <span className="trail-flow">
                      {step.原状态 ? `${step.原状态} → ${step.新状态}` : `登记为 ${step.新状态}`}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

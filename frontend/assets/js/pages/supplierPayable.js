import { getEmails, saveEmails } from '../core/storage.js'
import { escapeHtml } from '../core/utils.js'

const search = document.getElementById('supplier-payable-search')
const body = document.getElementById('supplier-payable-body')

function normalizeSubject(subject = '') {
  let value = String(subject).trim()
  while (/^(re|fw|fwd)\s*:/i.test(value)) value = value.replace(/^(re|fw|fwd)\s*:\s*/i, '')
  return value.trim().toLowerCase()
}

function normalizeSender(value = '') {
  const bracket = String(value).match(/<([^>]+)>/)
  return (bracket ? bracket[1] : String(value)).trim().toLowerCase()
}

function threadKey(item) {
  const supplier = item.supplierCompanyId || normalizeSender(item.from)
  return `${supplier}::${normalizeSubject(item.subject)}`
}

function priorityFromCount(count) {
  if (count >= 5) return 'High'
  if (count >= 3) return 'Medium'
  return 'Low'
}

function showDate(value = '') {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : (value || '—')
}

function groupedRows() {
  const groups = new Map()
  const source = getEmails().filter(item => item.section === 'supplier-payable')

  source.forEach(item => {
    const key = threadKey(item)
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        records: [],
        from: item.from || '',
        subject: item.subject || '',
        dates: []
      })
    }

    const group = groups.get(key)
    group.records.push(item)
    const threadDates = Array.isArray(item.mailDates) && item.mailDates.length
      ? item.mailDates
      : [item.receivedDate]
    group.dates.push(...threadDates.filter(Boolean))
  })

  return [...groups.values()].map(group => {
    const uniqueDates = [...new Set(group.dates)].sort()
    const manualPriority = group.records.find(item => item.supplierPayablePriority)?.supplierPayablePriority
    const manualStatus = group.records.find(item => item.supplierPayableStatus)?.supplierPayableStatus
    return {
      ...group,
      mailCount: uniqueDates.length || group.records.length,
      firstDate: uniqueDates[0] || group.records[0]?.receivedDate || '',
      priority: manualPriority || priorityFromCount(uniqueDates.length || group.records.length),
      status: manualStatus || 'Not Paid'
    }
  }).sort((a, b) => a.firstDate.localeCompare(b.firstDate))
}

function render() {
  const query = search.value.trim().toLowerCase()
  const rows = groupedRows().filter(row => {
    if (!query) return true
    return `${row.from} ${row.subject}`.toLowerCase().includes(query)
  })

  body.innerHTML = rows.length ? rows.map(row => `
    <tr data-thread-key="${escapeHtml(row.key)}">
      <td>${escapeHtml(row.from)}</td>
      <td>${escapeHtml(row.subject)}</td>
      <td>${row.mailCount}</td>
      <td>${escapeHtml(showDate(row.firstDate))}</td>
      <td>
        <select data-priority>
          <option value="High" ${row.priority === 'High' ? 'selected' : ''}>High</option>
          <option value="Medium" ${row.priority === 'Medium' ? 'selected' : ''}>Medium</option>
          <option value="Low" ${row.priority === 'Low' ? 'selected' : ''}>Low</option>
        </select>
      </td>
      <td>
        <select data-status>
          <option value="Paid" ${row.status === 'Paid' ? 'selected' : ''}>Paid</option>
          <option value="Not Fully Paid" ${row.status === 'Not Fully Paid' ? 'selected' : ''}>Not Fully Paid</option>
          <option value="Not Paid" ${row.status === 'Not Paid' ? 'selected' : ''}>Not Paid</option>
        </select>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty-state">No supplier payable reminders.</td></tr>'
}

function updateThread(key, patch) {
  const emails = getEmails()
  emails.forEach(item => {
    if (item.section === 'supplier-payable' && threadKey(item) === key) Object.assign(item, patch)
  })
  saveEmails(emails)
  render()
}

body.addEventListener('change', event => {
  const row = event.target.closest('[data-thread-key]')
  if (!row) return
  if (event.target.matches('[data-priority]')) {
    updateThread(row.dataset.threadKey, { supplierPayablePriority: event.target.value })
  } else if (event.target.matches('[data-status]')) {
    updateThread(row.dataset.threadKey, { supplierPayableStatus: event.target.value })
  }
})

search.addEventListener('input', render)
render()

import { apiJson } from '../core/api.js'
import { formatDateTimeSGT } from '../core/dateTime.js'
import { escapeHtml } from '../core/utils.js'

const search = document.getElementById('supplier-payable-search')
const body = document.getElementById('supplier-payable-body')
const statusText = document.getElementById('supplier-payable-status')

let messages = []
const OVERRIDE_KEY = 'maxgreen_supplier_payable_overrides_v26'

function normalizeSubject(subject = '') {
  let value = String(subject).trim()
  while (/^(re|fw|fwd)\s*:/i.test(value)) value = value.replace(/^(re|fw|fwd)\s*:\s*/i, '')
  return value.trim().toLowerCase()
}

function normalizeSender(value = '') {
  return String(value).trim().toLowerCase()
}

function groupKey(item) {
  // Gmail thread id is the strongest grouping key. For suppliers that start a new
  // reminder thread, sender + normalized subject still groups repeated chasers.
  if (item.thread_id) return `thread:${item.thread_id}`
  const supplier = normalizeSender(item.sender_email || item.sender)
  const ref = String(item.ai_supplier_reference || '').trim().toLowerCase()
  const subject = normalizeSubject(item.subject)
  return `supplier:${supplier}::${ref || subject}`
}

function priorityFromCount(count) {
  if (count >= 5) return 'High'
  if (count >= 3) return 'Medium'
  return 'Low'
}

function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveOverride(key, patch) {
  const all = loadOverrides()
  all[key] = { ...(all[key] || {}), ...patch }
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(all))
}

function groupedRows() {
  const groups = new Map()
  messages.forEach(item => {
    const key = groupKey(item)
    if (!groups.has(key)) groups.set(key, { key, records: [] })
    groups.get(key).records.push(item)
  })

  const overrides = loadOverrides()
  return [...groups.values()].map(group => {
    const records = group.records.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))
    const first = records[0]
    const last = records[records.length - 1]
    const override = overrides[group.key] || {}
    return {
      key: group.key,
      from: first.sender_email || first.sender || 'Unknown supplier',
      senderName: first.sender && first.sender !== first.sender_email ? first.sender : '',
      subject: first.subject || '(No subject)',
      count: records.length,
      firstDate: first.received_at,
      latestMessageId: last.gmail_message_id,
      reference: last.ai_supplier_reference || first.ai_supplier_reference || '',
      amount: last.ai_amount || first.ai_amount || '',
      dueDate: last.ai_due_date || first.ai_due_date || '',
      priority: override.priority || priorityFromCount(records.length),
      status: override.status || 'Not Paid'
    }
  }).sort((a, b) => String(b.firstDate).localeCompare(String(a.firstDate)))
}

function render() {
  const query = search.value.trim().toLowerCase()
  const rows = groupedRows().filter(row => {
    if (!query) return true
    return `${row.from} ${row.senderName} ${row.subject} ${row.reference} ${row.amount}`.toLowerCase().includes(query)
  })

  body.innerHTML = rows.length ? rows.map(row => {
    const viewUrl = `./gmail-message.html?id=${encodeURIComponent(row.latestMessageId)}`
    const details = [row.reference, row.amount, row.dueDate].filter(Boolean).join(' · ')
    return `
      <tr data-thread-key="${escapeHtml(row.key)}">
        <td><a href="${viewUrl}">${escapeHtml(row.from)}</a>${row.senderName ? `<div>${escapeHtml(row.senderName)}</div>` : ''}</td>
        <td><a href="${viewUrl}">${escapeHtml(row.subject)}</a>${details ? `<div class="supplier-meta">${escapeHtml(details)}</div>` : ''}</td>
        <td>${row.count}</td>
        <td>${escapeHtml(formatDateTimeSGT(row.firstDate))}</td>
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
    `
  }).join('') : '<tr><td colspan="6" class="empty-state">No AI-routed supplier payable reminders.</td></tr>'
}

async function load() {
  statusText.textContent = 'Loading real Supplier Payable messages…'
  try {
    const data = await apiJson('/api/supplier-payable/messages?limit=500')
    messages = data.messages || []
    statusText.textContent = `${messages.length} supplier payable email${messages.length === 1 ? '' : 's'} routed by Claude`
    render()
  } catch (error) {
    messages = []
    statusText.textContent = `Backend not reachable: ${error.message}`
    render()
  }
}

body.addEventListener('change', event => {
  const row = event.target.closest('[data-thread-key]')
  if (!row) return
  if (event.target.matches('[data-priority]')) saveOverride(row.dataset.threadKey, { priority: event.target.value })
  if (event.target.matches('[data-status]')) saveOverride(row.dataset.threadKey, { status: event.target.value })
  render()
})

search.addEventListener('input', render)
load()

import { getEmails } from '../core/storage.js'
import { escapeHtml } from '../core/utils.js'

const searchInput = document.getElementById('completed-search')
const categoryFilter = document.getElementById('completed-category')
const dateFilter = document.getElementById('completed-date')
const body = document.getElementById('completed-body')
const tabs = [...document.querySelectorAll('[data-party]')]

let activeParty = 'customer'

function dateOnly(value, fallback = '') {
  if (!value) return fallback
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return fallback || value
  return parsed.toISOString().slice(0, 10)
}

function displayDate(value, fallback = '') {
  const iso = dateOnly(value, fallback)
  if (!iso) return '—'
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric'
  }).format(date)
}

function displayCategory(category) {
  return category === 'Statement of Account' ? 'Statement Of Account' : category
}

function completedRows() {
  return getEmails().filter(item => item.status === 'Completed' && !item.referenceOnly && !item.deletedFromCompleted)
}

function refreshDates() {
  const selected = dateFilter.value
  const dates = [...new Set(
    completedRows().map(item => dateOnly(item.sentAt || item.completedAt, item.receivedDate)).filter(Boolean)
  )].sort().reverse()

  dateFilter.innerHTML = '<option value="All">All dates</option>' + dates
    .map(date => `<option value="${escapeHtml(date)}">${escapeHtml(displayDate(date))}</option>`)
    .join('')

  if (dates.includes(selected)) dateFilter.value = selected
}

function filteredRows() {
  const search = searchInput.value.trim().toLowerCase()
  const category = categoryFilter.value
  const date = dateFilter.value

  return completedRows()
    .filter(item => item.partyType === activeParty)
    .filter(item => category === 'All' || item.category === category)
    .filter(item => {
      const itemDate = dateOnly(item.sentAt || item.completedAt, item.receivedDate)
      return date === 'All' || itemDate === date
    })
    .filter(item => {
      if (!search) return true
      return [item.fileName, item.documentId, item.subject, item.from]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search)
    })
    .sort((a, b) => new Date(b.sentAt || b.completedAt || b.receivedDate) - new Date(a.sentAt || a.completedAt || a.receivedDate))
}

function render() {
  refreshDates()
  const rows = filteredRows()

  body.innerHTML = rows.length ? rows.map(item => `
    <tr>
      <td><a class="completed-document-link" href="./completed-view.html?id=${encodeURIComponent(item.id)}">${escapeHtml(item.fileName || `${item.category}.pdf`)}</a></td>
      <td>${escapeHtml(item.documentId || '—')}</td>
      <td>${escapeHtml(displayCategory(item.category))}</td>
      <td>${escapeHtml(displayDate(item.sentAt || item.completedAt, item.receivedDate))}</td>
    </tr>
  `).join('') : '<tr><td colspan="4" class="empty-state">No completed documents.</td></tr>'
}

searchInput.addEventListener('input', render)
categoryFilter.addEventListener('change', render)
dateFilter.addEventListener('change', render)

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    activeParty = tab.dataset.party
    tabs.forEach(item => {
      const isActive = item === tab
      item.classList.toggle('active', isActive)
      item.setAttribute('aria-selected', String(isActive))
    })
    render()
  })
})

render()

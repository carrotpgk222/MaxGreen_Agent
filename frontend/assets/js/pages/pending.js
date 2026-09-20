import { getEmails } from '../core/storage.js'
import { escapeHtml } from '../core/utils.js'

const searchInput = document.getElementById('pending-search')
const categoryFilter = document.getElementById('pending-category')
const dateFilter = document.getElementById('pending-date')
const body = document.getElementById('pending-body')
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

function pendingRows() {
  return getEmails().filter(item => item.status === 'Pending')
}

function refreshDates() {
  const selected = dateFilter.value
  const dates = [...new Set(
    pendingRows().map(item => dateOnly(item.pendingAt, item.receivedDate)).filter(Boolean)
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

  return pendingRows()
    .filter(item => item.partyType === activeParty)
    .filter(item => category === 'All' || item.category === category)
    .filter(item => {
      const itemDate = dateOnly(item.pendingAt, item.receivedDate)
      return date === 'All' || itemDate === date
    })
    .filter(item => {
      if (!search) return true
      const haystack = [item.fileName, item.documentId, item.subject, item.from]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(search)
    })
}

function render() {
  refreshDates()
  const rows = filteredRows()

  body.innerHTML = rows.length ? rows.map(item => `
    <tr>
      <td>${escapeHtml(item.fileName || `${item.category}.pdf`)}</td>
      <td>${escapeHtml(item.category === 'Invoice & DO' ? [item.documentIds?.invoice, item.documentIds?.deliveryOrder].filter(Boolean).join(' + ') : (item.documentId || '—'))}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(displayDate(item.pendingAt, item.receivedDate))}</td>
      <td><a class="pending-view-button" href="./pending-view.html?id=${encodeURIComponent(item.id)}">View</a></td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="empty-state">No pending documents.</td></tr>'
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

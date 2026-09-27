import { getEmails } from '../core/storage.js'
import { escapeHtml } from '../core/utils.js'
import { documentPreviewHtml } from '../core/documentPreview.js'

const searchInput = document.getElementById('pending-search')
const categoryFilter = document.getElementById('pending-category')
const dateFilter = document.getElementById('pending-date')
const body = document.getElementById('pending-body')
const tabs = [...document.querySelectorAll('[data-party]')]

let activeParty = 'customer'
let expandedId = ''
const previewCache = new Map()

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

function previewRowId(id) {
  return `pending-preview-${id}`
}

function previewHtml(item) {
  if (!previewCache.has(item.id)) {
    previewCache.set(item.id, documentPreviewHtml(item))
  }
  return previewCache.get(item.id)
}

function rowHtml(item) {
  const isOpen = item.id === expandedId
  const label = item.fileName || `${item.category}.pdf`
  const reference = item.category === 'Invoice & DO'
    ? [item.documentIds?.invoice, item.documentIds?.deliveryOrder].filter(Boolean).join(' + ')
    : (item.documentId || '—')

  return `
    <tr class="pending-row${isOpen ? ' is-open' : ''}" data-id="${escapeHtml(item.id)}">
      <td class="pending-name-cell">
        <button
          type="button"
          class="pending-toggle"
          data-toggle="${escapeHtml(item.id)}"
          aria-expanded="${String(isOpen)}"
          aria-controls="${escapeHtml(previewRowId(item.id))}"
        >
          <span class="pending-caret" aria-hidden="true"></span>
          <span class="pending-toggle-label">${escapeHtml(label)}</span>
        </button>
      </td>
      <td>${escapeHtml(reference)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(displayDate(item.pendingAt, item.receivedDate))}</td>
      <td><a class="pending-view-button" href="./pending-view.html?id=${encodeURIComponent(item.id)}">View</a></td>
    </tr>
    ${isOpen ? previewRowHtml(item) : ''}
  `
}

function previewRowHtml(item) {
  return `
    <tr class="pending-preview-row" id="${escapeHtml(previewRowId(item.id))}">
      <td colspan="5">
        <div class="pending-preview-bar">
          <span>Document preview &mdash; ${escapeHtml(item.category)}</span>
          <a href="./pending-view.html?id=${encodeURIComponent(item.id)}">Open full page</a>
        </div>
        <div class="pending-preview-scroll">${previewHtml(item)}</div>
      </td>
    </tr>
  `
}

function render() {
  refreshDates()
  const rows = filteredRows()

  if (expandedId && !rows.some(item => item.id === expandedId)) {
    expandedId = ''
  }

  body.innerHTML = rows.length
    ? rows.map(rowHtml).join('')
    : '<tr><td colspan="5" class="empty-state">No pending documents.</td></tr>'
}

body.addEventListener('click', event => {
  const trigger = event.target.closest('[data-toggle]')
  if (!trigger) return

  const id = trigger.dataset.toggle
  expandedId = expandedId === id ? '' : id
  render()

  const next = body.querySelector(`[data-toggle="${CSS.escape(id)}"]`)
  if (next) next.focus()
})

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

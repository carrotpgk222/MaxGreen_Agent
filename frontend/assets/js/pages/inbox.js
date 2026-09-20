import { getEmails } from '../core/storage.js'
import { escapeHtml } from '../core/utils.js'
import { routeForCategory } from '../core/workflowCategory.js'

const emails = getEmails()
const searchInput = document.getElementById('inbox-search')
const categoryFilter = document.getElementById('category-filter')
const dateFilter = document.getElementById('date-filter')
const tableBody = document.getElementById('inbox-body')
const tabs = [...document.querySelectorAll('[data-party]')]

let activeParty = 'customer'

const inboxEmails = emails.filter(item => item.section === 'inbox' && item.status === 'To Be Reviewed')
const dates = [...new Set(inboxEmails.map(item => item.receivedDate))].sort()

dates.forEach(date => {
  const option = document.createElement('option')
  option.value = date
  option.textContent = date
  dateFilter.appendChild(option)
})

function filteredRows() {
  const search = searchInput.value.trim().toLowerCase()
  const category = categoryFilter.value
  const date = dateFilter.value

  return inboxEmails
    .filter(item => item.partyType === activeParty)
    .filter(item => !search || item.from.toLowerCase().includes(search))
    .filter(item => category === 'All' || item.category === category)
    .filter(item => date === 'All' || item.receivedDate === date)
}

function renderRows() {
  const rows = filteredRows()

  if (!rows.length) {
    tableBody.innerHTML = '<tr><td colspan="5" class="empty-state">No matching emails.</td></tr>'
    return
  }

  tableBody.innerHTML = rows.map(item => `
    <tr>
      <td><a class="sender-link" href="${routeForCategory(item.category, item.id)}">${escapeHtml(item.from)}</a></td>
      <td>${escapeHtml(item.subject)}</td>
      <td><span class="chip">${escapeHtml(item.category)}</span></td>
      <td>${escapeHtml(item.receivedDate)}</td>
      <td class="view-cell"><a class="view-link" href="${routeForCategory(item.category, item.id)}">View</a></td>
    </tr>
  `).join('')
}

searchInput.addEventListener('input', renderRows)
categoryFilter.addEventListener('change', renderRows)
dateFilter.addEventListener('change', renderRows)

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.party === 'supplier') {
      window.location.href = './supplier-payable.html'
      return
    }
    activeParty = tab.dataset.party
    tabs.forEach(item => item.classList.toggle('active', item === tab))
    renderRows()
  })
})

renderRows()

import { getEmails } from '../core/storage.js'
import { money } from '../core/utils.js'
import { getReceivables } from '../core/receivableStorage.js'
import { apiJson } from '../core/api.js'

const emails = getEmails()
const receivableRows = getReceivables()

const counts = {
  inbox: emails.filter(item => item.section === 'inbox' && item.status === 'To Be Reviewed').length,
  receivable: receivableRows.length,
  payable: emails.filter(item => item.section === 'supplier-payable' && item.status !== 'Completed').length,
  pending: emails.filter(item => item.status === 'Pending').length,
  completed: emails.filter(item => item.status === 'Completed' && !item.referenceOnly && !item.deletedFromCompleted).length
}

function renderCounts() {
  document.getElementById('count-inbox').textContent = counts.inbox
  document.getElementById('count-receivable').textContent = counts.receivable
  document.getElementById('count-payable').textContent = counts.payable
  document.getElementById('count-pending').textContent = counts.pending
  document.getElementById('count-completed').textContent = counts.completed
}

renderCounts()

// Real routing counts from SQLite/Claude. Fall back to demo counts when backend is offline.
apiJson('/api/dashboard/counts')
  .then(data => {
    counts.inbox = Number(data.inbox || 0)
    counts.payable = Number(data.supplier_payable || 0)
    renderCounts()
  })
  .catch(() => {
    // Keep local demo counts while the backend is stopped.
  })

const total = receivableRows.reduce((sum, item) => sum + Number(item.balance ?? item.invoiceAmount ?? 0), 0)
const overdue = receivableRows
  .filter(item => item.status !== 'Paid')
  .reduce((sum, item) => sum + Number(item.balance ?? 0), 0)

document.getElementById('receivable-total').textContent = money(total)
document.getElementById('receivable-overdue').textContent = money(overdue)

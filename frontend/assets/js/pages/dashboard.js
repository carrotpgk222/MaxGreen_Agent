import { getEmails } from '../core/storage.js'
import { money } from '../core/utils.js'
import { getReceivables } from '../core/receivableStorage.js'

const emails = getEmails()
const receivableRows = getReceivables()

const counts = {
  inbox: emails.filter(item => item.section === 'inbox' && item.status === 'To Be Reviewed').length,
  receivable: receivableRows.length,
  payable: emails.filter(item => item.section === 'supplier-payable' && item.status !== 'Completed').length,
  pending: emails.filter(item => item.status === 'Pending').length,
  completed: emails.filter(item => item.status === 'Completed' && !item.referenceOnly && !item.deletedFromCompleted).length
}

document.getElementById('count-inbox').textContent = counts.inbox
document.getElementById('count-receivable').textContent = counts.receivable
document.getElementById('count-payable').textContent = counts.payable
document.getElementById('count-pending').textContent = counts.pending
document.getElementById('count-completed').textContent = counts.completed

const total = receivableRows.reduce((sum, item) => sum + Number(item.balance ?? item.invoiceAmount ?? 0), 0)
const overdue = receivableRows
  .filter(item => item.status !== 'Paid')
  .reduce((sum, item) => sum + Number(item.balance ?? 0), 0)

document.getElementById('receivable-total').textContent = money(total)
document.getElementById('receivable-overdue').textContent = money(overdue)

import { ensureDemoData } from './demoData.js'
import { getInvoiceDraft } from './invoiceStorage.js'
import { quotationTotals } from './quotationUtils.js'

const KEY = 'maxgreen-receivables-v1'

function parse() {
  ensureDemoData()
  try {
    const value = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function getReceivables() { return parse() }
export function saveReceivables(rows) { ensureDemoData(); localStorage.setItem(KEY, JSON.stringify(rows)) }
export function getReceivable(id) { return parse().find(row => row.id === id) || null }

export function calculatePayments(receivable) {
  const payments = Array.isArray(receivable?.payments) ? receivable.payments : []
  const totalPaid = payments.reduce((sum, row) => sum + Math.max(0, Number(row.paidAmount || 0)), 0)
  const invoiceAmount = Math.max(0, Number(receivable?.invoiceAmount || 0))
  return { invoiceAmount, totalPaid, balance: Math.max(0, invoiceAmount - totalPaid) }
}

export function suggestedStatus(receivable) {
  const { invoiceAmount, totalPaid, balance } = calculatePayments(receivable)
  if (invoiceAmount > 0 && balance <= 0.005) return 'Paid'
  if (totalPaid > 0) return 'Not Fully Paid'
  return 'Not Paid'
}

export function upsertReceivableFromCompletedInvoice(email) {
  if (!email || email.category !== 'Invoice') return null
  const rows = parse()
  const existing = rows.find(row => row.invoiceEmailId === email.id)
  const draft = getInvoiceDraft(email.id)
  const totals = quotationTotals(draft?.items || [])
  const base = {
    id: existing?.id || `recv-${email.id}`,
    invoiceEmailId: email.id,
    invoiceNo: email.documentId || draft?.invoiceNumber || '',
    companyId: draft?.companyId || '',
    company: draft?.company || 'Customer',
    sentEmailOn: String(email.sentAt || email.completedAt || email.receivedDate || '').slice(0, 10),
    invoiceAmount: Number(totals.total || email.amount || 0),
    payments: existing?.payments || [],
    status: existing?.status || 'Not Paid'
  }
  const calculated = calculatePayments(base)
  base.balance = calculated.balance
  if (!existing?.statusManuallySet) base.status = suggestedStatus(base)
  if (existing) Object.assign(existing, base)
  else rows.push(base)
  saveReceivables(rows)
  return base
}

export function updateReceivable(id, patch) {
  const rows = parse()
  const row = rows.find(item => item.id === id)
  if (!row) return null
  Object.assign(row, patch)
  const calc = calculatePayments(row)
  row.balance = calc.balance
  saveReceivables(rows)
  return row
}

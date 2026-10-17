import { escapeHtml, getQueryParam } from '../core/utils.js'
import {
  getReceivable,
  getReceivables,
  saveReceivables,
  calculatePayments,
  suggestedStatus
} from '../core/receivableStorage.js'

const $ = id => document.getElementById(id)
const id = getQueryParam('id')
let rec = getReceivable(id)

if (!rec) {
  document.body.innerHTML = '<main class="page"><a href="./customer-receivable.html" class="back-link">← Back</a><h1>Invoice receivable not found</h1></main>'
  throw new Error('receivable not found')
}

$('receivable-invoice-no').textContent = rec.invoiceNo
$('receivable-company').textContent = rec.company || ''

function paymentRows() {
  if (!Array.isArray(rec.payments)) rec.payments = []
  return rec.payments
}

function amount(value) {
  return Number(value || 0).toFixed(2)
}

function ensurePlaceholder(paymentId) {
  if (paymentId !== 'placeholder') {
    return paymentRows().find(p => p.id === paymentId)
  }

  const payment = {
    id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    paidAmount: '',
    date: ''
  }
  rec.payments.push(payment)
  return payment
}

function updateCalculatedValues() {
  let previous = Math.max(0, Number(rec.invoiceAmount || 0))

  document.querySelectorAll('#payment-body tr[data-payment-id]').forEach(tr => {
    const paymentId = tr.dataset.paymentId
    let paid = 0

    if (paymentId !== 'placeholder') {
      const payment = paymentRows().find(p => p.id === paymentId)
      paid = Math.max(0, Number(payment?.paidAmount || 0))
    }

    const after = Math.max(0, previous - paid)
    const amountCell = tr.querySelector('[data-payment-amount]')
    const balanceCell = tr.querySelector('[data-payment-balance]')

    if (amountCell) amountCell.textContent = amount(previous)
    if (balanceCell) balanceCell.textContent = amount(after)

    previous = after
  })
}

function render() {
  let previous = Math.max(0, Number(rec.invoiceAmount || 0))
  const rows = paymentRows()
  const displayRows = rows.length
    ? rows
    : [{ id: 'placeholder', paidAmount: '', date: '' }]

  $('payment-body').innerHTML = displayRows.map((p, i) => {
    const paid = Math.max(0, Number(p.paidAmount || 0))
    const after = Math.max(0, previous - paid)
    const start = previous
    previous = after

    return `
      <tr data-payment-id="${escapeHtml(p.id || 'placeholder')}">
        <td>${i + 1}</td>
        <td><span class="payment-static-value" data-payment-amount>${amount(start)}</span></td>
        <td><input data-field="paidAmount" type="number" min="0" step="0.01" value="${escapeHtml(p.paidAmount ?? '')}" placeholder="Enter"></td>
        <td><input data-field="date" type="date" value="${escapeHtml(p.date || '')}"></td>
        <td><span class="payment-static-value" data-payment-balance>${amount(after)}</span></td>
        <td><button class="delete-payment" type="button" data-delete-payment="${escapeHtml(p.id || 'placeholder')}">🗑</button></td>
      </tr>
    `
  }).join('')
}

$('payment-body').addEventListener('input', e => {
  const tr = e.target.closest('[data-payment-id]')
  const field = e.target.dataset.field
  if (!tr || !field) return

  const payment = ensurePlaceholder(tr.dataset.paymentId)
  if (!payment) return

  if (tr.dataset.paymentId === 'placeholder') {
    tr.dataset.paymentId = payment.id
    const deleteButton = tr.querySelector('[data-delete-payment]')
    if (deleteButton) deleteButton.dataset.deletePayment = payment.id
  }

  payment[field] = e.target.value

  // Do not re-render while the user is typing. Rebuilding the row on every
  // keystroke removes focus from the Paid Amount field.
  updateCalculatedValues()
})

$('payment-body').addEventListener('click', e => {
  const button = e.target.closest('[data-delete-payment]')
  if (!button) return
  if (button.dataset.deletePayment === 'placeholder') return

  rec.payments = paymentRows().filter(p => p.id !== button.dataset.deletePayment)
  render()
})

$('add-payment-row').addEventListener('click', () => {
  rec.payments.push({
    id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    paidAmount: '',
    date: ''
  })
  render()
})

$('save-receivable').addEventListener('click', () => {
  const list = getReceivables()
  const row = list.find(r => r.id === id)
  if (!row) return

  row.payments = rec.payments.filter(p => Number(p.paidAmount || 0) > 0 || p.date)
  const calc = calculatePayments(row)
  row.balance = calc.balance
  row.status = suggestedStatus(row)
  row.statusManuallySet = false
  saveReceivables(list)
  window.location.href = './customer-receivable.html'
})

render()

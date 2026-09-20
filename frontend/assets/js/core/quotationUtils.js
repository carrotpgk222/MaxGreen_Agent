import { money } from './utils.js'

const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

export function isoDate(value) {
  const date = value ? new Date(`${value}T00:00:00`) : new Date()
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

export function displayDate(value) {
  if (!value) return ''
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date)
}

export function createQuotationItem(item = {}, index = 1) {
  return {
    rowId: item.rowId || `row-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    item: item.item ?? String(index),
    description: item.description ?? '',
    qty: Number(item.qty ?? 1),
    uom: item.uom ?? '',
    unitPrice: Number(item.unitPrice ?? 0),
    taxRate: Number(item.taxRate ?? 9)
  }
}

export function createDefaultQuotation(email) {
  return {
    documentId: email?.documentId || '',
    company: '',
    companyId: '',
    customerAddress: '',
    customerPostal: '',
    attn: '',
    issueDate: isoDate(email?.receivedDate),
    dueDate: '',
    quotationNumber: email?.documentId || '',
    externalReference: email?.externalReference || '',
    currency: 'SGD',
    subjectTitle: '',
    attachments: [],
    items: [createQuotationItem({}, 1)]
  }
}

export function normalizeQuotationNumber(value = '') {
  return String(value || '').trim()
}

export function lineAmount(item) {
  return Number(item.qty || 0) * Number(item.unitPrice || 0)
}

export function taxAmount(item) {
  return lineAmount(item) * Number(item.taxRate || 0) / 100
}

export function quotationTotals(items = []) {
  const subtotal = items.reduce((sum, item) => sum + lineAmount(item), 0)
  const gst = items.reduce((sum, item) => sum + taxAmount(item), 0)
  return {
    subtotal,
    gst,
    total: subtotal + gst
  }
}

export function quotationTaxLabel(items = [], mode = 'editor') {
  const rates = [...new Set(
    items
      .map(item => Number(item.taxRate || 0))
      .filter(rate => Number.isFinite(rate))
  )]

  if (rates.length === 1) {
    const rate = Number.isInteger(rates[0]) ? String(rates[0]) : String(rates[0]).replace(/0+$/, '').replace(/\.$/, '')
    return mode === 'pdf' ? `${rate}% GST` : `GST (${rate}%)`
  }

  return rates.length > 1 ? 'Tax Total' : (mode === 'pdf' ? '0% GST' : 'GST (0%)')
}

function belowThousand(number) {
  let n = Math.floor(number)
  const parts = []

  if (n >= 100) {
    parts.push(`${ones[Math.floor(n / 100)]} Hundred`)
    n %= 100
  }

  if (n >= 20) {
    parts.push(tens[Math.floor(n / 10)])
    n %= 10
  }

  if (n > 0) parts.push(ones[n])
  return parts.join(' ')
}

function numberWords(number) {
  let n = Math.floor(Math.abs(number))
  if (n === 0) return 'Zero'

  const parts = []

  if (n >= 1_000_000) {
    parts.push(`${belowThousand(Math.floor(n / 1_000_000))} Million`)
    n %= 1_000_000
  }

  if (n >= 1000) {
    parts.push(`${belowThousand(Math.floor(n / 1000))} Thousand`)
    n %= 1000
  }

  if (n > 0) parts.push(belowThousand(n))
  return parts.join(' ')
}

export function totalInWords(value) {
  const rounded = Math.round(Number(value || 0) * 100) / 100
  const dollars = Math.floor(rounded)
  const cents = Math.round((rounded - dollars) * 100)

  const dollarLabel = dollars === 1 ? 'Dollar' : 'Dollars'
  let text = `Sum of Singapore ${numberWords(dollars)} ${dollarLabel}`

  if (cents > 0) {
    const centLabel = cents === 1 ? 'Cent' : 'Cents'
    text += ` And ${numberWords(cents)} ${centLabel}`
  }

  return `${text} Only`
}

export function formatMoney(value) {
  return money(Number(value || 0))
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]))
}

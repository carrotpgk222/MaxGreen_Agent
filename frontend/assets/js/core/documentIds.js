export const DOCUMENT_PREFIXES = Object.freeze({
  Quotation: 'MGQ',
  'Delivery Order': 'DO',
  Invoice: 'INV',
  'Statement of Account': 'SOA'
})

function normalizeDate(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) return `${match[1]}.${match[2]}.${match[3]}`

  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}.${mm}.${dd}`
}

function expectedPrefix(category) {
  return DOCUMENT_PREFIXES[category] || ''
}

function parseDocumentId(id = '') {
  const match = String(id).trim().match(/^([A-Z]+)\.(\d{4}\.\d{2}\.\d{2})\.(\d+)$/i)
  if (!match) return null

  return {
    prefix: match[1].toUpperCase(),
    date: match[2],
    sequence: Number(match[3])
  }
}

function counterKey(prefix, date) {
  return `${prefix}|${date}`
}

function nextId(prefix, dateValue, counters) {
  const date = normalizeDate(dateValue)
  const key = counterKey(prefix, date)
  counters[key] = (counters[key] || 0) + 1
  return `${prefix}.${date}.${counters[key]}`
}

function hasCurrentFormat(id, prefix) {
  const parsed = parseDocumentId(id)
  return Boolean(parsed && parsed.prefix === prefix && parsed.sequence >= 1)
}

function rememberPreviousId(record, id) {
  if (!id) return record.previousDocumentIds || []
  const current = Array.isArray(record.previousDocumentIds) ? record.previousDocumentIds : []
  return [...new Set([...current, id])]
}

function assignSingleDocumentId(copy, counters) {
  const category = copy.category || copy.originalCategory
  const prefix = expectedPrefix(category)
  if (!prefix) return copy

  if (!hasCurrentFormat(copy.documentId, prefix)) {
    if (copy.documentId) copy.previousDocumentIds = rememberPreviousId(copy, copy.documentId)
    copy.documentId = nextId(prefix, copy.receivedDate, counters)
  }

  copy.fileName = `${copy.documentId}.pdf`
  return copy
}

export function ensureDocumentIds(records = []) {
  // Sequence numbers are tracked independently for each category prefix AND calendar day.
  // Example on the same day: MGQ.2026.09.18.1, MGQ.2026.09.18.2.
  // The next day's first quotation resets to MGQ.2026.09.19.1.
  const counters = {}

  records.forEach(record => {
    const allIds = [
      record.documentId,
      record.documentIds?.invoice,
      record.documentIds?.deliveryOrder
    ].filter(Boolean)

    allIds.forEach(id => {
      const parsed = parseDocumentId(id)
      if (!parsed) return
      const key = counterKey(parsed.prefix, parsed.date)
      counters[key] = Math.max(counters[key] || 0, parsed.sequence)
    })
  })

  return records.map(record => {
    const copy = { ...record }

    if (copy.category === 'Invoice & DO') {
      copy.documentIds = { ...(copy.documentIds || {}) }

      if (!hasCurrentFormat(copy.documentIds.invoice, 'INV')) {
        copy.documentIds.invoice = nextId('INV', copy.receivedDate, counters)
      }

      if (!hasCurrentFormat(copy.documentIds.deliveryOrder, 'DO')) {
        copy.documentIds.deliveryOrder = nextId('DO', copy.receivedDate, counters)
      }

      copy.fileName = `${copy.documentIds.invoice}.pdf + ${copy.documentIds.deliveryOrder}.pdf`
      return copy
    }

    return assignSingleDocumentId(copy, counters)
  })
}

export function getPrimaryDocumentId(record) {
  if (!record) return ''
  if (record.documentId) return record.documentId
  if (record.documentIds?.invoice) return record.documentIds.invoice
  if (record.documentIds?.deliveryOrder) return record.documentIds.deliveryOrder
  return ''
}

export function documentFileName(reference = '', fallback = 'Document') {
  return reference ? `${reference}.pdf` : `${fallback}.pdf`
}

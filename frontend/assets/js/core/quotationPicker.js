import { getEmails } from './storage.js'
import { getQuotationDraft } from './quotationStorage.js'

export function completedQuotationRows() {
  return getEmails()
    .filter(item => item.status === 'Completed' && item.category === 'Quotation' && !item.deletedFromCompleted)
    .map(item => ({ email: item, quotation: getQuotationDraft(item.id) }))
    .filter(item => item.quotation)
    .sort((a, b) => new Date(b.email.sentAt || b.email.completedAt || b.email.receivedDate) - new Date(a.email.sentAt || a.email.completedAt || a.email.receivedDate))
}

export function isSelectableQuotation(email) {
  return Boolean(email)
    && email.status === 'Completed'
    && email.category === 'Quotation'
    && !email.deletedFromCompleted
}

export function filterQuotationRows(rows, query = '') {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return rows
  return rows.filter(({ email: quoteEmail, quotation }) => [
    quotation.quotationNumber,
    quotation.subjectTitle,
    quotation.company,
    quoteEmail.subject
  ].filter(Boolean).join(' ').toLowerCase().includes(needle))
}

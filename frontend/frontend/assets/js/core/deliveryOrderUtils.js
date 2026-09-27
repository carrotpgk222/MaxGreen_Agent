import { displayDate, escapeHtml, isoDate } from './quotationUtils.js'

export { displayDate, escapeHtml, isoDate }

export function createDeliveryOrderItem(item = {}, index = 1) {
  return {
    rowId: item.rowId || `do-row-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    item: item.item ?? String(index),
    description: item.description ?? '',
    qty: Math.max(0, Math.trunc(Number(item.qty ?? 1))),
    uom: item.uom ?? '',
    unitPrice: Number(item.unitPrice ?? 0),
    taxRate: Number(item.taxRate ?? 9)
  }
}

export function createDefaultDeliveryOrder(email) {
  return {
    documentId: email?.documentId || '',
    deliveryOrderNumber: email?.documentId || '',
    sourceQuotationEmailId: email?.sourceQuotationEmailId || '',
    refQuoteDocumentId: email?.refQuoteDocumentId || '',
    companyId: '',
    company: '',
    customerAddress: '',
    customerPostal: '',
    attn: '',
    issueDate: isoDate(email?.receivedDate),
    dueDate: '',
    currency: 'SGD',
    reference: email?.documentId || '',
    externalReference: email?.refQuoteDocumentId || '',
    staff: '',
    terms: '',
    job: '',
    subjectTitle: '',
    attachments: [],
    items: [createDeliveryOrderItem({}, 1)]
  }
}

export function deliveryOrderFromQuotation(email, quotation, overrides = {}) {
  const items = (quotation?.items?.length ? quotation.items : [{}]).map((item, index) => createDeliveryOrderItem({
    item: String(index + 1),
    description: item.description || '',
    qty: item.qty ?? 1,
    uom: item.uom || '',
    unitPrice: item.unitPrice ?? 0,
    taxRate: item.taxRate ?? 9
  }, index + 1))

  return {
    ...createDefaultDeliveryOrder(email),
    sourceQuotationEmailId: overrides.sourceQuotationEmailId || email?.sourceQuotationEmailId || '',
    refQuoteDocumentId: overrides.refQuoteDocumentId || quotation?.quotationNumber || quotation?.documentId || '',
    externalReference: overrides.refQuoteDocumentId || quotation?.quotationNumber || quotation?.documentId || '',
    companyId: quotation?.companyId || '',
    company: quotation?.company || '',
    customerAddress: quotation?.customerAddress || '',
    customerPostal: quotation?.customerPostal || '',
    attn: quotation?.attn || '',
    issueDate: overrides.issueDate || isoDate(email?.receivedDate),
    dueDate: quotation?.dueDate || '',
    currency: quotation?.currency || 'SGD',
    deliveryOrderNumber: email?.documentId || overrides.deliveryOrderNumber || '',
    documentId: email?.documentId || overrides.documentId || '',
    subjectTitle: quotation?.subjectTitle || email?.subject || '',
    items,
    ...overrides
  }
}

export function normalizeDeliveryOrderNumber(value = '') {
  return String(value || '').trim()
}

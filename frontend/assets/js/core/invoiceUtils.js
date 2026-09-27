import { displayDate, escapeHtml, isoDate } from './quotationUtils.js'

export { displayDate, escapeHtml, isoDate }

export function createInvoiceItem(item = {}, index = 1) {
  return {
    rowId: item.rowId || `inv-row-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    item: item.item ?? String(index),
    itemCode: item.itemCode ?? '',
    description: item.description ?? '',
    qty: Math.max(0, Math.trunc(Number(item.qty ?? 1))),
    uom: item.uom ?? '',
    unitPrice: Number(item.unitPrice ?? 0),
    taxRate: Number(item.taxRate ?? 9)
  }
}

export function createDefaultInvoice(email) {
  return {
    documentId: email?.documentId || '',
    invoiceNumber: email?.documentId || '',
    sourceQuotationEmailId: email?.sourceQuotationEmailId || '',
    sourceDeliveryOrderEmailId: email?.sourceDeliveryOrderEmailId || '',
    refQuoteDocumentId: email?.refQuoteDocumentId || '',
    externalDeliveryOrderId: email?.externalReference || email?.sourceDeliveryOrderDocumentId || '',
    companyId: '',
    company: '',
    customerAddress: '',
    customerPostal: '',
    attn: '',
    issueDate: isoDate(email?.receivedDate),
    dueDate: '',
    currency: 'SGD',
    reference: email?.refQuoteDocumentId || '',
    externalReference: email?.externalReference || '',
    staff: '',
    terms: '',
    job: '',
    subjectTitle: '',
    attachments: [],
    items: [createInvoiceItem({}, 1)]
  }
}

export function invoiceFromQuotation(email, quotation, overrides = {}) {
  const items = (quotation?.items?.length ? quotation.items : [{}]).map((item, index) => createInvoiceItem({
    item: String(index + 1),
    itemCode: item.itemCode || `B${String(index + 1).padStart(3, '0')}`,
    description: item.description || '',
    qty: item.qty ?? 1,
    uom: item.uom || '',
    unitPrice: item.unitPrice ?? 0,
    taxRate: item.taxRate ?? 9
  }, index + 1))

  const quoteRef = overrides.refQuoteDocumentId || quotation?.quotationNumber || quotation?.documentId || ''

  return {
    ...createDefaultInvoice(email),
    sourceQuotationEmailId: overrides.sourceQuotationEmailId || email?.sourceQuotationEmailId || '',
    refQuoteDocumentId: quoteRef,
    reference: quoteRef,
    companyId: quotation?.companyId || '',
    company: quotation?.company || '',
    customerAddress: quotation?.customerAddress || '',
    customerPostal: quotation?.customerPostal || '',
    attn: quotation?.attn || '',
    issueDate: overrides.issueDate || isoDate(email?.receivedDate),
    dueDate: quotation?.dueDate || '',
    currency: quotation?.currency || 'SGD',
    invoiceNumber: email?.documentId || overrides.invoiceNumber || '',
    documentId: email?.documentId || overrides.documentId || '',
    subjectTitle: quotation?.subjectTitle || email?.subject || '',
    staff: quotation?.staff || '',
    terms: '',
    job: quotation?.job || '',
    items,
    ...overrides
  }
}

export function invoiceFromDeliveryOrder(email, deliveryOrder, quotation = null, overrides = {}) {
  const items = (deliveryOrder?.items?.length ? deliveryOrder.items : [{}]).map((item, index) => createInvoiceItem({
    item: String(index + 1),
    itemCode: item.itemCode || `B${String(index + 1).padStart(3, '0')}`,
    description: item.description || '',
    qty: item.qty ?? 1,
    uom: item.uom || '',
    unitPrice: item.unitPrice ?? 0,
    taxRate: item.taxRate ?? 9
  }, index + 1))

  const quoteRef = overrides.refQuoteDocumentId
    || deliveryOrder?.refQuoteDocumentId
    || quotation?.quotationNumber
    || quotation?.documentId
    || ''
  const doRef = overrides.externalDeliveryOrderId
    || deliveryOrder?.deliveryOrderNumber
    || deliveryOrder?.documentId
    || email?.externalReference
    || ''

  return {
    ...createDefaultInvoice(email),
    sourceQuotationEmailId: overrides.sourceQuotationEmailId || deliveryOrder?.sourceQuotationEmailId || email?.sourceQuotationEmailId || '',
    sourceDeliveryOrderEmailId: overrides.sourceDeliveryOrderEmailId || email?.sourceDeliveryOrderEmailId || '',
    refQuoteDocumentId: quoteRef,
    externalDeliveryOrderId: doRef,
    reference: quoteRef,
    externalReference: doRef,
    companyId: deliveryOrder?.companyId || quotation?.companyId || '',
    company: deliveryOrder?.company || quotation?.company || '',
    customerAddress: deliveryOrder?.customerAddress || quotation?.customerAddress || '',
    customerPostal: deliveryOrder?.customerPostal || quotation?.customerPostal || '',
    attn: deliveryOrder?.attn || quotation?.attn || '',
    issueDate: overrides.issueDate || isoDate(email?.receivedDate),
    dueDate: deliveryOrder?.dueDate || quotation?.dueDate || '',
    currency: deliveryOrder?.currency || quotation?.currency || 'SGD',
    invoiceNumber: email?.documentId || overrides.invoiceNumber || '',
    documentId: email?.documentId || overrides.documentId || '',
    subjectTitle: deliveryOrder?.subjectTitle || quotation?.subjectTitle || email?.subject || '',
    staff: deliveryOrder?.staff || '',
    terms: '',
    job: deliveryOrder?.job || '',
    items,
    ...overrides
  }
}

import { getEmails, saveEmails } from './storage.js'
import { getQuotationDraft } from './quotationStorage.js'
import { getDeliveryOrderDraft } from './deliveryOrderStorage.js'
import { getInvoiceDraft, saveInvoiceDraft } from './invoiceStorage.js'
import { invoiceFromDeliveryOrder } from './invoiceUtils.js'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

export function spawnInvoiceFromCompletedDeliveryOrder(deliveryEmailId) {
  let emails = getEmails()
  const deliveryEmail = emails.find(item => item.id === deliveryEmailId)
  if (!deliveryEmail || deliveryEmail.status !== 'Completed' || deliveryEmail.category !== 'Delivery Order') return null

  const deliveryOrder = getDeliveryOrderDraft(deliveryEmailId)
  if (!deliveryOrder) return null

  const existing = emails.find(item => item.sourceDeliveryOrderEmailId === deliveryEmailId && item.category === 'Invoice')
  if (existing) return existing

  const quotationEmailId = deliveryOrder.sourceQuotationEmailId || deliveryEmail.sourceQuotationEmailId || ''
  const quotation = quotationEmailId ? getQuotationDraft(quotationEmailId) : null
  const id = `generated-inv-${deliveryEmailId}`

  const record = {
    id,
    partyType: deliveryEmail.partyType || 'customer',
    from: deliveryEmail.from,
    subject: `Invoice - ${deliveryOrder.subjectTitle || deliveryEmail.subject}`,
    category: 'Invoice',
    originalCategory: 'Invoice',
    section: 'inbox',
    receivedDate: todayIso(),
    status: 'To Be Reviewed',
    body: `Invoice created automatically from completed Delivery Order ${deliveryOrder.deliveryOrderNumber || deliveryEmail.documentId || ''}. Review the generated details before sending.`,
    attachments: [],
    fileName: '',
    amount: 0,
    confidence: 1,
    generatedFromCompletedDeliveryOrder: true,
    sourceDeliveryOrderEmailId: deliveryEmailId,
    sourceQuotationEmailId: quotationEmailId,
    refQuoteDocumentId: deliveryOrder.refQuoteDocumentId || quotation?.quotationNumber || '',
    externalReference: deliveryOrder.deliveryOrderNumber || deliveryEmail.documentId || ''
  }

  emails.push(record)
  saveEmails(emails)

  emails = getEmails()
  const savedRecord = emails.find(item => item.id === id)
  if (!savedRecord) return null

  if (!getInvoiceDraft(id)) {
    saveInvoiceDraft(id, invoiceFromDeliveryOrder(savedRecord, deliveryOrder, quotation, {
      sourceDeliveryOrderEmailId: deliveryEmailId,
      sourceQuotationEmailId: quotationEmailId,
      refQuoteDocumentId: savedRecord.refQuoteDocumentId,
      externalDeliveryOrderId: savedRecord.externalReference,
      issueDate: todayIso(),
      invoiceNumber: savedRecord.documentId,
      documentId: savedRecord.documentId
    }))
  }

  return savedRecord
}

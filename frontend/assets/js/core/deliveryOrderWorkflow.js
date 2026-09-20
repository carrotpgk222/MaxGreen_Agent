import { getEmails, saveEmails } from './storage.js'
import { getQuotationDraft } from './quotationStorage.js'
import { getDeliveryOrderDraft, saveDeliveryOrderDraft } from './deliveryOrderStorage.js'
import { deliveryOrderFromQuotation } from './deliveryOrderUtils.js'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

export function spawnDeliveryOrderFromCompletedQuotation(quotationEmailId) {
  let emails = getEmails()
  const quotationEmail = emails.find(item => item.id === quotationEmailId)
  if (!quotationEmail || quotationEmail.status !== 'Completed' || quotationEmail.category !== 'Quotation') return null

  const quotation = getQuotationDraft(quotationEmailId)
  if (!quotation) return null

  const existing = emails.find(item => item.sourceQuotationEmailId === quotationEmailId && item.category === 'Delivery Order')
  if (existing) return existing

  const id = `generated-do-${quotationEmailId}`
  const record = {
    id,
    partyType: quotationEmail.partyType || 'customer',
    from: quotationEmail.from,
    subject: `Delivery Order - ${quotation.subjectTitle || quotationEmail.subject}`,
    category: 'Delivery Order',
    originalCategory: 'Delivery Order',
    section: 'inbox',
    receivedDate: todayIso(),
    status: 'To Be Reviewed',
    body: `Delivery Order created automatically from completed quotation ${quotation.quotationNumber || quotationEmail.documentId || ''}. Review the generated details before sending.`,
    attachments: [],
    fileName: '',
    amount: 0,
    confidence: 1,
    generatedFromCompletedQuotation: true,
    sourceQuotationEmailId: quotationEmailId,
    refQuoteDocumentId: quotation.quotationNumber || quotationEmail.documentId || '',
    externalReference: quotation.quotationNumber || quotationEmail.documentId || ''
  }

  emails.push(record)
  saveEmails(emails)

  emails = getEmails()
  const savedRecord = emails.find(item => item.id === id)
  if (!savedRecord) return null

  if (!getDeliveryOrderDraft(id)) {
    const draft = deliveryOrderFromQuotation(savedRecord, quotation, {
      sourceQuotationEmailId: quotationEmailId,
      refQuoteDocumentId: quotation.quotationNumber || quotationEmail.documentId || '',
    externalReference: quotation.quotationNumber || quotationEmail.documentId || '',
      issueDate: todayIso(),
      deliveryOrderNumber: savedRecord.documentId,
      documentId: savedRecord.documentId
    })
    saveDeliveryOrderDraft(id, draft)
  }

  return savedRecord
}

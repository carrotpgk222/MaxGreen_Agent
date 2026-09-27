import { getEmails, saveEmails } from './storage.js'
import { getInvoiceDraft, saveInvoiceDraft } from './invoiceStorage.js'
import { getDeliveryOrderDraft, saveDeliveryOrderDraft } from './deliveryOrderStorage.js'
import { quotationTotals } from './quotationUtils.js'
import { upsertReceivableFromCompletedInvoice } from './receivableStorage.js'

export function splitCompletedInvoiceDo(bundleId, sendMeta = {}) {
  let emails = getEmails()
  const bundle = emails.find(item => item.id === bundleId)
  if (!bundle || bundle.category !== 'Invoice & DO') return null

  const invoiceDraft = getInvoiceDraft(bundleId)
  const deliveryDraft = getDeliveryOrderDraft(bundleId)
  if (!invoiceDraft || !deliveryDraft) return null

  const sentAt = sendMeta.sentAt || new Date().toISOString()
  const invoiceId = `${bundleId}--completed-invoice`
  const deliveryId = `${bundleId}--completed-do`

  const invoiceDocumentId = bundle.documentIds?.invoice || invoiceDraft.documentId || invoiceDraft.invoiceNumber || ''
  const deliveryDocumentId = bundle.documentIds?.deliveryOrder || deliveryDraft.documentId || deliveryDraft.deliveryOrderNumber || ''
  const invoiceTotals = quotationTotals(invoiceDraft.items || [])

  // Keep the original bundle as a workflow audit record, but remove it from
  // Pending/Completed UI. Completed shows the two PDFs independently.
  bundle.status = 'Split Completed'
  bundle.section = 'archive'
  bundle.splitCompletedAt = sentAt
  bundle.sentAt = sentAt
  bundle.sentTo = sendMeta.to || bundle.sentTo || ''
  bundle.sentSubject = sendMeta.subject || bundle.sentSubject || ''
  bundle.sentBody = sendMeta.body || bundle.sentBody || ''

  emails = emails.filter(item => ![invoiceId, deliveryId].includes(item.id))

  const invoiceEmail = {
    ...bundle,
    id: invoiceId,
    category: 'Invoice',
    originalCategory: 'Invoice & DO',
    status: 'Completed',
    section: 'completed',
    bundleSourceId: bundleId,
    documentId: invoiceDocumentId,
    fileName: `${invoiceDocumentId}.pdf`,
    documentIds: undefined,
    amount: Number(invoiceTotals.total || 0),
    sentAt,
    completedAt: sentAt,
    sentTo: sendMeta.to || bundle.sentTo || '',
    sentSubject: sendMeta.subject || `Tax Invoice - ${invoiceDraft.subjectTitle || bundle.subject}`,
    sentBody: sendMeta.body || '',
    generatedFromInvoiceDoBundle: true
  }

  const deliveryEmail = {
    ...bundle,
    id: deliveryId,
    category: 'Delivery Order',
    originalCategory: 'Invoice & DO',
    status: 'Completed',
    section: 'completed',
    bundleSourceId: bundleId,
    documentId: deliveryDocumentId,
    fileName: `${deliveryDocumentId}.pdf`,
    documentIds: undefined,
    amount: 0,
    sentAt,
    completedAt: sentAt,
    sentTo: sendMeta.to || bundle.sentTo || '',
    sentSubject: sendMeta.subject || `Delivery Order - ${deliveryDraft.subjectTitle || bundle.subject}`,
    sentBody: sendMeta.body || '',
    generatedFromInvoiceDoBundle: true
  }

  emails.push(invoiceEmail, deliveryEmail)
  saveEmails(emails)

  saveInvoiceDraft(invoiceId, {
    ...invoiceDraft,
    documentId: invoiceDocumentId,
    invoiceNumber: invoiceDocumentId
  })
  saveDeliveryOrderDraft(deliveryId, {
    ...deliveryDraft,
    documentId: deliveryDocumentId,
    deliveryOrderNumber: deliveryDocumentId,
    reference: deliveryDocumentId
  })

  upsertReceivableFromCompletedInvoice(invoiceEmail)

  return { invoiceEmail, deliveryEmail }
}

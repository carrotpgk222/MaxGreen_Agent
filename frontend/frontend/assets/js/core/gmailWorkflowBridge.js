import { API_BASE } from './api.js'
import { sgtDateKey } from './dateTime.js'
import { getEmails, saveEmails } from './storage.js'
import { getQuotationDraft, saveQuotationDraft } from './quotationStorage.js'
import { getDeliveryOrderDraft, saveDeliveryOrderDraft } from './deliveryOrderStorage.js'
import { getInvoiceDraft, saveInvoiceDraft } from './invoiceStorage.js'
import { createDefaultQuotation, createQuotationItem } from './quotationUtils.js'
import { deliveryOrderFromQuotation } from './deliveryOrderUtils.js'
import { invoiceFromDeliveryOrder } from './invoiceUtils.js'

function gmailAttachmentUrl(messageId, attachment = {}) {
  const attachmentId = attachment.attachment_id || ''
  if (!attachmentId) return ''
  const filename = attachment.filename || 'attachment'
  return `${API_BASE}/api/gmail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?filename=${encodeURIComponent(filename)}`
}

function normalizePartyType(value, category) {
  if (category === 'Supplier Payable') return 'supplier'
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'supplier') return 'supplier'
  return 'customer'
}

function normalizeRef(value = '') {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function findCompletedQuotationByRef(refs = []) {
  const wanted = refs.map(normalizeRef).filter(Boolean)
  if (!wanted.length) return null

  const emails = getEmails()
  for (const quoteEmail of emails) {
    if (quoteEmail.category !== 'Quotation' || quoteEmail.status !== 'Completed' || quoteEmail.deletedFromCompleted) continue
    const quotation = getQuotationDraft(quoteEmail.id)
    if (!quotation) continue

    const candidates = [
      quotation.quotationNumber,
      quotation.documentId,
      quoteEmail.documentId,
      ...(quoteEmail.previousDocumentIds || [])
    ].map(normalizeRef).filter(Boolean)

    if (wanted.some(ref => candidates.includes(ref))) {
      return { email: quoteEmail, quotation }
    }
  }
  return null
}

function aiQuotationDraft(message, workflowEmail) {
  const extracted = message.ai_quotation_draft || {}
  const sourceItems = Array.isArray(extracted.items) ? extracted.items : []
  const base = createDefaultQuotation(workflowEmail)

  const fallbackDescription = String(workflowEmail.subject || message.subject || 'Customer quotation request').replace(/^\s*\[[^\]]+\]\s*/, '').trim()
  const items = sourceItems.length
    ? sourceItems.map((item, index) => createQuotationItem({
        item: String(index + 1),
        description: item.description || '',
        qty: item.qty == null ? '' : item.qty,
        preserveBlankQty: item.qty == null,
        uom: item.uom || '',
        unitPrice: item.unit_price == null ? 0 : item.unit_price,
        taxRate: item.tax_rate == null ? 9 : item.tax_rate
      }, index + 1))
    : [createQuotationItem({
        item: '1',
        description: fallbackDescription,
        qty: '',
        preserveBlankQty: true,
        uom: '',
        unitPrice: 0,
        taxRate: 9
      }, 1)]

  const hasStructuredAiFields = Boolean(
    sourceItems.length > 0
    || extracted.company
    || extracted.attn
    || extracted.customer_address
    || extracted.customer_postal
    || extracted.external_reference
    || extracted.currency
    || extracted.subject_title
  )

  return {
    ...base,
    documentId: workflowEmail.documentId || base.documentId || '',
    quotationNumber: workflowEmail.documentId || base.quotationNumber || '',
    company: extracted.company || '',
    attn: extracted.attn || '',
    customerAddress: extracted.customer_address || '',
    customerPostal: String(extracted.customer_postal || '').replace(/\D/g, ''),
    externalReference: extracted.external_reference || '',
    currency: extracted.currency || 'SGD',
    subjectTitle: extracted.subject_title || workflowEmail.subject || '',
    items,
    aiPrefilled: hasStructuredAiFields,
    automationFallback: !hasStructuredAiFields,
    aiExtractionVersion: Number(extracted.extraction_version || 0),
    aiSourceGmailMessageId: message.gmail_message_id,
    aiPrefilledAt: new Date().toISOString()
  }
}

function isBlank(value) {
  return value == null || String(value).trim() === ''
}

function hasMeaningfulQuotationItems(items = []) {
  return Array.isArray(items) && items.some(item => {
    const description = String(item?.description || '').trim()
    const uom = String(item?.uom || '').trim()
    const unitPrice = Number(item?.unitPrice || 0)
    // A default draft often contains only item no. 1 / qty 1 / tax 9.
    // Those defaults must not block Gmail automation from filling the description.
    return Boolean(description || uom || unitPrice > 0)
  })
}

function mergeAutomationIntoDraft(existing, prepared) {
  // Once the human explicitly saves the editor, AI/source automation must never
  // overwrite their decisions on later Inbox refreshes or Gmail syncs.
  if (existing?.humanEdited) return existing

  const merged = { ...existing }
  const upgradingFallback = Boolean(existing?.automationFallback && prepared?.aiPrefilled)
  const existingVersion = Number(existing?.aiExtractionVersion || 0)
  const preparedVersion = Number(prepared?.aiExtractionVersion || 0)
  const upgradingAiExtraction = Boolean(prepared?.aiPrefilled && preparedVersion > existingVersion)

  const fillIfBlank = (key) => {
    if (isBlank(merged[key]) && !isBlank(prepared[key])) merged[key] = prepared[key]
  }

  ;[
    'company',
    'attn',
    'customerAddress',
    'customerPostal',
    'externalReference',
    'subjectTitle'
  ].forEach(fillIfBlank)

  // v31 may already have saved a safe source-email fallback. When structured
  // Claude extraction later succeeds, upgrade that AUTOMATION fallback to the
  // better AI draft. This is safe because humanEdited was checked above.
  if (upgradingFallback || upgradingAiExtraction) {
    ;[
      'company',
      'attn',
      'customerAddress',
      'customerPostal',
      'externalReference',
      'subjectTitle'
    ].forEach(key => {
      if (!isBlank(prepared[key])) merged[key] = prepared[key]
    })
  }

  if (isBlank(merged.currency) || upgradingFallback || upgradingAiExtraction) merged.currency = prepared.currency || merged.currency || 'SGD'

  if (
    hasMeaningfulQuotationItems(prepared.items)
    && (!hasMeaningfulQuotationItems(merged.items) || upgradingFallback || upgradingAiExtraction)
  ) {
    merged.items = prepared.items
  }

  // Carry automation metadata forward so the review page can explain how the
  // draft was prepared, even when this is an older v27/v28/v31 fallback draft.
  merged.aiPrefilled = Boolean(existing?.aiPrefilled || prepared.aiPrefilled)
  merged.automationFallback = Boolean(
    !merged.aiPrefilled && (existing?.automationFallback || prepared.automationFallback)
  )
  merged.aiExtractionVersion = Math.max(existingVersion, preparedVersion)
  merged.aiSourceGmailMessageId = prepared.aiSourceGmailMessageId || existing?.aiSourceGmailMessageId || ''
  merged.aiPrefilledAt = prepared.aiPrefilledAt || existing?.aiPrefilledAt || new Date().toISOString()

  return merged
}

function ensureQuotationDraftFromAi(message, workflowEmail) {
  if ((message.ai_category || '') !== 'Quotation') return

  const prepared = aiQuotationDraft(message, workflowEmail)
  const existing = getQuotationDraft(workflowEmail.id)

  if (!existing) {
    saveQuotationDraft(workflowEmail.id, prepared)
    return
  }

  // v27-v30 could already have created an empty/default quotation before the
  // Gmail extraction was available. Merge automation into only the blank parts
  // instead of returning early and leaving the PDF empty.
  const merged = mergeAutomationIntoDraft(existing, prepared)
  saveQuotationDraft(workflowEmail.id, merged)
}

function ensureInvoiceDoDraftsFromQuote(message, workflowEmail) {
  if ((message.ai_category || '') !== 'Invoice & DO') return

  const refs = message.ai_quotation_references || []
  const match = findCompletedQuotationByRef(refs)
  if (!match) return

  let emails = getEmails()
  const record = emails.find(item => item.id === workflowEmail.id)
  if (!record) return

  record.sourceQuotationEmailId = match.email.id
  record.refQuoteDocumentId = match.quotation.quotationNumber || match.quotation.documentId || refs[0] || ''
  record.matchedPurchaseOrderQuoteRef = refs[0] || record.refQuoteDocumentId
  record.purchaseOrderQuoteMatched = true
  saveEmails(emails)

  emails = getEmails()
  const saved = emails.find(item => item.id === workflowEmail.id)
  if (!saved) return

  let delivery = getDeliveryOrderDraft(saved.id)
  if (!delivery) {
    delivery = deliveryOrderFromQuotation(saved, match.quotation, {
      sourceQuotationEmailId: match.email.id,
      refQuoteDocumentId: match.quotation.quotationNumber || match.quotation.documentId || refs[0] || '',
      externalReference: match.quotation.quotationNumber || match.quotation.documentId || refs[0] || '',
      documentId: saved.documentIds?.deliveryOrder || '',
      deliveryOrderNumber: saved.documentIds?.deliveryOrder || ''
    })
    delivery.aiMatchedFromPurchaseOrder = true
    saveDeliveryOrderDraft(saved.id, delivery)
  }

  if (!getInvoiceDraft(saved.id)) {
    const invoice = invoiceFromDeliveryOrder(saved, delivery, match.quotation, {
      sourceDeliveryOrderEmailId: saved.id,
      sourceQuotationEmailId: match.email.id,
      refQuoteDocumentId: match.quotation.quotationNumber || match.quotation.documentId || refs[0] || '',
      externalDeliveryOrderId: saved.documentIds?.deliveryOrder || delivery.documentId || '',
      documentId: saved.documentIds?.invoice || '',
      invoiceNumber: saved.documentIds?.invoice || '',
      terms: ''
    })
    invoice.aiMatchedFromPurchaseOrder = true
    saveInvoiceDraft(saved.id, invoice)
  }
}

/**
 * Mirror a real Gmail/SQLite record into the existing browser workflow store.
 * For Quotation, Claude's extracted email fields are used to pre-fill the quotation PDF.
 * For Invoice & DO, only the PO's Quote Ref is needed; the matching completed quotation
 * becomes the source for both generated documents.
 */
export function upsertGmailWorkflowMessage(message) {
  const id = message?.gmail_message_id
  if (!id) return null

  const category = message.ai_category || 'Others'
  const emails = getEmails()
  const existing = emails.find(item => item.id === id)

  const attachments = (message.attachments || []).map(item => ({
    name: item.filename || 'attachment',
    fileName: item.filename || 'attachment',
    mimeType: item.mime_type || '',
    attachmentId: item.attachment_id || '',
    url: gmailAttachmentUrl(id, item)
  }))

  const gmailFields = {
    sourceType: 'gmail',
    gmailMessageId: id,
    threadId: message.thread_id || '',
    from: message.sender_email || message.sender || 'Unknown sender',
    senderName: message.sender || '',
    subject: message.subject || '(No subject)',
    receivedDate: sgtDateKey(message.received_at),
    receivedAt: message.received_at || '',
    body: message.body_text || message.snippet || '',
    attachments,
    aiCategory: category,
    aiReason: message.ai_reason || '',
    aiSecurityStatus: message.ai_security_status || 'Pending',
    confidence: message.ai_confidence ?? null,
    aiQuotationDraft: message.ai_quotation_draft || {},
    purchaseOrderQuoteRefs: message.ai_quotation_references || [],
    partyType: normalizePartyType(message.ai_party_type, category)
  }

  if (existing) {
    Object.assign(existing, gmailFields)
    if (!existing.originalCategory || existing.originalCategory === 'Unclassified') {
      existing.originalCategory = category
    }
    // Do not overwrite a category that the human manually corrected.
    if (!existing.correctedByUser && existing.status !== 'Pending' && existing.status !== 'Completed') {
      existing.category = category
    }
    existing.section = existing.section || 'inbox'
    existing.status = existing.status || 'To Be Reviewed'
  } else {
    emails.push({
      id,
      ...gmailFields,
      category,
      originalCategory: category,
      section: 'inbox',
      status: 'To Be Reviewed'
    })
  }

  saveEmails(emails)
  const saved = getEmails().find(item => item.id === id) || null
  if (!saved) return null

  ensureQuotationDraftFromAi(message, saved)
  ensureInvoiceDoDraftsFromQuote(message, saved)
  return getEmails().find(item => item.id === id) || saved
}

export function findPurchaseOrderQuotationMatch(message) {
  return findCompletedQuotationByRef(message?.ai_quotation_references || [])
}

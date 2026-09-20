import { getEmails, saveEmails } from './storage.js'
import { getQuotationDraft, saveQuotationDraft } from './quotationStorage.js'
import { getDeliveryOrderDraft, saveDeliveryOrderDraft } from './deliveryOrderStorage.js'
import { createDefaultQuotation, createQuotationItem } from './quotationUtils.js'
import { createDefaultDeliveryOrder, createDeliveryOrderItem, deliveryOrderFromQuotation } from './deliveryOrderUtils.js'
import { getInvoiceDraft, saveInvoiceDraft } from './invoiceStorage.js'
import { createDefaultInvoice, createInvoiceItem, invoiceFromDeliveryOrder } from './invoiceUtils.js'


const FILE_NAMES = Object.freeze({
  Quotation: 'QUOTATION.pdf',
  'Delivery Order': 'Delivery Order.pdf',
  Invoice: 'Invoice.pdf',
  'Invoice & DO': 'Invoice & DO.pdf'
})

export function routeForCategory(category, id) {
  const encoded = encodeURIComponent(id)
  if (category === 'Quotation') return `./quotation.html?id=${encoded}`
  if (category === 'Delivery Order') return `./delivery-order.html?id=${encoded}`
  if (category === 'Invoice') return `./invoice.html?id=${encoded}`
  if (category === 'Invoice & DO') return `./invoice-do.html?id=${encoded}`
  return `./document.html?id=${encoded}`
}

function quotationFromDeliveryOrder(email, deliveryOrder) {
  const base = createDefaultQuotation(email)
  return {
    ...base,
    companyId: deliveryOrder?.companyId || '',
    company: deliveryOrder?.company || '',
    customerAddress: deliveryOrder?.customerAddress || '',
    customerPostal: deliveryOrder?.customerPostal || '',
    attn: deliveryOrder?.attn || '',
    issueDate: deliveryOrder?.issueDate || base.issueDate,
    subjectTitle: deliveryOrder?.subjectTitle || '',
    attachments: deliveryOrder?.attachments || [],
    quotationNumber: email.documentId || base.quotationNumber,
    documentId: email.documentId || '',
    items: (deliveryOrder?.items?.length ? deliveryOrder.items : [{}]).map((item, index) => createQuotationItem({
      item: String(index + 1),
      description: item.description || '',
      qty: item.qty ?? 1,
      uom: item.uom || '',
      unitPrice: 0,
      taxRate: 9
    }, index + 1))
  }
}

function deliveryOrderFromCurrent(email, deliveryOrder) {
  const base = createDefaultDeliveryOrder(email)
  return {
    ...base,
    ...(deliveryOrder || {}),
    documentId: email.documentId || deliveryOrder?.documentId || '',
    deliveryOrderNumber: email.documentId || deliveryOrder?.deliveryOrderNumber || '',
    items: (deliveryOrder?.items?.length ? deliveryOrder.items : [{}]).map((item, index) => createDeliveryOrderItem(item, index + 1))
  }
}

export function changeWorkflowCategory(emailId, newCategory) {
  let emails = getEmails()
  let email = emails.find(item => item.id === emailId)
  if (!email) return null

  const oldCategory = email.category
  if (oldCategory === newCategory) {
    return { email, route: routeForCategory(newCategory, emailId) }
  }

  const quotationDraft = getQuotationDraft(emailId)
  const deliveryDraft = getDeliveryOrderDraft(emailId)
  const invoiceDraft = getInvoiceDraft(emailId)

  email.category = newCategory
  email.correctedByUser = newCategory !== email.originalCategory
  email.categoryCorrectedAt = new Date().toISOString()
  email.previousCategory = oldCategory

  // Category-specific business document IDs must also change with the selected PDF type.
  delete email.documentId
  delete email.documentIds
  saveEmails(emails)

  emails = getEmails()
  email = emails.find(item => item.id === emailId)
  if (!email) return null
  email.fileName = email.documentId ? `${email.documentId}.pdf` : (FILE_NAMES[newCategory] || `${newCategory}.pdf`)
  saveEmails(emails)
  emails = getEmails()
  email = emails.find(item => item.id === emailId)

  if (newCategory === 'Delivery Order') {
    const draft = quotationDraft
      ? deliveryOrderFromQuotation(email, quotationDraft, {
          sourceQuotationEmailId: email.sourceQuotationEmailId || '',
          refQuoteDocumentId: quotationDraft.quotationNumber || quotationDraft.documentId || ''
        })
      : deliveryOrderFromCurrent(email, deliveryDraft)
    draft.documentId = email.documentId
    draft.deliveryOrderNumber = email.documentId
    saveDeliveryOrderDraft(emailId, draft)
  }

  if (newCategory === 'Quotation') {
    const draft = deliveryDraft
      ? quotationFromDeliveryOrder(email, deliveryDraft)
      : {
          ...createDefaultQuotation(email),
          ...(quotationDraft || {}),
          documentId: email.documentId,
          quotationNumber: email.documentId,
          items: (quotationDraft?.items?.length ? quotationDraft.items : [{}]).map((item, index) => createQuotationItem(item, index + 1))
        }
    draft.documentId = email.documentId
    draft.quotationNumber = email.documentId
    saveQuotationDraft(emailId, draft)
  }


  if (newCategory === 'Invoice & DO') {
    const sourceQuotation = quotationDraft
      || (email.sourceQuotationEmailId ? getQuotationDraft(email.sourceQuotationEmailId) : null)

    let bundledDelivery
    if (sourceQuotation) {
      bundledDelivery = deliveryOrderFromQuotation(email, sourceQuotation, {
        sourceQuotationEmailId: email.sourceQuotationEmailId || emailId,
        refQuoteDocumentId: sourceQuotation.quotationNumber || sourceQuotation.documentId || ''
      })
    } else {
      bundledDelivery = deliveryOrderFromCurrent(email, deliveryDraft)
    }

    bundledDelivery.documentId = email.documentIds?.deliveryOrder || bundledDelivery.documentId || ''
    bundledDelivery.deliveryOrderNumber = bundledDelivery.documentId
    bundledDelivery.reference = bundledDelivery.documentId
    saveDeliveryOrderDraft(emailId, bundledDelivery)

    const bundledInvoice = invoiceFromDeliveryOrder(email, bundledDelivery, sourceQuotation, {
      sourceDeliveryOrderEmailId: emailId,
      sourceQuotationEmailId: bundledDelivery.sourceQuotationEmailId || email.sourceQuotationEmailId || '',
      refQuoteDocumentId: bundledDelivery.refQuoteDocumentId || sourceQuotation?.quotationNumber || '',
      externalDeliveryOrderId: bundledDelivery.documentId || '',
      documentId: email.documentIds?.invoice || '',
      invoiceNumber: email.documentIds?.invoice || '',
      terms: ''
    })
    saveInvoiceDraft(emailId, bundledInvoice)
  }

  if (newCategory === 'Invoice') {
    let draft
    if (deliveryDraft) {
      const quotation = deliveryDraft.sourceQuotationEmailId
        ? getQuotationDraft(deliveryDraft.sourceQuotationEmailId)
        : quotationDraft
      draft = invoiceFromDeliveryOrder(email, deliveryDraft, quotation, {
        refQuoteDocumentId: deliveryDraft.refQuoteDocumentId || quotation?.quotationNumber || '',
        externalDeliveryOrderId: deliveryDraft.deliveryOrderNumber || deliveryDraft.documentId || '',
        documentId: email.documentId,
        invoiceNumber: email.documentId
      })
    } else {
      draft = {
        ...createDefaultInvoice(email),
        ...(invoiceDraft || {}),
        documentId: email.documentId,
        invoiceNumber: email.documentId,
        items: (invoiceDraft?.items?.length ? invoiceDraft.items : [{}])
          .map((item, index) => createInvoiceItem(item, index + 1))
      }
    }
    saveInvoiceDraft(emailId, draft)
  }

  return { email, route: routeForCategory(newCategory, emailId) }
}

import { getEmails, saveEmails } from '../core/storage.js'
import { getQuotationDraft } from '../core/quotationStorage.js'
import { getDeliveryOrderDraft } from '../core/deliveryOrderStorage.js'
import { spawnDeliveryOrderFromCompletedQuotation } from '../core/deliveryOrderWorkflow.js'
import { spawnInvoiceFromCompletedDeliveryOrder } from '../core/invoiceWorkflow.js'
import { getInvoiceDraft } from '../core/invoiceStorage.js'
import { upsertReceivableFromCompletedInvoice } from '../core/receivableStorage.js'
import { splitCompletedInvoiceDo } from '../core/invoiceDoWorkflow.js'
import { getSoaDraft } from '../core/soaStorage.js'
import { money as soaMoney, displayDate as soaDisplayDate } from '../core/soaUtils.js'
import { createDefaultInvoice, createInvoiceItem } from '../core/invoiceUtils.js'
import { getCompanies } from '../core/customerStorage.js'
import { getQueryParam } from '../core/utils.js'
import { attachmentNames } from '../core/attachmentUtils.js'
import {
  sendEmail
} from '../core/documentSend.js'

import {
  createDefaultQuotation,
  createQuotationItem,
  displayDate,
  escapeHtml,
  formatMoney,
  lineAmount,
  quotationTaxLabel,
  quotationTotals,
  totalInWords
} from '../core/quotationUtils.js'

import {
  createDefaultDeliveryOrder,
  createDeliveryOrderItem
} from '../core/deliveryOrderUtils.js'


// ============================================================
// DOCUMENT
// ============================================================

const id = getQueryParam('id')

const completedViewMode =
  document.body.dataset.viewMode === 'completed'

let emails = getEmails()

let email =
  emails.find(item => item.id === id)


if (!email) {
<<<<<<< Updated upstream
  document.body.innerHTML = `
    <main class="page">
      <a class="back-link" href="./pending.html">
        ← Back to Pending
      </a>

      <h1 class="page-title">
        Document not found
      </h1>
    </main>
  `

=======
  renderDocumentMissing('./pending.html', 'Back to Pending')
}

function renderDocumentMissing(backHref, backLabel, detail = '') {
  document.body.innerHTML = `<main class="page"><a class="back-link" href="${backHref}">← ${backLabel}</a><h1 class="page-title">Document not found</h1>${detail ? `<p>${detail}</p>` : ''}</main>`
>>>>>>> Stashed changes
  throw new Error('Pending document not found')
}


const $ = elementId =>
  document.getElementById(elementId)


const quotationDraft =
  getQuotationDraft(id)

const deliveryOrderDraft =
  getDeliveryOrderDraft(id)

const invoiceDraft =
  getInvoiceDraft(id)


const isQuotation =
  email.category === 'Quotation' ||
  Boolean(
    quotationDraft &&
    email.category === 'Quotation'
  )


const isDeliveryOrder =
  email.category === 'Delivery Order' ||
  Boolean(
    deliveryOrderDraft &&
    email.category === 'Delivery Order'
  )


const isInvoice =
  email.category === 'Invoice'


const isInvoiceDo =
  email.category === 'Invoice & DO'


const isSoa =
  email.category === 'Statement of Account'


const isCompleted =
  email.status === 'Completed'



// ============================================================
// HEADER
// ============================================================

$('pending-file-name').textContent =
  email.fileName ||
  `${email.category}.pdf`


$('pending-reference').textContent =
  isInvoiceDo
    ? [
      email.documentIds?.invoice,
      email.documentIds?.deliveryOrder
    ]
      .filter(Boolean)
      .join(' + ')
    : (
      email.documentId ||
      'No reference'
    )


$('pending-category').textContent =
  email.category



// ============================================================
// COMPLETED VIEW
// ============================================================

if (isCompleted) {

  $('view-context').textContent =
    'COMPLETED'

  $('back-link').href =
    './completed.html'

  $('back-link').textContent =
    '← Back to Completed'

  $('pending-actions').hidden =
    !completedViewMode

  $('sent-summary').hidden =
    false


  const sentDate =
    email.sentAt
      ? new Date(
        email.sentAt
      ).toLocaleString('en-SG')
      : 'previously'


  $('sent-summary-text').textContent =
    `Sent to ${email.sentTo || 'recipient'} on ${sentDate}.`
}


if (
  completedViewMode &&
  !isCompleted
) {

  $('view-context').textContent =
    'DOCUMENT'

  $('pending-actions').hidden =
    true
}



// ============================================================
// QUOTATION STATE
// ============================================================

function quotationState() {

  return {

    ...createDefaultQuotation(email),

    ...(quotationDraft || {}),

    documentId:
      email.documentId ||
      quotationDraft?.documentId ||
      '',

    items:
      (
        quotationDraft?.items?.length
          ? quotationDraft.items
          : [{}]
      )
        .map(
          (item, index) =>
            createQuotationItem(
              item,
              index + 1
            )
        )

  }

}



// ============================================================
// DELIVERY ORDER STATE
// ============================================================

function deliveryOrderState() {

  return {

    ...createDefaultDeliveryOrder(email),

    ...(deliveryOrderDraft || {}),

    documentId:
      (
        isInvoiceDo
          ? email.documentIds?.deliveryOrder
          : email.documentId
      ) ||
      deliveryOrderDraft?.documentId ||
      '',

    deliveryOrderNumber:
      deliveryOrderDraft?.deliveryOrderNumber ||
      (
        isInvoiceDo
          ? email.documentIds?.deliveryOrder
          : email.documentId
      ) ||
      '',

    items:
      (
        deliveryOrderDraft?.items?.length
          ? deliveryOrderDraft.items
          : [{}]
      )
        .map(
          (item, index) =>
            createDeliveryOrderItem(
              item,
              index + 1
            )
        )

  }

}



// ============================================================
// CUSTOMER DETAILS
// ============================================================

function customerDetails(document) {

  const companies =
    getCompanies()


  const company =
    companies.find(item =>

      (
        document.companyId &&
        item.id === document.companyId
      )

      ||

      item.companyName
        ?.trim()
        .toLowerCase() ===
      document.company
        ?.trim()
        .toLowerCase()

    )


  const contact =
    company?.contacts?.find(
      item =>
        item.name === document.attn
    )
    ||
    company?.contacts?.[0]
    ||
    null


  return {

    address:
      document.customerAddress ||
      contact?.address ||
      '',

    postal:
      document.customerPostal ||
      contact?.postal ||
      ''

  }

}



// ============================================================
// RENDER QUOTATION
// ============================================================

function renderQuotation() {

  const quotation =
    quotationState()

  const customer =
    customerDetails(quotation)

  const {
    subtotal,
    gst,
    total
  } =
    quotationTotals(
      quotation.items
    )


  $('quotation-document').hidden =
    false

  $('preview-company').textContent =
    quotation.company ||
    'Customer / Company'

  $('preview-address').textContent =
    customer.address

  $('preview-postal').textContent =
    customer.postal
      ? `Singapore ${customer.postal}`
      : ''

  $('preview-attn').textContent =
    quotation.attn
      ? `Attn: ${quotation.attn}`
      : ''

  $('preview-number').textContent =
    `: ${quotation.quotationNumber ||
    quotation.documentId ||
    ''
    }`

  $('preview-date').textContent =
    `: ${displayDate(
      quotation.issueDate
    )}`

  $('preview-ref').textContent =
    `: ${quotation.documentId ||
    quotation.quotationNumber ||
    email.documentId ||
    ''
    }`

  $('preview-external-ref').textContent =
    `: ${quotation.externalReference ||
    email.externalReference ||
    ''
    }`

  $('preview-subject').textContent =
    (
      quotation.subjectTitle ||
      'QUOTATION SUBJECT'
    ).toUpperCase()

  $('preview-amount-words').textContent =
    totalInWords(total)

  $('preview-subtotal').textContent =
    formatMoney(subtotal)

  $('preview-tax-label').textContent =
    quotationTaxLabel(
      quotation.items,
      'pdf'
    )

  $('preview-gst').textContent =
    formatMoney(gst)

  $('preview-total').textContent =
    formatMoney(total)


  const rows =
    quotation.items

      .map(
        (item, index) => `

          <tr class="paper-data-row">

            <td>
              ${escapeHtml(
          item.item ||
          String(index + 1)
        )}
            </td>

            <td>
              ${escapeHtml(
          item.description
        ).replace(/\n/g, '<br>')}
            </td>

            <td>
              ${escapeHtml(
          String(item.qty || '')
        )}
              ${item.uom
            ? ` ${escapeHtml(item.uom)}`
            : ''
          }
            </td>

            <td>
              ${formatMoney(
            item.unitPrice
          )}
            </td>

            <td>
              ${formatMoney(
            lineAmount(item)
          )}
            </td>

          </tr>

        `
      )

      .join('')


  $('preview-items').innerHTML =
    `${rows}

      <tr
        class="paper-spacer-row"
        aria-hidden="true"
      >
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
      </tr>`

}



// ============================================================
// RENDER DELIVERY ORDER
// ============================================================

function renderDeliveryOrder() {

  const deliveryOrder =
    deliveryOrderState()

  const customer =
    customerDetails(
      deliveryOrder
    )


  $('delivery-order-document').hidden =
    false

  $('do-preview-company').textContent =
    deliveryOrder.company ||
    'Customer / Company'

  $('do-preview-address').textContent =
    customer.address

  $('do-preview-postal').textContent =
    customer.postal
      ? `Singapore ${customer.postal}`
      : ''

  $('do-preview-attn').textContent =
    deliveryOrder.attn
      ? `Attn: ${deliveryOrder.attn}`
      : ''

  $('do-preview-number').textContent =
    `: ${deliveryOrder.deliveryOrderNumber ||
    deliveryOrder.documentId ||
    ''
    }`

  $('do-preview-date').textContent =
    `: ${displayDate(
      deliveryOrder.issueDate
    )}`

  $('do-preview-reference').textContent =
    `: ${deliveryOrder.documentId ||
    deliveryOrder.deliveryOrderNumber ||
    email.documentId ||
    ''
    }`

  $('do-preview-external-reference').textContent =
    `: ${deliveryOrder.refQuoteDocumentId ||
    deliveryOrder.externalReference ||
    ''
    }`

  $('do-preview-staff').textContent =
    `: ${deliveryOrder.staff || ''}`

  $('do-preview-terms').textContent =
    `: ${deliveryOrder.terms || ''}`

  $('do-preview-job').textContent =
    `: ${deliveryOrder.job || ''}`

  $('do-preview-subject').textContent =
    deliveryOrder.subjectTitle ||
    'DELIVERY ORDER SUBJECT'


  const rows =
    deliveryOrder.items

      .map(
        (item, index) => `

          <tr class="delivery-data-row">

            <td>
              ${escapeHtml(
          item.item ||
          String(index + 1)
        )}
            </td>

            <td>
              ${escapeHtml(
          item.description
        ).replace(/\n/g, '<br>')}
            </td>

            <td>
              ${escapeHtml(
          String(item.qty || '')
        )}
              ${item.uom
            ? ` ${escapeHtml(item.uom)}`
            : ''
          }
            </td>

          </tr>

        `
      )

      .join('')


  const refRow =
    deliveryOrder.refQuoteDocumentId

      ? `
        <tr class="delivery-ref-row">

          <td></td>

          <td>
            <strong>
              ${escapeHtml(
        deliveryOrder.refQuoteDocumentId
      )}
            </strong>
          </td>

          <td></td>

        </tr>
      `

      : ''


  $('do-preview-items').innerHTML =
    `${rows}${refRow}

      <tr
        class="delivery-spacer-row"
        aria-hidden="true"
      >
        <td></td>
        <td></td>
        <td></td>
      </tr>`

}



// ============================================================
// INVOICE STATE
// ============================================================

function invoiceState() {

  const base =
    createDefaultInvoice(email)


  return {

    ...base,

    ...(invoiceDraft || {}),

    documentId:
      (
        isInvoiceDo
          ? email.documentIds?.invoice
          : email.documentId
      ) ||
      invoiceDraft?.documentId ||
      '',

    invoiceNumber:
      (
        isInvoiceDo
          ? email.documentIds?.invoice
          : email.documentId
      ) ||
      invoiceDraft?.invoiceNumber ||
      '',

    items:
      (
        invoiceDraft?.items?.length
          ? invoiceDraft.items
          : [{}]
      )
        .map(
          (item, index) =>
            createInvoiceItem(
              item,
              index + 1
            )
        ),

    terms: ''

  }

}



// ============================================================
// RENDER INVOICE
// ============================================================

function renderInvoice() {

  const invoice =
    invoiceState()


  $('invoice-document').hidden =
    false

  $('inv-preview-company').textContent =
    invoice.company ||
    'Customer / Company'

  $('inv-preview-address').textContent =
    invoice.customerAddress ||
    ''

  $('inv-preview-postal').textContent =
    invoice.customerPostal
      ? `Singapore ${invoice.customerPostal}`
      : ''

  $('inv-preview-attn').textContent =
    invoice.attn
      ? `Attn: ${invoice.attn}`
      : ''

  $('inv-preview-number').textContent =
    `: ${invoice.invoiceNumber ||
    invoice.documentId ||
    ''
    }`

  $('inv-preview-date').textContent =
    `: ${displayDate(
      invoice.issueDate
    )}`

  $('inv-preview-reference').textContent =
    `: ${invoice.refQuoteDocumentId ||
    invoice.reference ||
    ''
    }`

  $('inv-preview-external-reference').textContent =
    `: ${invoice.externalDeliveryOrderId ||
    invoice.externalReference ||
    ''
    }`

  $('inv-preview-staff').textContent =
    `: ${invoice.staff || ''}`

  $('inv-preview-terms').textContent =
    `: ${invoice.terms || ''}`

  $('inv-preview-job').textContent =
    `: ${invoice.job || ''}`

  $('inv-preview-subject').textContent =
    invoice.subjectTitle ||
    'INVOICE SUBJECT'


  const rows =
    invoice.items

      .map(
        (item, index) => `

          <tr class="invoice-data-row">

            <td>
              ${escapeHtml(
          item.item ||
          String(index + 1)
        )}
            </td>

            <td>
              ${escapeHtml(
          item.description || ''
        ).replace(/\n/g, '<br>')}
            </td>

            <td>
              ${escapeHtml(
          String(item.qty || '')
        )}
              ${item.uom
            ? ` ${escapeHtml(item.uom)}`
            : ''
          }
            </td>

            <td>
              ${formatMoney(
            item.unitPrice
          )}
            </td>

            <td>
              ${formatMoney(
            lineAmount(item)
          )}
            </td>

          </tr>

        `
      )

      .join('')


  $('inv-preview-items').innerHTML =
    `${rows}

      <tr
        class="invoice-spacer-row"
        aria-hidden="true"
      >
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
      </tr>`


  $('pending-invoice-paynow').src =
    invoice.paynowQrDataUrl ||
    './assets/images/paynow-qr.png'


  const totals =
    quotationTotals(
      invoice.items
    )


  $('inv-preview-subtotal').textContent =
    formatMoney(
      totals.subtotal
    )

  $('inv-preview-gst').textContent =
    formatMoney(
      totals.gst
    )

  $('inv-preview-total').textContent =
    formatMoney(
      totals.total
    )

  $('inv-preview-tax-label').textContent =
    quotationTaxLabel(
      invoice.items,
      'paper'
    )

  $('inv-preview-amount-words').textContent =
    totalInWords(
      totals.total
    )

}



// ============================================================
// GENERIC DOCUMENT
// ============================================================

function renderGeneric() {

  $('generic-document').hidden =
    false

  $('generic-title').textContent =
    email.fileName ||
    `${email.category}.pdf`

  $('generic-from').textContent =
    email.from

  $('generic-subject').textContent =
    email.subject

  $('generic-reference').textContent =
    email.documentId ||
    '—'

  $('generic-category').textContent =
    email.category

}



// ============================================================
// STATEMENT OF ACCOUNT
// ============================================================

function renderSoa() {

  const draft =
    getSoaDraft(id)


  if (!draft) {

    renderGeneric()

    return

  }


  $('soa-document').hidden =
    false

  $('soa-preview-to').textContent =
    draft.company ||
    'Customer'

  $('soa-preview-date').textContent =
    soaDisplayDate(
      draft.toDate
    )

  $('soa-preview-currency').textContent =
    draft.currency ||
    'SGD'


  $('soa-preview-rows').innerHTML =
    draft.transactions

      .map(
        row => `

          <tr>

            <td></td>

            <td>
              ${escapeHtml(
          soaDisplayDate(
            row.date
          )
        )}
            </td>

            <td>
              ${escapeHtml(
          row.document
        )}
            </td>

            <td>
              ${soaMoney(
          row.debit
        )}
            </td>

            <td>
              ${soaMoney(
          row.credit
        )}
            </td>

            <td>
              ${soaMoney(
          row.balance
        )}
            </td>

          </tr>

        `
      )

      .join('')


  $('soa-preview-balance').textContent =
    soaMoney(
      draft.balance
    )


  const a =
    draft.ageing ||
    {}


  $('soa-age-current').textContent =
    soaMoney(a.current)

  $('soa-age-1-30').textContent =
    soaMoney(a.d1_30)

  $('soa-age-31-60').textContent =
    soaMoney(a.d31_60)

  $('soa-age-61-90').textContent =
    soaMoney(a.d61_90)

  $('soa-age-91-120').textContent =
    soaMoney(a.d91_120)

  $('soa-age-over-120').textContent =
    soaMoney(a.over120)

  $('soa-age-total').textContent =
    soaMoney(
      draft.balance
    )

}



// ============================================================
// INITIAL DOCUMENT RENDER
// ============================================================

if (isQuotation) {

  renderQuotation()

}

else if (isDeliveryOrder) {

  renderDeliveryOrder()

}

else if (isInvoice) {

  renderInvoice()

}

else if (isInvoiceDo) {

  renderInvoice()

  renderDeliveryOrder()

}

else if (isSoa) {

  renderSoa()

}

else {

  renderGeneric()

}



// ============================================================
// EXTRACT EMAIL ADDRESS
// ============================================================

function extractEmailAddress(
  value = ''
) {

  const bracketMatch =
    String(value).match(
      /<([^>]+)>/
    )


  if (bracketMatch) {

    return bracketMatch[1]
      .trim()

  }


  const plainMatch =
    String(value).match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    )


  return plainMatch
    ? plainMatch[0]
    : ''

}



// ============================================================
// EMAIL ATTACHMENT NAMES
// ============================================================

function emailAttachments() {

  const generatedFiles =
    isInvoiceDo

      ? [
        email.documentIds?.invoice,
        email.documentIds?.deliveryOrder
      ]
        .filter(Boolean)
        .map(
          reference =>
            `${reference}.pdf`
        )

      : [
        email.fileName ||
        `${email.category}.pdf`
      ]


  const savedFiles =
    isQuotation

      ? attachmentNames(
        quotationDraft?.attachments ||
        []
      )

      : isDeliveryOrder

        ? attachmentNames(
          deliveryOrderDraft?.attachments ||
          []
        )

        : isInvoice

          ? attachmentNames(
            invoiceDraft?.attachments ||
            []
          )

          : isInvoiceDo

            ? [
              ...attachmentNames(
                invoiceDraft?.attachments ||
                []
              ),

              ...attachmentNames(
                deliveryOrderDraft?.attachments ||
                []
              )
            ]

            : []


  return [

    ...generatedFiles,

    ...savedFiles.filter(
      file =>
        file &&
        !generatedFiles.includes(file)
    )

  ]

}



// ============================================================
// DEFAULT EMAIL SUBJECT
// ============================================================

function defaultEmailSubject() {

  if (isQuotation) {

    const quotation =
      quotationState()


    return (
      `Quotation - ${quotation.subjectTitle ||
      email.subject
      }`
    )

  }


  if (isDeliveryOrder) {

    const deliveryOrder =
      deliveryOrderState()


    return (
      `Delivery Order - ${deliveryOrder.subjectTitle ||
      email.subject
      }`
    )

  }


  if (isInvoice) {

    const invoice =
      invoiceState()


    return (
      `Tax Invoice - ${invoice.subjectTitle ||
      email.subject
      }`
    )

  }


  if (isInvoiceDo) {

    const invoice =
      invoiceState()


    return (
      `Invoice & Delivery Order - ${invoice.subjectTitle ||
      email.subject
      }`
    )

  }


  return (
    `${email.category} - ${email.subject}`
  )

}



// ============================================================
// OPEN EMAIL MODAL
// ============================================================

function openEmailModal() {

  $('email-to').value =
    extractEmailAddress(
      email.from
    )


  $('email-subject').value =
    defaultEmailSubject()


  $('email-message').value =
    `Dear Sir/Madam,

Please find attached the ${email.category.toLowerCase()} for your reference.

Thank you.

Best regards,
MaxGreen Contractor Pte Ltd`


  $('email-attachment-list').innerHTML =
    emailAttachments()

      .map(
        file =>
          `<span class="email-attachment-chip">📎 ${escapeHtml(file)}</span>`
      )

      .join('')


  $('email-modal').hidden =
    false


  document.body.classList.add(
    'modal-open'
  )

}



// ============================================================
// CLOSE EMAIL MODAL
// ============================================================

function closeEmailModal() {

  $('email-modal').hidden =
    true


  document.body.classList.remove(
    'modal-open'
  )

}



// ============================================================
// PDF HELPERS
// ============================================================

function blobToBase64(blob) {

<<<<<<< Updated upstream
  return new Promise(
    (resolve, reject) => {
=======
    emails = getEmails()
    email = emails.find(item => item.id === id)
    if (!email) {
      closeEmailModal()
      renderDocumentMissing('./pending.html', 'Back to Pending', 'It is no longer in browser storage, so it cannot be sent.')
    }
>>>>>>> Stashed changes

      const reader =
        new FileReader()


      reader.onloadend = () => {

        const result =
          String(
            reader.result || ''
          )


        const commaIndex =
          result.indexOf(',')


        const base64 =
          commaIndex >= 0
            ? result.slice(
              commaIndex + 1
            )
            : result


        resolve(base64)

      }


      reader.onerror = () => {

        reject(
          new Error(
            'Could not read generated PDF.'
          )
        )

      }


      reader.readAsDataURL(
        blob
      )

    }
  )

}



// ============================================================
// CREATE ONE PDF ATTACHMENT
// ============================================================

async function createPdfAttachment(
  element,
  filename
) {

  if (!element) {

    throw new Error(
      `Cannot create ${filename}: document preview was not found.`
    )

  }


  if (
    typeof window.html2pdf !==
    'function'
  ) {

    throw new Error(
      'html2pdf.js is not loaded. Add the html2pdf script before pendingView.js.'
    )

  }


  // Make sure images such as PayNow QR have had time to load.
  const images =
    Array.from(
      element.querySelectorAll('img')
    )


  await Promise.all(
    images.map(image => {

      if (image.complete) {
        return Promise.resolve()
      }


      return new Promise(resolve => {

        image.addEventListener(
          'load',
          resolve,
          { once: true }
        )


        image.addEventListener(
          'error',
          resolve,
          { once: true }
        )

      })

    })
  )


  const options = {

    margin: 0,

    filename,

    image: {
      type: 'jpeg',
      quality: 0.98
    },

    html2canvas: {
      scale: 2,
      useCORS: true,
      allowTaint: false,
      logging: false,
      backgroundColor: '#ffffff'
    },

    jsPDF: {
      unit: 'mm',
      format: 'a4',
      orientation: 'portrait'
    },

    pagebreak: {
      mode: [
        'css',
        'legacy'
      ]
    }

  }


  const worker =
    window
      .html2pdf()
      .set(options)
      .from(element)


  const blob =
    await worker.outputPdf(
      'blob'
    )


  const data =
    await blobToBase64(
      blob
    )


  return {

    filename,

    mime_type:
      'application/pdf',

    data

  }

}



// ============================================================
// CREATE GENERATED EMAIL PDF ATTACHMENTS
// ============================================================

async function createEmailPdfAttachments() {

  const attachments = []


  // ==========================================================
  // QUOTATION
  // ==========================================================

  if (isQuotation) {

    const quotation =
      quotationState()


    const reference =
      quotation.quotationNumber ||
      quotation.documentId ||
      email.documentId ||
      'Quotation'


    attachments.push(

      await createPdfAttachment(

        $('quotation-document'),

        `${reference}.pdf`

      )

    )


    return attachments

  }



  // ==========================================================
  // DELIVERY ORDER
  // ==========================================================

  if (isDeliveryOrder) {

    const deliveryOrder =
      deliveryOrderState()


    const reference =
      deliveryOrder.deliveryOrderNumber ||
      deliveryOrder.documentId ||
      email.documentId ||
      'Delivery-Order'


    attachments.push(

      await createPdfAttachment(

        $('delivery-order-document'),

        `${reference}.pdf`

      )

    )


    return attachments

  }



  // ==========================================================
  // INVOICE
  // ==========================================================

  if (isInvoice) {

    const invoice =
      invoiceState()


    const reference =
      invoice.invoiceNumber ||
      invoice.documentId ||
      email.documentId ||
      'Invoice'


    attachments.push(

      await createPdfAttachment(

        $('invoice-document'),

        `${reference}.pdf`

      )

    )


    return attachments

  }



  // ==========================================================
  // INVOICE + DELIVERY ORDER
  // ==========================================================

  if (isInvoiceDo) {

    const invoice =
      invoiceState()


    const deliveryOrder =
      deliveryOrderState()


    const invoiceReference =
      invoice.invoiceNumber ||
      invoice.documentId ||
      email.documentIds?.invoice ||
      'Invoice'


    const deliveryOrderReference =
      deliveryOrder.deliveryOrderNumber ||
      deliveryOrder.documentId ||
      email.documentIds?.deliveryOrder ||
      'Delivery-Order'


    const invoiceAttachment =
      await createPdfAttachment(

        $('invoice-document'),

        `${invoiceReference}.pdf`

      )


    const deliveryOrderAttachment =
      await createPdfAttachment(

        $('delivery-order-document'),

        `${deliveryOrderReference}.pdf`

      )


    attachments.push(
      invoiceAttachment,
      deliveryOrderAttachment
    )


    return attachments

  }



  // ==========================================================
  // STATEMENT OF ACCOUNT
  // ==========================================================

  if (isSoa) {

    const reference =
      email.documentId ||
      'Statement-of-Account'


    attachments.push(

      await createPdfAttachment(

        $('soa-document'),

        `${reference}.pdf`

      )

    )


    return attachments

  }



  // ==========================================================
  // GENERIC DOCUMENT
  // ==========================================================

  const genericDocument =
    $('generic-document')


  if (genericDocument) {

    const reference =
      email.documentId ||
      email.category ||
      'Document'


    attachments.push(

      await createPdfAttachment(

        genericDocument,

        `${reference}.pdf`

      )

    )

  }


  return attachments

}



// ============================================================
// PENDING ACTIONS
// ============================================================

if (
  !isCompleted &&
  !completedViewMode
) {


  // ==========================================================
  // REVERT TO INBOX
  // ==========================================================

  $('revert-inbox').addEventListener(
    'click',
    () => {

      emails =
        getEmails()


      email =
        emails.find(
          item =>
            item.id === id
        )


      if (!email) {
        return
      }


      email.status =
        'To Be Reviewed'


      email.section =
        'inbox'


      email.revertedAt =
        new Date()
          .toISOString()


      delete email.pendingAt


      saveEmails(
        emails
      )


      window.location.href =
        './inbox.html'

    }
  )



  // ==========================================================
  // OPEN EMAIL
  // ==========================================================

  $('open-email').addEventListener(
    'click',
    openEmailModal
  )



  // ==========================================================
  // CLOSE EMAIL
  // ==========================================================

  document
    .querySelectorAll(
      '[data-close-email]'
    )
    .forEach(button => {

      button.addEventListener(
        'click',
        closeEmailModal
      )

    })



  // ==========================================================
  // SEND REAL EMAIL THROUGH GMAIL
  // ==========================================================

  $('email-form').addEventListener(
    'submit',
    async event => {

      event.preventDefault()


      // ------------------------------------------------------
      // FORM VALUES
      // ------------------------------------------------------

      const to =
        $('email-to')
          .value
          .trim()


      const subject =
        $('email-subject')
          .value
          .trim()


      const body =
        $('email-message')
          .value


      if (
        !to ||
        !subject
      ) {

        return

      }



      // ------------------------------------------------------
      // SEND BUTTON
      // ------------------------------------------------------

      const sendButton =
        $('email-form')
          .querySelector(
            'button[type="submit"]'
          )


      const originalButtonText =
        sendButton
          ? sendButton.textContent
          : 'Send Email'



      try {


        // ====================================================
        // LOCK BUTTON
        // ====================================================

        if (sendButton) {

          sendButton.disabled =
            true


          sendButton.textContent =
            'Creating PDF...'

        }



        // ====================================================
        // GENERATE REAL PDF ATTACHMENTS
        // ====================================================

        const generatedAttachments =
          await createEmailPdfAttachments()



        console.log(
          'Generated PDF attachments:',
          generatedAttachments.map(
            attachment => ({
              filename:
                attachment.filename,

              mime_type:
                attachment.mime_type,

              base64Length:
                attachment.data?.length || 0
            })
          )
        )



        // ====================================================
        // SENDING STATE
        // ====================================================

        if (sendButton) {

          sendButton.textContent =
            'Sending...'

        }



        // ====================================================
        // SEND
        // ====================================================

        // One step: compose, click Send, sent. The backend validates the recipient,
        // subject, body and attachment types on the way through.
        const sent =
          await sendEmail(
            {

              to,
              subject,
              body,
              attachments:
                generatedAttachments

            }
          )



        const result =
          sent




        // ====================================================
        // GMAIL CONFIRMED SEND
        // ====================================================

        emails =
          getEmails()


        email =
          emails.find(
            item =>
              item.id === id
          )


        if (!email) {

          throw new Error(
            'Document could not be found after sending.'
          )

        }



        const sentAt =
          new Date()
            .toISOString()



        // ====================================================
        // INVOICE & DELIVERY ORDER
        // ====================================================

        if (
          email.category ===
          'Invoice & DO'
        ) {

          splitCompletedInvoiceDo(
            email.id,
            {
              to,
              subject,
              body,
              sentAt
            }
          )


          closeEmailModal()


          window.location.href =
            './completed.html'


          return

        }



        // ====================================================
        // MARK DOCUMENT COMPLETED
        // ====================================================

        email.status =
          'Completed'


        email.sentAt =
          sentAt


        email.completedAt =
          sentAt


        email.sentTo =
          to


        email.sentSubject =
          subject


        email.sentBody =
          body


        email.sentAttachments =
          generatedAttachments.map(
            attachment =>
              attachment.filename
          )



        // ====================================================
        // STORE GMAIL RESULT
        // ====================================================

        if (
          result.messageId
        ) {

          email.gmailSentMessageId =
            result.messageId

        }


        if (
          result.threadId
        ) {

          email.gmailSentThreadId =
            result.threadId

        }



        // ====================================================
        // SAVE
        // ====================================================

        saveEmails(
          emails
        )



        // ====================================================
        // RECEIVABLE WORKFLOW
        // ====================================================

        if (
          email.category ===
          'Invoice'
        ) {

          upsertReceivableFromCompletedInvoice(
            email
          )

        }



        // ====================================================
        // QUOTATION → DELIVERY ORDER
        // ====================================================

        if (
          email.category ===
          'Quotation'
        ) {

          spawnDeliveryOrderFromCompletedQuotation(
            email.id
          )

        }



        // ====================================================
        // DELIVERY ORDER → INVOICE
        // ====================================================

        if (
          email.category ===
          'Delivery Order'
        ) {

          spawnInvoiceFromCompletedDeliveryOrder(
            email.id
          )

        }



        // ====================================================
        // FINISH
        // ====================================================

        closeEmailModal()


        window.location.href =
          './completed.html'

      }


      catch (error) {


        // ====================================================
        // FAILURE
        // ====================================================

        // ====================================================
        // FAILURE
        // ====================================================

        console.error(
          'Email sending failed:',
          error
        )


        // A 5xx means nothing was sent, so retrying is safe. A 4xx means the request
        // itself was refused and will fail identically, so say which it was rather than
        // implying a retry is always the answer.
        const retryable =
          error.retryable === true

        const requestId =
          error.requestId
            ? `\n\nRequest ID: ${error.requestId}`
            : ''


        window.alert(
          retryable

            ? `Email was not sent.\n\n${error.message}\n\nNothing was sent, so it is safe to try again.${requestId}`

            : `Email was not sent.\n\n${error.message}${requestId}`
        )



        // ====================================================
        // RESTORE BUTTON
        // ====================================================

        if (sendButton) {

          sendButton.disabled =
            false


          sendButton.textContent =
            originalButtonText

        }

      }

    }
  )

}



// ============================================================
// COMPLETED VIEW DELETE
// ============================================================

if (
  completedViewMode &&
  isCompleted
) {

  const deleteButton =
    $('delete-completed')


  if (deleteButton) {

    deleteButton.addEventListener(
      'click',
      () => {

        const confirmed =
          window.confirm(
            'Delete this completed document from the Completed list?'
          )


        if (!confirmed) {
          return
        }


        emails =
          getEmails()


        const current =
          emails.find(
            item =>
              item.id === id
          )


        if (!current) {
          return
        }


        current.deletedAt =
          new Date()
            .toISOString()


        current.deletedFromCompleted =
          true


        saveEmails(
          emails
        )


        window.location.href =
          './completed.html'

      }
    )

  }

}
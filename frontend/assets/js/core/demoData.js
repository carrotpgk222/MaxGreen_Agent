const DATA_VERSION_KEY = 'maxgreen-demo-data-version'
const EMAILS_KEY = 'maxgreen-emails'
const COMPANIES_KEY = 'maxgreen_companies_v1'
const QUOTATIONS_KEY = 'maxgreen-quotation-drafts'
const DELIVERY_ORDERS_KEY = 'maxgreen-delivery-order-drafts'
const INVOICES_KEY = 'maxgreen-invoice-drafts'
const RECEIVABLES_KEY = 'maxgreen-receivables-v1'
const SOA_KEY = 'maxgreen-soa-drafts-v1'

const DATA_URL = new URL('../../data/demo-data.json', import.meta.url)

function readSeedFile() {
  const request = new XMLHttpRequest()
  request.open('GET', DATA_URL.href, false)
  request.send(null)

  if (request.status < 200 || request.status >= 300) {
    throw new Error(`Unable to load demo data (${request.status}). Run the project through Live Server.`)
  }

  return JSON.parse(request.responseText)
}

function writeSeed(seed) {
  localStorage.setItem(EMAILS_KEY, JSON.stringify(seed.emails || []))
  localStorage.setItem(COMPANIES_KEY, JSON.stringify(seed.companies || []))
  localStorage.setItem(QUOTATIONS_KEY, JSON.stringify(seed.quotationDrafts || {}))
  localStorage.setItem(DELIVERY_ORDERS_KEY, JSON.stringify(seed.deliveryOrderDrafts || {}))
  localStorage.setItem(INVOICES_KEY, JSON.stringify(seed.invoiceDrafts || {}))
  localStorage.setItem(RECEIVABLES_KEY, JSON.stringify(seed.receivables || []))
  localStorage.setItem(SOA_KEY, JSON.stringify(seed.soaDrafts || {}))
  localStorage.setItem(DATA_VERSION_KEY, seed.version || 'unknown')
}

export function ensureDemoData() {
  const seed = readSeedFile()
  const currentVersion = localStorage.getItem(DATA_VERSION_KEY)
  const hasStoredEmails = localStorage.getItem(EMAILS_KEY) != null

  // Seed only on a true first run. A missing or evicted version key must never
  // be read as an upgrade, or every getEmails()/saveEmails() wipes live workflow data.
  if (!hasStoredEmails && currentVersion !== seed.version) {
    writeSeed(seed)
  }

  return seed
}

export function resetAllDemoData() {
  const seed = readSeedFile()
  writeSeed(seed)
  return seed
}

export function getDemoDataVersion() {
  try {
    return readSeedFile().version || 'unknown'
  } catch {
    return 'unknown'
  }
}

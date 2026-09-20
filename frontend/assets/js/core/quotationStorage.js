import { ensureDemoData } from './demoData.js'

const DRAFT_KEY = 'maxgreen-quotation-drafts'

function parse(key, fallback) {
  ensureDemoData()
  try {
    const value = JSON.parse(localStorage.getItem(key))
    return value ?? fallback
  } catch {
    return fallback
  }
}

export function getQuotationDraft(emailId) {
  const drafts = parse(DRAFT_KEY, {})
  return drafts[emailId] || null
}

export function saveQuotationDraft(emailId, draft) {
  const drafts = parse(DRAFT_KEY, {})
  drafts[emailId] = draft
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts))
}

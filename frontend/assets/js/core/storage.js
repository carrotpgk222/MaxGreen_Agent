import { ensureDocumentIds } from './documentIds.js'
import { ensureDemoData, resetAllDemoData } from './demoData.js'

const STORAGE_KEY = 'maxgreen-emails'

function loadSavedEmails() {
  ensureDemoData()

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

export function getEmails() {
  const original = loadSavedEmails()
  const enriched = ensureDocumentIds(original)

  if (JSON.stringify(enriched) !== JSON.stringify(original)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enriched))
  }

  return enriched
}

export function saveEmails(emails) {
  ensureDemoData()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ensureDocumentIds(emails)))
}

export function resetDemoData() {
  resetAllDemoData()
}

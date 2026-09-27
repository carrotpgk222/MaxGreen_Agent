import { ensureDemoData } from './demoData.js'
const KEY = 'maxgreen-soa-drafts-v1'
function all() { ensureDemoData(); try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} } }
export function getSoaDraft(emailId) { return all()[emailId] || null }
export function saveSoaDraft(emailId, draft) { const rows=all(); rows[emailId]=draft; localStorage.setItem(KEY, JSON.stringify(rows)) }

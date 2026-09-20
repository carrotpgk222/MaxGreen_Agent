import { resetDemoData } from '../core/storage.js'
import { getDemoDataVersion } from '../core/demoData.js'

const version = document.getElementById('demo-data-version')
if (version) version.textContent = getDemoDataVersion()

document.getElementById('reset-demo').addEventListener('click', () => {
  const confirmed = window.confirm('Reset all demo emails, companies, quotations and delivery orders to the JSON seed data?')
  if (!confirmed) return

  resetDemoData()
  alert('Demo data has been reset from assets/data/demo-data.json.')
  window.location.href = './index.html'
})

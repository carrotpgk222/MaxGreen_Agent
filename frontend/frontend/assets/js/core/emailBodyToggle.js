export function setupEmailBodyToggle({
  bodyId = 'source-body',
  buttonId = 'toggle-email-body',
  collapsedByDefault = true
} = {}) {
  const body = document.getElementById(bodyId)
  const button = document.getElementById(buttonId)
  if (!body || !button) return

  function setCollapsed(collapsed) {
    body.hidden = collapsed
    button.textContent = collapsed ? 'Show email body' : 'Hide email body'
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  }

  setCollapsed(collapsedByDefault)
  button.addEventListener('click', () => setCollapsed(!body.hidden))
}

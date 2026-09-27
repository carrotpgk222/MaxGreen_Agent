import { getReceivables, calculatePayments } from './receivableStorage.js'

export function money(value) { return Number(value || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
export function displayDate(value) {
  if (!value) return ''
  const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}
function daysBetween(a,b){ const start=new Date(`${a}T00:00:00`), end=new Date(`${b}T00:00:00`); return Math.max(0,Math.floor((end-start)/86400000)) }

export function buildSoa(companyId, companyName, fromDate, toDate) {
  const invoices = getReceivables()
    .filter(r => (companyId && r.companyId === companyId) || (!companyId && r.company === companyName))
    .filter(r => r.sentEmailOn >= fromDate && r.sentEmailOn <= toDate)
    .sort((a,b) => a.sentEmailOn.localeCompare(b.sentEmailOn))

  const events=[]
  invoices.forEach(inv => {
    events.push({date: inv.sentEmailOn, document: inv.invoiceNo, debit: Number(inv.invoiceAmount||0), credit:0, sort:0})
    ;(inv.payments||[]).filter(p=>p.date && p.date>=fromDate && p.date<=toDate && Number(p.paidAmount||0)>0).forEach((p,i)=>{
      events.push({date:p.date, document:`Payment - ${inv.invoiceNo}`, debit:0, credit:Number(p.paidAmount||0), sort:i+1})
    })
  })
  events.sort((a,b)=>a.date.localeCompare(b.date)||a.sort-b.sort)
  let running=0
  const transactions=events.map(e=>{ running += e.debit-e.credit; return {...e,balance:Math.max(0,running)} })

  const ageing = { current:0, d1_30:0, d31_60:0, d61_90:0, d91_120:0, over120:0 }
  invoices.forEach(inv=>{
    const outstanding=calculatePayments(inv).balance
    if(outstanding<=0) return
    const days=daysBetween(inv.sentEmailOn,toDate)
    if(days===0) ageing.current += outstanding
    else if(days<=30) ageing.d1_30 += outstanding
    else if(days<=60) ageing.d31_60 += outstanding
    else if(days<=90) ageing.d61_90 += outstanding
    else if(days<=120) ageing.d91_120 += outstanding
    else ageing.over120 += outstanding
  })

  return { companyId, company:companyName, fromDate, toDate, currency:'SGD', invoiceIds:invoices.map(i=>i.id), transactions, balance:Math.max(0,running), ageing }
}

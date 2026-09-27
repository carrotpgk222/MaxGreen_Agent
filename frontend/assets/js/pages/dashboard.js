import { getEmails } from '../core/storage.js'
import { money } from '../core/utils.js'
import { getReceivables } from '../core/receivableStorage.js'
import { apiJson } from '../core/api.js'


// ============================================================
// DATA
// ============================================================

const emails = getEmails()
const receivableRows = getReceivables()



// ============================================================
// DASHBOARD COUNTS
// ============================================================

const counts = {

  inbox: emails.filter(
    item =>
      item.section === 'inbox' &&
      item.status === 'To Be Reviewed'
  ).length,

  receivable: receivableRows.length,

  payable: emails.filter(
    item =>
      item.section === 'supplier-payable' &&
      item.status !== 'Completed'
  ).length,

  pending: emails.filter(
    item =>
      item.status === 'Pending'
  ).length,

  completed: emails.filter(
    item =>
      item.status === 'Completed' &&
      !item.referenceOnly &&
      !item.deletedFromCompleted
  ).length

}



// ============================================================
// RENDER COUNTS
// ============================================================

function renderCounts() {

  const inbox =
    document.getElementById('count-inbox')

  const receivable =
    document.getElementById('count-receivable')

  const payable =
    document.getElementById('count-payable')

  const pending =
    document.getElementById('count-pending')

  const completed =
    document.getElementById('count-completed')


  if (inbox) {
    inbox.textContent = counts.inbox
  }

  if (receivable) {
    receivable.textContent = counts.receivable
  }

  if (payable) {
    payable.textContent = counts.payable
  }

  if (pending) {
    pending.textContent = counts.pending
  }

  if (completed) {
    completed.textContent = counts.completed
  }

}


renderCounts()



// ============================================================
// BACKEND COUNTS
// ============================================================

apiJson('/api/dashboard/counts')

  .then(data => {

    counts.inbox =
      Number(data.inbox || 0)

    counts.payable =
      Number(data.supplier_payable || 0)

    renderCounts()

  })

  .catch(() => {

    // Use local values if backend is unavailable

  })



// ============================================================
// RECEIVABLE CARD
// ============================================================

function populateReceivableCards(rows = []) {

  const today =
    startOfDay(new Date())


  // ==========================================================
  // NORMALISE DATA
  // ==========================================================

  const receivables = rows

    .map(item => {

      const amount = Number(
        item.balance ??
        item.invoiceAmount ??
        0
      )


      /*
        IMPORTANT:

        receivableStorage.js stores sentEmailOn.

        It DOES NOT currently store a due date.

        Therefore the chart is grouped using sentEmailOn.
      */

      const sentDate =
        parseReceivableDate(
          item.sentEmailOn
        )


      const status =
        String(
          item.status || ''
        )
          .trim()
          .toLowerCase()


      return {

        ...item,

        amount,

        sentDate,

        status

      }

    })

    .filter(item => {

      if (
        !Number.isFinite(item.amount)
      ) {
        return false
      }


      if (
        item.amount <= 0
      ) {
        return false
      }


      // Paid receivables have no outstanding balance
      if (
        item.status === 'paid'
      ) {
        return false
      }


      return true

    })



  // ==========================================================
  // TOTAL RECEIVABLE
  // ==========================================================

  const totalReceivable =
    receivables.reduce(

      (sum, item) =>
        sum + item.amount,

      0

    )



  // ==========================================================
  // OVERDUE
  // ==========================================================
  //
  // IMPORTANT:
  //
  // There is currently NO due date in receivableStorage.js.
  // Therefore we cannot accurately determine overdue invoices.
  //
  // Keep this as 0 until a due date is actually stored.
  // ==========================================================

  const totalOverdue = 0



  // ==========================================================
  // UPDATE MONEY
  // ==========================================================

  const totalElement =
    document.getElementById(
      'receivable-total'
    )


  const overdueElement =
    document.getElementById(
      'receivable-overdue'
    )


  if (totalElement) {

    totalElement.textContent =
      money(totalReceivable)

  }


  if (overdueElement) {

    overdueElement.textContent =
      money(totalOverdue)

  }



  // ==========================================================
  // WEEK RANGES
  // ==========================================================

  const thisWeekStart =
    getMonday(today)


  const thisWeekEnd =
    addDays(
      thisWeekStart,
      6
    )


  const nextWeekStart =
    addDays(
      thisWeekStart,
      7
    )


  const nextWeekEnd =
    addDays(
      thisWeekStart,
      13
    )


  const followingWeekStart =
    addDays(
      thisWeekStart,
      14
    )


  const followingWeekEnd =
    addDays(
      thisWeekStart,
      20
    )



  // ==========================================================
  // GROUP AMOUNTS
  // ==========================================================

  let olderAmount = 0
  let thisWeekAmount = 0
  let nextWeekAmount = 0
  let followingWeekAmount = 0



  receivables.forEach(item => {

    if (!item.sentDate) {

      console.warn(
        'Receivable has no sentEmailOn:',
        item
      )

      return

    }



    // --------------------------------------------------------
    // OLDER
    // --------------------------------------------------------

    if (
      item.sentDate < thisWeekStart
    ) {

      olderAmount +=
        item.amount

      return

    }



    // --------------------------------------------------------
    // THIS WEEK
    // --------------------------------------------------------

    if (

      item.sentDate >=
      thisWeekStart &&

      item.sentDate <=
      thisWeekEnd

    ) {

      thisWeekAmount +=
        item.amount

      return

    }



    // --------------------------------------------------------
    // NEXT WEEK
    // --------------------------------------------------------

    if (

      item.sentDate >=
      nextWeekStart &&

      item.sentDate <=
      nextWeekEnd

    ) {

      nextWeekAmount +=
        item.amount

      return

    }



    // --------------------------------------------------------
    // FOLLOWING WEEK
    // --------------------------------------------------------

    if (

      item.sentDate >=
      followingWeekStart &&

      item.sentDate <=
      followingWeekEnd

    ) {

      followingWeekAmount +=
        item.amount

    }

  })



  // ==========================================================
  // CHART GROUPS
  // ==========================================================

  const groups = [

    {

      label: 'Older',

      amount:
        olderAmount

    },


    {

      label: 'This week',

      amount:
        thisWeekAmount

    },


    {

      label:
        formatDateRange(
          nextWeekStart,
          nextWeekEnd
        ),

      amount:
        nextWeekAmount

    },


    {

      label:
        formatDateRange(
          followingWeekStart,
          followingWeekEnd
        ),

      amount:
        followingWeekAmount

    }

  ]



  console.log(
    'Receivable rows:',
    rows
  )


  console.log(
    'Receivable chart:',
    groups
  )



  // ==========================================================
  // AXIS MAXIMUM
  // ==========================================================

  const largestAmount =
    Math.max(

      ...groups.map(
        group =>
          group.amount
      ),

      0

    )


  const axisMaximum =
    calculateAxisMaximum(
      largestAmount
    )



  // ==========================================================
  // RENDER CHART
  // ==========================================================

  renderYAxis(
    axisMaximum
  )


  renderBars(
    groups,
    axisMaximum
  )

}



// ============================================================
// Y AXIS
// ============================================================

function renderYAxis(maximum) {

  const axis =
    document.getElementById(
      'receivable-y-axis'
    )


  if (!axis) {
    return
  }


  const step =
    maximum / 4


  const values = [

    maximum,

    maximum - step,

    maximum - step * 2,

    maximum - step * 3,

    0

  ]


  axis.innerHTML =
    values

      .map(value => `

        <span>
          ${formatAxis(value)}
        </span>

      `)

      .join('')

}



// ============================================================
// BARS
// ============================================================

function renderBars(
  groups,
  maximum
) {

  const container =
    document.getElementById(
      'receivable-chart-bars'
    )


  if (!container) {
    return
  }



  container.innerHTML =
    groups

      .map(group => {

        const percentage =
          maximum > 0

            ? (
              group.amount /
              maximum
            ) * 100

            : 0



        return `

          <div class="chart-item">

            <div class="chart-bar-wrap">

              <div
                class="chart-bar"
                style="
                  height: ${percentage}%;
                  min-height: ${group.amount > 0 ? '10px' : '0'};
                "
              >

                <div class="chart-tooltip">

                  $${money(group.amount)}

                </div>

              </div>

            </div>


            <span>
              ${group.label}
            </span>

          </div>

        `

      })

      .join('')

}



// ============================================================
// CALCULATE Y AXIS MAX
// ============================================================

function calculateAxisMaximum(value) {

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {

    return 1000

  }


  /*
    Example:

    8610
      ↓
    10000

    4200
      ↓
    5000

    17500
      ↓
    20000
  */


  const magnitude =
    Math.pow(

      10,

      Math.floor(
        Math.log10(value)
      )

    )


  const normalized =
    value / magnitude


  let nice


  if (
    normalized <= 1
  ) {

    nice = 1

  }

  else if (
    normalized <= 2
  ) {

    nice = 2

  }

  else if (
    normalized <= 5
  ) {

    nice = 5

  }

  else {

    nice = 10

  }


  return (
    nice *
    magnitude
  )

}



// ============================================================
// FORMAT AXIS
// ============================================================

function formatAxis(value) {

  if (
    value >= 1_000_000
  ) {

    return (
      Number(
        (
          value /
          1_000_000
        ).toFixed(1)
      ) + 'M'
    )

  }


  if (
    value >= 1_000
  ) {

    return (
      Number(
        (
          value /
          1_000
        ).toFixed(1)
      ) + 'K'
    )

  }


  return Math.round(
    value
  ).toString()

}



// ============================================================
// DATE PARSER
// ============================================================

function parseReceivableDate(value) {

  if (!value) {
    return null
  }


  // YYYY-MM-DD
  if (

    typeof value === 'string' &&

    /^\d{4}-\d{2}-\d{2}$/
      .test(value)

  ) {

    const [
      year,
      month,
      day
    ] =
      value
        .split('-')
        .map(Number)


    return startOfDay(

      new Date(
        year,
        month - 1,
        day
      )

    )

  }


  const date =
    new Date(value)


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return null

  }


  return startOfDay(date)

}



// ============================================================
// START OF DAY
// ============================================================

function startOfDay(date) {

  const copy =
    new Date(date)


  copy.setHours(
    0,
    0,
    0,
    0
  )


  return copy

}



// ============================================================
// ADD DAYS
// ============================================================

function addDays(
  date,
  amount
) {

  const copy =
    new Date(date)


  copy.setDate(
    copy.getDate() +
    amount
  )


  return copy

}



// ============================================================
// GET MONDAY
// ============================================================

function getMonday(date) {

  const copy =
    startOfDay(date)


  const day =
    copy.getDay()


  const difference =

    day === 0

      ? -6

      : 1 - day


  copy.setDate(
    copy.getDate() +
    difference
  )


  return copy

}



// ============================================================
// DATE RANGE LABEL
// ============================================================

function formatDateRange(
  start,
  end
) {

  const startMonth =
    start.toLocaleString(
      'en-US',
      {
        month: 'short'
      }
    )


  const endMonth =
    end.toLocaleString(
      'en-US',
      {
        month: 'short'
      }
    )


  if (
    start.getMonth() ===
    end.getMonth()
  ) {

    return (
      `${startMonth} ` +
      `${start.getDate()}–` +
      `${end.getDate()}`
    )

  }


  return (
    `${startMonth} ` +
    `${start.getDate()}–` +
    `${endMonth} ` +
    `${end.getDate()}`
  )

}



// ============================================================
// INITIALISE
// ============================================================

populateReceivableCards(
  receivableRows
)
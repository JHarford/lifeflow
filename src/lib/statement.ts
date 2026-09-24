import { addMonths, differenceInCalendarMonths, endOfMonth, format, parseISO, startOfMonth } from 'date-fns'
import type { AccountBalance, Asset, Debt, Frequency, RecurringItem, Source, Transaction } from '@/types'
import { UNCATEGORISED, categoryOrder, isCommitted, isPL } from '@/lib/categories'

// A personal statement of income & liabilities — the shape a lender or
// adviser asks for: average monthly income and outgoings over recent complete
// months, then what you own and what you owe as of the latest balances.

export interface StatementLine {
  label: string
  monthly: number
}

export interface StatementGroup {
  category: string
  monthly: number
  lines: StatementLine[]
}

export interface BalanceLine {
  id: string
  label: string
  kind: string
  amount: number          // always positive; the section says which side it's on
  asOf: string | null
  included: boolean       // counted towards net worth (mirrors the Net Worth card)
}

export interface LiabilityLine extends BalanceLine {
  interestRate: number | null
  monthlyPayment: number | null
  payoff: string | null   // 'MMM yyyy', null = no linked payment or never clears
}

export interface Statement {
  periodStart: Date
  periodEnd: Date
  months: number          // complete months averaged over (may be fewer than asked if data is short)
  income: StatementGroup[]
  committed: StatementGroup[]
  discretionary: StatementGroup[]
  totalIncome: number
  totalCommitted: number
  totalDiscretionary: number
  surplus: number
  assets: BalanceLine[]
  liabilities: LiabilityLine[]
  totalAssets: number
  totalLiabilities: number
  netWorth: number
  debtService: number     // monthly payments on linked debts
}

function monthlyFromFrequency(amount: number, frequency: Frequency): number {
  if (frequency === 'weekly') return amount * 52 / 12
  if (frequency === 'quarterly') return amount / 3
  if (frequency === 'annually') return amount / 12
  return amount
}

function payoffDate(balance: number, monthly: number, ratePct: number, now: Date): string | null {
  if (monthly <= 0 || balance <= 0) return null
  const r = ratePct / 100 / 12
  let bal = balance
  let m = 0
  while (bal > 0 && m < 600) {
    bal += bal * r
    bal -= monthly
    m++
  }
  return bal > 0 ? null : format(addMonths(now, m), 'MMM yyyy')
}

function latestBalance(balances: AccountBalance[], sourceId: string): AccountBalance | null {
  let best: AccountBalance | null = null
  for (const b of balances) {
    if (b.source_id !== sourceId) continue
    if (!best || b.as_of_date > best.as_of_date) best = b
  }
  return best
}

const ASSET_KIND: Record<Asset['type'], string> = {
  property: 'Property', vehicle: 'Vehicle', investment: 'Investment', other: 'Other asset',
}
const DEBT_KIND: Record<Debt['type'], string> = {
  mortgage: 'Mortgage', loan: 'Loan', tax: 'Tax owed', other: 'Other debt',
}

export function buildStatement(
  input: {
    transactions: Transaction[]
    sources: Source[]
    balances: AccountBalance[]
    debts: Debt[]
    assets: Asset[]
    recurringItems: RecurringItem[]
  },
  requestedMonths: number,
  now = new Date(),
): Statement {
  const { transactions, sources, balances, debts, assets, recurringItems } = input

  // ── Income & outgoings: the last N complete months, by accrual month ──
  const periodEnd = endOfMonth(addMonths(now, -1))
  let periodStart = startOfMonth(addMonths(now, -requestedMonths))

  // Don't average over months before the data begins
  let earliest: string | null = null
  for (const t of transactions) {
    const d = t.accrual_date ?? t.date
    if (!earliest || d < earliest) earliest = d
  }
  if (earliest) {
    const firstMonth = startOfMonth(parseISO(earliest))
    if (firstMonth > periodStart) periodStart = firstMonth
  }
  const months = Math.max(1, differenceInCalendarMonths(periodEnd, periodStart) + 1)

  // Net per category → subcategory (positive = out, negative = in). Transfers
  // and one-off payouts aren't income or spend, so they're left out.
  const net = new Map<string, Map<string, number>>()
  for (const t of transactions) {
    if (!isPL(t.category)) continue
    const d = parseISO(t.accrual_date ?? t.date)
    if (d < periodStart || d > periodEnd) continue
    const cat = t.category || UNCATEGORISED
    const sub = t.subcategory || 'Other'
    const subs = net.get(cat) ?? new Map<string, number>()
    subs.set(sub, (subs.get(sub) ?? 0) + Number(t.amount))
    net.set(cat, subs)
  }

  const income: StatementGroup[] = []
  const committed: StatementGroup[] = []
  const discretionary: StatementGroup[] = []
  for (const [category, subs] of net) {
    const total = [...subs.values()].reduce((a, b) => a + b, 0)
    if (Math.abs(total) < 0.5) continue
    // Income is the Income category plus any other category that nets to money
    // in (e.g. Business revenue exceeding its costs). Refunds inside a spend
    // category just reduce that category's spend.
    const isIncome = category === 'Income' || total < 0
    const sign = isIncome ? -1 : 1
    const group: StatementGroup = {
      category,
      monthly: (sign * total) / months,
      lines: [...subs.entries()]
        .map(([label, v]) => ({ label, monthly: (sign * v) / months }))
        .filter(l => Math.abs(l.monthly) >= 0.5)
        .sort((a, b) => b.monthly - a.monthly),
    }
    if (isIncome) income.push(group)
    else if (isCommitted(category)) committed.push(group)
    else discretionary.push(group)
  }
  income.sort((a, b) => b.monthly - a.monthly)
  committed.sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category))
  discretionary.sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category))

  const sum = (gs: StatementGroup[]) => gs.reduce((a, g) => a + g.monthly, 0)
  const totalIncome = sum(income)
  const totalCommitted = sum(committed)
  const totalDiscretionary = sum(discretionary)

  // ── Assets & liabilities, as of the latest snapshots ──
  // Same arithmetic as the Net Worth card: every account balance counts (an
  // overdrawn account or card balance is a liability), plus included assets,
  // minus included debts.
  const assetLines: BalanceLine[] = []
  const liabilityLines: LiabilityLine[] = []

  for (const s of sources) {
    const b = latestBalance(balances, s.id)
    if (!b || Math.abs(b.balance) < 0.5) continue
    const bal = Number(b.balance)
    if (bal > 0) {
      assetLines.push({
        id: `src-${s.id}`, label: s.name,
        kind: s.type === 'credit_card' ? 'Card in credit' : 'Cash',
        amount: bal, asOf: b.as_of_date, included: true,
      })
    } else {
      liabilityLines.push({
        id: `src-${s.id}`, label: s.name,
        kind: s.type === 'credit_card' ? 'Credit card' : s.type === 'loan' ? 'Loan' : 'Overdraft',
        amount: -bal, asOf: b.as_of_date, included: true,
        interestRate: null, monthlyPayment: null, payoff: null,
      })
    }
  }

  for (const a of assets) {
    if (Number(a.current_value) === 0) continue
    assetLines.push({
      id: `asset-${a.id}`, label: a.name, kind: ASSET_KIND[a.type] ?? 'Other asset',
      amount: Number(a.current_value), asOf: null, included: a.include_in_net_worth,
    })
  }

  let debtService = 0
  for (const d of debts) {
    const linked = d.recurring_item_id ? recurringItems.find(i => i.id === d.recurring_item_id) : undefined
    const monthly = linked && linked.is_active ? monthlyFromFrequency(Number(linked.amount), linked.frequency) : null
    if (monthly && d.include_in_net_worth) debtService += monthly
    liabilityLines.push({
      id: `debt-${d.id}`, label: d.name, kind: DEBT_KIND[d.type] ?? 'Other debt',
      amount: Number(d.current_balance), asOf: null, included: d.include_in_net_worth,
      interestRate: d.interest_rate ? Number(d.interest_rate) : null,
      monthlyPayment: monthly,
      payoff: monthly ? payoffDate(Number(d.current_balance), monthly, Number(d.interest_rate) || 0, now) : null,
    })
  }

  assetLines.sort((a, b) => Number(b.included) - Number(a.included) || b.amount - a.amount)
  liabilityLines.sort((a, b) => Number(b.included) - Number(a.included) || b.amount - a.amount)

  const totalAssets = assetLines.filter(l => l.included).reduce((a, l) => a + l.amount, 0)
  const totalLiabilities = liabilityLines.filter(l => l.included).reduce((a, l) => a + l.amount, 0)

  return {
    periodStart, periodEnd, months,
    income, committed, discretionary,
    totalIncome, totalCommitted, totalDiscretionary,
    surplus: totalIncome - totalCommitted - totalDiscretionary,
    assets: assetLines, liabilities: liabilityLines,
    totalAssets, totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    debtService,
  }
}

// Flat CSV of the whole statement, one row per line item, for pasting into a
// spreadsheet or a lender's form. Amounts are plain numbers (no £ or commas).
export function statementToCsv(s: Statement): string {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return ''
    if (typeof v === 'number') return v.toFixed(2)
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  }
  const rows: Array<Array<string | number | null>> = [
    ['Statement of income & liabilities'],
    ['Prepared', format(new Date(), 'yyyy-MM-dd')],
    ['Period', `${format(s.periodStart, 'MMM yyyy')} - ${format(s.periodEnd, 'MMM yyyy')}`, `${s.months} month average`],
    [],
    ['Section', 'Category', 'Item', 'Per month', 'Per year', 'Amount', 'Details'],
  ]

  const groups = (section: string, gs: StatementGroup[], total: number) => {
    for (const g of gs) {
      if (g.lines.length > 1) {
        for (const l of g.lines) rows.push([section, g.category, l.label, l.monthly, l.monthly * 12, null, null])
      } else {
        rows.push([section, g.category, g.lines[0]?.label ?? '', g.monthly, g.monthly * 12, null, null])
      }
    }
    rows.push([section, 'Total', '', total, total * 12, null, null])
  }
  groups('Income', s.income, s.totalIncome)
  groups('Committed outgoings', s.committed, s.totalCommitted)
  groups('Discretionary spending', s.discretionary, s.totalDiscretionary)
  rows.push([s.surplus >= 0 ? 'Surplus' : 'Shortfall', '', '', s.surplus, s.surplus * 12, null, null])

  const excluded = (l: BalanceLine) => (l.included ? null : 'excluded from net worth')
  for (const l of s.assets) {
    rows.push(['Assets', l.kind, l.label, null, null, l.amount,
      [l.asOf && `as of ${l.asOf}`, excluded(l)].filter(Boolean).join('; ')])
  }
  rows.push(['Assets', 'Total', '', null, null, s.totalAssets, null])
  for (const l of s.liabilities) {
    rows.push(['Liabilities', l.kind, l.label, l.monthlyPayment, l.monthlyPayment != null ? l.monthlyPayment * 12 : null, l.amount,
      [l.interestRate != null && `${l.interestRate}% APR`, l.payoff && `clear ${l.payoff}`, l.asOf && `as of ${l.asOf}`, excluded(l)]
        .filter(Boolean).join('; ')])
  }
  rows.push(['Liabilities', 'Total', '', s.debtService, s.debtService * 12, s.totalLiabilities, 'per month = payments on linked debts'])
  rows.push(['Net worth', '', '', null, null, s.netWorth, null])

  return rows.map(r => r.map(cell).join(',')).join('\n') + '\n'
}

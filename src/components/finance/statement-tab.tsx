import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { Printer } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { buildStatement, type BalanceLine, type LiabilityLine, type StatementGroup } from '@/lib/statement'
import type { Source, Transaction, RecurringItem, AccountBalance, Debt, Asset } from '@/types'

interface Props {
  sources: Source[]
  transactions: Transaction[]
  recurringItems: RecurringItem[]
  balances: AccountBalance[]
  debts: Debt[]
  assets: Asset[]
}

const PERIODS = [3, 6, 12] as const

function periodKey(): number {
  try {
    const v = Number(localStorage.getItem('lifeflow-statement-months'))
    return (PERIODS as readonly number[]).includes(v) ? v : 6
  } catch {
    return 6
  }
}

const gbp = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n)
const pct = (n: number) => `${Math.round(n * 100)}%`

// Statement of income & liabilities: average monthly income and outgoings over
// recent complete months, then what's owned and owed as of the latest balances.
// Printable (the rest of the app is hidden via #statement print CSS).
export function StatementTab({ sources, transactions, recurringItems, balances, debts, assets }: Props) {
  const [months, setMonths] = useState<number>(periodKey)
  const s = useMemo(
    () => buildStatement({ sources, transactions, recurringItems, balances, debts, assets }, months),
    [sources, transactions, recurringItems, balances, debts, assets, months],
  )

  const choose = (m: number) => {
    setMonths(m)
    try { localStorage.setItem('lifeflow-statement-months', String(m)) } catch { /* private mode */ }
  }

  const periodLabel = `${format(s.periodStart, 'MMM yyyy')} – ${format(s.periodEnd, 'MMM yyyy')}`
  const outgoings = s.totalCommitted + s.totalDiscretionary

  return (
    <div id="statement" className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap print:hidden">
        <div className="flex rounded-lg border bg-muted/40 p-0.5">
          {PERIODS.map(m => (
            <button
              key={m}
              onClick={() => choose(m)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                months === m ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m} mo avg
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="w-4 h-4 mr-1.5" /> Print / PDF
        </Button>
      </div>

      <Card className="py-5 gap-5 print:shadow-none print:border-0">
        <CardContent className="px-4 sm:px-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Statement of income &amp; liabilities</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Prepared {format(new Date(), 'd MMMM yyyy')} · income and outgoings averaged over {s.months} complete month{s.months === 1 ? '' : 's'} ({periodLabel})
              {s.months < months && ` — only ${s.months} month${s.months === 1 ? '' : 's'} of data available`}
            </p>
          </div>

          {/* Headline figures */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Net monthly income" value={gbp(s.totalIncome)} tone="in" />
            <Stat label="Monthly outgoings" value={gbp(outgoings)} tone="out" />
            <Stat label="Monthly surplus" value={gbp(s.surplus)} tone={s.surplus >= 0 ? 'in' : 'out'} />
            <Stat label="Net worth" value={gbp(s.netWorth)} tone={s.netWorth >= 0 ? 'in' : 'out'} />
          </div>

          {/* Income & outgoings */}
          <section className="space-y-2">
            <SectionHead title="Income & outgoings" cols={['per month', 'per year']} />
            <GroupBlock title="Income" short="income" groups={s.income} total={s.totalIncome} tone="in" empty="No income recorded in this period" />
            <GroupBlock title="Committed outgoings" short="committed" groups={s.committed} total={s.totalCommitted} tone="out" empty="None" />
            <GroupBlock title="Discretionary spending" short="discretionary" groups={s.discretionary} total={s.totalDiscretionary} tone="out" empty="None" />
            <TotalRow label={s.surplus >= 0 ? 'Surplus' : 'Shortfall'} monthly={s.surplus} strong tone={s.surplus >= 0 ? 'in' : 'out'} />
          </section>

          {/* Assets */}
          <section className="space-y-2">
            <SectionHead title="Assets" cols={['value']} />
            {s.assets.length === 0
              ? <p className="text-sm text-muted-foreground">No balances or assets recorded</p>
              : s.assets.map(l => <BalanceRow key={l.id} line={l} />)}
            <BalanceTotal label="Total assets" value={s.totalAssets} tone="in" />
          </section>

          {/* Liabilities */}
          <section className="space-y-2">
            <SectionHead title="Liabilities" cols={['owed']} />
            {s.liabilities.length === 0
              ? <p className="text-sm text-muted-foreground">No liabilities recorded</p>
              : s.liabilities.map(l => <LiabilityRow key={l.id} line={l} />)}
            <BalanceTotal label="Total liabilities" value={s.totalLiabilities} tone="out" />
          </section>

          <div className="border-t-2 pt-3 flex items-baseline justify-between gap-3">
            <span className="font-semibold">Net worth</span>
            <span className={`text-xl font-bold tabular-nums ${s.netWorth >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{gbp(s.netWorth)}</span>
          </div>

          {/* Affordability ratios */}
          {s.totalIncome > 0 && (
            <section className="space-y-2">
              <SectionHead title="Ratios" cols={[]} />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Ratio label="Debt payments / income" value={pct(s.debtService / s.totalIncome)} hint={`${gbp(s.debtService)}/mo on linked debts`} />
                <Ratio label="Committed / income" value={pct(s.totalCommitted / s.totalIncome)} hint="housing, tax, debt, bills, insurance" />
                <Ratio label="Savings rate" value={pct(s.surplus / s.totalIncome)} hint="surplus as share of income" />
                <Ratio label="Liabilities / annual income" value={`${(s.totalLiabilities / (s.totalIncome * 12)).toFixed(1)}×`} hint={`${gbp(s.totalIncome * 12)} a year`} />
              </div>
            </section>
          )}

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Income and outgoings are net of refunds and exclude transfers between your own accounts and one-off payouts.
            Balances are the latest recorded snapshot per account. Items marked “excluded” are shown for completeness but left out of the totals, matching the Net Worth card.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'in' | 'out' }) {
  return (
    <div className="rounded-lg border px-3 py-2 min-w-0">
      <div className="text-[11px] text-muted-foreground truncate">{label}</div>
      <div className={`text-base font-bold tabular-nums ${tone === 'in' ? 'text-emerald-600' : 'text-red-600'}`}>{value}</div>
    </div>
  )
}

function SectionHead({ title, cols }: { title: string; cols: string[] }) {
  return (
    <div className="flex items-end justify-between gap-2 border-b pb-1">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="flex gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        {cols.map(c => <span key={c} className="w-20 text-right">{c}</span>)}
      </div>
    </div>
  )
}

function Amounts({ monthly, className = '' }: { monthly: number; className?: string }) {
  return (
    <div className={`flex gap-2 tabular-nums shrink-0 ${className}`}>
      <span className="w-20 text-right">{gbp(monthly)}</span>
      <span className="w-20 text-right text-muted-foreground">{gbp(monthly * 12)}</span>
    </div>
  )
}

function GroupBlock({ title, short, groups, total, tone, empty }: {
  title: string; short: string; groups: StatementGroup[]; total: number; tone: 'in' | 'out'; empty: string
}) {
  return (
    <div className="space-y-1 pb-1">
      <div className="text-sm font-medium pt-1">{title}</div>
      {groups.length === 0 && <p className="text-xs text-muted-foreground pl-3">{empty}</p>}
      {groups.map(g => (
        <div key={g.category} className="text-sm">
          <div className="flex items-center justify-between gap-2 pl-3">
            <span className="truncate min-w-0">
              {g.category}
              {g.lines.length === 1 && g.lines[0].label !== 'Other' && <span className="text-muted-foreground"> · {g.lines[0].label}</span>}
            </span>
            <Amounts monthly={g.monthly} />
          </div>
          {g.lines.length > 1 && g.lines.map(l => (
            <div key={l.label} className="flex items-center justify-between gap-2 pl-6 text-xs text-muted-foreground">
              <span className="truncate min-w-0">{l.label}</span>
              <Amounts monthly={l.monthly} />
            </div>
          ))}
        </div>
      ))}
      <TotalRow label={`Total ${short}`} monthly={total} tone={tone} />
    </div>
  )
}

function TotalRow({ label, monthly, tone, strong }: { label: string; monthly: number; tone: 'in' | 'out'; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-2 border-t pt-1 text-sm ${strong ? 'font-bold border-t-2' : 'font-medium'}`}>
      <span className="truncate min-w-0">{label}</span>
      <Amounts monthly={monthly} className={tone === 'in' ? 'text-emerald-600' : 'text-red-600'} />
    </div>
  )
}

function excludedTag(included: boolean) {
  return included ? null : <span className="ml-1.5 text-[10px] rounded bg-muted px-1 py-px text-muted-foreground">excluded</span>
}

function BalanceRow({ line }: { line: BalanceLine }) {
  return (
    <div className={`flex items-start justify-between gap-2 text-sm ${line.included ? '' : 'opacity-60'}`}>
      <div className="min-w-0">
        <div className="truncate">{line.label}{excludedTag(line.included)}</div>
        <div className="text-[11px] text-muted-foreground">
          {line.kind}{line.asOf && ` · as of ${format(parseISO(line.asOf), 'd MMM yyyy')}`}
        </div>
      </div>
      <span className="tabular-nums shrink-0">{gbp(line.amount)}</span>
    </div>
  )
}

function LiabilityRow({ line }: { line: LiabilityLine }) {
  const details = [
    line.kind,
    line.interestRate != null && `${line.interestRate}% APR`,
    line.monthlyPayment != null && `${gbp(line.monthlyPayment)}/mo`,
    line.payoff && `clear ${line.payoff}`,
    line.asOf && `as of ${format(parseISO(line.asOf), 'd MMM yyyy')}`,
  ].filter(Boolean).join(' · ')
  return (
    <div className={`flex items-start justify-between gap-2 text-sm ${line.included ? '' : 'opacity-60'}`}>
      <div className="min-w-0">
        <div className="truncate">{line.label}{excludedTag(line.included)}</div>
        <div className="text-[11px] text-muted-foreground">{details}</div>
      </div>
      <span className="tabular-nums shrink-0">{gbp(line.amount)}</span>
    </div>
  )
}

function BalanceTotal({ label, value, tone }: { label: string; value: number; tone: 'in' | 'out' }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t pt-1 text-sm font-medium">
      <span>{label}</span>
      <span className={`tabular-nums ${tone === 'in' ? 'text-emerald-600' : 'text-red-600'}`}>{gbp(value)}</span>
    </div>
  )
}

function Ratio({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border px-3 py-2 min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-base font-bold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted-foreground">{hint}</div>
    </div>
  )
}

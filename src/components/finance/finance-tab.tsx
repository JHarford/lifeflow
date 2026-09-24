import { lazy, Suspense, useEffect, useState } from 'react'
import { onNavigate, peekPendingAction } from '@/lib/nav-bus'
import type { Source, Transaction, RecurringItem, AccountBalance, Debt, Asset, FutureObligation, CategoryBudget } from '@/types'

const DashboardTab = lazy(() => import('@/components/dashboard/dashboard-tab').then(m => ({ default: m.DashboardTab })))
const TransactionsTab = lazy(() => import('@/components/transactions/transactions-tab').then(m => ({ default: m.TransactionsTab })))
const StatementTab = lazy(() => import('@/components/finance/statement-tab').then(m => ({ default: m.StatementTab })))
const InputTab = lazy(() => import('@/components/input/input-tab').then(m => ({ default: m.InputTab })))

type FinanceSub = 'overview' | 'statement' | 'activity' | 'input'

const SUBTABS: Array<{ value: FinanceSub; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'statement', label: 'Statement' },
  { value: 'activity', label: 'Transactions' },
  { value: 'input', label: 'Input' },
]

interface FinanceTabProps {
  sources: Source[]
  transactions: Transaction[]
  recurringItems: RecurringItem[]
  futureObligations: FutureObligation[]
  categoryBudgets: CategoryBudget[]
  balances: AccountBalance[]
  debts: Debt[]
  assets: Asset[]
  forecastMonths: number
}

// Everything money-related lives under one tab, with a segmented control for
// the sections (three of which used to be top-level tabs).
export function FinanceTab(props: FinanceTabProps) {
  // Deep links (CSV upload → suggest recurring) land on the Transactions section
  const [sub, setSub] = useState<FinanceSub>(() => peekPendingAction('suggest-recurring') ? 'activity' : 'overview')

  useEffect(() => onNavigate(i => {
    if (i.tab === 'finance' && peekPendingAction('suggest-recurring')) setSub('activity')
  }), [])

  return (
    <div className="space-y-4">
      <div className="flex rounded-lg border bg-muted/40 p-0.5 w-full sm:w-auto sm:inline-flex">
        {SUBTABS.map(t => (
          <button
            key={t.value}
            onClick={() => setSub(t.value)}
            className={`flex-1 sm:flex-none px-2 sm:px-4 py-1.5 text-sm rounded-md transition-colors ${
              sub === t.value ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Suspense fallback={<p className="text-sm text-muted-foreground animate-pulse py-8 text-center">Loading…</p>}>
        {sub === 'overview' && <DashboardTab {...props} />}
        {sub === 'statement' && <StatementTab {...props} />}
        {sub === 'activity' && <TransactionsTab />}
        {sub === 'input' && <InputTab />}
      </Suspense>
    </div>
  )
}

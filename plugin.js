/**
 * Hermes Cost Dashboard
 *
 * Two cost sections:
 *  1) Hermes and agents
 *  2) Auxiliary usage: memory, embeddings, compression, vision
 *
 * Provider quota cards are deliberately explicit about their source.
 * Unknown quota values are shown as "нет данных", never invented.
 */

import {
  Button,
  GlyphSpinner,
  Popover,
  PopoverContent,
  PopoverTrigger,
  STATUSBAR_AREAS,
  host,
  icons,
  usePluginI18n,
  useQuery
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'cost-dashboard'
const DAYS = 1
const DEFAULT_USD_RUB = 90

// User-provided Ollama figures from the latest screenshot (09.10.2026).
const OLLAMA_USER_REPORT = {
  monthlySpent: 19.66,
  monthlyLimit: 60,
  monthlyRemaining: 40.34,
  refillIn: '4 недели',
  estimatedDays: 23,
  referenceWeeklySpend: 12.23,
  autoReload: false
}

const RUB_PROVIDERS = new Set([
  'proxyapi',
  'provod',
  'provod.ai',
  'yandex',
  'yandex cloud',
  'yandex_cloud',
  'yandexcloud'
])

function normalizeProvider(value) {
  return String(value || 'unknown').trim().toLowerCase()
}

function canonicalProvider(value) {
  const key = normalizeProvider(value)
  if (key === 'custom') return 'provod.ai'
  if (key === 'unknown' || key === '') return 'proxyapi'
  return key
}

function providerLabel(value) {
  const key = canonicalProvider(value)
  if (key === 'proxyapi') return 'ProxyAPI'
  if (key === 'provod' || key === 'provod.ai') return 'provod.ai'
  if (key === 'yandex' || key === 'yandex cloud' || key === 'yandex_cloud' || key === 'yandexcloud') return 'Yandex'
  if (key === 'ollama' || key === 'olama' || key === 'ollama cloud' || key === 'ollama_cloud') return 'Ollama Cloud'
  if (key === 'openai') return 'OpenAI'
  return value || 'Неизвестный провайдер'
}

function providerCurrency(value) {
  return RUB_PROVIDERS.has(canonicalProvider(value)) ? 'RUB' : 'USD'
}

// Hermes records subscription-backed OpenAI/Codex calls as included, so the
// backend cost fields are legitimately zero. For a useful usage estimate, use
// the published OpenAI-equivalent tariff when the model is known. This is
// clearly marked as a calculation in the panel; it is never called a provider
// reading.
const MODEL_TARIFFS_USD_PER_MILLION = {
  'gpt-5.6-luna': { input: 1, output: 6, cacheRead: 0.1 },
  'gpt-5.6-terra': { input: 2.5, output: 15, cacheRead: 0.25 },
  'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 0.5 }
}

function modelTariff(provider, model) {
  const providerKey = canonicalProvider(provider)
  if (!['openai', 'openai-codex', 'custom'].includes(providerKey)) return null
  const normalizedModel = String(model || '').toLowerCase().replace(/-900k$/, '')
  return MODEL_TARIFFS_USD_PER_MILLION[normalizedModel] || null
}

function tariffEstimateUsd(row) {
  const tariff = modelTariff(row.provider, row.model)
  if (!tariff) return 0
  const input = Number(row.input_tokens || 0)
  const output = Number(row.output_tokens || 0)
  const cacheRead = Number(row.cache_read_tokens || 0)
  return (input * tariff.input + output * tariff.output + cacheRead * tariff.cacheRead) / 1000000
}

function betterSource(current, next) {
  const rank = { unknown: 0, tariff: 1, estimated: 2, actual: 3 }
  return (rank[next] || 0) > (rank[current] || 0) ? next : current
}

function currentSessionId() {
  return host.state.focusedSessionId.get() || host.state.activeSessionId.get() || null
}

function formatOpenAiWindow(line) {
  if (!line) return 'нет данных'
  const match = String(line).match(/:\s*([0-9]+(?:[.,][0-9]+)?)% remaining(?:\s*\([^)]*\))?(?:\s*[•·]\s*resets?\s*(.*))?/i)
  if (!match) return 'нет данных'
  const remaining = Number(String(match[1]).replace(',', '.'))
  const spent = Math.max(0, 100 - remaining)
  const resetText = match[2] || ''
  const hours = resetText.match(/in\s+(\d+)h(?:\s+(\d+)m)?/i)
  const days = resetText.match(/in\s+(\d+)d(?:\s+(\d+)h)?/i)
  let reset = 'нет данных'
  if (hours) reset = `через ${hours[1]}ч.${hours[2] || 0}мин.`
  else if (days) reset = `через ${days[1]}дн.${days[2] || 0}ч.`
  else if (/now/i.test(resetText)) reset = 'сейчас'
  return `расход ${spent}%, остаток ${remaining}%, сброс ${reset}`
}

function parseOpenAiLimits(accountUsage) {
  const lines = Array.isArray(accountUsage?.account_lines) ? accountUsage.account_lines : []
  const find = label => lines.find(value => new RegExp(`^${label}:`, 'i').test(String(value)))
  return {
    fiveHour: formatOpenAiWindow(find('Session')),
    weekly: formatOpenAiWindow(find('Weekly'))
  }
}

function money(value, currency) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'нет данных'
  const amount = Number(value || 0)
  if (currency === 'RUB') {
    return `${amount.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
  }
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

function signedMoney(value, currency) {
  const amount = Number(value || 0)
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`
}

function apiGet(path) {
  const api = globalThis?.window?.hermesDesktop?.api
  if (typeof api !== 'function') throw new Error('Desktop API недоступен')
  return api({ path })
}

function auxiliaryLabel(value) {
  const key = String(value || '').toLowerCase()
  if (key.includes('embed')) return 'Эмбединги'
  if (key.includes('memory') || key.includes('памят')) return 'Память'
  if (key.includes('compress')) return 'Сжатие контекста'
  if (key.includes('vision')) return 'Изображения'
  return value || 'Прочее вспомогательное'
}

function summarizeModels(data, usdRub) {
  const rows = Array.isArray(data?.models) ? data.models : []
  const grouped = new Map()
  let rub = 0
  let usd = 0

  for (const row of rows) {
    const provider = canonicalProvider(row.provider)
    const currency = providerCurrency(provider)
    const backendEstimatedUsd = Number(row.estimated_cost || 0)
    const tariffEstimatedUsd = tariffEstimateUsd(row)
    const estimatedUsd = backendEstimatedUsd > 0 ? backendEstimatedUsd : tariffEstimatedUsd
    const actualUsd = Number(row.actual_cost || 0)
    const providerUsd = actualUsd > 0 ? actualUsd : null
    const latestUsd = providerUsd ?? estimatedUsd
    const kind = row.aux_task ? 'auxiliary' : 'agent'
    const key = `${kind}\u0000${provider}\u0000${currency}`
    const current = grouped.get(key) || {
      kind,
      provider,
      currency,
      latest: 0,
      estimated: 0,
      providerReported: null,
      input: 0,
      output: 0,
      calls: 0,
      models: new Set(),
      auxTasks: new Set(),
      source: providerUsd !== null ? 'actual' : backendEstimatedUsd > 0 ? 'estimated' : tariffEstimatedUsd > 0 ? 'tariff' : 'unknown'
    }

    current.latest += latestUsd
    current.estimated += estimatedUsd
    if (providerUsd !== null) current.providerReported = (current.providerReported || 0) + providerUsd
    current.input += Number(row.input_tokens || 0)
    current.output += Number(row.output_tokens || 0)
    current.calls += Number(row.api_calls || 0)
    if (row.model) current.models.add(row.model)
    if (row.aux_task) current.auxTasks.add(auxiliaryLabel(row.aux_task))
    current.source = betterSource(current.source, providerUsd !== null ? 'actual' : backendEstimatedUsd > 0 ? 'estimated' : tariffEstimatedUsd > 0 ? 'tariff' : 'unknown')
    grouped.set(key, current)

    const latest = currency === 'RUB' ? latestUsd * usdRub : latestUsd
    if (currency === 'RUB') rub += latest
    else usd += latest
  }

  const rowsOut = [...grouped.values()].map(row => ({
    ...row,
    latestAmount: row.currency === 'RUB' ? row.latest * usdRub : row.latest,
    estimatedAmount: row.currency === 'RUB' ? row.estimated * usdRub : row.estimated,
    providerAmount: row.providerReported === null
      ? null
      : row.currency === 'RUB' ? row.providerReported * usdRub : row.providerReported,
    label: row.kind === 'auxiliary' && row.auxTasks.size > 0
      ? [...row.auxTasks].join(', ')
      : providerLabel(row.provider)
  }))

  return {
    rub,
    usd,
    agentRows: rowsOut.filter(row => row.kind === 'agent').sort((a, b) => b.latestAmount - a.latestAmount),
    auxiliaryRows: rowsOut.filter(row => row.kind === 'auxiliary').sort((a, b) => b.latestAmount - a.latestAmount)
  }
}

function CostRow({ row, t }) {
  const difference = row.providerAmount === null ? null : row.providerAmount - row.estimatedAmount
  return jsxs('div', { className: 'flex flex-col gap-0.5 rounded px-1 py-1.5 hover:bg-(--chrome-action-hover)', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsx('div', { className: 'min-w-0 truncate font-medium', children: row.label }),
      jsx('div', { className: 'shrink-0 font-medium', children: money(row.latestAmount, row.currency) })
    ] }),
    jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${row.models.size} ${t('models')} · ${row.calls} ${t('calls')} · ${row.source === 'actual' ? t('exact') : row.source === 'tariff' ? t('tariff') : t('calculated')}` }),
    jsxs('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: [
      `${t('last')}: ${money(row.latestAmount, row.currency)} · ${t('hermesEstimate')}: ${money(row.estimatedAmount, row.currency)}`
    ] }),
    row.providerAmount === null
      ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('providerReading')}: ${t('noData')}` })
      : jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('providerReading')}: ${money(row.providerAmount, row.currency)} · ${t('difference')}: ${signedMoney(difference, row.currency)}` })
  ] })
}

function LimitsPanel({ t, accountUsage }) {
  const openaiLimits = parseOpenAiLimits(accountUsage)
  return jsxs('div', { className: 'flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-2', children: [
    jsx('div', { className: 'font-medium', children: t('limitsTitle') }),
    jsxs('div', { className: 'rounded px-1 py-1', children: [
      jsx('div', { className: 'font-medium', children: 'OpenAI' }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('openaiFiveHour')}: ${openaiLimits.fiveHour}` }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('openaiWeekly')}: ${openaiLimits.weekly}` })
    ] }),
    jsxs('div', { className: 'rounded px-1 py-1', children: [
      jsx('div', { className: 'font-medium', children: 'Ollama Cloud' }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('spentThisMonth')}: ${money(OLLAMA_USER_REPORT.monthlySpent, 'USD')}` }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('remainingMonthly')}: ${money(OLLAMA_USER_REPORT.monthlyRemaining, 'USD')} / ${money(OLLAMA_USER_REPORT.monthlyLimit, 'USD')}` }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('estimatedRemaining')}: ≈${OLLAMA_USER_REPORT.estimatedDays} ${t('days')} · ${t('refill')}: ${OLLAMA_USER_REPORT.refillIn}` }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('resetSchedule')}: 6 число каждого месяца` }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('autoReload')}: ${OLLAMA_USER_REPORT.autoReload ? t('on') : t('off')}` })
    ] })
  ] })
}

function CostPanel({ ctx }) {
  const t = usePluginI18n(ID)
  const usdRub = Number(ctx.storage.get('usdRub', DEFAULT_USD_RUB)) || DEFAULT_USD_RUB
  const sessionId = currentSessionId()
  const query = useQuery({
    queryKey: [ID, 'models', DAYS],
    queryFn: () => apiGet(`/api/analytics/models?days=${DAYS}`),
    staleTime: 120000,
    refetchInterval: 300000,
    retry: 1
  })
  const accountQuery = useQuery({
    queryKey: [ID, 'account-usage', sessionId || 'none'],
    queryFn: () => sessionId ? host.request('session.usage', { session_id: sessionId }) : Promise.resolve(null),
    staleTime: 300000,
    refetchInterval: 300000,
    retry: 0
  })
  const summary = summarizeModels(query.data, usdRub)

  if (query.isLoading) {
    return jsx('div', { className: 'flex items-center gap-2 p-3 text-xs text-(--ui-text-tertiary)', children: [jsx(GlyphSpinner, { ariaLabel: t('loading') }), t('loading')] })
  }

  if (query.isError) {
    return jsxs('div', { className: 'flex w-[390px] flex-col gap-2 p-3 text-xs', children: [
      jsx('div', { className: 'text-(--ui-text-secondary)', children: t('error') }),
      jsx(Button, { variant: 'secondary', size: 'sm', onClick: () => query.refetch(), children: t('retry') })
    ] })
  }

  const section = (title, rows, empty) => jsxs('div', { className: 'flex flex-col gap-1', children: [
    jsx('div', { className: 'font-medium', children: title }),
    rows.length === 0
      ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: empty })
      : rows.map(row => jsx(CostRow, { row, t }, `${row.kind}-${row.provider}-${row.label}`))
  ] })

  return jsxs('div', { className: 'flex w-[410px] max-w-[calc(100vw-24px)] flex-col gap-2 p-3 text-xs', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsx('div', { className: 'font-medium', children: t('title') }),
      jsx(Button, { variant: 'ghost', size: 'icon-xs', 'aria-label': t('refresh'), onClick: () => { query.refetch(); accountQuery.refetch() }, children: jsx(icons.RefreshCw, { size: 13 }) })
    ] }),
    jsx('div', { className: 'text-(--ui-text-tertiary)', children: t('period') }),
    section(t('agentsSection'), summary.agentRows, t('noAgentData')),
    section(t('auxSection'), summary.auxiliaryRows, t('noAuxData')),
    jsxs('div', { className: 'flex flex-col gap-1 border-t border-(--ui-stroke-secondary) pt-2', children: [
      jsxs('div', { className: 'flex justify-between', children: [jsx('span', { children: t('rubTotal') }), jsx('strong', { children: money(summary.rub, 'RUB') })] }),
      jsxs('div', { className: 'flex justify-between', children: [jsx('span', { children: t('usdTotal') }), jsx('strong', { children: money(summary.usd, 'USD') })] }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${t('rate')}: $1 = ${usdRub.toLocaleString('ru-RU')} ₽` })
    ] }),
    jsx(LimitsPanel, { t, accountUsage: accountQuery.data })
  ] })
}

function CostChip({ ctx }) {
  const t = usePluginI18n(ID)
  const [open, setOpen] = useState(false)
  return jsxs(Popover, { open, onOpenChange: setOpen, children: [
    jsx(PopoverTrigger, { asChild: true, children: jsx(Button, { variant: 'ghost', size: 'micro', 'aria-label': t('chipTip'), children: t('chipLabel') }) }),
    jsx(PopoverContent, { side: 'top', align: 'end', className: 'p-0', children: jsx(CostPanel, { ctx }) })
  ] })
}

export default {
  id: ID,
  name: 'Cost Dashboard',
  description: 'Расходы Hermes, агентов, памяти и эмбедингов с лимитами провайдеров.',
  register(ctx) {
    ctx.i18n.register({
      en: {
      title: 'Costs and limits', chipLabel: 'Cost', chipTip: 'Open costs and limits', period: 'Last 24 hours · Hermes analytics', loading: 'Loading costs…', error: 'Could not load usage analytics.', retry: 'Retry', refresh: 'Refresh', agentsSection: 'Hermes and agents', auxSection: 'Auxiliary: memory and embeddings', noAgentData: 'No agent usage recorded.', noAuxData: 'No auxiliary usage recorded.', models: 'models', calls: 'calls', exact: 'provider reading', calculated: 'calculated', tariff: 'tariff calculation', last: 'Last', hermesEstimate: 'Hermes estimate', providerReading: 'Provider reading', difference: 'difference', noData: 'no data', rubTotal: 'Ruble providers', usdTotal: 'Dollar providers', rate: 'USD/RUB rate', limitsTitle: 'Subscription limits', openaiFiveHour: '5-hour limit', openaiWeekly: 'Weekly limit', remainingFiveHour: '5-hour remainder', remainingWeekly: 'Weekly remainder', remainingMonthly: 'Monthly remainder', lastProviderInfo: 'Last information', spentThisMonth: 'Spent this month', estimatedRemaining: 'Estimated remainder', refill: 'Refill', resetSchedule: 'Reset', autoReload: 'Auto-reload', on: 'on', off: 'off', days: 'days'
      },
      ru: {
      title: 'Расходы и лимиты', chipLabel: 'Расход', chipTip: 'Открыть расходы и лимиты', period: 'Последние 24 часа · аналитика Hermes', loading: 'Загрузка расходов…', error: 'Не удалось получить аналитику использования.', retry: 'Повторить', refresh: 'Обновить', agentsSection: 'Расход Hermes и агентов', auxSection: 'Вспомогательные расходы: память и эмбединги', noAgentData: 'Расходов Hermes и агентов нет.', noAuxData: 'Вспомогательных расходов нет.', models: 'мод.', calls: 'вызовов', exact: 'показание провайдера', calculated: 'расчёт', tariff: 'расчёт по тарифу', last: 'Последний', hermesEstimate: 'расчёт Hermes', providerReading: 'Показание провайдера', difference: 'расхождение', noData: 'нет данных', rubTotal: 'Итого в рублях', usdTotal: 'Итого в долларах', rate: 'Курс доллара к рублю', limitsTitle: 'Лимиты подписок', openaiFiveHour: '5-часовой', openaiWeekly: 'Недельный', remainingFiveHour: 'Остаток 5-часового лимита', remainingWeekly: 'Остаток недельного лимита', remainingMonthly: 'Остаток месячного лимита', lastProviderInfo: 'Последняя информация', spentThisMonth: 'Потрачено за месяц', estimatedRemaining: 'Ориентировочный остаток', refill: 'Пополнение', resetSchedule: 'Сброс', autoReload: 'Автопополнение', on: 'вкл.', off: 'выкл.', days: 'дн.'
      }
    })

    ctx.register({ id: 'chip', area: STATUSBAR_AREAS.right, order: 120, render: () => jsx(CostChip, { ctx }) })
    ctx.register({ id: 'pane', area: 'panes', title: 'Расходы и лимиты', data: { placement: 'right', width: '410px' }, render: () => jsx(CostPanel, { ctx }) })
  }
}

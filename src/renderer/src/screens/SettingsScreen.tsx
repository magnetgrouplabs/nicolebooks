// Plan 01-06 Task 2 + plan 02-01 Task 4 + plan 03-02 Task 3: the Settings screen.
//
// Three sections in one section-stack:
//   1. "Secret store" (01-06): the permanent HealthIndicator (SC2 + SC4 round-trip proof).
//   2. "Inbox folder" (02-01): the D-01 "configure once, repoint anywhere" home for the inbox
//      path. On mount it shows the resolved inbox path; a "Change inbox folder" button opens the
//      native OS folder picker (window.api.ingestion.chooseInbox) and, on a non-canceled result,
//      updates the displayed path (which the next Bills scan reads). Cancel is a no-op.
//   3. "AI connection" (03-02, AI-01..AI-04, decisions D-01/D-03/D-04/D-05): base-URL presets
//      plus a custom field, a masked API-key field, one "Connect and test" action, an OK/error
//      status mirroring the HealthIndicator, and the classified model picker.
//
// SECRET BOUNDARY (D-05, threat T-03-01/T-03-01b): the API key lives in transient input state
// only. It is written straight to the OS keychain through window.api.secrets.set and then cleared
// from state; it is never read back, never re-rendered, and never logged. The same applies to the
// base URL. The ONLY AI value this screen reads back is the non-secret selected model id, over the
// ordinary settings channel.
//
// The renderer performs zero direct fs/db/network access; all resolve/choose/persist/connect runs
// main-side. All colors are semantic theme classes (no hardcoded color literals).

import { useEffect, useState } from 'react'

import { ShieldAlert, ShieldCheck } from 'lucide-react'

import { HealthIndicator } from '../components/HealthIndicator'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import type { ModelInfo, QboStatus, QboSyncResult } from '@shared/ipc-contract'

// Storage keys are written as literals at each call site so a reader can see exactly what leaves
// this screen. They must stay in step with the main-side readers: 'ai-api-key' / 'ai-base-url' in
// src/main/ai/client.ts (keychain, never read back here) and 'ai-model' in src/main/ai/models.ts
// (app_settings, non-secret, the one AI value this screen does read back).

type PresetId = 'openai' | 'openrouter' | 'custom'

/**
 * D-03: presets plus custom. Typing a base URL by hand is the single likeliest configuration
 * mistake for a non-technical user, so the two endpoints this app is actually tested against are
 * one click away and free text is the deliberate escape hatch.
 */
const BASE_URL_PRESETS: ReadonlyArray<{ id: PresetId; label: string; url: string }> = [
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { id: 'custom', label: 'Other (enter a URL)', url: '' }
]

/** Shared control styling, built only from semantic theme tokens. */
const FIELD_CLASS =
  'w-full max-w-xl rounded-lg border border-border bg-background px-3 py-2 font-sans text-sm text-foreground outline-none transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

/**
 * app_settings key recording WHICH endpoint the stored API key belongs to.
 *
 * Non-secret (it is one of the two preset URLs, or a host the user typed), so app_settings is the
 * right home and the keychain is not (D-05). It is what lets the screen tell "the saved key is
 * for this provider" from "the saved key is for a different one" across a restart.
 */
const KEY_PROVIDER_SETTING = 'ai-key-base-url'

/** Shown when the provider changed but no new key was typed (WR-08). */
export const KEY_REQUIRED_FOR_PROVIDER =
  'Enter the API key for this provider before connecting. Your saved key belongs to a different endpoint and was not sent.'

/**
 * Should "Connect and test" be blocked, and why?
 *
 * The bug this closes: connectAndTest always wrote ai-base-url but wrote ai-api-key only when the
 * field was non-empty, and the field is deliberately never repopulated ("Saved. Type a new key to
 * replace it."). So switching the provider dropdown and pressing the button sent the PREVIOUS
 * provider's key to the NEW endpoint on the very next request. assertHttpsBaseUrl stops plaintext
 * transport but says nothing about sending the credential to the wrong party, which is what
 * T-03-05 is actually about.
 *
 * Pure and exported so the decision is testable without a DOM.
 */
export function connectBlockedReason(input: {
  baseUrl: string
  typedKey: string
  /** The endpoint the stored key was saved for, or null when no key is stored. */
  keyProvider: string | null
}): string | null {
  const baseUrl = input.baseUrl.trim()
  if (baseUrl === '') {
    return 'Choose a provider, or enter a base URL that starts with https://.'
  }
  // A newly typed key is by definition the key for the endpoint being connected to.
  if (input.typedKey.trim() !== '') return null
  if (input.keyProvider !== baseUrl) return KEY_REQUIRED_FOR_PROVIDER
  return null
}

/**
 * app_settings key recording that an Intuit client id and client secret have been saved.
 *
 * Non-secret by construction: it is the string '1', never the credentials themselves. The
 * credentials go to the OS keychain and are denied read-back (src/main/qbo/secret-keys.ts), so this
 * flag is the ONLY way the form can honestly say "saved" after a restart instead of pretending
 * nothing was ever entered.
 */
const QBO_CLIENT_CONFIGURED_SETTING = 'qbo-client-configured'

/**
 * The connection chip's text. Pure and exported so the wording is testable without a DOM.
 *
 * 'expired' says "Reconnect needed" rather than "Not connected" on purpose: the fix is one click on
 * a button that reopens the same consent screen, and telling somebody their setup is gone would
 * invite them to start over instead.
 */
export function qboStatusLabel(status: QboStatus | null): string {
  if (!status) return 'Checking your QuickBooks connection...'
  if (status.state === 'connected') {
    return status.companyName ? `Connected to ${status.companyName}` : 'Connected to QuickBooks'
  }
  if (status.state === 'expired') return 'Reconnect needed'
  return 'Not connected'
}

/** Plain-language counts after a sync. Pure and exported so the copy is testable. */
export function qboSyncSummary(result: QboSyncResult): string {
  return (
    `Refreshed ${result.vendors} vendors, ${result.expenseAccounts} expense categories, ` +
    `${result.paymentAccounts} payment accounts, and ${result.items} items.`
  )
}

/** Human-readable "last synced" line. Falls back to the raw value if it will not parse. */
export function formatSyncTime(iso: string | null): string {
  if (!iso) return 'Not synced yet'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return `Last synced ${iso}`
  return `Last synced ${parsed.toLocaleString()}`
}

/** Vision-capable models get a badge; unbadged ones require the D-01 confirm before selection. */
function VisionBadge({ vision }: { vision: ModelInfo['vision'] }): React.JSX.Element | null {
  if (vision === 'vision') return <Badge variant="default">Vision</Badge>
  if (vision === 'vision-family') return <Badge variant="secondary">Vision</Badge>
  return null
}

export function SettingsScreen(): React.JSX.Element {
  const [inboxPath, setInboxPath] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [chooseError, setChooseError] = useState<string | null>(null)

  // --- AI connection state ---------------------------------------------------------------
  const [preset, setPreset] = useState<PresetId>('openai')
  const [customUrl, setCustomUrl] = useState('')
  // Transient only. Cleared the moment it reaches the keychain, and never rendered back.
  const [apiKey, setApiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  // Which endpoint the stored key belongs to (non-secret, from app_settings). null = none stored.
  const [keyProvider, setKeyProvider] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [aiStatus, setAiStatus] = useState<'unknown' | 'ok' | 'error'>('unknown')
  const [aiError, setAiError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelFilter, setModelFilter] = useState('')
  const [selectedModel, setSelectedModelState] = useState<string | null>(null)
  const [pendingModel, setPendingModel] = useState<ModelInfo | null>(null)

  // --- QuickBooks connection state -------------------------------------------------------
  // Transient only, exactly like the AI key: both credentials are written straight to the OS
  // keychain and cleared from state. Neither is ever read back, and the main-side getter refuses to
  // serve them regardless (src/main/ipc/secrets.ts deny-list).
  const [qboClientId, setQboClientId] = useState('')
  const [qboClientSecret, setQboClientSecret] = useState('')
  const [qboClientSaved, setQboClientSaved] = useState(false)
  const [savingQboClient, setSavingQboClient] = useState(false)
  const [qboStatus, setQboStatus] = useState<QboStatus | null>(null)
  const [qboBusy, setQboBusy] = useState<'connect' | 'disconnect' | 'sync' | null>(null)
  const [qboError, setQboError] = useState<string | null>(null)
  const [qboNotice, setQboNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadInbox(): Promise<void> {
      try {
        const resolved = await window.api.ingestion.resolveInbox()
        if (!cancelled) setInboxPath(resolved.path)
      } catch {
        if (!cancelled) setInboxPath(null)
      }
    }
    void loadInbox()
    return () => {
      cancelled = true
    }
  }, [])

  // Reflect the persisted selection on load (AI-04). Only NON-SECRET values are read back: the
  // model id and the endpoint the stored key belongs to. The key and base URL themselves have no
  // read path into this screen, and the main-side handler refuses to serve them anyway.
  useEffect(() => {
    let cancelled = false
    async function loadAiSettings(): Promise<void> {
      try {
        const stored = await window.api.settings.get('ai-model')
        if (!cancelled) setSelectedModelState(stored)
      } catch {
        if (!cancelled) setSelectedModelState(null)
      }
      try {
        const provider = await window.api.settings.get(KEY_PROVIDER_SETTING)
        if (cancelled) return
        setKeyProvider(provider)
        // A recorded provider means a key was stored on some earlier run, so the placeholder can
        // tell the truth across a restart instead of reverting to "Paste your API key".
        if (provider) setKeySaved(true)
      } catch {
        if (!cancelled) setKeyProvider(null)
      }
    }
    void loadAiSettings()
    return () => {
      cancelled = true
    }
  }, [])

  // Read the connection once on mount, then follow the qbo:status-changed broadcast. The broadcast
  // is what keeps this card correct when the state changes somewhere other than a button press
  // here: a refresh that came back invalid_grant flips it to Reconnect with no user action at all.
  useEffect(() => {
    let cancelled = false
    async function loadQbo(): Promise<void> {
      try {
        const status = await window.api.qbo.status()
        if (!cancelled) setQboStatus(status)
      } catch {
        if (!cancelled) setQboStatus(null)
      }
      try {
        const configured = await window.api.settings.get(QBO_CLIENT_CONFIGURED_SETTING)
        if (!cancelled) setQboClientSaved(configured === '1')
      } catch {
        if (!cancelled) setQboClientSaved(false)
      }
    }
    void loadQbo()
    // The subscription returns its own disposer, so this cleanup removes exactly this listener.
    const unsubscribe = window.api.qbo.onStatusChanged((status) => setQboStatus(status))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  /**
   * Store the Intuit app credentials. Write-only: both go to the keychain and are cleared from
   * state immediately, and the non-secret "configured" flag is written AFTER they land, so a failed
   * write never claims credentials that were not stored (the same ordering as the AI key).
   */
  async function saveQboClientCredentials(): Promise<void> {
    const id = qboClientId.trim()
    const secret = qboClientSecret.trim()
    if (!id || !secret) {
      setQboError('Enter both the client id and the client secret from your Intuit app.')
      return
    }
    setSavingQboClient(true)
    setQboError(null)
    setQboNotice(null)
    try {
      await window.api.secrets.set('qbo-client-id', id)
      await window.api.secrets.set('qbo-client-secret', secret)
      await window.api.settings.set(QBO_CLIENT_CONFIGURED_SETTING, '1')
      setQboClientId('')
      setQboClientSecret('')
      setQboClientSaved(true)
      setQboNotice('Saved. You can connect to QuickBooks now.')
    } catch {
      setQboError('Could not save those QuickBooks keys on this machine. Please try again.')
    } finally {
      setSavingQboClient(false)
    }
  }

  /** Connect and Reconnect are the same action: both open the Intuit consent screen. */
  async function connectQuickBooks(): Promise<void> {
    setQboBusy('connect')
    setQboError(null)
    setQboNotice('Finish signing in to QuickBooks in your browser, then come back here.')
    try {
      const status = await window.api.qbo.connect()
      setQboStatus(status)
      setQboNotice(
        status.state === 'connected'
          ? 'Connected. Choose Sync now to load your vendors and categories.'
          : null
      )
    } catch (err) {
      // The main handler already mapped this to fixed, recoverable copy; it never carries raw
      // error text, a host, or a realm id.
      setQboNotice(null)
      setQboError(err instanceof Error ? err.message : 'Could not connect to QuickBooks.')
    } finally {
      setQboBusy(null)
    }
  }

  async function disconnectQuickBooks(): Promise<void> {
    setQboBusy('disconnect')
    setQboError(null)
    setQboNotice(null)
    try {
      const status = await window.api.qbo.disconnect()
      setQboStatus(status)
      setQboNotice('Disconnected. Your QuickBooks keys are still saved on this machine.')
    } catch (err) {
      setQboError(err instanceof Error ? err.message : 'Could not disconnect from QuickBooks.')
    } finally {
      setQboBusy(null)
    }
  }

  async function syncQuickBooksReference(): Promise<void> {
    setQboBusy('sync')
    setQboError(null)
    setQboNotice(null)
    try {
      const result = await window.api.qbo.syncReference()
      setQboNotice(qboSyncSummary(result))
      setQboStatus(await window.api.qbo.status())
    } catch (err) {
      setQboError(err instanceof Error ? err.message : 'Could not read your QuickBooks lists.')
    } finally {
      setQboBusy(null)
    }
  }

  async function chooseInbox(): Promise<void> {
    setChoosing(true)
    setChooseError(null)
    try {
      const result = await window.api.ingestion.chooseInbox()
      // On a non-canceled result, reflect the chosen path; a canceled dialog is a no-op.
      if (!result.canceled) setInboxPath(result.path)
    } catch {
      // The picker rejected (the main handler threw before returning). Surface a plain,
      // recoverable message instead of leaving the button looking inert (same fix as CR-01).
      setChooseError('Could not open the folder picker. Please try again.')
    } finally {
      setChoosing(false)
    }
  }

  /** The base URL the user has configured, from the preset or the custom field. */
  function resolveBaseUrl(): string {
    if (preset === 'custom') return customUrl.trim()
    return BASE_URL_PRESETS.find((p) => p.id === preset)?.url ?? ''
  }

  /**
   * D-04: ONE action stores the credentials, validates them, and populates the picker, because it
   * makes exactly one /models call. Both values go straight to the OS keychain and are never
   * returned; only the classified model list comes back.
   */
  async function connectAndTest(): Promise<void> {
    const baseUrl = resolveBaseUrl()
    // Checked BEFORE anything is written: writing the new base URL and then refusing would leave
    // the stored key paired with an endpoint it does not belong to.
    const blocked = connectBlockedReason({ baseUrl, typedKey: apiKey, keyProvider })
    if (blocked) {
      setAiStatus('error')
      setAiError(blocked)
      return
    }

    setTesting(true)
    setAiError(null)
    setPendingModel(null)
    try {
      await window.api.secrets.set('ai-base-url', baseUrl)
      if (apiKey.trim()) {
        await window.api.secrets.set('ai-api-key', apiKey.trim())
        setApiKey('') // transient only: it is in the keychain now, so drop it from state
        setKeySaved(true)
        // Record which endpoint this key belongs to, so the pairing survives a restart. Written
        // AFTER the key lands, so a failed write never claims a key that was not stored.
        await window.api.settings.set(KEY_PROVIDER_SETTING, baseUrl)
        setKeyProvider(baseUrl)
      }

      const result = await window.api.ai.testConnection()
      if (result.ok) {
        setAiStatus('ok')
        setModels(result.models ?? [])
        setAiError(null)
      } else {
        setAiStatus('error')
        setModels([])
        setAiError(result.error ?? 'Could not connect with those settings. Please try again.')
      }
    } catch {
      setAiStatus('error')
      setModels([])
      setAiError('Could not save those settings on this machine. Please try again.')
    } finally {
      setTesting(false)
    }
  }

  /** Persist the pick (AI-04). Called only after the D-01 confirm gate for unbadged models. */
  async function selectModel(model: ModelInfo): Promise<void> {
    setPendingModel(null)
    try {
      await window.api.ai.setModel(model.id)
      setSelectedModelState(model.id)
      setAiError(null)
    } catch {
      setAiError('Could not save your model choice. Please try again.')
    }
  }

  /** D-01: flag and confirm, never filter. An unclassified model needs an explicit "use anyway". */
  function requestModel(model: ModelInfo): void {
    if (model.vision === 'unknown') {
      setPendingModel(model)
      return
    }
    void selectModel(model)
  }

  const filterText = modelFilter.trim().toLowerCase()
  const visibleModels = filterText
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(filterText) ||
          (m.label ?? '').toLowerCase().includes(filterText)
      )
    : models

  const qboConnected = qboStatus?.state === 'connected'
  const qboExpired = qboStatus?.state === 'expired'

  const StatusIcon = aiStatus === 'error' ? ShieldAlert : ShieldCheck
  const statusIconColor =
    aiStatus === 'ok' ? 'text-success' : aiStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'
  const statusLabel =
    aiStatus === 'ok'
      ? 'AI connection: OK'
      : aiStatus === 'error'
        ? 'AI connection: error'
        : 'AI connection: not tested yet'
  const statusSupporting =
    aiStatus === 'ok'
      ? `Your endpoint answered and returned ${models.length} model${models.length === 1 ? '' : 's'}. Pick the one to use below.`
      : aiStatus === 'error'
        ? null
        : 'Enter your API key, choose your provider, then run Connect and test.'

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-sans text-sm font-semibold text-muted-foreground">Secret store</h2>
      <HealthIndicator />

      <h2 className="font-sans text-sm font-semibold text-muted-foreground">Inbox folder</h2>
      <p className="font-mono text-sm text-muted-foreground">
        {inboxPath ?? 'Locating your inbox folder...'}
      </p>
      <div>
        <Button variant="outline" disabled={choosing} onClick={() => void chooseInbox()}>
          Change inbox folder
        </Button>
      </div>
      {chooseError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {chooseError}
        </p>
      )}

      <h2 className="font-sans text-sm font-semibold text-muted-foreground">AI connection</h2>

      <div className="flex flex-col gap-1">
        <label htmlFor="ai-provider" className="font-sans text-sm font-medium text-foreground">
          Provider
        </label>
        <select
          id="ai-provider"
          className={FIELD_CLASS}
          value={preset}
          onChange={(e) => setPreset(e.target.value as PresetId)}
        >
          {BASE_URL_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {preset !== 'custom' && (
          <p className="font-mono text-sm text-muted-foreground">{resolveBaseUrl()}</p>
        )}
      </div>

      {preset === 'custom' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="ai-base-url" className="font-sans text-sm font-medium text-foreground">
            Base URL
          </label>
          <input
            id="ai-base-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className={FIELD_CLASS}
            placeholder="https://your-endpoint.example/v1"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
          />
          <p className="font-sans text-sm text-muted-foreground">
            Must start with https:// so your key is never sent unencrypted.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="ai-api-key" className="font-sans text-sm font-medium text-foreground">
          API key
        </label>
        <input
          id="ai-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={FIELD_CLASS}
          placeholder={
            keySaved && keyProvider === resolveBaseUrl()
              ? 'Saved. Type a new key to replace it.'
              : keySaved
                ? 'Enter the key for this provider'
                : 'Paste your API key'
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <p className="font-sans text-sm text-muted-foreground">
          Your key is stored in this machine&apos;s secure keychain and is never shown again. A key
          is only ever sent to the provider it was saved for.
        </p>
      </div>

      <div>
        <Button disabled={testing} onClick={() => void connectAndTest()}>
          {testing ? 'Connecting...' : 'Connect and test'}
        </Button>
      </div>

      <div className="max-w-xl rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <StatusIcon className={`size-5 ${statusIconColor}`} aria-hidden="true" />
          <span className="text-sm font-semibold text-card-foreground">{statusLabel}</span>
        </div>
        {statusSupporting && (
          <p className="mt-1 pl-7 text-sm font-normal text-muted-foreground">{statusSupporting}</p>
        )}
      </div>

      {aiError && (
        <p
          role="alert"
          className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {aiError}
        </p>
      )}

      {models.length > 0 && (
        <div className="flex max-w-xl flex-col gap-2">
          <label htmlFor="ai-model-filter" className="font-sans text-sm font-medium text-foreground">
            Model
          </label>
          <p className="font-sans text-sm text-muted-foreground">
            {selectedModel
              ? `Currently using ${selectedModel}.`
              : 'No model chosen yet. Pick one marked Vision so NicoleBooks can read scanned bills.'}
          </p>
          <input
            id="ai-model-filter"
            type="search"
            autoComplete="off"
            spellCheck={false}
            className={FIELD_CLASS}
            placeholder="Search models"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
          />
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {visibleModels.map((model) => (
              <li
                key={model.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
              >
                <span className="font-mono text-sm text-card-foreground">{model.id}</span>
                <div className="flex items-center gap-2">
                  <VisionBadge vision={model.vision} />
                  {selectedModel === model.id ? (
                    <Badge variant="outline">Selected</Badge>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => requestModel(model)}>
                      Use this model
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {visibleModels.length === 0 && (
            <p className="font-sans text-sm text-muted-foreground">
              No models match that search.
            </p>
          )}
        </div>
      )}

      {pendingModel && (
        <div
          role="alertdialog"
          aria-label="Confirm model choice"
          className="max-w-xl rounded-xl border border-border bg-card p-4"
        >
          <p className="font-sans text-sm font-semibold text-card-foreground">
            This model is not confirmed vision-capable. Use anyway?
          </p>
          <p className="mt-1 font-sans text-sm text-muted-foreground">
            NicoleBooks could not confirm that {pendingModel.id} can read images. If it cannot,
            photos and scanned bills will fail to parse.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" onClick={() => void selectModel(pendingModel)}>
              Use anyway
            </Button>
            <Button variant="ghost" onClick={() => setPendingModel(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <h2 className="font-sans text-sm font-semibold text-muted-foreground">
        QuickBooks connection
      </h2>

      <div className="max-w-xl rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          {qboConnected ? (
            <Badge variant="default">Connected</Badge>
          ) : qboExpired ? (
            <Badge variant="secondary">Reconnect needed</Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
          <span className="text-sm font-semibold text-card-foreground">
            {qboStatusLabel(qboStatus)}
          </span>
        </div>
        <p className="mt-1 font-sans text-sm text-muted-foreground">
          {qboConnected || qboExpired
            ? formatSyncTime(qboStatus?.lastSyncAt ?? null)
            : 'Connect NicoleBooks to your QuickBooks company so it can read your vendors, categories, and payment accounts.'}
        </p>
        {qboStatus?.realmId && (
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            Company id {qboStatus.realmId}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={qboBusy !== null} onClick={() => void connectQuickBooks()}>
          {qboBusy === 'connect'
            ? 'Waiting for your browser...'
            : qboExpired
              ? 'Reconnect to QuickBooks'
              : qboConnected
                ? 'Connect a different company'
                : 'Connect to QuickBooks'}
        </Button>
        {(qboConnected || qboExpired) && (
          <>
            <Button
              variant="outline"
              disabled={qboBusy !== null || qboExpired}
              onClick={() => void syncQuickBooksReference()}
            >
              {qboBusy === 'sync' ? 'Syncing...' : 'Sync now'}
            </Button>
            <Button
              variant="ghost"
              disabled={qboBusy !== null}
              onClick={() => void disconnectQuickBooks()}
            >
              {qboBusy === 'disconnect' ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </>
        )}
      </div>

      {qboNotice && (
        <p className="max-w-xl rounded-lg border border-border bg-card px-3 py-2 font-sans text-sm text-muted-foreground">
          {qboNotice}
        </p>
      )}

      {qboError && (
        <p
          role="alert"
          className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {qboError}
        </p>
      )}

      <h3 className="font-sans text-sm font-medium text-foreground">QuickBooks app keys</h3>
      <p className="max-w-xl font-sans text-sm text-muted-foreground">
        These come from your Intuit developer app and are needed once, before the first connection.
        They are stored in this machine&apos;s secure keychain and are never shown again.
      </p>

      <div className="flex flex-col gap-1">
        <label htmlFor="qbo-client-id" className="font-sans text-sm font-medium text-foreground">
          Client id
        </label>
        <input
          id="qbo-client-id"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={FIELD_CLASS}
          placeholder={qboClientSaved ? 'Saved. Type a new client id to replace it.' : 'Paste your client id'}
          value={qboClientId}
          onChange={(e) => setQboClientId(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="qbo-client-secret" className="font-sans text-sm font-medium text-foreground">
          Client secret
        </label>
        <input
          id="qbo-client-secret"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={FIELD_CLASS}
          placeholder={
            qboClientSaved ? 'Saved. Type a new client secret to replace it.' : 'Paste your client secret'
          }
          value={qboClientSecret}
          onChange={(e) => setQboClientSecret(e.target.value)}
        />
      </div>

      <div>
        <Button
          variant="outline"
          disabled={savingQboClient}
          onClick={() => void saveQboClientCredentials()}
        >
          {savingQboClient ? 'Saving...' : 'Save QuickBooks keys'}
        </Button>
      </div>
    </div>
  )
}

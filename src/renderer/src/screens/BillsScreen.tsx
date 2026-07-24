// Plan 02-01: the Bills screen scan surface (ING-01, D-14).
//
// On mount it reads the configured inbox path through window.api.ingestion.resolveInbox()
// (display-only; repointing lives on the Settings screen). A "Scan now" button runs the
// read-only scan through window.api.ingestion.scan() and renders the minimal loaded-results
// surface: a one-line summary, the batch processing date, the loaded files with a per-status
// Badge, and an unsupported-skipped summary listing the names (D-12, visibility over silence).
//
// The renderer performs zero direct fs/db access — every privileged operation runs main-side
// behind the ingestion IPC group. All colors are semantic theme classes (no hardcoded hex).

import { useEffect, useState } from 'react'

import { Receipt } from 'lucide-react'

import { EmptyState } from '../components/EmptyState'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import type { ScanFile, ScanFileStatus, ScanResult } from '@shared/ipc-contract'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

// Loaded is the branded default; unsupported is a quiet outline; the duplicate/not-ready
// states (added in plans 02-02/02-03) read as destructive so a caught problem stands out.
const STATUS_VARIANT: Record<ScanFileStatus, BadgeVariant> = {
  loaded: 'default',
  'duplicate-excluded': 'destructive',
  'duplicate-in-batch': 'destructive',
  'not-ready-skipped': 'destructive',
  'unsupported-skipped': 'outline'
}

const STATUS_LABEL: Record<ScanFileStatus, string> = {
  loaded: 'Loaded',
  'duplicate-excluded': 'Already entered',
  'duplicate-in-batch': 'Duplicate in batch',
  'not-ready-skipped': 'Not downloaded yet',
  'unsupported-skipped': 'Unsupported'
}

function summaryLine(result: ScanResult): string {
  const { total, loaded, duplicates, notReady, unsupported } = result.summary
  const parts = [`${loaded} loaded`]
  if (duplicates > 0) parts.push(`${duplicates} duplicate`)
  if (notReady > 0) parts.push(`${notReady} not downloaded`)
  if (unsupported > 0) parts.push(`${unsupported} unsupported`)
  const noun = total === 1 ? 'file' : 'files'
  return `${total} ${noun}: ${parts.join(', ')}`
}

function ScanRow({ file }: { file: ScanFile }): React.JSX.Element {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <span className="font-mono text-sm text-card-foreground">{file.filename}</span>
      <Badge variant={STATUS_VARIANT[file.status]}>{STATUS_LABEL[file.status]}</Badge>
    </li>
  )
}

export function BillsScreen(): React.JSX.Element {
  const [inboxPath, setInboxPath] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)

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

  async function runScan(): Promise<void> {
    setScanning(true)
    try {
      const scan = await window.api.ingestion.scan()
      setResult(scan)
    } finally {
      setScanning(false)
    }
  }

  const loadedFiles = result?.files.filter((f) => f.status === 'loaded') ?? []
  const unsupportedFiles = result?.files.filter((f) => f.status === 'unsupported-skipped') ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-sm font-semibold text-muted-foreground">Inbox</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {inboxPath ?? 'Locating your inbox folder...'}
          </p>
        </div>
        <Button variant="default" disabled={scanning} onClick={() => void runScan()}>
          {scanning ? 'Scanning...' : 'Scan now'}
        </Button>
      </div>

      {!result && (
        <EmptyState
          icon={Receipt}
          heading="No bills to review"
          body="Drop bills into your inbox folder, then click Scan now to load them for review."
        />
      )}

      {result && result.files.length === 0 && (
        <EmptyState
          icon={Receipt}
          heading="Your inbox is empty"
          body="Drop bills into your inbox folder, then click Scan now to load them for review."
        />
      )}

      {result && result.files.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="font-sans text-sm font-medium text-foreground">{summaryLine(result)}</p>
            <p className="font-sans text-sm text-muted-foreground">
              Batch date: {result.batchEntryDate}
            </p>
          </div>

          {loadedFiles.length > 0 && (
            <ul className="flex flex-col gap-2">
              {loadedFiles.map((file) => (
                <ScanRow key={file.filename} file={file} />
              ))}
            </ul>
          )}

          {unsupportedFiles.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
              <p className="text-sm font-semibold text-card-foreground">
                {unsupportedFiles.length} {unsupportedFiles.length === 1 ? 'file' : 'files'} skipped
                (unsupported type)
              </p>
              <ul className="flex flex-col gap-1">
                {unsupportedFiles.map((file) => (
                  <li key={file.filename} className="font-mono text-sm text-muted-foreground">
                    {file.filename}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

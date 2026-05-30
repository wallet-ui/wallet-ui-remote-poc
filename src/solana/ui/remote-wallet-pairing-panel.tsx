import { CheckIcon, CopyIcon, QrCodeIcon, XIcon } from 'lucide-react'
import QRCode from 'qrcode'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'

import { Badge } from '@/core/ui/badge'
import { Button } from '@/core/ui/button'
import { Input } from '@/core/ui/input'
import { cn } from '@/core/util/utils'
import {
  cancelRemoteWalletPairing,
  getRemoteWalletPairingSnapshot,
  REMOTE_WALLET_PAIRING_TTL_MS,
  subscribeRemoteWalletPairing,
} from '@/solana/data-access/remote-wallet-session'

export function RemoteWalletPairingPanel({ className }: { className?: string }) {
  const session = useRemoteWalletPairingSession()

  if (!session) {
    return null
  }

  return (
    <div className={cn('grid gap-3', className)}>
      <div className="grid gap-3 sm:grid-cols-[24rem_minmax(0,1fr)] lg:grid-cols-[28rem_minmax(0,1fr)]">
        <RemoteWalletQrImage
          alt="Remote Wallet pairing QR"
          className="max-w-96 sm:max-w-none"
          text={session.pairingUrl}
        />
        <div className="grid min-w-0 content-start gap-2">
          <RemoteWalletPairingCountdown expiresAt={session.expiresAt} status={session.status} />
          <PairingField action={<CopyButton text={session.relayDomain} />} label="Relay">
            <Input className="font-mono text-[0.625rem]" readOnly value={session.relayDomain} />
          </PairingField>
          <PairingField action={<CopyButton text={session.status} />} label="Status">
            <Badge className="h-7 rounded-md px-2 font-mono text-sm tracking-normal" variant="outline">
              {session.status}
            </Badge>
          </PairingField>
          <PairingField action={<CopyButton text={session.expiresAt} />} label="Expires at">
            <Input className="font-mono text-[0.625rem]" readOnly value={session.expiresAt} />
          </PairingField>
          <PairingField action={<CopyButton text={session.pairingUrl} />} label="Pairing URL">
            <Input className="font-mono text-[0.625rem]" readOnly value={session.pairingUrl} />
          </PairingField>
        </div>
      </div>
      <Button className="w-full" onClick={cancelRemoteWalletPairing} variant="outline">
        <XIcon />
        Cancel pairing
      </Button>
    </div>
  )
}

export function useRemoteWalletPairingSession() {
  return useSyncExternalStore(
    subscribeRemoteWalletPairing,
    () => getRemoteWalletPairingSnapshot().session,
    () => getRemoteWalletPairingSnapshot().session,
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      aria-label={copied ? 'Copied' : 'Copy'}
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

function getRemoteWalletStatusLabel(status: string) {
  switch (status) {
    case 'authorizing':
      return 'Authorizing'
    case 'connected':
      return 'Connected'
    case 'wallet-joined':
      return 'Wallet joined'
    default:
      return status
  }
}

function PairingField({ action, children, label }: { action: ReactNode; children: ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[0.625rem] font-medium text-muted-foreground uppercase">{label}</div>
        {action}
      </div>
      {children}
    </div>
  )
}

function RemoteWalletPairingCountdown({ expiresAt, status }: { expiresAt: string; status: string }) {
  const remainingMs = usePairingRemainingMs({ expiresAt, status })
  const remainingSeconds = Math.ceil(remainingMs / 1000)
  const isWaitingForWallet = status === 'waiting-for-wallet'
  const progress = isWaitingForWallet ? Math.max(0, Math.min(1, remainingMs / REMOTE_WALLET_PAIRING_TTL_MS)) : 1
  const radius = 18
  const circumference = 2 * Math.PI * radius

  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <div className="relative flex size-12 shrink-0 items-center justify-center">
        <svg aria-hidden className="absolute inset-0 size-12 -rotate-90" viewBox="0 0 48 48">
          <circle className="stroke-muted" cx="24" cy="24" fill="none" r={radius} strokeWidth="4" />
          <circle
            className="stroke-primary transition-[stroke-dashoffset] duration-300 ease-linear"
            cx="24"
            cy="24"
            fill="none"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            strokeLinecap="round"
            strokeWidth="4"
          />
        </svg>
        {isWaitingForWallet ? (
          <span className="font-mono text-xs tabular-nums">{remainingSeconds}</span>
        ) : (
          <CheckIcon className="size-5" />
        )}
      </div>
      <div className="min-w-0">
        <div className="text-[0.625rem] font-medium text-muted-foreground uppercase">Time to scan</div>
        <div className="truncate text-sm">
          {isWaitingForWallet ? `${remainingSeconds}s remaining` : getRemoteWalletStatusLabel(status)}
        </div>
      </div>
    </div>
  )
}

function RemoteWalletQrImage({ alt, className, text }: { alt: string; className?: string; text: string }) {
  const [qrCode, setQrCode] = useState<{ dataUrl: string; text: string }>()

  useEffect(() => {
    let cancelled = false

    QRCode.toString(text, {
      color: {
        dark: '#111111',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'L',
      margin: 4,
      width: 512,
    }).then((svg) => {
      if (!cancelled) {
        setQrCode({ dataUrl: `data:image/svg+xml;base64,${btoa(svg)}`, text })
      }
    })

    return () => {
      cancelled = true
    }
  }, [text])

  const qrDataUrl = qrCode?.text === text ? qrCode.dataUrl : ''

  return (
    <div
      className={cn(
        'mx-auto flex aspect-square w-full items-center justify-center rounded-lg border border-border bg-white p-2',
        className,
      )}
    >
      {qrDataUrl ? (
        <img alt={alt} className="size-full" src={qrDataUrl} />
      ) : (
        <QrCodeIcon className="size-8 text-neutral-900" />
      )}
    </div>
  )
}

function usePairingRemainingMs({ expiresAt, status }: { expiresAt: string; status: string }) {
  const expiresAtMs = Date.parse(expiresAt)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (status !== 'waiting-for-wallet') {
      return
    }

    const intervalId = window.setInterval(() => setNowMs(Date.now()), 250)

    return () => window.clearInterval(intervalId)
  }, [expiresAtMs, status])

  return Math.max(0, expiresAtMs - nowMs)
}

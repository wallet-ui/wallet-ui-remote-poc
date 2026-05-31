'use client'

import { type UiWallet, useWalletUi, useWalletUiWallet, WalletUiIcon } from '@wallet-ui/react'
import { useState } from 'react'

import { Button } from '@/core/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/core/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu'
import { cn } from '@/core/util/utils'
import { cancelRemoteWalletPairing } from '@/solana/data-access/remote-wallet-provider'

import { RemoteWalletPairingPanel, useRemoteWalletPairingSession } from './remote-wallet-pairing-panel'
import { formatWalletTriggerLabel, INSTALL_WALLETS_URL, sortWallets } from './wallet-utils'

export function SolanaUiWalletDialog({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const { account, connected, copy, disconnect, wallet, wallets } = useWalletUi()
  const pairingSession = useRemoteWalletPairingSession()
  const sortedWallets = sortWallets(wallets)
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)

    if (!nextOpen && pairingSession) {
      cancelRemoteWalletPairing()
    }
  }
  const triggerContent = (
    <>
      {connected && wallet ? <WalletUiIcon className="size-5" wallet={wallet} /> : null}
      <span className="truncate">
        {formatWalletTriggerLabel({ accountAddress: account?.address, connected, walletName: wallet?.name })}
      </span>
    </>
  )

  return (
    <>
      {connected ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button className={cn('justify-start gap-1 pl-1', className)} variant="outline" />}
          >
            {triggerContent}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => copy()}>Copy address</DropdownMenuItem>
              <DropdownMenuItem onClick={() => disconnect()}>Disconnect</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="my-2" />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setOpen(true)}>Select Wallet</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button className={cn('justify-start gap-2', className)} onClick={() => setOpen(true)} variant="outline">
          {triggerContent}
        </Button>
      )}
      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogContent className={pairingSession ? 'sm:max-w-3xl lg:max-w-4xl' : undefined}>
          <DialogHeader>
            <DialogTitle>{pairingSession ? 'Pair Remote Wallet' : 'Select Wallet'}</DialogTitle>
            <DialogDescription>
              {pairingSession
                ? 'Scan the QR code or paste the pairing URL into a remote wallet.'
                : 'Connect a wallet on Solana to continue.'}
            </DialogDescription>
          </DialogHeader>
          {pairingSession ? (
            <RemoteWalletPairingPanel />
          ) : (
            <div className="grid gap-2">
              {sortedWallets.length > 0 ? (
                sortedWallets.map((availableWallet) => (
                  <WalletDialogWalletItem
                    key={availableWallet.name}
                    onConnected={() => setOpen(false)}
                    wallet={availableWallet}
                  />
                ))
              ) : (
                <Button
                  className="w-full justify-start"
                  nativeButton={false}
                  render={<a href={INSTALL_WALLETS_URL} rel="noreferrer" target="_blank" />}
                  variant="outline"
                >
                  Install a Solana wallet
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function WalletDialogWalletItem({ onConnected, wallet }: { onConnected: () => void; wallet: UiWallet }) {
  const { connect } = useWalletUiWallet({ wallet })

  return (
    <Button
      className="h-10 w-full justify-start gap-2 hover:bg-muted dark:hover:border-neutral-700 dark:hover:bg-muted/10"
      onClick={async () => {
        try {
          await connect()
          onConnected()
        } catch {
          // Keep the dialog open so the user can retry or choose another wallet.
        }
      }}
      variant="outline"
    >
      <WalletUiIcon className="size-6 shrink-0" wallet={wallet} />
      <span className="truncate">{wallet.name}</span>
    </Button>
  )
}

import type { ReactNode } from 'react'

import { type UiWallet, type UiWalletAccount, WalletUiIcon } from '@wallet-ui/react'

import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/core/ui/card'
import { SolanaUiAddress } from '@/solana/ui/solana-ui-address'

export function WalletUiAccountCard({
  account,
  action,
  wallet,
}: {
  account: UiWalletAccount
  action?: ReactNode
  wallet: UiWallet
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <WalletUiIcon className="size-6" wallet={wallet} />
          <span>{account.label ?? wallet.name}</span>
        </CardTitle>
        <CardDescription>
          <SolanaUiAddress address={account.address} />
        </CardDescription>
        {action ? <CardAction className="space-x-2">{action}</CardAction> : null}
      </CardHeader>
    </Card>
  )
}

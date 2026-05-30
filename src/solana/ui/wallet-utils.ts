import { ellipsify, type UiWallet } from '@wallet-ui/react'

import { REMOTE_WALLET_NAME } from '@/solana/data-access/remote-wallet-provider'

export const INSTALL_WALLETS_URL = 'https://solana.com/solana-wallets'

export function formatWalletTriggerLabel({
  accountAddress,
  connected,
  walletName,
}: {
  accountAddress?: string
  connected: boolean
  walletName?: string
}) {
  if (!connected) {
    return 'Select Wallet'
  }

  if (accountAddress) {
    return ellipsify(accountAddress)
  }

  return walletName ?? 'Connected'
}

export function sortWallets(wallets: readonly UiWallet[]) {
  return [...wallets].sort((left, right) => {
    if (left.name === REMOTE_WALLET_NAME) {
      return -1
    }
    if (right.name === REMOTE_WALLET_NAME) {
      return 1
    }

    return left.name.localeCompare(right.name)
  })
}

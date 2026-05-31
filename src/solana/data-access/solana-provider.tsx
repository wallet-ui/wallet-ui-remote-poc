import {
  createSolanaDevnet,
  createSolanaLocalnet,
  createSolanaTestnet,
  createWalletUiConfig,
  WalletUi,
} from '@wallet-ui/react'
import { type ReactNode, useEffect } from 'react'

import { registerReferenceRemoteWallet } from './remote-wallet-provider'
import { solanaMobileWalletAdapter } from './solana-mobile-wallet-adapter'

const config = createWalletUiConfig({
  clusters: [
    createSolanaDevnet('https://api.devnet.solana.com'),
    createSolanaLocalnet('http://127.0.0.1:8899'),
    createSolanaTestnet('https://api.testnet.solana.com'),
  ],
})

let walletAdaptersLoaded = false

export function SolanaProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (walletAdaptersLoaded) {
      return
    }

    walletAdaptersLoaded = true
    registerReferenceRemoteWallet({ clusters: config.clusters })
    solanaMobileWalletAdapter({ clusters: config.clusters })
  }, [])

  return <WalletUi config={config}>{children}</WalletUi>
}

import { type SolanaCluster } from '@wallet-ui/react'
import {
  createRemoteWalletProvider,
  registerRemoteWallet,
  REMOTE_WALLET_NAME,
  REMOTE_WALLET_PAIRING_TTL_MS,
  type RemoteWalletPairingSession,
  type RemoteWalletProviderSnapshot,
} from 'remote-wallet/browser'

const provider = createRemoteWalletProvider()
let remoteWalletRegistered = false

export { REMOTE_WALLET_NAME, REMOTE_WALLET_PAIRING_TTL_MS }
export type { RemoteWalletPairingSession, RemoteWalletProviderSnapshot }

export function cancelRemoteWalletPairing() {
  provider.cancelPairing()
}

export function getRemoteWalletPairingSnapshot() {
  return provider.getSnapshot()
}

export function registerReferenceRemoteWallet({ clusters }: { clusters: readonly SolanaCluster[] }) {
  if (remoteWalletRegistered) {
    return
  }

  remoteWalletRegistered = true
  registerRemoteWallet({
    chains: clusters.map((cluster) => cluster.id),
    identity: {
      name: document.title || 'Wallet UI Remote POC',
      uri: window.location.origin,
    },
    provider,
  })
}

export function subscribeRemoteWalletPairing(listener: () => void) {
  return provider.subscribe(listener)
}

import {
  registerWallet,
  type SolanaCluster,
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignAndSendTransactionMethod,
  SolanaSignIn,
  type SolanaSignInFeature,
  type SolanaSignInMethod,
  SolanaSignMessage,
  type SolanaSignMessageFeature,
  type SolanaSignMessageMethod,
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
  type SolanaSignTransactionMethod,
  StandardConnect,
  type StandardConnectFeature,
  type StandardConnectMethod,
  StandardDisconnect,
  type StandardDisconnectFeature,
  type StandardDisconnectMethod,
  StandardEvents,
  type StandardEventsChangeProperties,
  type StandardEventsFeature,
  type StandardEventsListeners,
  type StandardEventsNames,
  type StandardEventsOnMethod,
  type Wallet,
  type WalletAccount,
  type WalletIcon,
} from '@wallet-ui/react'
import { type ReactNode, useEffect } from 'react'

import {
  cancelRemoteWalletPairing,
  clearRemoteWalletPairing,
  createRemoteWalletPairingSession,
  getRemoteWalletPairingSnapshot,
  REMOTE_WALLET_PAIRING_TTL_MS,
  type RemoteWalletAuthorizedAccount,
  type RemoteWalletAuthorizedSession,
  type RemoteWalletSignInOutput,
  subscribeRemoteWalletPairing,
  subscribeRemoteWalletPairingCancel,
} from './remote-wallet-session'

export const REMOTE_WALLET_NAME = 'Remote Wallet'

const REMOTE_WALLET_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiNmZmYiLz48cGF0aCBmaWxsPSIjMTExIiBkPSJNMTAgMTBoMTZ2MTZIMTB6TTM4IDEwaDE2djE2SDM4ek0xMCAzOGgxNnYxNkgxMHpNMzAgMzBoOHY4aC04ek00MiAzMGg0djRoLTR6TTUwIDMwaDR2OGgtNHpNMzAgNDJoNHYxMmgtNHpNMzggNDJoOHY0aC04ek01MCA0Nmg0djhoLTR6TTQyIDUwaDR2NGgtNHpNMTQgMTR2OGg4di04em0yOCAwdjhoOHYtOHptLTI4IDI4djhoOHYtOHoiLz48L3N2Zz4='

let remoteWalletRegistered = false

type RemoteWalletFeatures = SolanaSignAndSendTransactionFeature &
  SolanaSignInFeature &
  SolanaSignMessageFeature &
  SolanaSignTransactionFeature &
  StandardConnectFeature &
  StandardDisconnectFeature &
  StandardEventsFeature
type RemoteWalletPendingConnect = {
  promise: ReturnType<StandardConnectMethod>
  reject: (reason?: unknown) => void
  timeout?: ReturnType<typeof setTimeout>
}

class RemoteWallet implements Wallet {
  readonly icon = REMOTE_WALLET_ICON as WalletIcon
  readonly name = REMOTE_WALLET_NAME
  readonly version = '1.0.0'
  get accounts() {
    return this.#accounts
  }
  get chains() {
    return this.#chains
  }
  get features() {
    return this.#features
  }
  #accounts: readonly WalletAccount[] = []
  readonly #chains: Wallet['chains']

  readonly #features: RemoteWalletFeatures

  readonly #listeners = new Set<StandardEventsListeners['change']>()

  #pendingConnect: RemoteWalletPendingConnect | undefined
  #remoteSession: RemoteWalletAuthorizedSession | undefined

  constructor(chains: Wallet['chains']) {
    this.#chains = chains
    subscribeRemoteWalletPairing(() => {
      const session = getRemoteWalletPairingSnapshot().session

      if (session?.status !== 'waiting-for-wallet') {
        this.#clearPendingConnectTimeout()
      }
    })
    subscribeRemoteWalletPairingCancel(() => this.#rejectPendingConnect(new Error('Remote Wallet pairing cancelled')))
    this.#features = {
      [SolanaSignAndSendTransaction]: {
        signAndSendTransaction: this.#signAndSendTransaction,
        supportedTransactionVersions: ['legacy', 0],
        version: '1.0.0',
      },
      [SolanaSignIn]: {
        signIn: this.#signIn,
        version: '1.0.0',
      },
      [SolanaSignMessage]: {
        signMessage: this.#signMessage,
        version: '1.0.0',
      },
      [SolanaSignTransaction]: {
        signTransaction: this.#signTransaction,
        supportedTransactionVersions: ['legacy', 0],
        version: '1.0.0',
      },
      [StandardConnect]: {
        connect: this.#connect,
        version: '1.0.0',
      },
      [StandardDisconnect]: {
        disconnect: this.#disconnect,
        version: '1.0.0',
      },
      [StandardEvents]: {
        on: this.#on,
        version: '1.0.0',
      },
    }
  }

  #clearPendingConnectTimeout() {
    if (!this.#pendingConnect?.timeout) {
      return
    }

    clearTimeout(this.#pendingConnect.timeout)
    this.#pendingConnect.timeout = undefined
  }

  #connect: StandardConnectMethod = async (input) => {
    if (input?.silent && !this.#accounts.length) {
      return { accounts: [] }
    }

    if (this.#accounts.length) {
      return { accounts: this.#accounts }
    }

    if (this.#pendingConnect) {
      return this.#pendingConnect.promise
    }

    const session = await createRemoteWalletPairingSession({ chains: this.#chains })
    let resolveConnect!: (result: Awaited<ReturnType<StandardConnectMethod>>) => void
    let rejectConnect: RemoteWalletPendingConnect['reject']
    const promise = new Promise<Awaited<ReturnType<StandardConnectMethod>>>((resolve, reject) => {
      rejectConnect = reject
      resolveConnect = resolve
    })
    this.#pendingConnect = {
      promise,
      reject: rejectConnect!,
      timeout: setTimeout(() => cancelRemoteWalletPairing(), REMOTE_WALLET_PAIRING_TTL_MS),
    }
    session.authorizedSession
      .then((remoteSession) => {
        this.#clearPendingConnectTimeout()
        this.#pendingConnect = undefined
        this.#remoteSession = remoteSession
        this.#accounts = remoteSession.accounts.map(mapRemoteWalletAccount)
        this.#emit({ accounts: this.#accounts })
        resolveConnect({ accounts: this.#accounts })
      })
      .catch((error: unknown) => {
        this.#rejectPendingConnect(error)
      })

    return promise
  }

  #disconnect: StandardDisconnectMethod = async () => {
    const remoteSession = this.#remoteSession

    if (remoteSession) {
      try {
        await remoteSession.disconnect()
      } finally {
        clearRemoteWalletPairing()
      }
    } else {
      cancelRemoteWalletPairing()
    }

    this.#accounts = []
    this.#remoteSession = undefined
    this.#emit({ accounts: this.#accounts })
  }

  #emit(properties: StandardEventsChangeProperties) {
    for (const listener of this.#listeners) {
      listener(properties)
    }
  }

  #on: StandardEventsOnMethod = <E extends StandardEventsNames>(event: E, listener: StandardEventsListeners[E]) => {
    if (event === 'change') {
      this.#listeners.add(listener)
    }

    return () => this.#listeners.delete(listener)
  }

  #rejectPendingConnect(reason: unknown) {
    if (!this.#pendingConnect) {
      return
    }

    this.#clearPendingConnectTimeout()
    this.#pendingConnect.reject(reason)
    this.#pendingConnect = undefined
  }

  #signAndSendTransaction: SolanaSignAndSendTransactionMethod = async (...inputs) => {
    if (!this.#remoteSession) {
      throw new Error('Remote Wallet is not connected')
    }

    return this.#remoteSession
      .signAndSendTransactions(
        inputs.map((input) => ({
          options: input.options,
          transaction: new Uint8Array(input.transaction),
        })),
      )
      .then((outputs) => outputs.map((output) => ({ signature: output.signature })))
  }

  #signIn: SolanaSignInMethod = async (...inputs) => {
    if (!this.#remoteSession) {
      throw new Error('Remote Wallet is not connected')
    }

    const outputs: RemoteWalletSignInOutput[] = []

    if (inputs.length > 1) {
      for (const input of inputs) {
        outputs.push(await this.#remoteSession.signIn(input))
      }
    } else {
      outputs.push(await this.#remoteSession.signIn(inputs[0]))
    }

    this.#accounts = this.#remoteSession.accounts.map(mapRemoteWalletAccount)
    this.#emit({ accounts: this.#accounts })

    return outputs.map((output) => ({
      account: mapRemoteWalletAccount(output.account),
      signature: output.signature,
      signatureType: output.signatureType,
      signedMessage: output.signedMessage,
    }))
  }

  #signMessage: SolanaSignMessageMethod = async (...inputs) => {
    if (!this.#remoteSession) {
      throw new Error('Remote Wallet is not connected')
    }

    return this.#remoteSession
      .signMessages(
        inputs.map((input) => ({
          message: new Uint8Array(input.message),
          publicKey: new Uint8Array(input.account.publicKey),
        })),
      )
      .then((outputs) =>
        outputs.map((output) => ({
          signature: output.signature,
          signatureType: 'ed25519' as const,
          signedMessage: output.signedMessage,
        })),
      )
  }

  #signTransaction: SolanaSignTransactionMethod = async (...inputs) => {
    if (!this.#remoteSession) {
      throw new Error('Remote Wallet is not connected')
    }

    return this.#remoteSession
      .signTransactions(inputs.map((input) => ({ transaction: new Uint8Array(input.transaction) })))
      .then((outputs) => outputs.map((output) => ({ signedTransaction: output.signedTransaction })))
  }
}

export function RemoteWalletProvider({ children, clusters }: { children: ReactNode; clusters: SolanaCluster[] }) {
  useEffect(() => {
    if (remoteWalletRegistered) {
      return
    }

    remoteWalletRegistered = true
    registerWallet(new RemoteWallet(clusters.map((cluster) => cluster.id)))
  }, [clusters])

  return children
}

function mapRemoteWalletAccount(account: RemoteWalletAuthorizedAccount): WalletAccount {
  return {
    address: account.address,
    chains: account.chains as WalletAccount['chains'],
    features: account.features as WalletAccount['features'],
    icon: account.icon as undefined | WalletIcon,
    label: account.label,
    publicKey: account.publicKey,
  }
}

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { getBase58Decoder, getBase64Decoder, getBase64Encoder } from '@solana/kit'

export const REMOTE_WALLET_PAIRING_TTL_MS = 60_000

const DEFAULT_REMOTE_WALLET_NOSTR_RELAY_DOMAIN = 'relay.damus.io'
const ENCODED_PUBLIC_KEY_LENGTH_BYTES = 65
const INITIALIZATION_VECTOR_BYTES = 12
const NOSTR_EVENT_KIND_MWA = 20012
const REMOTE_WALLET_DEFAULT_ACCOUNT_FEATURES = [
  'solana:signAndSendTransaction',
  'solana:signIn',
  'solana:signMessage',
  'solana:signTransaction',
]
const SEQUENCE_NUMBER_BYTES = 4
const SIGNATURE_LENGTH_IN_BYTES = 64

const base58Decoder = getBase58Decoder()
const base64Decoder = getBase64Decoder()
const base64Encoder = getBase64Encoder()

export interface RemoteWalletAuthorizedAccount {
  address: string
  chains: readonly string[]
  features: readonly string[]
  icon?: string
  label?: string
  publicKey: Uint8Array
}

export interface RemoteWalletAuthorizedSession {
  accounts: readonly RemoteWalletAuthorizedAccount[]
  authToken: string
  chain: string
  close: () => void
  disconnect: () => Promise<void>
  signAndSendTransactions: (
    inputs: readonly RemoteWalletSignAndSendTransactionInput[],
  ) => Promise<readonly RemoteWalletSignAndSendTransactionOutput[]>
  signIn: (input?: RemoteWalletSignInInput) => Promise<RemoteWalletSignInOutput>
  signMessages: (inputs: readonly RemoteWalletSignMessageInput[]) => Promise<readonly RemoteWalletSignMessageOutput[]>
  signTransactions: (
    inputs: readonly RemoteWalletSignTransactionInput[],
  ) => Promise<readonly RemoteWalletSignTransactionOutput[]>
}

export interface RemoteWalletPairingSession {
  associationKeyPair: CryptoKeyPair
  authorizedSession: Promise<RemoteWalletAuthorizedSession>
  chain: string
  close: () => void
  dappNostrPubkey: string
  expiresAt: string
  pairingUrl: string
  relayDomain: string
  sessionIdentifier: string
  status: RemoteWalletPairingStatus
}

export interface RemoteWalletPairingSnapshot {
  session?: RemoteWalletPairingSession
}

export type RemoteWalletPairingStatus = 'authorizing' | 'connected' | 'waiting-for-wallet' | 'wallet-joined'

export interface RemoteWalletSignAndSendTransactionInput {
  options?: RemoteWalletSignAndSendTransactionOptions
  transaction: Uint8Array
}

export interface RemoteWalletSignAndSendTransactionOptions {
  commitment?: string
  maxRetries?: number
  minContextSlot?: number
  skipPreflight?: boolean
}

export interface RemoteWalletSignAndSendTransactionOutput {
  signature: Uint8Array
}

export interface RemoteWalletSignInInput {
  address?: string
  chainId?: string
  domain?: string
  expirationTime?: string
  issuedAt?: string
  nonce?: string
  notBefore?: string
  requestId?: string
  resources?: readonly string[]
  statement?: string
  uri?: string
  version?: string
}

export interface RemoteWalletSignInOutput {
  account: RemoteWalletAuthorizedAccount
  signature: Uint8Array
  signatureType?: 'ed25519'
  signedMessage: Uint8Array
}

export interface RemoteWalletSignMessageInput {
  message: Uint8Array
  publicKey: Uint8Array
}

export interface RemoteWalletSignMessageOutput {
  signature: Uint8Array
  signedMessage: Uint8Array
}

export interface RemoteWalletSignTransactionInput {
  transaction: Uint8Array
}

export interface RemoteWalletSignTransactionOutput {
  signedTransaction: Uint8Array
}

interface NostrEvent {
  content: string
  created_at: number
  id: string
  kind: number
  pubkey: string
  sig: string
  tags: string[][]
}

type ProtocolVersion = 'legacy' | 'v1'

interface RemoteWalletAuthorizationResult {
  accounts: RemoteWalletAuthorizationResultAccount[]
  auth_token: string
  sign_in_result?: RemoteWalletSignInResult
  wallet_icon?: string
  wallet_uri_base?: string
}

interface RemoteWalletAuthorizationResultAccount {
  address: string
  chains?: readonly string[]
  features?: readonly string[]
  icon?: string
  label?: string
}

interface RemoteWalletJsonRpcError {
  code: number
  message: string
}

interface RemoteWalletJsonRpcResponse<TResult> {
  error?: RemoteWalletJsonRpcError
  id: number
  jsonrpc: '2.0'
  result?: TResult
}

type RemoteWalletPairingCancelListener = () => void
type RemoteWalletPairingListener = () => void
interface RemoteWalletSignAndSendTransactionsResult {
  signatures: string[]
}
interface RemoteWalletSignInResult {
  address: string
  signature: string
  signature_type?: string
  signed_message: string
}
interface RemoteWalletSignMessagesResult {
  signed_payloads: string[]
}

interface RemoteWalletSignTransactionsResult {
  signed_payloads: string[]
}

const cancelListeners = new Set<RemoteWalletPairingCancelListener>()
const listeners = new Set<RemoteWalletPairingListener>()
let currentSession: RemoteWalletPairingSession | undefined
let currentSnapshot: RemoteWalletPairingSnapshot = {}

class RemoteWalletRpcClient {
  readonly #getNextJsonRpcMessageId: () => number
  readonly #pendingRequests = new Map<
    number,
    { reject: (reason?: unknown) => void; resolve: (result: unknown) => void }
  >()
  readonly #sendNostrEvent: (content: string, recipientPubkey: string) => void
  readonly #sharedSecret: CryptoKey
  readonly #walletNostrPubkey: string

  constructor({
    getNextJsonRpcMessageId,
    sendNostrEvent,
    sharedSecret,
    walletNostrPubkey,
  }: {
    getNextJsonRpcMessageId: () => number
    sendNostrEvent: (content: string, recipientPubkey: string) => void
    sharedSecret: CryptoKey
    walletNostrPubkey: string
  }) {
    this.#getNextJsonRpcMessageId = getNextJsonRpcMessageId
    this.#sendNostrEvent = sendNostrEvent
    this.#sharedSecret = sharedSecret
    this.#walletNostrPubkey = walletNostrPubkey
  }

  async disconnect(authToken: string) {
    await this.request<Record<string, never>>('deauthorize', { auth_token: authToken })
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    const id = this.#getNextJsonRpcMessageId()
    const binaryMessage = await this.#encryptJsonRpcMessage({ id, jsonrpc: '2.0' as const, method, params })
    const responsePromise = new Promise<TResult>((resolve, reject) => {
      this.#pendingRequests.set(id, {
        reject,
        resolve: (result) => resolve(result as TResult),
      })
    })

    this.#sendNostrEvent(bytesToBase64(binaryMessage), this.#walletNostrPubkey)

    return responsePromise
  }

  async resolveResponse(message: Uint8Array) {
    const response = await this.#decryptJsonRpcMessage(message)
    const pendingRequest = this.#pendingRequests.get(response.id)

    if (!pendingRequest) {
      return
    }

    this.#pendingRequests.delete(response.id)

    if (response.error) {
      pendingRequest.reject(new Error(response.error.message))
      return
    }

    pendingRequest.resolve(response.result)
  }

  async signAndSendTransactions(inputs: readonly RemoteWalletSignAndSendTransactionInput[]) {
    const result = await this.request<RemoteWalletSignAndSendTransactionsResult>('sign_and_send_transactions', {
      ...normalizeRemoteWalletSignAndSendTransactionOptions(inputs),
      payloads: inputs.map((input) => bytesToBase64(input.transaction)),
    })

    return result.signatures.map((signature) => ({ signature: base64ToBytes(signature) }))
  }

  async signIn(chain: string, protocolVersion: ProtocolVersion, input?: RemoteWalletSignInInput) {
    return authorizeRemoteWallet({
      chain,
      protocolVersion,
      rpcClient: this,
      signInPayload: normalizeRemoteWalletSignInPayload(input),
    })
  }

  async signMessages(inputs: readonly RemoteWalletSignMessageInput[]) {
    const result = await this.request<RemoteWalletSignMessagesResult>('sign_messages', {
      addresses: inputs.map((input) => bytesToBase64(input.publicKey)),
      payloads: inputs.map((input) => bytesToBase64(input.message)),
    })

    return result.signed_payloads.map((signedPayload) => {
      const signedMessage = base64ToBytes(signedPayload)

      return { signature: signedMessage.slice(-SIGNATURE_LENGTH_IN_BYTES), signedMessage }
    })
  }

  async signTransactions(inputs: readonly RemoteWalletSignTransactionInput[]) {
    const result = await this.request<RemoteWalletSignTransactionsResult>('sign_transactions', {
      payloads: inputs.map((input) => bytesToBase64(input.transaction)),
    })

    return result.signed_payloads.map((signedPayload) => ({ signedTransaction: base64ToBytes(signedPayload) }))
  }

  async #decryptJsonRpcMessage(message: Uint8Array) {
    const plaintext = await decryptMessage(toArrayBuffer(message), this.#sharedSecret)

    return JSON.parse(plaintext) as RemoteWalletJsonRpcResponse<unknown>
  }

  async #encryptJsonRpcMessage(jsonRpcMessage: { id: number; jsonrpc: '2.0'; method: string; params: unknown }) {
    return encryptMessage(JSON.stringify(jsonRpcMessage), jsonRpcMessage.id, this.#sharedSecret)
  }
}

export function cancelRemoteWalletPairing() {
  currentSession?.close()
  clearRemoteWalletPairing()
  emitRemoteWalletPairingCancel()
}

export function clearRemoteWalletPairing() {
  currentSession = undefined
  currentSnapshot = {}
  emitRemoteWalletPairingChange()
}

export async function createRemoteWalletPairingSession({ chains }: { chains: readonly string[] }) {
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + REMOTE_WALLET_PAIRING_TTL_MS)
  const associationKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const associationPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', associationKeyPair.publicKey))
  const chain = chains[0] ?? 'solana:devnet'
  const relayDomain = getRemoteWalletNostrRelayDomain()
  const sessionIdentifier = await deriveSessionIdentifier(associationKeyPair.publicKey)
  const { privateKey: dappNostrPrivateKey, publicKey: dappNostrPubkey } = generateNostrKeypair()
  const relay = await connectToNostrRelay({
    associationKeyPair,
    chain,
    dappNostrPrivateKey,
    dappNostrPubkey,
    onStatusChange: (status) => {
      setRemoteWalletPairingStatus(status)
    },
    relayDomain,
    sessionIdentifier,
  })

  currentSession = {
    associationKeyPair,
    authorizedSession: relay.authorizedSession,
    chain,
    close: relay.close,
    dappNostrPubkey,
    expiresAt: expiresAt.toISOString(),
    pairingUrl: createNostrAssociationUrl({
      association: base64UrlEncode(associationPublicKey),
      dappNostrPubkey,
      relayDomain,
    }).toString(),
    relayDomain,
    sessionIdentifier,
    status: 'waiting-for-wallet',
  }
  currentSnapshot = { session: currentSession }
  emitRemoteWalletPairingChange()

  return currentSession
}

export function getRemoteWalletPairingSnapshot(): RemoteWalletPairingSnapshot {
  return currentSnapshot
}

export function subscribeRemoteWalletPairing(listener: RemoteWalletPairingListener) {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

export function subscribeRemoteWalletPairingCancel(listener: RemoteWalletPairingCancelListener) {
  cancelListeners.add(listener)

  return () => cancelListeners.delete(listener)
}

async function authorizeRemoteWallet({
  chain,
  protocolVersion,
  rpcClient,
  signInPayload,
}: {
  chain: string
  protocolVersion: ProtocolVersion
  rpcClient: RemoteWalletRpcClient
  signInPayload?: RemoteWalletSignInInput
}) {
  const legacyCluster = chainToLegacyCluster(chain)

  return rpcClient.request<RemoteWalletAuthorizationResult>('authorize', {
    ...(protocolVersion === 'legacy' && legacyCluster ? { cluster: legacyCluster } : null),
    chain,
    identity: {
      name: document.title || 'Wallet UI Remote POC',
      uri: window.location.origin,
    },
    ...(signInPayload ? { sign_in_payload: signInPayload } : null),
  })
}

function base64ToBytes(base64: string) {
  return new Uint8Array(base64Encoder.encode(base64))
}

function base64UrlEncode(bytes: Uint8Array) {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function bytesToBase58(bytes: Uint8Array) {
  return base58Decoder.decode(bytes)
}

function bytesToBase64(bytes: Uint8Array) {
  return base64Decoder.decode(bytes)
}

function chainToLegacyCluster(chain: string) {
  switch (chain) {
    case 'solana:devnet':
      return 'devnet'
    case 'solana:mainnet':
      return 'mainnet-beta'
    case 'solana:testnet':
      return 'testnet'
    default:
      return undefined
  }
}

function computeNostrEventId(pubkey: string, createdAt: number, kind: number, tags: string[][], content: string) {
  const serializedEvent = JSON.stringify([0, pubkey, createdAt, kind, tags, content])

  return bytesToHex(sha256(new TextEncoder().encode(serializedEvent)))
}

function connectToNostrRelay({
  associationKeyPair,
  chain,
  dappNostrPrivateKey,
  dappNostrPubkey,
  onStatusChange,
  relayDomain,
  sessionIdentifier,
}: {
  associationKeyPair: CryptoKeyPair
  chain: string
  dappNostrPrivateKey: Uint8Array
  dappNostrPubkey: string
  onStatusChange: (status: RemoteWalletPairingStatus) => void
  relayDomain: string
  sessionIdentifier: string
}) {
  return new Promise<{
    authorizedSession: Promise<RemoteWalletAuthorizedSession>
    close: () => void
  }>((resolve, reject) => {
    const authorization = createRemoteWalletAuthorizationPromise()
    const socket = new WebSocket(`wss://${relayDomain}`)
    const subscriptionId = crypto.randomUUID()
    let lastKnownInboundSequenceNumber = 0
    let nextJsonRpcMessageId = 1
    let closeRequested = false
    let settled = false
    let state:
      | { ecdhPrivateKey: CryptoKey; type: 'hello-req-sent'; walletNostrPubkey: string }
      | { rpcClient: RemoteWalletRpcClient; type: 'connected'; walletNostrPubkey: string }
      | { type: 'subscribed' }
      | { type: 'waiting-for-subscription' } = { type: 'waiting-for-subscription' }
    let walletNostrPubkey: string | undefined
    const timeoutId = window.setTimeout(() => {
      cleanup()
      socket.close()
      reject(new Error(`Timed out connecting to Nostr relay ${relayDomain}`))
    }, REMOTE_WALLET_PAIRING_TTL_MS)
    const sendNostrEvent = (content: string, recipientPubkey: string, extraTags: string[][] = []) => {
      const event = createNostrEvent(
        NOSTR_EVENT_KIND_MWA,
        content,
        [['d', sessionIdentifier], ['p', recipientPubkey], ...extraTags],
        dappNostrPrivateKey,
      )

      socket.send(JSON.stringify(['EVENT', event]))
    }
    const close = () => {
      if (closeRequested) {
        return
      }

      closeRequested = true

      if (walletNostrPubkey && socket.readyState === WebSocket.OPEN) {
        sendNostrEvent('', walletNostrPubkey, [['msg', 'SESSION_END']])
        window.setTimeout(() => socket.close(), 250)
      } else {
        socket.close()
      }

      cleanup()
      authorization.reject(new Error('Remote Wallet session closed'))
    }
    const cleanup = () => {
      window.clearTimeout(timeoutId)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('open', handleOpen)
    }
    const resolveSubscription = () => {
      if (settled) {
        return
      }

      settled = true
      state = { type: 'subscribed' }
      window.clearTimeout(timeoutId)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('open', handleOpen)
      resolve({
        authorizedSession: authorization.promise,
        close,
      })
    }
    const handleClose = () => {
      if (!settled) {
        cleanup()
        reject(new Error(`Nostr relay ${relayDomain} closed before subscribing`))
      }
    }
    const handleError = () => {
      if (!settled) {
        cleanup()
        reject(new Error(`Failed to connect to Nostr relay ${relayDomain}`))
      }
    }
    const handleOpen = () => {
      socket.send(JSON.stringify(['REQ', subscriptionId, { '#d': [sessionIdentifier], kinds: [NOSTR_EVENT_KIND_MWA] }]))
    }
    const handleMessage = async (event: MessageEvent<string>) => {
      const message = parseNostrRelayMessage(event.data)

      if (message?.[0] === 'EOSE' && message[1] === subscriptionId) {
        resolveSubscription()
        return
      }

      if (message?.[0] !== 'EVENT') {
        return
      }

      const nostrEvent = message[2]

      if (!isNostrEvent(nostrEvent) || !verifyNostrEvent(nostrEvent)) {
        return
      }

      const eventTags = getNostrEventTags(nostrEvent)

      if (
        nostrEvent.kind !== NOSTR_EVENT_KIND_MWA ||
        eventTags.d?.[0] !== sessionIdentifier ||
        !eventTags.p?.includes(dappNostrPubkey)
      ) {
        return
      }

      try {
        switch (state.type) {
          case 'connected': {
            if (nostrEvent.pubkey !== state.walletNostrPubkey || nostrEvent.content.length === 0) {
              return
            }

            const responsePayload = base64ToBytes(nostrEvent.content)
            const sequenceNumber = getSequenceNumber(responsePayload)

            if (sequenceNumber !== lastKnownInboundSequenceNumber + 1) {
              throw new Error('Encrypted message has invalid sequence number')
            }

            lastKnownInboundSequenceNumber = sequenceNumber
            await state.rpcClient.resolveResponse(responsePayload)
            break
          }
          case 'hello-req-sent': {
            if (nostrEvent.pubkey !== state.walletNostrPubkey || nostrEvent.content.length === 0) {
              return
            }

            const responsePayload = base64ToBytes(nostrEvent.content)
            const responseBuffer = toArrayBuffer(responsePayload)
            const sharedSecret = await parseHelloRsp(responseBuffer, associationKeyPair.publicKey, state.ecdhPrivateKey)
            const sessionPropertiesBuffer = responseBuffer.slice(ENCODED_PUBLIC_KEY_LENGTH_BYTES)
            const protocolVersion =
              sessionPropertiesBuffer.byteLength !== 0
                ? await (async () => {
                    const sequenceNumber = getSequenceNumber(sessionPropertiesBuffer)

                    if (sequenceNumber !== lastKnownInboundSequenceNumber + 1) {
                      throw new Error('Encrypted session properties have invalid sequence number')
                    }

                    lastKnownInboundSequenceNumber = sequenceNumber
                    return parseSessionProtocolVersion(sessionPropertiesBuffer, sharedSecret)
                  })()
                : 'legacy'

            onStatusChange('authorizing')
            const rpcClient = new RemoteWalletRpcClient({
              getNextJsonRpcMessageId: () => nextJsonRpcMessageId++,
              sendNostrEvent,
              sharedSecret,
              walletNostrPubkey: state.walletNostrPubkey,
            })

            state = { rpcClient, type: 'connected', walletNostrPubkey: state.walletNostrPubkey }

            const authorizationResult = await authorizeRemoteWallet({
              chain,
              protocolVersion,
              rpcClient,
            })
            let accounts = authorizationResult.accounts.map((account) => mapRemoteWalletAccount(account, chain))
            let authToken = authorizationResult.auth_token

            onStatusChange('connected')
            authorization.resolve({
              get accounts() {
                return accounts
              },
              get authToken() {
                return authToken
              },
              chain,
              close,
              disconnect: async () => {
                try {
                  await rpcClient.disconnect(authToken)
                } finally {
                  close()
                }
              },
              signAndSendTransactions: (inputs) => rpcClient.signAndSendTransactions(inputs),
              signIn: async (input) => {
                const signInAuthorizationResult = await rpcClient.signIn(chain, protocolVersion, input)
                const signInResult = signInAuthorizationResult.sign_in_result

                if (!signInResult) {
                  throw new Error('Sign in failed, no sign in result returned by wallet')
                }

                if (signInResult.signature_type && signInResult.signature_type !== 'ed25519') {
                  throw new Error(`Unsupported Sign In signature type: ${signInResult.signature_type}`)
                }

                accounts = signInAuthorizationResult.accounts.map((account) => mapRemoteWalletAccount(account, chain))
                authToken = signInAuthorizationResult.auth_token

                return {
                  account: getRemoteWalletAuthorizedAccount(accounts, signInResult.address, chain),
                  signature: base64ToBytes(signInResult.signature),
                  signatureType: signInResult.signature_type === 'ed25519' ? 'ed25519' : undefined,
                  signedMessage: base64ToBytes(signInResult.signed_message),
                }
              },
              signMessages: (inputs) => rpcClient.signMessages(inputs),
              signTransactions: (inputs) => rpcClient.signTransactions(inputs),
            })
            break
          }
          case 'subscribed': {
            if (nostrEvent.content.length !== 0) {
              return
            }

            walletNostrPubkey = nostrEvent.pubkey
            onStatusChange('wallet-joined')

            const ecdhKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
              'deriveBits',
            ])
            const helloReq = await createHelloReq(ecdhKeyPair.publicKey, associationKeyPair.privateKey)

            sendNostrEvent(bytesToBase64(helloReq), walletNostrPubkey)
            state = { ecdhPrivateKey: ecdhKeyPair.privateKey, type: 'hello-req-sent', walletNostrPubkey }
            break
          }
          case 'waiting-for-subscription':
            break
        }
      } catch (error) {
        authorization.reject(error)
        close()
      }
    }

    socket.addEventListener('close', handleClose)
    socket.addEventListener('error', handleError)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('open', handleOpen)
  })
}

async function createHelloReq(ecdhPublicKey: CryptoKey, associationKeypairPrivateKey: CryptoKey) {
  const publicKeyBuffer = await crypto.subtle.exportKey('raw', ecdhPublicKey)
  const signatureBuffer = await crypto.subtle.sign(
    { hash: 'SHA-256', name: 'ECDSA' },
    associationKeypairPrivateKey,
    publicKeyBuffer,
  )
  const response = new Uint8Array(publicKeyBuffer.byteLength + signatureBuffer.byteLength)

  response.set(new Uint8Array(publicKeyBuffer), 0)
  response.set(new Uint8Array(signatureBuffer), publicKeyBuffer.byteLength)

  return response
}

function createNostrAssociationUrl({
  association,
  dappNostrPubkey,
  relayDomain,
}: {
  association: string
  dappNostrPubkey: string
  relayDomain: string
}) {
  const url = new URL('solana-wallet:/v1/associate/remote/nostr')
  url.searchParams.set('association', association)
  url.searchParams.set('relay', relayDomain)
  url.searchParams.set('pubkey', dappNostrPubkey)
  url.searchParams.set('v', 'v1')

  return url
}

function createNostrEvent(kind: number, content: string, tags: string[][], privateKey: Uint8Array): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey))
  const createdAt = Math.floor(Date.now() / 1000)
  const id = computeNostrEventId(pubkey, createdAt, kind, tags, content)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privateKey))

  return { content, created_at: createdAt, id, kind, pubkey, sig, tags }
}

function createRemoteWalletAuthorizationPromise() {
  let rejectAuthorization!: (reason?: unknown) => void
  let resolveAuthorization!: (session: RemoteWalletAuthorizedSession) => void
  const promise = new Promise<RemoteWalletAuthorizedSession>((resolve, reject) => {
    rejectAuthorization = reject
    resolveAuthorization = resolve
  })

  return {
    promise,
    reject: rejectAuthorization,
    resolve: resolveAuthorization,
  }
}

function createSequenceNumberVector(sequenceNumber: number): Uint8Array {
  if (sequenceNumber >= 4294967296) {
    throw new Error('Outbound sequence number overflow. The maximum sequence number is 32-bytes.')
  }

  const byteArray = new ArrayBuffer(SEQUENCE_NUMBER_BYTES)
  const view = new DataView(byteArray)

  view.setUint32(0, sequenceNumber, false)

  return new Uint8Array(byteArray)
}

async function decryptMessage(message: ArrayBuffer, sharedSecret: CryptoKey) {
  const sequenceNumberVector = message.slice(0, SEQUENCE_NUMBER_BYTES)
  const initializationVector = message.slice(SEQUENCE_NUMBER_BYTES, SEQUENCE_NUMBER_BYTES + INITIALIZATION_VECTOR_BYTES)
  const ciphertext = message.slice(SEQUENCE_NUMBER_BYTES + INITIALIZATION_VECTOR_BYTES)
  const plaintextBuffer = await crypto.subtle.decrypt(
    getEncryptionAlgorithmParams(sequenceNumberVector, initializationVector),
    sharedSecret,
    ciphertext,
  )

  return new TextDecoder('utf-8').decode(plaintextBuffer)
}

async function deriveSessionIdentifier(associationPublicKey: CryptoKey) {
  const rawKey = await crypto.subtle.exportKey('raw', associationPublicKey)

  return bytesToHex(sha256(new Uint8Array(rawKey)))
}

function emitRemoteWalletPairingCancel() {
  for (const listener of cancelListeners) {
    listener()
  }
}

function emitRemoteWalletPairingChange() {
  for (const listener of listeners) {
    listener()
  }
}

async function encryptMessage(plaintext: string, sequenceNumber: number, sharedSecret: CryptoKey) {
  const sequenceNumberVector = createSequenceNumberVector(sequenceNumber)
  const initializationVector = new Uint8Array(INITIALIZATION_VECTOR_BYTES)

  crypto.getRandomValues(initializationVector)

  const ciphertext = await crypto.subtle.encrypt(
    getEncryptionAlgorithmParams(sequenceNumberVector, initializationVector),
    sharedSecret,
    new TextEncoder().encode(plaintext),
  )
  const response = new Uint8Array(
    sequenceNumberVector.byteLength + initializationVector.byteLength + ciphertext.byteLength,
  )

  response.set(new Uint8Array(sequenceNumberVector), 0)
  response.set(new Uint8Array(initializationVector), sequenceNumberVector.byteLength)
  response.set(new Uint8Array(ciphertext), sequenceNumberVector.byteLength + initializationVector.byteLength)

  return response
}

function generateNostrKeypair(): { privateKey: Uint8Array; publicKey: string } {
  const privateKey = schnorr.utils.randomSecretKey()
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey))

  return { privateKey, publicKey }
}

function getEncryptionAlgorithmParams(
  sequenceNumber: ArrayBuffer | Uint8Array,
  initializationVector: ArrayBuffer | Uint8Array,
) {
  return {
    additionalData: sequenceNumber,
    iv: initializationVector,
    name: 'AES-GCM',
    tagLength: 128,
  }
}

function getNostrEventTags(event: NostrEvent) {
  const tags: Record<string, string[]> = {}

  for (const [name, value] of event.tags) {
    if (!name || !value) {
      continue
    }

    tags[name] = [...(tags[name] ?? []), value]
  }

  return tags
}

function getRemoteWalletAuthorizedAccount(
  accounts: readonly RemoteWalletAuthorizedAccount[],
  encodedAddress: string,
  chain: string,
) {
  const publicKey = base64ToBytes(encodedAddress)
  const account = accounts.find((account) => uint8ArraysEqual(account.publicKey, publicKey))

  if (account) {
    return account
  }

  return {
    address: bytesToBase58(publicKey),
    chains: [chain],
    features: REMOTE_WALLET_DEFAULT_ACCOUNT_FEATURES,
    publicKey,
  }
}

function getRemoteWalletNostrRelayDomain() {
  const relayDomain = import.meta.env.VITE_REMOTE_WALLET_NOSTR_RELAY_DOMAIN

  if (relayDomain) {
    return relayDomain
  }

  const legacyRelayUrl = import.meta.env.VITE_REMOTE_WALLET_RELAY_URL

  if (legacyRelayUrl) {
    return new URL(legacyRelayUrl).host
  }

  return DEFAULT_REMOTE_WALLET_NOSTR_RELAY_DOMAIN
}

function getSequenceNumber(message: ArrayBuffer | Uint8Array) {
  const buffer = message instanceof Uint8Array ? toArrayBuffer(message) : message
  const view = new DataView(buffer, 0, SEQUENCE_NUMBER_BYTES)

  return view.getUint32(0, false)
}

function isNostrEvent(event: unknown): event is NostrEvent {
  if (!event || typeof event !== 'object') {
    return false
  }

  const candidate = event as NostrEvent

  return (
    typeof candidate.content === 'string' &&
    typeof candidate.created_at === 'number' &&
    typeof candidate.id === 'string' &&
    typeof candidate.kind === 'number' &&
    typeof candidate.pubkey === 'string' &&
    typeof candidate.sig === 'string' &&
    Array.isArray(candidate.tags)
  )
}

function mapRemoteWalletAccount(
  account: RemoteWalletAuthorizationResultAccount,
  chain: string,
): RemoteWalletAuthorizedAccount {
  const publicKey = base64ToBytes(account.address)

  return {
    address: bytesToBase58(publicKey),
    chains: account.chains ?? [chain],
    features: account.features ?? REMOTE_WALLET_DEFAULT_ACCOUNT_FEATURES,
    icon: account.icon,
    label: account.label,
    publicKey,
  }
}

function normalizeRemoteWalletSignAndSendTransactionOptions(
  inputs: readonly RemoteWalletSignAndSendTransactionInput[],
) {
  const options = inputs[0]?.options

  if (!options) {
    return {}
  }

  const normalizedOptions = {
    commitment: options.commitment,
    max_retries: options.maxRetries,
    min_context_slot: options.minContextSlot,
    skip_preflight: options.skipPreflight,
  }

  return Object.values(normalizedOptions).some((option) => option !== undefined) ? { options: normalizedOptions } : {}
}

function normalizeRemoteWalletSignInPayload(input?: RemoteWalletSignInInput): RemoteWalletSignInInput {
  return {
    ...(input ?? {}),
    domain: input?.domain ?? window.location.host,
  }
}

async function parseHelloRsp(payloadBuffer: ArrayBuffer, associationPublicKey: CryptoKey, ecdhPrivateKey: CryptoKey) {
  const [associationPublicKeyBuffer, walletPublicKey] = await Promise.all([
    crypto.subtle.exportKey('raw', associationPublicKey),
    crypto.subtle.importKey(
      'raw',
      payloadBuffer.slice(0, ENCODED_PUBLIC_KEY_LENGTH_BYTES),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    ),
  ])
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: walletPublicKey }, ecdhPrivateKey, 256)
  const ecdhSecretKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])

  return crypto.subtle.deriveKey(
    {
      hash: 'SHA-256',
      info: new Uint8Array(),
      name: 'HKDF',
      salt: new Uint8Array(associationPublicKeyBuffer),
    },
    ecdhSecretKey,
    { length: 128, name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

function parseNostrRelayMessage(message: string): undefined | unknown[] {
  try {
    const parsedMessage: unknown = JSON.parse(message)

    return Array.isArray(parsedMessage) ? parsedMessage : undefined
  } catch {
    return undefined
  }
}

async function parseSessionProtocolVersion(message: ArrayBuffer, sharedSecret: CryptoKey): Promise<ProtocolVersion> {
  const plaintext = await decryptMessage(message, sharedSecret)
  const jsonProperties = JSON.parse(plaintext) as { v?: unknown }

  switch (jsonProperties.v) {
    case 1:
    case '1':
    case 'v1':
      return 'v1'
    case 'legacy':
    case undefined:
      return 'legacy'
    default:
      throw new Error(`Unknown/unsupported protocol version: ${String(jsonProperties.v)}`)
  }
}

function setRemoteWalletPairingStatus(status: RemoteWalletPairingStatus) {
  if (!currentSession) {
    return
  }

  currentSession = { ...currentSession, status }
  currentSnapshot = { session: currentSession }
  emitRemoteWalletPairingChange()
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new Uint8Array(bytes.byteLength)

  buffer.set(bytes)

  return buffer.buffer
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) {
    return false
  }

  return a.every((value, index) => value === b[index])
}

function verifyNostrEvent(event: NostrEvent): boolean {
  const expectedId = computeNostrEventId(event.pubkey, event.created_at, event.kind, event.tags, event.content)

  if (expectedId !== event.id) {
    return false
  }

  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
  } catch {
    return false
  }
}

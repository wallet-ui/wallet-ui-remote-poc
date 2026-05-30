import { ed25519 } from '@noble/curves/ed25519.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionCodec,
  type SignatureBytes,
} from '@solana/kit'
import { Command } from 'commander'
import process from 'node:process'

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

interface CliOptions {
  chain?: string
  label: string
  printSecret: boolean
  rpcUrl?: string
  secretKey?: string
  timeout: string
  url?: string
}

interface JsonRpcError {
  code: number
  message: string
}

interface JsonRpcRequest {
  id: number
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  error?: JsonRpcError
  id: number
  jsonrpc: '2.0'
  result?: unknown
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

interface PairingDetails {
  associationPublicKey: Uint8Array
  dappNostrPubkey: string
  relayDomain: string
  relayUrl: string
  sessionIdentifier: string
}

interface RemoteWalletAccount {
  address: string
  chains: string[]
  features: string[]
  label: string
}

interface RemoteWalletState {
  authToken: string
  chain: string
  label: string
  publicKey: Uint8Array
  publicKeyBase58: string
  publicKeyBase64: string
  rpcUrl?: string
  secretKey: Uint8Array
}

interface SignAndSendTransactionOptions {
  commitment?: string
  maxRetries?: number
  minContextSlot?: number
  skipPreflight?: boolean
  waitForCommitmentToSendNextTransaction?: boolean
}

const base58Decoder = getBase58Decoder()
const base58Encoder = getBase58Encoder()
const base64Decoder = getBase64Decoder()
const base64Encoder = getBase64Encoder()
const transactionCodec = getTransactionCodec()

type SessionState =
  | {
      lastInboundSequenceNumber: number
      lastOutboundSequenceNumber: number
      sharedSecret: CryptoKey
      type: 'connected'
    }
  | { type: 'waiting-for-hello' }

interface SignInPayload {
  address?: string
  chainId?: string
  domain?: string
  expirationTime?: string
  issuedAt?: string
  nonce?: string
  notBefore?: string
  requestId?: string
  resources?: string[]
  statement?: string
  uri?: string
  version?: string
}

const program = new Command()
  .name('remote-wallet')
  .description('Quick-and-dirty Nostr remote wallet for the wallet-ui remote POC')
  .argument('[pairing-url]', 'solana-wallet pairing URL copied from the Remote Wallet modal')
  .option('--chain <chain>', 'fallback Solana chain if the dapp omits one', 'solana:devnet')
  .option('--label <label>', 'wallet label returned to the dapp', 'CLI Remote Wallet')
  .option('--print-secret', 'include the generated or supplied Ed25519 secret key in the wallet JSON event', false)
  .option('--rpc-url <rpcUrl>', 'Solana JSON-RPC URL used for sign_and_send_transactions')
  .option('--secret-key <secretKey>', 'Ed25519 secret key as base64 or hex; 32-byte and Solana 64-byte forms work')
  .option('--timeout <milliseconds>', 'milliseconds to wait for the session handshake', '60000')
  .option('--url <pairingUrl>', 'solana-wallet pairing URL copied from the Remote Wallet modal')

program.action(async (pairingUrl: string | undefined, options: CliOptions) => {
  try {
    await runRemoteWallet(options.url ?? pairingUrl, options)
  } catch (error) {
    writeJson('error', { message: getErrorMessage(error) })
    process.exitCode = 1
  }
})

await program.parseAsync()

function base58ToBytes(base58: string) {
  return new Uint8Array(base58Encoder.encode(base58))
}

function base64ToBytes(base64: string) {
  return new Uint8Array(base64Encoder.encode(base64))
}

function base64UrlToBytes(value: string) {
  const normalizedValue = value.replaceAll('-', '+').replaceAll('_', '/')
  const paddedValue = normalizedValue.padEnd(Math.ceil(normalizedValue.length / 4) * 4, '=')

  return base64ToBytes(paddedValue)
}

function bytesToBase58(bytes: Uint8Array) {
  return base58Decoder.decode(bytes)
}

function bytesToBase64(bytes: Uint8Array) {
  return base64Decoder.decode(bytes)
}

function computeNostrEventId(pubkey: string, createdAt: number, kind: number, tags: string[][], content: string) {
  const serializedEvent = JSON.stringify([0, pubkey, createdAt, kind, tags, content])

  return bytesToHex(sha256(new TextEncoder().encode(serializedEvent)))
}

function concatBytes(...chunks: Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }

  return result
}

async function connectRemoteWalletSession({
  pairing,
  timeoutMs,
  wallet,
}: {
  pairing: PairingDetails
  timeoutMs: number
  wallet: RemoteWalletState
}) {
  const nostrPrivateKey = schnorr.utils.randomSecretKey()
  const walletNostrPubkey = bytesToHex(schnorr.getPublicKey(nostrPrivateKey))
  const subscriptionId = crypto.randomUUID()
  const socket = new WebSocket(pairing.relayUrl)
  let closed = false
  let state: SessionState = { type: 'waiting-for-hello' }

  writeJson('relay-connecting', {
    relayDomain: pairing.relayDomain,
    relayUrl: pairing.relayUrl,
    sessionIdentifier: pairing.sessionIdentifier,
    walletNostrPubkey,
  })

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      closeSocket()
      reject(new Error(`Timed out waiting for dapp handshake after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeoutId)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('open', handleOpen)
    }
    const closeSocket = () => {
      if (closed) {
        return
      }

      closed = true
      socket.close()
    }
    const sendNostrEvent = (content: string, recipientPubkey: string, extraTags: string[][] = []) => {
      const nostrEvent = createNostrEvent(
        NOSTR_EVENT_KIND_MWA,
        content,
        [['d', pairing.sessionIdentifier], ['p', recipientPubkey], ...extraTags],
        nostrPrivateKey,
      )

      socket.send(JSON.stringify(['EVENT', nostrEvent]))
    }
    const sendJsonRpcResponse = async (request: JsonRpcRequest, response: Omit<JsonRpcResponse, 'id' | 'jsonrpc'>) => {
      if (state.type !== 'connected') {
        throw new Error('Cannot send JSON-RPC response before the encrypted session is connected')
      }

      const nextSequenceNumber = state.lastOutboundSequenceNumber + 1
      const binaryMessage = await encryptMessage(
        JSON.stringify({
          ...response,
          id: request.id,
          jsonrpc: '2.0',
        }),
        nextSequenceNumber,
        state.sharedSecret,
      )

      state = {
        ...state,
        lastOutboundSequenceNumber: nextSequenceNumber,
      }

      sendNostrEvent(bytesToBase64(binaryMessage), pairing.dappNostrPubkey)
    }
    const handleClose = () => {
      cleanup()
      writeJson('relay-closed')
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error(`Failed to connect to Nostr relay ${pairing.relayUrl}`))
    }
    const handleMessage = async (event: MessageEvent<string>) => {
      try {
        const message = parseNostrRelayMessage(event.data)

        if (message?.[0] === 'EOSE' && message[1] === subscriptionId) {
          sendNostrEvent('', pairing.dappNostrPubkey, [['msg', 'CONNECT']])
          writeJson('wallet-joined')
          return
        }

        if (message?.[0] === 'NOTICE') {
          writeJson('relay-notice', { message: String(message[1] ?? '') })
          return
        }

        if (message?.[0] !== 'EVENT') {
          return
        }

        const nostrEvent = message[2]

        if (!isExpectedNostrEvent(nostrEvent, pairing, walletNostrPubkey)) {
          return
        }

        if (nostrEvent.content.length === 0) {
          const tags = getNostrEventTags(nostrEvent)

          if (tags.msg?.includes('SESSION_END')) {
            writeJson('session-ended')
            closeSocket()
          }

          return
        }

        if (state.type === 'waiting-for-hello') {
          const helloResult = await respondToHelloRequest({
            pairing,
            sendNostrEvent,
            walletPayload: base64ToBytes(nostrEvent.content),
          })

          state = {
            lastInboundSequenceNumber: 0,
            lastOutboundSequenceNumber: helloResult.lastOutboundSequenceNumber,
            sharedSecret: helloResult.sharedSecret,
            type: 'connected',
          }
          clearTimeout(timeoutId)
          writeJson('hello-complete')
          return
        }

        const encryptedPayload = base64ToBytes(nostrEvent.content)
        const sequenceNumber = getSequenceNumber(encryptedPayload)

        if (sequenceNumber !== state.lastInboundSequenceNumber + 1) {
          throw new Error(`Invalid inbound sequence number ${sequenceNumber}`)
        }

        state = {
          ...state,
          lastInboundSequenceNumber: sequenceNumber,
        }

        const request = JSON.parse(
          await decryptMessage(toArrayBuffer(encryptedPayload), state.sharedSecret),
        ) as JsonRpcRequest

        writeJson('request', {
          id: request.id,
          method: request.method,
        })

        try {
          const result = await handleJsonRpcRequest(request, wallet)

          await sendJsonRpcResponse(request, { result })

          writeJson('response', {
            id: request.id,
            method: request.method,
          })
        } catch (error) {
          await sendJsonRpcResponse(request, {
            error: {
              code: -32_000,
              message: getErrorMessage(error),
            },
          })

          writeJson('response-error', {
            id: request.id,
            message: getErrorMessage(error),
            method: request.method,
          })
        }
      } catch (error) {
        cleanup()
        closeSocket()
        reject(error)
      }
    }
    const handleOpen = () => {
      socket.send(
        JSON.stringify(['REQ', subscriptionId, { '#d': [pairing.sessionIdentifier], kinds: [NOSTR_EVENT_KIND_MWA] }]),
      )
      writeJson('relay-connected')
    }

    socket.addEventListener('close', handleClose)
    socket.addEventListener('error', handleError)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('open', handleOpen)
  })
}

function createNostrEvent(kind: number, content: string, tags: string[][], privateKey: Uint8Array): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey))
  const createdAt = Math.floor(Date.now() / 1000)
  const id = computeNostrEventId(pubkey, createdAt, kind, tags, content)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privateKey))

  return { content, created_at: createdAt, id, kind, pubkey, sig, tags }
}

function createRemoteWalletAccount(wallet: RemoteWalletState): RemoteWalletAccount {
  return {
    address: wallet.publicKeyBase64,
    chains: [wallet.chain],
    features: REMOTE_WALLET_DEFAULT_ACCOUNT_FEATURES,
    label: wallet.label,
  }
}

function createRemoteWalletState({
  chain,
  label,
  rpcUrl,
  secretKey,
}: {
  chain: string
  label: string
  rpcUrl?: string
  secretKey: Uint8Array
}): RemoteWalletState {
  const publicKey = ed25519.getPublicKey(secretKey)

  return {
    authToken: crypto.randomUUID(),
    chain,
    label,
    publicKey,
    publicKeyBase58: bytesToBase58(publicKey),
    publicKeyBase64: bytesToBase64(publicKey),
    rpcUrl,
    secretKey,
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

function createSignInMessage(input: Required<Pick<SignInPayload, 'address' | 'domain'>> & SignInPayload) {
  let message = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`

  if (input.statement) {
    message += `\n\n${input.statement}`
  }

  const fields: string[] = []

  if (input.uri) {
    fields.push(`URI: ${input.uri}`)
  }

  if (input.version) {
    fields.push(`Version: ${input.version}`)
  }

  if (input.chainId) {
    fields.push(`Chain ID: ${input.chainId}`)
  }

  if (input.nonce) {
    fields.push(`Nonce: ${input.nonce}`)
  }

  if (input.issuedAt) {
    fields.push(`Issued At: ${input.issuedAt}`)
  }

  if (input.expirationTime) {
    fields.push(`Expiration Time: ${input.expirationTime}`)
  }

  if (input.notBefore) {
    fields.push(`Not Before: ${input.notBefore}`)
  }

  if (input.requestId) {
    fields.push(`Request ID: ${input.requestId}`)
  }

  if (input.resources) {
    fields.push('Resources:')

    for (const resource of input.resources) {
      fields.push(`- ${resource}`)
    }
  }

  if (fields.length) {
    message += `\n\n${fields.join('\n')}`
  }

  return new TextEncoder().encode(message)
}

async function decryptMessage(message: ArrayBuffer, sharedSecret: CryptoKey) {
  const ciphertext = message.slice(SEQUENCE_NUMBER_BYTES + INITIALIZATION_VECTOR_BYTES)
  const initializationVector = message.slice(SEQUENCE_NUMBER_BYTES, SEQUENCE_NUMBER_BYTES + INITIALIZATION_VECTOR_BYTES)
  const sequenceNumberVector = message.slice(0, SEQUENCE_NUMBER_BYTES)
  const plaintextBuffer = await crypto.subtle.decrypt(
    getEncryptionAlgorithmParams(sequenceNumberVector, initializationVector),
    sharedSecret,
    ciphertext,
  )

  return new TextDecoder('utf-8').decode(plaintextBuffer)
}

async function deriveSharedSecret({
  associationPublicKey,
  dappEcdhPublicKey,
  walletEcdhPrivateKey,
}: {
  associationPublicKey: Uint8Array
  dappEcdhPublicKey: Uint8Array
  walletEcdhPrivateKey: CryptoKey
}) {
  const dappPublicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(dappEcdhPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: dappPublicKey },
    walletEcdhPrivateKey,
    256,
  )
  const ecdhSecretKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])

  return crypto.subtle.deriveKey(
    {
      hash: 'SHA-256',
      info: new Uint8Array(),
      name: 'HKDF',
      salt: toArrayBuffer(associationPublicKey),
    },
    ecdhSecretKey,
    { length: 128, name: 'AES-GCM' },
    false,
    ['decrypt', 'encrypt'],
  )
}

async function encryptMessage(plaintext: string, sequenceNumber: number, sharedSecret: CryptoKey) {
  const initializationVector = crypto.getRandomValues(new Uint8Array(INITIALIZATION_VECTOR_BYTES))
  const sequenceNumberVector = createSequenceNumberVector(sequenceNumber)
  const ciphertext = await crypto.subtle.encrypt(
    getEncryptionAlgorithmParams(sequenceNumberVector, initializationVector),
    sharedSecret,
    new TextEncoder().encode(plaintext),
  )

  return concatBytes(sequenceNumberVector, initializationVector, new Uint8Array(ciphertext))
}

function getBooleanOption(options: Record<string, unknown>, key: string) {
  const value = options[key]

  return typeof value === 'boolean' ? value : undefined
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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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

function getNumberOption(options: Record<string, unknown>, key: string) {
  const value = options[key]

  return typeof value === 'number' ? value : undefined
}

function getSequenceNumber(message: ArrayBuffer | Uint8Array) {
  const buffer = message instanceof Uint8Array ? toArrayBuffer(message) : message
  const view = new DataView(buffer, 0, SEQUENCE_NUMBER_BYTES)

  return view.getUint32(0, false)
}

function getSignAndSendTransactionOptions(params: unknown): SignAndSendTransactionOptions {
  const rawOptions = isRecord(params) && isRecord(params.options) ? params.options : {}

  return {
    commitment: getStringOption(rawOptions, 'commitment'),
    maxRetries: getNumberOption(rawOptions, 'max_retries'),
    minContextSlot: getNumberOption(rawOptions, 'min_context_slot'),
    skipPreflight: getBooleanOption(rawOptions, 'skip_preflight'),
    waitForCommitmentToSendNextTransaction: getBooleanOption(
      rawOptions,
      'wait_for_commitment_to_send_next_transaction',
    ),
  }
}

function getSolanaRpcUrl(chain: string, rpcUrl?: string) {
  if (rpcUrl) {
    return rpcUrl
  }

  switch (chain) {
    case 'devnet':
    case 'solana:devnet':
      return 'https://api.devnet.solana.com'
    case 'mainnet-beta':
    case 'solana:mainnet':
    case 'solana:mainnet-beta':
      return 'https://api.mainnet-beta.solana.com'
    case 'solana:testnet':
    case 'testnet':
      return 'https://api.testnet.solana.com'
    default:
      throw new Error(`No default RPC URL for chain ${chain}. Pass --rpc-url to the CLI wallet.`)
  }
}

function getStringOption(options: Record<string, unknown>, key: string) {
  const value = options[key]

  return typeof value === 'string' ? value : undefined
}

function getWalletSecretKey(secretKeyOption?: string) {
  if (!secretKeyOption) {
    return ed25519.utils.randomSecretKey()
  }

  const secretKey = parseEncodedBytes(secretKeyOption)

  if (secretKey.byteLength === 32) {
    return secretKey
  }

  if (secretKey.byteLength === 64) {
    return secretKey.slice(0, 32)
  }

  throw new Error(`Expected 32-byte or 64-byte Ed25519 secret key, received ${secretKey.byteLength} bytes`)
}

async function handleAuthorizeRequest(params: unknown, wallet: RemoteWalletState) {
  const authorizeParams = isRecord(params) ? params : {}
  const chain = typeof authorizeParams.chain === 'string' ? authorizeParams.chain : wallet.chain
  const signInPayload = isRecord(authorizeParams.sign_in_payload)
    ? normalizeSignInPayload(authorizeParams.sign_in_payload, { chain, wallet })
    : undefined
  const account = createRemoteWalletAccount({ ...wallet, chain })

  wallet.authToken = crypto.randomUUID()
  wallet.chain = chain

  return {
    accounts: [account],
    auth_token: wallet.authToken,
    ...(signInPayload
      ? {
          sign_in_result: signSignInPayload(signInPayload, wallet),
        }
      : null),
  }
}

async function handleJsonRpcRequest(request: JsonRpcRequest, wallet: RemoteWalletState) {
  switch (request.method) {
    case 'authorize':
      return handleAuthorizeRequest(request.params, wallet)
    case 'deauthorize':
      return {}
    case 'get_capabilities':
      return {
        features: REMOTE_WALLET_DEFAULT_ACCOUNT_FEATURES,
        max_messages_per_request: 10,
        max_transactions_per_request: 10,
        supported_transaction_versions: ['legacy', 0],
        supports_clone_authorization: false,
        supports_sign_and_send_transactions: true,
      }
    case 'sign_and_send_transactions':
      return handleSignAndSendTransactionsRequest(request.params, wallet)
    case 'sign_messages':
      return handleSignMessagesRequest(request.params, wallet)
    case 'sign_transactions':
      return handleSignTransactionsRequest(request.params, wallet)
    default:
      throw new Error(`Unsupported JSON-RPC method: ${request.method}`)
  }
}

async function handleSignAndSendTransactionsRequest(params: unknown, wallet: RemoteWalletState) {
  const signedTransactions = await signTransactionPayloads(params, wallet, 'sign_and_send_transactions')
  const options = getSignAndSendTransactionOptions(params)
  const rpcUrl = getSolanaRpcUrl(wallet.chain, wallet.rpcUrl)
  const signatures: string[] = []

  for (const signedTransaction of signedTransactions) {
    const signature = await sendSignedTransaction({
      options,
      rpcUrl,
      signedTransaction: signedTransaction.signedTransaction,
    })

    signatures.push(bytesToBase64(base58ToBytes(signature)))
  }

  return { signatures }
}

function handleSignMessagesRequest(params: unknown, wallet: RemoteWalletState) {
  if (!isRecord(params) || !Array.isArray(params.payloads)) {
    throw new Error('sign_messages params must include payloads')
  }

  const addresses = Array.isArray(params.addresses) ? params.addresses : []

  return {
    signed_payloads: params.payloads.map((payload, index) => {
      if (typeof payload !== 'string') {
        throw new Error('sign_messages payloads must be base64 strings')
      }

      const address = addresses[index]

      if (typeof address === 'string' && address !== wallet.publicKeyBase64) {
        throw new Error(`Cannot sign for unknown address at index ${index}`)
      }

      const message = base64ToBytes(payload)
      const signature = ed25519.sign(message, wallet.secretKey)

      return bytesToBase64(concatBytes(message, signature))
    }),
  }
}

async function handleSignTransactionsRequest(params: unknown, wallet: RemoteWalletState) {
  const signedTransactions = await signTransactionPayloads(params, wallet, 'sign_transactions')

  return {
    signed_payloads: signedTransactions.map(({ signedTransaction }) => bytesToBase64(signedTransaction)),
  }
}

function isExpectedNostrEvent(event: unknown, pairing: PairingDetails, walletNostrPubkey: string): event is NostrEvent {
  if (!isNostrEvent(event) || !verifyNostrEvent(event)) {
    return false
  }

  const tags = getNostrEventTags(event)

  return (
    event.kind === NOSTR_EVENT_KIND_MWA &&
    event.pubkey === pairing.dappNostrPubkey &&
    tags.d?.[0] === pairing.sessionIdentifier &&
    Boolean(tags.p?.includes(walletNostrPubkey))
  )
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeRelayUrl(relay: string) {
  if (relay.startsWith('ws://') || relay.startsWith('wss://')) {
    return relay
  }

  return `wss://${relay}`
}

function normalizeSignInPayload(
  payload: Record<string, unknown>,
  { chain, wallet }: { chain: string; wallet: RemoteWalletState },
): Required<Pick<SignInPayload, 'address' | 'domain'>> & SignInPayload {
  return {
    address: typeof payload.address === 'string' ? payload.address : wallet.publicKeyBase58,
    chainId: typeof payload.chainId === 'string' ? payload.chainId : chain,
    domain: typeof payload.domain === 'string' ? payload.domain : 'localhost',
    expirationTime: typeof payload.expirationTime === 'string' ? payload.expirationTime : undefined,
    issuedAt: typeof payload.issuedAt === 'string' ? payload.issuedAt : undefined,
    nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
    notBefore: typeof payload.notBefore === 'string' ? payload.notBefore : undefined,
    requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
    resources: Array.isArray(payload.resources)
      ? payload.resources.filter((resource) => typeof resource === 'string')
      : undefined,
    statement: typeof payload.statement === 'string' ? payload.statement : undefined,
    uri: typeof payload.uri === 'string' ? payload.uri : undefined,
    version: typeof payload.version === 'string' ? payload.version : '1',
  }
}

function parseEncodedBytes(value: string) {
  const normalizedValue = value.trim()

  if (/^[\da-f]+$/i.test(normalizedValue) && normalizedValue.length % 2 === 0) {
    return hexToBytes(normalizedValue)
  }

  return base64ToBytes(normalizedValue)
}

function parseNostrRelayMessage(message: string): undefined | unknown[] {
  try {
    const parsedMessage: unknown = JSON.parse(message)

    return Array.isArray(parsedMessage) ? parsedMessage : undefined
  } catch {
    return undefined
  }
}

function parsePairingUrl(pairingUrl: string): PairingDetails {
  const url = new URL(pairingUrl)
  const association = url.searchParams.get('association')
  const dappNostrPubkey = url.searchParams.get('pubkey')
  const relay = url.searchParams.get('relay')

  if (!association) {
    throw new Error('Pairing URL is missing association')
  }

  if (!dappNostrPubkey) {
    throw new Error('Pairing URL is missing pubkey')
  }

  if (!relay) {
    throw new Error('Pairing URL is missing relay')
  }

  const associationPublicKey = base64UrlToBytes(association)
  const relayUrl = normalizeRelayUrl(relay)

  return {
    associationPublicKey,
    dappNostrPubkey,
    relayDomain: new URL(relayUrl).host,
    relayUrl,
    sessionIdentifier: bytesToHex(sha256(associationPublicKey)),
  }
}

async function respondToHelloRequest({
  pairing,
  sendNostrEvent,
  walletPayload,
}: {
  pairing: PairingDetails
  sendNostrEvent: (content: string, recipientPubkey: string, extraTags?: string[][]) => void
  walletPayload: Uint8Array
}) {
  const dappEcdhPublicKey = walletPayload.slice(0, ENCODED_PUBLIC_KEY_LENGTH_BYTES)
  const signature = walletPayload.slice(ENCODED_PUBLIC_KEY_LENGTH_BYTES)

  await verifyAssociationSignature({
    associationPublicKey: pairing.associationPublicKey,
    dappEcdhPublicKey,
    signature,
  })

  const walletEcdhKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const sharedSecret = await deriveSharedSecret({
    associationPublicKey: pairing.associationPublicKey,
    dappEcdhPublicKey,
    walletEcdhPrivateKey: walletEcdhKeyPair.privateKey,
  })
  const walletEcdhPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', walletEcdhKeyPair.publicKey))
  const sessionProperties = await encryptMessage(JSON.stringify({ v: 1 }), 1, sharedSecret)

  sendNostrEvent(bytesToBase64(concatBytes(walletEcdhPublicKey, sessionProperties)), pairing.dappNostrPubkey)

  return {
    lastOutboundSequenceNumber: 1,
    sharedSecret,
  }
}

async function runRemoteWallet(pairingUrl: string | undefined, options: CliOptions) {
  if (!pairingUrl) {
    throw new Error('Missing pairing URL. Pass it as an argument or with --url.')
  }

  const pairing = parsePairingUrl(pairingUrl)
  const secretKey = getWalletSecretKey(options.secretKey)
  const wallet = createRemoteWalletState({
    chain: options.chain ?? 'solana:devnet',
    label: options.label,
    rpcUrl: options.rpcUrl,
    secretKey,
  })

  writeJson('wallet', {
    address: wallet.publicKeyBase58,
    label: wallet.label,
    publicKeyBase64: wallet.publicKeyBase64,
    ...(options.printSecret ? { secretKeyBase64: bytesToBase64(wallet.secretKey) } : null),
  })

  await connectRemoteWalletSession({
    pairing,
    timeoutMs: Number(options.timeout),
    wallet,
  })
}

async function sendSignedTransaction({
  options,
  rpcUrl,
  signedTransaction,
}: {
  options: SignAndSendTransactionOptions
  rpcUrl: string
  signedTransaction: Uint8Array
}) {
  const config: Record<string, boolean | number | string> = {
    encoding: 'base64',
  }

  if (options.commitment) {
    config.preflightCommitment = options.commitment
  }

  if (options.maxRetries !== undefined) {
    config.maxRetries = options.maxRetries
  }

  if (options.minContextSlot !== undefined) {
    config.minContextSlot = options.minContextSlot
  }

  if (options.skipPreflight !== undefined) {
    config.skipPreflight = options.skipPreflight
  }

  const response = await fetch(rpcUrl, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: '2.0',
      method: 'sendTransaction',
      params: [bytesToBase64(signedTransaction), config],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`RPC ${rpcUrl} returned HTTP ${response.status}`)
  }

  const responseBody: unknown = await response.json()

  if (!isRecord(responseBody)) {
    throw new Error(`RPC ${rpcUrl} returned an invalid response`)
  }

  if (isRecord(responseBody.error)) {
    const message = typeof responseBody.error.message === 'string' ? responseBody.error.message : 'Unknown RPC error'

    throw new Error(`RPC sendTransaction failed: ${message}`)
  }

  if (typeof responseBody.result !== 'string') {
    throw new Error(`RPC ${rpcUrl} did not return a transaction signature`)
  }

  writeJson('transaction-sent', {
    rpcUrl,
    signature: responseBody.result,
  })

  return responseBody.result
}

function signSignInPayload(
  payload: Required<Pick<SignInPayload, 'address' | 'domain'>> & SignInPayload,
  wallet: RemoteWalletState,
) {
  const signedMessage = createSignInMessage(payload)
  const signature = ed25519.sign(signedMessage, wallet.secretKey)

  return {
    address: wallet.publicKeyBase64,
    signature: bytesToBase64(signature),
    signature_type: 'ed25519',
    signed_message: bytesToBase64(signedMessage),
  }
}

async function signTransactionPayloads(params: unknown, wallet: RemoteWalletState, method: string) {
  if (!isRecord(params) || !Array.isArray(params.payloads)) {
    throw new Error(`${method} params must include payloads`)
  }

  return Promise.all(
    params.payloads.map(async (payload, index) => {
      if (typeof payload !== 'string') {
        throw new Error(`${method} payloads must be base64 strings`)
      }

      const transaction = transactionCodec.decode(base64ToBytes(payload))

      if (!Object.prototype.hasOwnProperty.call(transaction.signatures, wallet.publicKeyBase58)) {
        throw new Error(`Cannot sign transaction for unknown signer at index ${index}`)
      }

      const signature = ed25519.sign(transaction.messageBytes, wallet.secretKey) as SignatureBytes
      const signedTransaction = {
        ...transaction,
        signatures: {
          ...transaction.signatures,
          [wallet.publicKeyBase58]: signature,
        },
      }

      return {
        signature,
        signedTransaction: new Uint8Array(transactionCodec.encode(signedTransaction)),
      }
    }),
  )
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new Uint8Array(bytes.byteLength)

  buffer.set(bytes)

  return buffer.buffer
}

async function verifyAssociationSignature({
  associationPublicKey,
  dappEcdhPublicKey,
  signature,
}: {
  associationPublicKey: Uint8Array
  dappEcdhPublicKey: Uint8Array
  signature: Uint8Array
}) {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(associationPublicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const verified = await crypto.subtle.verify(
    { hash: 'SHA-256', name: 'ECDSA' },
    publicKey,
    toArrayBuffer(signature),
    toArrayBuffer(dappEcdhPublicKey),
  )

  if (!verified) {
    throw new Error('Invalid association signature in hello request')
  }
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

function writeJson(type: string, payload: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
      type,
    }),
  )
}

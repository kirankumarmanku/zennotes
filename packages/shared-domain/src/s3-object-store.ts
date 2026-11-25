/**
 * The few object-store calls S3 sync needs, and an implementation that talks
 * to Amazon S3 (or an S3-compatible service) over plain `fetch`, signed with
 * AWS Signature Version 4. No SDK and no Node globals: Web Crypto, fetch and
 * TextEncoder only, so the same code runs in Electron's main process, the web
 * client and the phone shells' WebView.
 *
 * Sync's correctness rests on conditional writes: `ifNoneMatch: '*'` creates
 * an object only when the key is free, so two devices claiming the same log
 * entry cannot both win. S3 has honoured this since August 2024; an
 * S3-compatible service must too, or sync on it is not safe.
 */

export interface S3StoredObject {
  body: Uint8Array
  etag: string
}

export interface S3PutOptions {
  /** `'*'`: write only when no object has this key yet. */
  ifNoneMatch?: '*'
  /** Write only when the object's current ETag is this one. */
  ifMatch?: string
  contentType?: string
}

export interface S3ObjectStore {
  /** The object, or null when no object has this key. */
  get(key: string): Promise<S3StoredObject | null>
  /** Throws S3PreconditionFailedError when a condition does not hold. */
  put(key: string, body: Uint8Array, options?: S3PutOptions): Promise<{ etag: string }>
  /** Every key under `prefix`, ascending, after `startAfter` when given. */
  list(prefix: string, options?: { startAfter?: string }): Promise<string[]>
}

/** A conditional write lost: another writer got there first. */
export class S3PreconditionFailedError extends Error {
  constructor(readonly key: string) {
    super(`${key} was written by someone else first.`)
    this.name = 'S3PreconditionFailedError'
  }
}

/** Any other answer S3 gave that was not a success. */
export class S3RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message)
    this.name = 'S3RequestError'
  }
}

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  /** Set for temporary credentials (an assumed role, SSO). */
  sessionToken?: string
}

export interface S3HttpObjectStoreOptions {
  bucket: string
  region: string
  credentials: S3Credentials | (() => Promise<S3Credentials>)
  /**
   * The service's base URL. Leave out for Amazon S3. Set it for an
   * S3-compatible store, e.g. `https://<account>.r2.cloudflarestorage.com`
   * or `http://127.0.0.1:9000` for a local MinIO.
   */
  endpoint?: string
  /** Bucket in the path instead of the host name. Custom endpoints default to it. */
  forcePathStyle?: boolean
  fetchImplementation?: typeof fetch
  /** For tests: the signing time. */
  now?: () => Date
}

const encoder = new TextEncoder()
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const byte of view) out += byte.toString(16).padStart(2, '0')
  return out
}

function asBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', asBuffer(bytes)))
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', asBuffer(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

/** RFC 3986 encoding as SigV4 wants it; `/` kept when encoding a path. */
export function sigV4Encode(value: string, keepSlash = false): string {
  return Array.from(encoder.encode(value), (byte) => {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) return ch
    return '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }).join('')
}

export interface SigV4Request {
  method: string
  /** Already-encoded path, e.g. `/bucket/key%20name`. */
  path: string
  query?: Record<string, string>
  /** Lower-case names. `host` must be among them. */
  headers: Record<string, string>
  payloadSha256: string
}

/**
 * The Authorization header value for one request. `x-amz-date` (and
 * `x-amz-security-token` when used) must already be in `headers`; every
 * header passed is signed.
 */
export async function signSigV4(
  request: SigV4Request,
  credentials: S3Credentials,
  region: string,
  service: string,
  amzDate: string
): Promise<string> {
  const date = amzDate.slice(0, 8)
  const names = Object.keys(request.headers).map((name) => name.toLowerCase()).sort()
  const lower: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) lower[name.toLowerCase()] = value
  const canonicalHeaders = names.map((name) => `${name}:${lower[name].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalQuery = Object.entries(request.query ?? {})
    .map(([key, value]) => [sigV4Encode(key), sigV4Encode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    request.payloadSha256
  ].join('\n')
  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')
  let key = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), date)
  key = await hmac(key, region)
  key = await hmac(key, service)
  key = await hmac(key, 'aws4_request')
  const signature = hex(await hmac(key, stringToSign))
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

function amzDateOf(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function xmlText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match ? unescapeXml(match[1]) : null
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

export function createS3HttpObjectStore(options: S3HttpObjectStoreOptions): S3ObjectStore {
  const fetchImpl = options.fetchImplementation ?? fetch
  const pathStyle = options.forcePathStyle ?? Boolean(options.endpoint)
  const base = new URL(
    options.endpoint ??
      (pathStyle
        ? `https://s3.${options.region}.amazonaws.com`
        : `https://${options.bucket}.s3.${options.region}.amazonaws.com`)
  )
  const basePath = base.pathname.replace(/\/+$/, '')
  const host = pathStyle || !options.endpoint ? base.host : `${options.bucket}.${base.host}`

  async function credentials(): Promise<S3Credentials> {
    return typeof options.credentials === 'function' ? options.credentials() : options.credentials
  }

  async function send(
    method: 'GET' | 'PUT',
    key: string | null,
    init: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const objectPath = key === null ? '' : '/' + sigV4Encode(key, true)
    const path = (pathStyle ? `${basePath}/${sigV4Encode(options.bucket)}` : basePath) + objectPath || '/'
    const payloadSha256 = init.body ? await sha256Hex(init.body) : EMPTY_SHA256
    const amzDate = amzDateOf(options.now?.() ?? new Date())
    const creds = await credentials()
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadSha256,
      'x-amz-date': amzDate,
      ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
      ...(init.headers ?? {})
    }
    const authorization = await signSigV4(
      { method, path: path || '/', query: init.query, headers, payloadSha256 },
      creds,
      options.region,
      's3',
      amzDate
    )
    const url = new URL(`${base.protocol}//${host}${path || '/'}`)
    const search = Object.entries(init.query ?? {})
      .map(([k, v]) => `${sigV4Encode(k)}=${sigV4Encode(v)}`)
      .join('&')
    const requestHeaders = { ...headers, authorization }
    delete (requestHeaders as Record<string, string | undefined>).host
    return fetchImpl(url.toString().split('?')[0] + (search ? `?${search}` : ''), {
      method,
      headers: requestHeaders,
      body: init.body ? asBuffer(init.body) : undefined
    })
  }

  async function failure(response: Response, key: string): Promise<S3RequestError> {
    const text = await response.text().catch(() => '')
    const code = xmlText(text, 'Code')
    const message = xmlText(text, 'Message') ?? `S3 answered ${response.status} for ${key}.`
    return new S3RequestError(message, response.status, code)
  }

  return {
    async get(key) {
      const response = await send('GET', key)
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) throw await failure(response, key)
      return {
        body: new Uint8Array(await response.arrayBuffer()),
        etag: response.headers.get('etag') ?? ''
      }
    },
    async put(key, body, putOptions = {}) {
      const headers: Record<string, string> = {}
      if (putOptions.ifNoneMatch) headers['if-none-match'] = putOptions.ifNoneMatch
      if (putOptions.ifMatch) headers['if-match'] = putOptions.ifMatch
      if (putOptions.contentType) headers['content-type'] = putOptions.contentType
      const response = await send('PUT', key, { body, headers })
      // 409 ConditionalRequestConflict: a competing conditional write was in
      // flight for the same key. Either way this writer did not get the key.
      if (response.status === 412 || (response.status === 409 && (putOptions.ifNoneMatch || putOptions.ifMatch))) {
        await response.body?.cancel()
        throw new S3PreconditionFailedError(key)
      }
      if (!response.ok) throw await failure(response, key)
      await response.body?.cancel()
      return { etag: response.headers.get('etag') ?? '' }
    },
    async list(prefix, listOptions = {}) {
      const keys: string[] = []
      let continuation: string | null = null
      do {
        const query: Record<string, string> = { 'list-type': '2', prefix }
        if (continuation) query['continuation-token'] = continuation
        else if (listOptions.startAfter) query['start-after'] = listOptions.startAfter
        const response = await send('GET', null, { query })
        if (!response.ok) throw await failure(response, prefix)
        const xml = await response.text()
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = xmlText(match[1], 'Key')
          if (key !== null) keys.push(key)
        }
        continuation = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : null
      } while (continuation)
      return keys
    }
  }
}

/** An in-memory store with S3's conditional-write rules, for tests and demos. */
export function createMemoryS3ObjectStore(): S3ObjectStore & { objects: Map<string, S3StoredObject> } {
  const objects = new Map<string, S3StoredObject>()
  let counter = 0
  return {
    objects,
    async get(key) {
      const found = objects.get(key)
      return found ? { body: found.body.slice(), etag: found.etag } : null
    },
    async put(key, body, options = {}) {
      const existing = objects.get(key)
      if (options.ifNoneMatch === '*' && existing) throw new S3PreconditionFailedError(key)
      if (options.ifMatch && existing?.etag !== options.ifMatch) throw new S3PreconditionFailedError(key)
      const etag = `"${++counter}"`
      objects.set(key, { body: body.slice(), etag })
      return { etag }
    },
    async list(prefix, options = {}) {
      return [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && (!options.startAfter || key > options.startAfter))
        .sort()
    }
  }
}

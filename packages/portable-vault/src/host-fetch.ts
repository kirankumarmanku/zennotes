import { cloudSendTimeoutMs } from '@zennotes/shared-domain/cloud-sync-stall'
import { base64ToBytes, bytesToBase64 } from './base64'
import { portableHost, type HttpTransport, type HttpTransportRequest } from './host'

/**
 * `fetch` over the host's HTTP transport, for shared code written against
 * fetch (the S3 client) that a phone must run outside its WebView's CORS:
 * an S3 bucket answers a `capacitor://localhost` page only when its owner
 * added a CORS rule, and almost nobody does. CapacitorHttp sends the request
 * from native code instead.
 *
 * Bodies cross the native bridge as base64 (`dataType: 'file'`): a plain
 * string body is written out as UTF-8 and would change any byte above 0x7F,
 * which breaks both the file and its signed SHA-256. Answers come back as
 * base64 too (`responseType: 'blob'`), so binary objects arrive intact.
 *
 * A rejection means no answer came, as with fetch; any HTTP status, errors
 * included, resolves.
 */
export function createHostFetch(transport?: () => HttpTransport): typeof fetch {
  const http = transport ?? (() => portableHost().http)
  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = headerRecord(init.headers)
    const body = bodyBytes(init.body)
    const request: HttpTransportRequest = {
      url,
      method,
      headers,
      responseType: 'blob',
      // A signed request must reach the address it was signed for.
      disableRedirects: true
    }
    if (body) {
      // Capacitor iOS attaches a binary body only when a Content-Type is set.
      // An unsigned Content-Type does not break an S3 signature.
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/octet-stream'
      }
      request.data = bytesToBase64(body)
      request.dataType = 'file'
    }
    const timeout = cloudSendTimeoutMs(body?.byteLength ?? 0)
    request.connectTimeout = timeout
    request.readTimeout = timeout
    const response = await http().request(request)
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
      throw new TypeError(`No usable answer from ${new URL(url).host}.`)
    }
    const nullBody = response.status === 204 || response.status === 205 || response.status === 304
    return new Response(nullBody ? null : asArrayBuffer(responseBytes(response.data)), {
      status: response.status,
      headers: response.headers ?? {}
    })
  }) as typeof fetch
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value
    })
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value
  } else {
    for (const [key, value] of Object.entries(headers)) out[key] = String(value)
  }
  return out
}

function bodyBytes(body: BodyInit | null | undefined): Uint8Array | null {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('This request body cannot be sent through the native transport.')
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** CapacitorHttp gives a blob answer as base64. A host that parsed JSON or
 *  returned text anyway is read as that text, never as broken base64. */
function responseBytes(data: unknown): Uint8Array {
  if (data === null || data === undefined) return new Uint8Array()
  if (typeof data === 'string') {
    const compact = data.replace(/\s+/g, '')
    if (compact.length % 4 === 0 && BASE64.test(compact)) {
      try {
        return base64ToBytes(compact)
      } catch {
        // Not base64 after all: fall through to text.
      }
    }
    return new TextEncoder().encode(data)
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new TextEncoder().encode(JSON.stringify(data))
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { RecordingHttp } from '../test/test-host'
import { bytesToBase64 } from './base64'
import { createHostFetch } from './host-fetch'

describe('createHostFetch', () => {
  it('sends a binary body as base64 and reads a binary answer intact', async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255])
    const http = new RecordingHttp(() => ({ status: 200, headers: { ETag: '"x"' }, data: bytesToBase64(bytes) }))
    const fetcher = createHostFetch(() => http)
    const response = await fetcher('https://bucket.s3.amazonaws.com/key', {
      method: 'PUT',
      headers: { 'x-amz-content-sha256': 'abc' },
      body: bytes
    })
    const sent = http.requests[0]!
    assert.equal(sent.method, 'PUT')
    assert.equal(sent.dataType, 'file')
    assert.equal(sent.data, bytesToBase64(bytes))
    assert.equal(sent.headers?.['Content-Type'], 'application/octet-stream')
    assert.equal(sent.responseType, 'blob')
    assert.equal(sent.disableRedirects, true)
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
    assert.equal(response.headers.get('etag'), '"x"')
  })

  it('resolves error statuses and gives 204 no body', async () => {
    const http = new RecordingHttp((request) =>
      request.method === 'DELETE' ? { status: 204, headers: {}, data: '' } : { status: 412, headers: {}, data: '' }
    )
    const fetcher = createHostFetch(() => http)
    assert.equal((await fetcher('https://b.example.com/k', { method: 'PUT', body: 'x' })).status, 412)
    const gone = await fetcher('https://b.example.com/k', { method: 'DELETE' })
    assert.equal(gone.status, 204)
    assert.equal(await gone.text(), '')
  })

  it('rejects when no usable answer came', async () => {
    const http = new RecordingHttp(() => ({ status: 0, headers: {}, data: '' }))
    await assert.rejects(createHostFetch(() => http)('https://b.example.com/k'), TypeError)
  })
})

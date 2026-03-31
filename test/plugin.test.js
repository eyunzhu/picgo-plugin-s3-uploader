'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const http = require('node:http')

const pluginFactory = require('../index')
const {
  DEFAULT_USER_CONFIG,
  UPLOADER_NAME,
  buildDefaultPublicUrl,
  buildImgproxySource,
  buildOutputUrl,
  buildRequestTarget,
  createRemoveHandler,
  createUploadHandler,
  createUploadPath,
  createUploadPathTemplateValueMap,
  deleteObjectFromS3,
  extractUploadPayload,
  getApiEndpointUrl,
  normalizeUserConfig,
  renderTemplate,
  uploadObjectToS3,
  validateUserConfig
} = require('../lib/s3-uploader')

function createUserConfig(overrides) {
  return {
    accessKeyID: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    bucketName: 'public',
    uploadPath: 'img/{year}/{month}/{fullName}',
    outputURLPattern: 'https://cdn.example.com/{bucket}/{encodedKey}',
    region: 'garage',
    endpoint: 'https://gs-api.example.com',
    pathStyleAccess: true,
    rejectUnauthorized: true,
    acl: 'public-read',
    contentDispositionInline: false,
    ...overrides
  }
}

function readConfig(config, path) {
  return path.split('.').reduce((result, segment) => {
    if (!result || typeof result !== 'object') {
      return undefined
    }

    return result[segment]
  }, config)
}

function createSeed() {
  return {
    uuid: '11111111-2222-3333-4444-555555555555',
    uuidN: '11111111222233334444555555555555'
  }
}

function createI18n(language) {
  return {
    getLanguage() {
      return language
    }
  }
}

function createPluginHost(overrides) {
  const registrations = []
  const listeners = new EventEmitter()

  listeners.helper = {
    uploader: {
      register(id, definition) {
        registrations.push({ id, definition })
      }
    }
  }
  listeners.getConfig = () => ({})

  Object.assign(listeners, overrides)

  return {
    ctx: listeners,
    registrations
  }
}

test('module entry exposes CommonJS and default-compatible exports', () => {
  assert.equal(typeof pluginFactory, 'function')
  assert.equal(pluginFactory.default, pluginFactory)
  assert.equal(pluginFactory.picgoPlugin, pluginFactory)
})

test('plugin config schema can be created without getConfig host', () => {
  const pluginConfig = pluginFactory._test.createPluginConfig({})
  const inlinePreviewField = pluginConfig.find((field) => field.name === 'contentDispositionInline')

  assert.equal(Array.isArray(pluginConfig), true)
  assert.equal(pluginConfig.length, 11)
  assert.equal(Boolean(inlinePreviewField), true)
  assert.equal(inlinePreviewField.type, 'confirm')
})

test('plugin config schema follows English host language', () => {
  const pluginConfig = pluginFactory._test.createPluginConfig({
    i18n: createI18n('en')
  })
  const inlinePreviewField = pluginConfig.find((field) => field.name === 'contentDispositionInline')

  assert.equal(pluginConfig[2].alias, 'Bucket Name')
  assert.equal(pluginConfig[3].alias, 'Upload Path Template')
  assert.equal(pluginConfig[4].message, 'For example: https://cdn.example.com/{bucket}/{encodedKey}')
  assert.equal(inlinePreviewField.alias, 'Inline Preview')
})

test('plugin config schema falls back to settings.language when i18n is unavailable', () => {
  const pluginConfig = pluginFactory._test.createPluginConfig({
    getConfig(path) {
      return readConfig(
        {
          settings: {
            language: 'en-US'
          }
        },
        path
      )
    }
  })

  assert.equal(pluginConfig[2].alias, 'Bucket Name')
  assert.equal(pluginConfig[6].message, 'Must be a full http(s):// URL')
})

test('normalizeUserConfig merges defaults', () => {
  const normalizedConfig = normalizeUserConfig({
    bucketName: 'public',
    accessKeyID: 'ak',
    secretAccessKey: 'sk',
    uploadPath: '{fullName}'
  })

  assert.equal(normalizedConfig.region, DEFAULT_USER_CONFIG.region)
  assert.equal(normalizedConfig.outputURLPattern, DEFAULT_USER_CONFIG.outputURLPattern)
  assert.equal(
    normalizedConfig.contentDispositionInline,
    DEFAULT_USER_CONFIG.contentDispositionInline
  )
  assert.equal(normalizedConfig.bucketName, 'public')
})

test('normalizeUserConfig accepts boolean-like contentDispositionInline values', () => {
  const normalizedConfig = normalizeUserConfig({
    contentDispositionInline: 'true'
  })

  assert.equal(normalizedConfig.contentDispositionInline, true)
})

test('renderTemplate supports slice and regex replacement', () => {
  const result = renderTemplate(
    '{bucket}/{fileName:/\\s+/g,\'-\'}-{md5:8}.{extName}',
    {
      bucket: 'public',
      fileName: 'Echo idle 01',
      md5: '2095312189753de6ad47dfe20cbe97ec',
      extName: 'png'
    }
  )

  assert.equal(result, 'public/Echo-idle-01-20953121.png')
})

test('createUploadPath renders extended placeholders', () => {
  const payload = {
    body: Buffer.from('hello-world'),
    contentType: 'image/png'
  }
  const uploadPath = createUploadPath({
    item: {
      fileName: 'Echo idle 01.png',
      extname: '.png',
      buffer: Buffer.from('hello-world')
    },
    userConfig: createUserConfig({
      uploadPath: 'img/{bucket}/{year}/{month}/{fileName:/\\s+/g,\'-\'}-{md5:8}.{extName}'
    }),
    payload,
    uploadDate: new Date('2026-03-24T10:20:30.456Z'),
    templateSeed: createSeed()
  })

  assert.equal(uploadPath, 'img/public/2026/03/Echo-idle-01-20953121.png')
})

test('createUploadPath supports crc32 placeholder', () => {
  const payload = {
    body: Buffer.from('hello-world'),
    contentType: 'image/png'
  }
  const uploadPath = createUploadPath({
    item: {
      fileName: 'Echo-idle-01.png',
      extname: '.png',
      buffer: Buffer.from('hello-world')
    },
    userConfig: createUserConfig({
      uploadPath: 'img/{crc32}.{extName}'
    }),
    payload,
    uploadDate: new Date('2026-03-24T10:20:30.456Z'),
    templateSeed: createSeed()
  })

  assert.equal(uploadPath, 'img/b1d4025b.png')
})

test('createUploadPathTemplateValueMap exposes comprehensive placeholders', () => {
  const valueMap = createUploadPathTemplateValueMap({
    item: {
      fileName: 'Echo-idle-01.png',
      extname: '.png',
      buffer: Buffer.from('hello-world')
    },
    userConfig: createUserConfig(),
    payload: {
      body: Buffer.from('hello-world'),
      contentType: 'image/png'
    },
    uploadDate: new Date('2026-03-24T10:20:30.456Z'),
    templateSeed: createSeed()
  })

  assert.equal(valueMap.bucket, 'public')
  assert.equal(valueMap.fullName, 'Echo-idle-01.png')
  assert.equal(valueMap.fileName, 'Echo-idle-01')
  assert.equal(valueMap.extName, 'png')
  assert.equal(valueMap.contentType, 'image/png')
  assert.equal(valueMap.uuid, '11111111-2222-3333-4444-555555555555')
  assert.equal(valueMap.uuidN, '11111111222233334444555555555555')
  assert.equal(valueMap.crc32, 'b1d4025b')
  assert.equal(valueMap.md5B64Short.length, 7)
})

test('getApiEndpointUrl derives AWS endpoint when endpoint is empty', () => {
  const endpointUrl = getApiEndpointUrl(
    createUserConfig({
      endpoint: '',
      region: 'us-east-1'
    })
  )

  assert.equal(endpointUrl.href, 'https://s3.amazonaws.com/')
})

test('validateUserConfig rejects endpoint without protocol', () => {
  assert.throws(
    () =>
      validateUserConfig(
        createUserConfig({
          endpoint: 's3.us-west-004.backblazeb2.com'
        })
      ),
    /API Endpoint 必须是完整的 http:\/\/ 或 https:\/\/ 地址/
  )
})

test('validateUserConfig reports English validation errors when locale is English', () => {
  assert.throws(
    () =>
      validateUserConfig(
        createUserConfig({
          endpoint: 's3.us-west-004.backblazeb2.com'
        }),
        'en-US'
      ),
    /API Endpoint must be a complete http:\/\/ or https:\/\/ URL/
  )
})

test('validateUserConfig rejects empty region even when endpoint is set', () => {
  assert.throws(
    () =>
      validateUserConfig(
        createUserConfig({
          region: '   '
        })
      ),
    /请填写签名区域/
  )
})

test('buildRequestTarget supports path-style S3 requests', () => {
  const requestTarget = buildRequestTarget(createUserConfig(), 'public', 'img/Echo-idle-01.png')

  assert.equal(requestTarget.hostname, 'gs-api.example.com')
  assert.equal(requestTarget.path, '/public/img/Echo-idle-01.png')
})

test('buildRequestTarget strips duplicated bucket suffix from endpoint path', () => {
  const requestTarget = buildRequestTarget(
    createUserConfig({
      endpoint: 'https://gs-api.example.com/public/public',
      pathStyleAccess: true
    }),
    'public',
    'img/Echo-idle-01.png'
  )

  assert.equal(requestTarget.hostname, 'gs-api.example.com')
  assert.equal(requestTarget.path, '/public/img/Echo-idle-01.png')
})

test('buildRequestTarget supports virtual-host style S3 requests', () => {
  const requestTarget = buildRequestTarget(
    createUserConfig({
      endpoint: 'https://s3.amazonaws.com',
      pathStyleAccess: false
    }),
    'public',
    'img/Echo-idle-01.png'
  )

  assert.equal(requestTarget.hostname, 'public.s3.amazonaws.com')
  assert.equal(requestTarget.path, '/img/Echo-idle-01.png')
})

test('buildRequestTarget strips duplicated bucket from virtual-host endpoint', () => {
  const requestTarget = buildRequestTarget(
    createUserConfig({
      endpoint: 'https://public.r2.example.com/public',
      pathStyleAccess: false
    }),
    'public',
    'img/Echo-idle-01.png'
  )

  assert.equal(requestTarget.hostname, 'public.r2.example.com')
  assert.equal(requestTarget.path, '/img/Echo-idle-01.png')
})

test('buildDefaultPublicUrl derives path-style public URL', () => {
  assert.equal(
    buildDefaultPublicUrl(
      createUserConfig({
        outputURLPattern: '',
        pathStyleAccess: true
      }),
      'public',
      'img/Echo-idle-01.png'
    ),
    'https://gs-api.example.com/public/img/Echo-idle-01.png'
  )
})

test('buildDefaultPublicUrl strips duplicated bucket suffix from endpoint path', () => {
  assert.equal(
    buildDefaultPublicUrl(
      createUserConfig({
        outputURLPattern: '',
        endpoint: 'https://public.r2.example.com/public',
        pathStyleAccess: false
      }),
      'public',
      'img/Echo-idle-01.png'
    ),
    'https://public.r2.example.com/img/Echo-idle-01.png'
  )
})

test('buildOutputUrl supports custom outputURLPattern placeholders', () => {
  const outputUrl = buildOutputUrl({
    userConfig: createUserConfig({
      outputURLPattern: 'https://assets.example.com/{bucket}/{encodedKey}?etag={eTag}'
    }),
    bucketName: 'public',
    objectKey: 'img/中文 文件.png',
    item: {
      fileName: '中文 文件.png',
      extname: '.png',
      buffer: Buffer.from('hello-world')
    },
    payload: {
      body: Buffer.from('hello-world'),
      contentType: 'image/png'
    },
    uploadDate: new Date('2026-03-24T10:20:30.456Z'),
    templateSeed: createSeed(),
    eTag: 'etag-1'
  })

  assert.equal(
    outputUrl,
    'https://assets.example.com/public/img/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.png?etag=etag-1'
  )
})

test('buildOutputUrl normalizes custom URL template output', () => {
  const outputUrl = buildOutputUrl({
    userConfig: createUserConfig({
      outputURLPattern: 'https://assets.example.com/{bucket}/{key}'
    }),
    bucketName: 'public',
    objectKey: 'img/中文 文件.png',
    item: {
      fileName: '中文 文件.png',
      extname: '.png',
      buffer: Buffer.from('hello-world')
    },
    payload: {
      body: Buffer.from('hello-world'),
      contentType: 'image/png'
    },
    uploadDate: new Date('2026-03-24T10:20:30.456Z'),
    templateSeed: createSeed(),
    eTag: 'etag-1'
  })

  assert.equal(
    outputUrl,
    'https://assets.example.com/public/img/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.png'
  )
})

test('buildOutputUrl rejects non-http absolute URLs', () => {
  assert.throws(
    () =>
      buildOutputUrl({
        userConfig: createUserConfig({
          outputURLPattern: 's3://{bucket}/{key}'
        }),
        bucketName: 'public',
        objectKey: 'img/a.png',
        item: {
          fileName: 'a.png',
          extname: '.png',
          buffer: Buffer.from('hello-world')
        },
        payload: {
          body: Buffer.from('hello-world'),
          contentType: 'image/png'
        },
        uploadDate: new Date('2026-03-24T10:20:30.456Z'),
        templateSeed: createSeed(),
        eTag: 'etag-1'
      }),
    /自定义输出 URL 模板 必须使用 http 或 https/
  )
})

test('extractUploadPayload supports data URL base64 input', async () => {
  const payload = await extractUploadPayload({
    base64Image: 'data:image/png;base64,aGVsbG8='
  })

  assert.equal(payload.contentType, 'image/png')
  assert.equal(payload.contentEncoding, undefined)
  assert.equal(Buffer.isBuffer(payload.body), true)
})

test('extractUploadPayload guesses common file content types from file extension', async () => {
  const videoPayload = await extractUploadPayload({
    fileName: 'demo-video.mp4',
    extname: '.mp4',
    buffer: Buffer.from('not-a-real-mp4')
  })
  const htmlPayload = await extractUploadPayload({
    fileName: 'index.html',
    extname: '.html',
    buffer: Buffer.from('<html></html>')
  })
  const archivePayload = await extractUploadPayload({
    fileName: 'backup.zip',
    extname: '.zip',
    buffer: Buffer.from('not-a-real-zip')
  })

  assert.equal(videoPayload.contentType, 'video/mp4')
  assert.equal(htmlPayload.contentType, 'text/html; charset=utf-8')
  assert.equal(archivePayload.contentType, 'application/zip')
})

test('buildImgproxySource returns stable S3 source metadata', () => {
  assert.deepEqual(buildImgproxySource('public', 'img/Echo-idle-01.png'), {
    backend: 's3',
    bucket: 'public',
    key: 'img/Echo-idle-01.png'
  })
})

test('uploadObjectToS3 sends zero-dependency signed PUT request', async () => {
  const originalHttpRequest = http.request
  const requests = []

  try {
    http.request = (requestOptions, callback) => {
      const chunks = []
      const request = new EventEmitter()

      request.write = (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      request.end = () => {
        requests.push({
          options: requestOptions,
          body: Buffer.concat(chunks)
        })

        const response = new EventEmitter()
        response.statusCode = 200
        response.headers = {
          etag: '"etag-local"'
        }

        callback(response)

        process.nextTick(() => {
          response.emit('data', Buffer.from(''))
          response.emit('end')
        })
      }

      return request
    }

    const payload = {
      body: Buffer.from('hello-world'),
      contentType: 'image/png',
      contentEncoding: undefined
    }
    const result = await uploadObjectToS3({
      userConfig: createUserConfig({
        endpoint: 'http://127.0.0.1:9000',
        outputURLPattern: '',
        pathStyleAccess: true
      }),
      key: 'img/中文 文件.png',
      payload,
      createDate() {
        return new Date('2026-03-24T10:20:30.456Z')
      }
    })

    assert.deepEqual(result, {
      eTag: 'etag-local'
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].options.method, 'PUT')
    assert.equal(
      requests[0].options.path,
      '/public/img/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.png'
    )
    assert.equal(requests[0].options.headers.host, '127.0.0.1:9000')
    assert.equal(requests[0].options.headers['content-type'], 'image/png')
    assert.equal(requests[0].options.headers['content-disposition'], undefined)
    assert.equal(requests[0].options.headers['x-amz-acl'], 'public-read')
    assert.equal(
      requests[0].options.headers['x-amz-content-sha256'],
      crypto.createHash('sha256').update(payload.body).digest('hex')
    )
    assert.match(
      requests[0].options.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260324\/garage\/s3\/aws4_request, SignedHeaders=/
    )
    assert.equal(requests[0].options.headers['content-encoding'], undefined)
    assert.deepEqual(requests[0].body, payload.body)
  } finally {
    http.request = originalHttpRequest
  }
})

test('uploadObjectToS3 can force inline content disposition for browser preview', async () => {
  const originalHttpRequest = http.request
  const requests = []

  try {
    http.request = (requestOptions, callback) => {
      const chunks = []
      const request = new EventEmitter()

      request.write = (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      request.end = () => {
        requests.push({
          options: requestOptions,
          body: Buffer.concat(chunks)
        })

        const response = new EventEmitter()
        response.statusCode = 200
        response.headers = {
          etag: '"etag-inline"'
        }

        callback(response)

        process.nextTick(() => {
          response.emit('data', Buffer.from(''))
          response.emit('end')
        })
      }

      return request
    }

    await uploadObjectToS3({
      userConfig: createUserConfig({
        endpoint: 'http://127.0.0.1:9000',
        outputURLPattern: '',
        pathStyleAccess: true,
        contentDispositionInline: true
      }),
      key: 'assets/demo-video.mp4',
      payload: {
        body: Buffer.from('hello-world'),
        contentType: 'video/mp4',
        contentEncoding: undefined
      },
      createDate() {
        return new Date('2026-03-24T10:20:30.456Z')
      }
    })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].options.headers['content-disposition'], 'inline')
    assert.match(requests[0].options.headers.authorization, /SignedHeaders=.*content-disposition/)
  } finally {
    http.request = originalHttpRequest
  }
})

test('uploadObjectToS3 rejects empty region before sending request', async () => {
  const originalHttpRequest = http.request
  let called = false

  try {
    http.request = () => {
      called = true
      throw new Error('http.request should not be called when region is missing')
    }

    await assert.rejects(
      () =>
        uploadObjectToS3({
          userConfig: createUserConfig({
            endpoint: 'http://127.0.0.1:9000',
            outputURLPattern: '',
            pathStyleAccess: true,
            region: ''
          }),
          key: 'img/Echo-idle-01.png',
          payload: {
            body: Buffer.from('hello-world'),
            contentType: 'image/png'
          },
          createDate() {
            return new Date('2026-03-24T10:20:30.456Z')
          }
        }),
      /请填写签名区域/
    )

    assert.equal(called, false)
  } finally {
    http.request = originalHttpRequest
  }
})

test('deleteObjectFromS3 sends zero-dependency signed DELETE request', async () => {
  const originalHttpRequest = http.request
  const requests = []

  try {
    http.request = (requestOptions, callback) => {
      const chunks = []
      const request = new EventEmitter()

      request.write = (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      request.end = () => {
        requests.push({
          options: requestOptions,
          body: Buffer.concat(chunks)
        })

        const response = new EventEmitter()
        response.statusCode = 204
        response.headers = {}

        callback(response)

        process.nextTick(() => {
          response.emit('data', Buffer.from(''))
          response.emit('end')
        })
      }

      return request
    }

    const result = await deleteObjectFromS3({
      userConfig: createUserConfig({
        endpoint: 'http://127.0.0.1:9000',
        outputURLPattern: '',
        pathStyleAccess: true
      }),
      key: 'img/中文 文件.png',
      createDate() {
        return new Date('2026-03-24T10:20:30.456Z')
      }
    })

    assert.deepEqual(result, {
      deleted: true,
      missing: false
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].options.method, 'DELETE')
    assert.equal(
      requests[0].options.path,
      '/public/img/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.png'
    )
    assert.equal(requests[0].options.headers.host, '127.0.0.1:9000')
    assert.match(
      requests[0].options.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260324\/garage\/s3\/aws4_request, SignedHeaders=/
    )
    assert.deepEqual(requests[0].body, Buffer.from(''))
  } finally {
    http.request = originalHttpRequest
  }
})

test('deleteObjectFromS3 rejects empty region before sending request', async () => {
  const originalHttpRequest = http.request
  let called = false

  try {
    http.request = () => {
      called = true
      throw new Error('http.request should not be called when region is missing')
    }

    await assert.rejects(
      () =>
        deleteObjectFromS3({
          userConfig: createUserConfig({
            endpoint: 'http://127.0.0.1:9000',
            outputURLPattern: '',
            pathStyleAccess: true,
            region: ''
          }),
          key: 'img/Echo-idle-01.png',
          createDate() {
            return new Date('2026-03-24T10:20:30.456Z')
          }
        }),
      /请填写签名区域/
    )

    assert.equal(called, false)
  } finally {
    http.request = originalHttpRequest
  }
})

test('createUploadHandler writes custom output URL and imgproxy metadata', async () => {
  const logs = []
  const runtimeConfig = {
    picBed: {
      [UPLOADER_NAME]: createUserConfig({
        uploadPath: 'assets/{year}/{month}/{uuidN}.{extName}',
        outputURLPattern: 'https://cdn.example.com/{bucket}/{encodedKey}?etag={etag}'
      })
    }
  }
  const handle = createUploadHandler(
    {
      getConfig(path) {
        return readConfig(runtimeConfig, path)
      },
      log: {
        info(message) {
          logs.push(['info', message])
        },
        warn(message) {
          logs.push(['warn', message])
        }
      }
    },
    {
      createDate() {
        return new Date('2026-03-24T10:20:30.456Z')
      },
      createTemplateSeed() {
        return createSeed()
      },
      async uploadObject({ key }) {
        return {
          eTag: `etag:${key}`
        }
      }
    }
  )

  const ctx = {
    output: [
      {
        fileName: 'Echo-idle-01.png',
        extname: '.png',
        buffer: Buffer.from('hello-world')
      }
    ],
    getConfig(path) {
      return readConfig(runtimeConfig, path)
    },
    log: {
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      }
    }
  }

  const result = await handle(ctx)

  assert.equal(result, ctx)
  assert.equal(
    ctx.output[0].uploadPath,
    'assets/2026/03/11111111222233334444555555555555.png'
  )
  assert.equal(
    ctx.output[0].url,
    'https://cdn.example.com/public/assets/2026/03/11111111222233334444555555555555.png?etag=etag:assets/2026/03/11111111222233334444555555555555.png'
  )
  assert.equal(ctx.output[0].imgUrl, ctx.output[0].url)
  assert.equal(
    ctx.output[0].eTag,
    'etag:assets/2026/03/11111111222233334444555555555555.png'
  )
  assert.equal(ctx.output[0].type, 's3-uploader')
  assert.deepEqual(ctx.output[0].imgproxySource, {
    backend: 's3',
    bucket: 'public',
    key: 'assets/2026/03/11111111222233334444555555555555.png'
  })
  assert.equal(logs.some((entry) => entry[0] === 'info'), true)
})

test('createUploadHandler reports partial failures without logging a false success summary', async () => {
  const logs = []
  const runtimeConfig = {
    picBed: {
      [UPLOADER_NAME]: createUserConfig()
    }
  }
  const handle = createUploadHandler(
    {
      getConfig(path) {
        return readConfig(runtimeConfig, path)
      },
      log: {
        info(message) {
          logs.push(['info', message])
        },
        warn(message) {
          logs.push(['warn', message])
        }
      }
    },
    {
      createDate() {
        return new Date('2026-03-24T10:20:30.456Z')
      },
      createTemplateSeed() {
        return createSeed()
      },
      async uploadObject({ index, key }) {
        if (index === 0) {
          return {
            eTag: `etag:${key}`
          }
        }

        throw new Error('upload failed')
      }
    }
  )

  const ctx = {
    output: [
      {
        fileName: 'success.png',
        extname: '.png',
        buffer: Buffer.from('hello-world')
      },
      {
        fileName: 'failed.png',
        extname: '.png',
        buffer: Buffer.from('hello-world')
      }
    ],
    getConfig(path) {
      return readConfig(runtimeConfig, path)
    },
    log: {
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      }
    }
  }

  const result = await handle(ctx)

  assert.equal(result, ctx)
  assert.equal(ctx.output[0].type, 's3-uploader')
  assert.match(ctx.output[0].url, /^https:\/\/cdn\.example\.com\/public\//)
  assert.equal(ctx.output[1].error instanceof Error, true)
  assert.equal(
    logs.some((entry) => entry[0] === 'warn' && entry[1].includes('上传完成：成功 1 项，失败 1 项')),
    true
  )
  assert.equal(
    logs.some((entry) => entry[0] === 'info' && entry[1].includes('上传完成：成功 1 项')),
    false
  )
})

test('createRemoveHandler deletes only s3-uploader items and reports summary', async () => {
  const logs = []
  const notifications = []
  const runtimeConfig = {
    picBed: {
      [UPLOADER_NAME]: createUserConfig()
    }
  }
  const removedKeys = []
  const removeHandler = createRemoveHandler(
    {
      getConfig(path) {
        return readConfig(runtimeConfig, path)
      },
      log: {
        info(message) {
          logs.push(['info', message])
        },
        warn(message) {
          logs.push(['warn', message])
        }
      }
    },
    {
      async deleteObject({ key }) {
        removedKeys.push(key)
        return {
          deleted: true,
          missing: false
        }
      }
    }
  )

  await removeHandler(
    [
      {
        type: 's3-uploader',
        fileName: 'Echo-idle-01.png',
        uploadPath: 'img/Echo-idle-01.png'
      },
      {
        type: 'github',
        fileName: 'skip.png',
        uploadPath: 'img/skip.png'
      }
    ],
    {
      showNotification(notification) {
        notifications.push(notification)
      }
    }
  )

  assert.deepEqual(removedKeys, ['img/Echo-idle-01.png'])
  assert.deepEqual(notifications, [
    {
      title: 'S3 上传器',
      body: '云端删除完成：成功 1，已不存在 0'
    }
  ])
  assert.equal(logs.some((entry) => entry[1].includes('云端删除完成：成功 1，已不存在 0')), true)
})

test('createRemoveHandler skips when plugin is disabled', async () => {
  const runtimeConfig = {
    picBed: {
      [UPLOADER_NAME]: createUserConfig()
    },
    picgoPlugins: {
      'picgo-plugin-s3-uploader': false
    }
  }
  let called = false
  const removeHandler = createRemoveHandler(
    {
      getConfig(path) {
        return readConfig(runtimeConfig, path)
      },
      log: {
        info() {},
        warn() {}
      }
    },
    {
      async deleteObject() {
        called = true
        return {
          deleted: true,
          missing: false
        }
      }
    }
  )

  await removeHandler([
    {
      type: 's3-uploader',
      fileName: 'Echo-idle-01.png',
      uploadPath: 'img/Echo-idle-01.png'
    }
  ])

  assert.equal(called, false)
})

test('createRemoveHandler notifies user-friendly config error', async () => {
  const notifications = []
  const logs = []
  const removeHandler = createRemoveHandler({
    getConfig(path) {
      return readConfig(
        {
          picBed: {
            [UPLOADER_NAME]: createUserConfig({
              bucketName: ''
            })
          }
        },
        path
      )
    },
    log: {
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      }
    }
  })

  await removeHandler(
    [
      {
        type: 's3-uploader',
        fileName: 'Echo-idle-01.png',
        uploadPath: 'img/Echo-idle-01.png'
      }
    ],
    {
      showNotification(notification) {
        notifications.push(notification)
      }
    }
  )

  assert.deepEqual(notifications, [
    {
      title: 'S3 上传器',
      body: '配置错误：请填写桶名'
    }
  ])
  assert.equal(logs.some((entry) => entry[1].includes('配置错误：请填写桶名')), true)
})

test('createUploadHandler throws when all uploads fail', async () => {
  const runtimeConfig = {
    picBed: {
      [UPLOADER_NAME]: createUserConfig()
    }
  }
  const handle = createUploadHandler(
    {
      getConfig(path) {
        return readConfig(runtimeConfig, path)
      },
      log: {
        info() {},
        warn() {}
      }
    },
    {
      createDate() {
        return new Date('2026-03-24T10:20:30.456Z')
      },
      createTemplateSeed() {
        return createSeed()
      },
      async uploadObject() {
        throw new Error('upload failed')
      }
    }
  )

  await assert.rejects(
    () =>
      handle({
        output: [
          {
            fileName: 'Echo-idle-01.png',
            extname: '.png',
            buffer: Buffer.from('hello-world')
          }
        ],
        getConfig(path) {
          return readConfig(runtimeConfig, path)
        },
        log: {
          info() {},
          warn() {}
        }
      }),
    /\[Echo-idle-01\.png\] upload failed/
  )
})

test('createUploadHandler reports user-friendly config error before upload starts', async () => {
  const logs = []
  const runtimeConfig = {
    picBed: {
      [UPLOADER_NAME]: createUserConfig({
        accessKeyID: ''
      })
    }
  }
  const handle = createUploadHandler({
    getConfig(path) {
      return readConfig(runtimeConfig, path)
    },
    log: {
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      }
    }
  })

  await assert.rejects(
    () =>
      handle({
        output: [
          {
            fileName: 'Echo-idle-01.png',
            extname: '.png',
            buffer: Buffer.from('hello-world')
          }
        ],
        getConfig(path) {
          return readConfig(runtimeConfig, path)
        },
        log: {
          info(message) {
            logs.push(['info', message])
          },
          warn(message) {
            logs.push(['warn', message])
          }
        }
      }),
    /\[s3-uploader\] 配置错误：请填写 AccessKey ID/
  )

  assert.equal(logs.some((entry) => entry[1].includes('配置错误：请填写 AccessKey ID')), true)
})

test('createUploadHandler reports user-friendly config error in English', async () => {
  const logs = []
  const runtimeConfig = {
    picBed: {
      [UPLOADER_NAME]: createUserConfig({
        accessKeyID: ''
      })
    }
  }
  const handle = createUploadHandler({
    i18n: createI18n('en'),
    getConfig(path) {
      return readConfig(runtimeConfig, path)
    },
    log: {
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      }
    }
  })

  await assert.rejects(
    () =>
      handle({
        output: [
          {
            fileName: 'Echo-idle-01.png',
            extname: '.png',
            buffer: Buffer.from('hello-world')
          }
        ],
        getConfig(path) {
          return readConfig(runtimeConfig, path)
        },
        log: {
          info(message) {
            logs.push(['info', message])
          },
          warn(message) {
            logs.push(['warn', message])
          }
        },
        i18n: createI18n('en')
      }),
    /\[s3-uploader\] Configuration error: Please provide AccessKey ID/
  )

  assert.equal(
    logs.some((entry) => entry[1].includes('Configuration error: Please provide AccessKey ID')),
    true
  )
})

test('plugin factory is compatible with PicGo GUI, PicGo Core and PicList hosts', () => {
  const hostContexts = [
    {
      hostName: 'PicGo GUI',
      overrides: {
        GUI_VERSION: '2.3.1'
      }
    },
    {
      hostName: 'PicGo Core',
      overrides: {
        VERSION: '1.5.0'
      }
    },
    {
      hostName: 'PicList',
      overrides: {
        GUI_VERSION: '1.9.1',
        PICLIST_VERSION: '1.9.1'
      }
    }
  ]

  for (const hostContext of hostContexts) {
    const { ctx, registrations } = createPluginHost(hostContext.overrides)
    const plugin = pluginFactory(ctx)

    plugin.register()

    const pluginReloaded = pluginFactory(ctx)
    pluginReloaded.register()

    assert.equal(typeof plugin.register, 'function', `${hostContext.hostName} should expose register`)
    assert.equal(registrations.length, 2)
    assert.equal(registrations[0].id, 's3-uploader')
    assert.equal(typeof registrations[0].definition.handle, 'function')
    assert.equal(plugin.uploader, 's3-uploader')
    assert.equal(ctx.listenerCount('remove'), 1)
  }
})

test('plugin metadata is consumable by PicGo GUI and PicList plugin list logic', () => {
  const { ctx } = createPluginHost({
    GUI_VERSION: '2.3.1'
  })
  const plugin = pluginFactory(ctx)

  const pluginListSnapshot = {
    uploaderName: plugin.uploader || '',
    transformerName: plugin.transformer || '',
    hasPluginConfig: typeof plugin.config === 'function'
  }

  assert.deepEqual(pluginListSnapshot, {
    uploaderName: 's3-uploader',
    transformerName: '',
    hasPluginConfig: false
  })
})

test('plugin register reports unsupported host clearly', () => {
  const plugin = pluginFactory({
    helper: {}
  })

  assert.throws(
    () => plugin.register(),
    /当前宿主未提供 helper\.uploader\.register/
  )
})

test('plugin register reports unsupported host in English when host language is English', () => {
  const plugin = pluginFactory({
    helper: {},
    i18n: createI18n('en')
  })

  assert.throws(
    () => plugin.register(),
    /Current host does not expose helper\.uploader\.register/
  )
})

test('createUploadHandler skips gracefully when ctx is missing', async () => {
  const logs = []
  const handle = createUploadHandler({
    getConfig(path) {
      return readConfig(
        {
          picBed: {
            's3-uploader': createUserConfig()
          }
        },
        path
      )
    },
    log: {
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      }
    }
  })

  const result = await handle()

  assert.equal(result, undefined)
  assert.equal(logs.some((entry) => entry[1].includes('未发现上传结果')), true)
})

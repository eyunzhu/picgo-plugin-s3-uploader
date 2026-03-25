'use strict'

const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const path = require('node:path')
const { URL } = require('node:url')
const { getConfigFieldLabel, resolveLocale, translate } = require('./i18n')

const PLUGIN_NAME = 'picgo-plugin-s3-uploader'
const UPLOADER_NAME = 's3-uploader'
const AWS_SERVICE_NAME = 's3'
const TEMPLATE_TOKEN_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

const DEFAULT_USER_CONFIG = {
  accessKeyID: '',
  secretAccessKey: '',
  bucketName: '',
  uploadPath: '{year}/{month}/{fullName}',
  outputURLPattern: '',
  region: 'us-east-1',
  endpoint: '',
  pathStyleAccess: false,
  rejectUnauthorized: true,
  acl: 'public-read'
}

const EXTENSION_CONTENT_TYPE_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif'
}

function translateMessage(localeLike, key, variables) {
  return translate(localeLike, key, variables)
}

function formatPromptFieldLabel(localeLike, fieldName) {
  const fieldLabel = getConfigFieldLabel(localeLike, fieldName)

  if (resolveLocale(localeLike) === 'zh-CN' && /^[A-Za-z]/.test(fieldLabel)) {
    return ` ${fieldLabel}`
  }

  return fieldLabel
}

// 这里自行实现 CRC32，避免为了一个短哈希占位符引入外部依赖，
// 同时保证 PicGo 直接本地安装插件时不再出现依赖缺失问题。
function createCrc32LookupTable() {
  const table = new Uint32Array(256)

  for (let index = 0; index < table.length; index += 1) {
    let currentValue = index

    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      currentValue =
        (currentValue & 1) === 1
          ? (currentValue >>> 1) ^ 0xedb88320
          : currentValue >>> 1
    }

    table[index] = currentValue >>> 0
  }

  return table
}

const CRC32_LOOKUP_TABLE = createCrc32LookupTable()

function getLogger(ctx) {
  if (ctx && ctx.log) {
    return ctx.log
  }

  return {
    info: console.log,
    warn: console.warn,
    error: console.error
  }
}

function formatErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

function normalizeString(value, defaultValue) {
  if (typeof value !== 'string') {
    return defaultValue
  }

  return value.trim()
}

function normalizeBoolean(value, defaultValue) {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase()

    if (normalizedValue === 'true') {
      return true
    }

    if (normalizedValue === 'false') {
      return false
    }
  }

  return defaultValue
}

function normalizeUserConfig(userConfig) {
  const safeUserConfig = userConfig && typeof userConfig === 'object' ? userConfig : {}

  return {
    accessKeyID: normalizeString(safeUserConfig.accessKeyID, DEFAULT_USER_CONFIG.accessKeyID),
    secretAccessKey: normalizeString(
      safeUserConfig.secretAccessKey,
      DEFAULT_USER_CONFIG.secretAccessKey
    ),
    bucketName: normalizeString(safeUserConfig.bucketName, DEFAULT_USER_CONFIG.bucketName),
    uploadPath: normalizeString(safeUserConfig.uploadPath, DEFAULT_USER_CONFIG.uploadPath),
    outputURLPattern: normalizeString(
      safeUserConfig.outputURLPattern,
      DEFAULT_USER_CONFIG.outputURLPattern
    ),
    region: normalizeString(safeUserConfig.region, DEFAULT_USER_CONFIG.region),
    endpoint: normalizeString(safeUserConfig.endpoint, DEFAULT_USER_CONFIG.endpoint),
    pathStyleAccess: normalizeBoolean(
      safeUserConfig.pathStyleAccess,
      DEFAULT_USER_CONFIG.pathStyleAccess
    ),
    rejectUnauthorized: normalizeBoolean(
      safeUserConfig.rejectUnauthorized,
      DEFAULT_USER_CONFIG.rejectUnauthorized
    ),
    acl: normalizeString(safeUserConfig.acl, DEFAULT_USER_CONFIG.acl)
  }
}

function validateUserConfig(userConfig, localeLike) {
  const requiredFields = ['accessKeyID', 'secretAccessKey', 'bucketName', 'uploadPath']

  for (const fieldName of requiredFields) {
    if (!normalizeString(userConfig && userConfig[fieldName], '')) {
      throw new Error(
        translateMessage(localeLike, 'err_required', {
          fieldLabel: formatPromptFieldLabel(localeLike, fieldName)
        })
      )
    }
  }

  if (!normalizeString(userConfig && userConfig.region, '')) {
    throw new Error(
      translateMessage(localeLike, 'err_required', {
        fieldLabel: formatPromptFieldLabel(localeLike, 'region')
      })
    )
  }

  if (normalizeString(userConfig && userConfig.endpoint, '')) {
    const endpointUrl = parseAbsoluteHttpUrl(userConfig.endpoint, 'endpoint', localeLike)

    if (endpointUrl.search || endpointUrl.hash) {
      throw new Error(translateMessage(localeLike, 'err_endpoint_no_query_hash'))
    }
  }
}

function createHashValue(algorithm, value, encoding) {
  return crypto.createHash(algorithm).update(value).digest(encoding)
}

function createHmacValue(key, value, encoding) {
  const hmac = crypto.createHmac('sha256', key)
  hmac.update(value)
  return hmac.digest(encoding)
}

function createDateValueMap(date) {
  const safeDate = date || new Date()

  return {
    year: safeDate.getFullYear().toString(),
    month: String(safeDate.getMonth() + 1).padStart(2, '0'),
    day: String(safeDate.getDate()).padStart(2, '0'),
    hour: String(safeDate.getHours()).padStart(2, '0'),
    minute: String(safeDate.getMinutes()).padStart(2, '0'),
    second: String(safeDate.getSeconds()).padStart(2, '0'),
    millisecond: String(safeDate.getMilliseconds()).padStart(3, '0'),
    timestamp: Math.floor(safeDate.getTime() / 1000).toString(),
    timestampMS: safeDate.getTime().toString()
  }
}

function extractItemBodyBuffer(item) {
  if (Buffer.isBuffer(item && item.buffer)) {
    return item.buffer
  }

  if (item && typeof item.base64Image === 'string' && item.base64Image !== '') {
    const normalizedBase64 = item.base64Image.replace(/^data:[^;]+;base64,/, '')
    return Buffer.from(normalizedBase64, 'base64')
  }

  return Buffer.from('')
}

function splitFileNameParts(item) {
  const fullName = item && typeof item.fileName === 'string' ? item.fileName : ''
  const extWithDot =
    item && typeof item.extname === 'string' && item.extname !== ''
      ? item.extname
      : path.extname(fullName)
  const extName = extWithDot.replace(/^\./, '')
  const lowerCaseFullName = fullName.toLowerCase()
  const lowerCaseExt = extWithDot.toLowerCase()

  let fileName = fullName

  if (fullName && extWithDot && lowerCaseFullName.endsWith(lowerCaseExt)) {
    fileName = fullName.slice(0, fullName.length - extWithDot.length)
  }

  return {
    fullName,
    fileName,
    extName
  }
}

function guessContentTypeFromName(fileName, extname) {
  const normalizedExtname = (extname || path.extname(fileName || ''))
    .replace(/^\./, '')
    .toLowerCase()

  return EXTENSION_CONTENT_TYPE_MAP[normalizedExtname] || ''
}

async function tryDetectContentTypeFromBuffer(buffer) {
  try {
    const { fileTypeFromBuffer } = require('file-type')
    return fileTypeFromBuffer(buffer)
  } catch (error) {
    return null
  }
}

async function extractUploadPayload(item, localeLike) {
  const result = {
    body: null,
    contentType: '',
    contentEncoding: undefined
  }

  if (typeof item.base64Image === 'string' && item.base64Image !== '') {
    const contentTypeMatch = item.base64Image.match(/[^:]\w+\/[\w-+\d.]+(?=;|,)/)
    const normalizedBody = item.base64Image.replace(/^data:[^;]+;base64,/, '')

    result.body = Buffer.from(normalizedBody, 'base64')
    result.contentType = contentTypeMatch ? contentTypeMatch[0] : ''
  } else if (Buffer.isBuffer(item.buffer)) {
    result.body = item.buffer
  } else {
    throw new Error(
      translateMessage(localeLike, 'err_no_image_data', {
        fileName:
          item && item.fileName ? item.fileName : translateMessage(localeLike, 'unknown_file')
      })
    )
  }

  if (!result.contentType) {
    result.contentType = guessContentTypeFromName(item.fileName, item.extname)
  }

  if (!result.contentType) {
    const fileTypeResult = await tryDetectContentTypeFromBuffer(result.body)
    if (fileTypeResult && fileTypeResult.mime) {
      result.contentType = fileTypeResult.mime
    }
  }

  if (!result.contentType) {
    result.contentType = 'application/octet-stream'
  }

  return result
}

function removeTrailingSlashes(value) {
  return value.replace(/\/+$/, '')
}

function removeLeadingSlashes(value) {
  return value.replace(/^\/+/, '')
}

function joinAbsolutePath(...parts) {
  const joinedPath = parts
    .filter((part) => typeof part === 'string' && part !== '')
    .map((part) => removeLeadingSlashes(removeTrailingSlashes(part)))
    .filter((part) => part !== '')
    .join('/')

  return joinedPath ? `/${joinedPath}` : '/'
}

function getAwsEndpointOrigin(region) {
  const normalizedRegion = region || 'us-east-1'

  if (normalizedRegion === 'us-east-1') {
    return 'https://s3.amazonaws.com'
  }

  return `https://s3.${normalizedRegion}.amazonaws.com`
}

function parseAbsoluteHttpUrl(value, fieldName, localeLike) {
  const fieldLabel = getConfigFieldLabel(localeLike, fieldName)

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      translateMessage(localeLike, 'err_field_required', {
        fieldLabel
      })
    )
  }

  let parsedUrl

  try {
    parsedUrl = new URL(value.trim())
  } catch (error) {
    throw new Error(translateMessage(localeLike, 'err_field_absolute_http_url', { fieldLabel }))
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(translateMessage(localeLike, 'err_field_http_prefix', { fieldLabel }))
  }

  return parsedUrl
}

function splitUrlPathSegments(pathname) {
  return String(pathname || '')
    .split('/')
    .filter((segment) => segment !== '')
}

function stripTrailingBucketSegments(pathSegments, bucketName) {
  const normalizedSegments = [...pathSegments]
  let removedBucketSegmentCount = 0

  while (
    bucketName &&
    normalizedSegments.length > 0 &&
    normalizedSegments[normalizedSegments.length - 1] === bucketName
  ) {
    normalizedSegments.pop()
    removedBucketSegmentCount += 1
  }

  return {
    pathSegments: normalizedSegments,
    removedBucketSegmentCount
  }
}

// endpoint 允许带反向代理前缀，例如 /s3；
// 但如果用户把 bucket 也误写进 endpoint 末尾，或者 virtual-host 风格下
// 已经把 bucket 写进 host 前缀，这里会统一归一化，避免后续再次重复拼接。
function createEndpointContext(userConfig) {
  const endpointUrl = userConfig.endpoint
    ? parseAbsoluteHttpUrl(userConfig.endpoint, 'endpoint')
    : new URL(getAwsEndpointOrigin(userConfig.region))
  const bucketName = userConfig && userConfig.bucketName ? userConfig.bucketName : ''
  const normalizedPathResult = stripTrailingBucketSegments(
    splitUrlPathSegments(endpointUrl.pathname),
    bucketName
  )
  const normalizedEndpointUrl = new URL(endpointUrl.toString())
  const normalizedPathname = normalizedPathResult.pathSegments.length
    ? `/${normalizedPathResult.pathSegments.join('/')}`
    : '/'
  let serviceHostname = endpointUrl.hostname

  if (!userConfig.pathStyleAccess && bucketName) {
    const bucketHostPrefix = `${bucketName}.`

    if (
      serviceHostname.startsWith(bucketHostPrefix) &&
      serviceHostname.length > bucketHostPrefix.length
    ) {
      serviceHostname = serviceHostname.slice(bucketHostPrefix.length)
    }
  }

  normalizedEndpointUrl.pathname = normalizedPathname
  normalizedEndpointUrl.search = ''
  normalizedEndpointUrl.hash = ''
  normalizedEndpointUrl.hostname = serviceHostname

  return {
    normalizedEndpointUrl,
    basePath: normalizedPathname === '/' ? '' : normalizedPathname,
    serviceHostname
  }
}

function getApiEndpointUrl(userConfig) {
  return createEndpointContext(userConfig).normalizedEndpointUrl
}

function normalizeHttpUrl(value, fieldName, localeLike) {
  const fieldLabel = getConfigFieldLabel(localeLike, fieldName)

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(translateMessage(localeLike, 'err_url_resolved_empty', { fieldLabel }))
  }

  let parsedUrl

  try {
    parsedUrl = new URL(value.trim())
  } catch (error) {
    throw new Error(translateMessage(localeLike, 'err_url_invalid_absolute', { fieldLabel }))
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(translateMessage(localeLike, 'err_url_http_only', { fieldLabel }))
  }

  return parsedUrl.toString()
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

function encodeS3ObjectPath(objectPath) {
  return objectPath
    .split('/')
    .map((segment) => encodePathSegment(segment))
    .join('/')
}

function createCrc32Value(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '')
  let currentValue = 0xffffffff

  for (const byte of buffer) {
    currentValue =
      CRC32_LOOKUP_TABLE[(currentValue ^ byte) & 0xff] ^ (currentValue >>> 8)
  }

  return ((currentValue ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

function getObjectDirectory(objectKey) {
  const normalizedKey = removeLeadingSlashes(objectKey || '')

  if (!normalizedKey || !normalizedKey.includes('/')) {
    return ''
  }

  const directory = path.posix.dirname(normalizedKey)

  return directory === '.' ? '' : directory
}

function createTemplateSeed() {
  const uuid = crypto.randomUUID()

  return {
    uuid,
    uuidN: uuid.replace(/-/g, '')
  }
}

function toTemplateString(value) {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return ''
}

function createCommonTemplateValueMap({
  item,
  userConfig,
  payload,
  uploadDate,
  templateSeed
}) {
  const fileParts = splitFileNameParts(item)
  const bodyBuffer = Buffer.isBuffer(payload && payload.body)
    ? payload.body
    : extractItemBodyBuffer(item)
  const endpointUrl = userConfig ? getApiEndpointUrl(userConfig) : null
  const normalizedSeed =
    templateSeed && typeof templateSeed === 'object' ? templateSeed : createTemplateSeed()
  const uuid = typeof normalizedSeed.uuid === 'string' ? normalizedSeed.uuid : ''

  return {
    ...createDateValueMap(uploadDate),
    bucket: userConfig && userConfig.bucketName ? userConfig.bucketName : '',
    region: userConfig && userConfig.region ? userConfig.region : '',
    acl: userConfig && userConfig.acl ? userConfig.acl : '',
    pathStyleAccess:
      userConfig && typeof userConfig.pathStyleAccess === 'boolean'
        ? String(userConfig.pathStyleAccess)
        : '',
    fullName: fileParts.fullName,
    filename: fileParts.fullName,
    fileName: fileParts.fileName,
    basename: fileParts.fileName,
    name: fileParts.fileName,
    extName: fileParts.extName,
    ext: fileParts.extName,
    contentType: payload && payload.contentType ? payload.contentType : '',
    mime: payload && payload.contentType ? payload.contentType : '',
    size: String(bodyBuffer.length),
    md5: createHashValue('md5', bodyBuffer, 'hex'),
    md5B64: createHashValue('md5', bodyBuffer, 'base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
    crc32: createCrc32Value(bodyBuffer),
    sha1: createHashValue('sha1', bodyBuffer, 'hex'),
    sha256: createHashValue('sha256', bodyBuffer, 'hex'),
    uuid,
    uuidN:
      typeof normalizedSeed.uuidN === 'string'
        ? normalizedSeed.uuidN
        : uuid.replace(/-/g, ''),
    endpoint: endpointUrl ? endpointUrl.href : '',
    endpointOrigin: endpointUrl ? endpointUrl.origin : '',
    endpointProtocol: endpointUrl ? endpointUrl.protocol.replace(/:$/, '') : '',
    endpointHost: endpointUrl ? endpointUrl.host : '',
    endpointHostname: endpointUrl ? endpointUrl.hostname : '',
    endpointPort: endpointUrl ? endpointUrl.port : '',
    endpointPath: endpointUrl ? removeLeadingSlashes(endpointUrl.pathname) : ''
  }
}

function createUploadPathTemplateValueMap(options) {
  const valueMap = createCommonTemplateValueMap(options)

  return {
    ...valueMap,
    md5B64Short: valueMap.md5B64.slice(0, 7)
  }
}

function createOutputUrlTemplateValueMap({
  userConfig,
  bucketName,
  objectKey,
  defaultUrl,
  item,
  payload,
  uploadDate,
  templateSeed,
  eTag
}) {
  const normalizedKey = removeLeadingSlashes(objectKey)
  const encodedKey = encodeS3ObjectPath(normalizedKey)
  const rawDir = getObjectDirectory(normalizedKey)
  const encodedDir = rawDir ? encodeS3ObjectPath(rawDir) : ''
  const parsedDefaultUrl = new URL(defaultUrl)

  return {
    ...createCommonTemplateValueMap({
      item,
      userConfig,
      payload,
      uploadDate,
      templateSeed
    }),
    key: normalizedKey,
    objectKey: normalizedKey,
    uploadPath: normalizedKey,
    encodedKey,
    dir: rawDir,
    encodedDir,
    bucketPath: normalizedKey ? `${bucketName}/${normalizedKey}` : bucketName,
    encodedBucketPath: normalizedKey
      ? `${encodePathSegment(bucketName)}/${encodedKey}`
      : encodePathSegment(bucketName),
    url: defaultUrl,
    origin: parsedDefaultUrl.origin,
    protocol: parsedDefaultUrl.protocol.replace(/:$/, ''),
    host: parsedDefaultUrl.host,
    hostname: parsedDefaultUrl.hostname,
    port: parsedDefaultUrl.port,
    pathname: parsedDefaultUrl.pathname,
    path: removeLeadingSlashes(parsedDefaultUrl.pathname),
    query: parsedDefaultUrl.search.replace(/^\?/, ''),
    hash: parsedDefaultUrl.hash.replace(/^#/, ''),
    eTag: eTag || '',
    etag: eTag || ''
  }
}

function parseSliceExpression(expression) {
  const sliceMatch = expression.match(/^([A-Za-z][A-Za-z0-9_]*):(\d+)(?:,(\d+))?$/)

  if (!sliceMatch) {
    return null
  }

  return {
    name: sliceMatch[1],
    start: sliceMatch[3] ? Number(sliceMatch[2]) : 0,
    length: Number(sliceMatch[3] || sliceMatch[2])
  }
}

function parseRegexReplacementExpression(expression, localeLike) {
  const separatorIndex = expression.indexOf(':/')

  if (separatorIndex <= 0) {
    return null
  }

  const name = expression.slice(0, separatorIndex).trim()
  if (!TEMPLATE_TOKEN_NAME_PATTERN.test(name)) {
    return null
  }

  const rule = expression.slice(separatorIndex + 2)
  let cursor = 0
  let pattern = ''

  while (cursor < rule.length) {
    const character = rule[cursor]

    if (character === '\\') {
      if (cursor + 1 < rule.length) {
        pattern += `${character}${rule[cursor + 1]}`
        cursor += 2
        continue
      }

      pattern += character
      cursor += 1
      continue
    }

    if (character === '/') {
      break
    }

    pattern += character
    cursor += 1
  }

  if (cursor >= rule.length || rule[cursor] !== '/') {
    throw new Error(
      translateMessage(localeLike, 'err_template_regex_invalid', {
        expression
      })
    )
  }

  cursor += 1

  let flags = ''
  while (cursor < rule.length && /[a-z]/i.test(rule[cursor])) {
    flags += rule[cursor]
    cursor += 1
  }

  let replacement = ''

  if (cursor < rule.length) {
    if (rule[cursor] !== ',' || rule[cursor + 1] !== '\'') {
      throw new Error(
        translateMessage(localeLike, 'err_template_regex_invalid', {
          expression
        })
      )
    }

    cursor += 2

    while (cursor < rule.length) {
      const character = rule[cursor]

      if (character === '\\') {
        if (cursor + 1 < rule.length) {
          replacement += rule[cursor + 1]
          cursor += 2
          continue
        }

        replacement += character
        cursor += 1
        continue
      }

      if (character === '\'') {
        break
      }

      replacement += character
      cursor += 1
    }

    if (cursor >= rule.length || rule[cursor] !== '\'') {
      throw new Error(
        translateMessage(localeLike, 'err_template_regex_invalid', {
          expression
        })
      )
    }

    cursor += 1

    if (cursor !== rule.length) {
      throw new Error(
        translateMessage(localeLike, 'err_template_regex_invalid', {
          expression
        })
      )
    }
  }

  return {
    name,
    pattern,
    flags,
    replacement
  }
}

function getTemplateValueOrThrow(name, templateValueMap, localeLike) {
  if (!TEMPLATE_TOKEN_NAME_PATTERN.test(name)) {
    throw new Error(translateMessage(localeLike, 'err_template_name_invalid', { name }))
  }

  if (!Object.prototype.hasOwnProperty.call(templateValueMap, name)) {
    throw new Error(
      translateMessage(localeLike, 'err_template_placeholder_unknown', {
        name
      })
    )
  }

  return toTemplateString(templateValueMap[name])
}

// 模板渲染统一同时服务于 uploadPath 与 outputURLPattern。
// 支持三种写法：
// 1. {bucket}
// 2. {md5:8} / {md5:0,8}
// 3. {fileName:/\s+/g,'-'}
function renderTemplate(template, templateValueMap, localeLike) {
  if (typeof template !== 'string' || template === '') {
    return ''
  }

  return template.replace(/\{([^{}]+)\}/g, (matchedText, rawExpression) => {
    const expression = rawExpression.trim()

    const regexExpression = parseRegexReplacementExpression(expression, localeLike)
    if (regexExpression) {
      const sourceValue = getTemplateValueOrThrow(
        regexExpression.name,
        templateValueMap,
        localeLike
      )

      try {
        return sourceValue.replace(
          new RegExp(regexExpression.pattern, regexExpression.flags),
          regexExpression.replacement
        )
      } catch (error) {
        throw new Error(
          translateMessage(localeLike, 'err_template_regex_invalid', {
            expression
          })
        )
      }
    }

    const sliceExpression = parseSliceExpression(expression)
    if (sliceExpression) {
      const sourceValue = getTemplateValueOrThrow(
        sliceExpression.name,
        templateValueMap,
        localeLike
      )
      return sourceValue.substring(
        sliceExpression.start,
        sliceExpression.start + sliceExpression.length
      )
    }

    return getTemplateValueOrThrow(expression, templateValueMap, localeLike)
  })
}

function buildRequestTarget(userConfig, bucketName, objectKey) {
  const endpointContext = createEndpointContext(userConfig)
  const encodedObjectKey = encodeS3ObjectPath(objectKey)

  if (userConfig.pathStyleAccess) {
    return {
      protocol: endpointContext.normalizedEndpointUrl.protocol,
      hostname: endpointContext.normalizedEndpointUrl.hostname,
      port: endpointContext.normalizedEndpointUrl.port,
      hostHeader: endpointContext.normalizedEndpointUrl.host,
      path: joinAbsolutePath(
        endpointContext.basePath,
        encodePathSegment(bucketName),
        encodedObjectKey
      )
    }
  }

  const hostWithBucket = endpointContext.normalizedEndpointUrl.port
    ? `${bucketName}.${endpointContext.serviceHostname}:${endpointContext.normalizedEndpointUrl.port}`
    : `${bucketName}.${endpointContext.serviceHostname}`

  return {
    protocol: endpointContext.normalizedEndpointUrl.protocol,
    hostname: `${bucketName}.${endpointContext.serviceHostname}`,
    port: endpointContext.normalizedEndpointUrl.port,
    hostHeader: hostWithBucket,
    path: joinAbsolutePath(endpointContext.basePath, encodedObjectKey)
  }
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function getDateStamp(amzDate) {
  return amzDate.slice(0, 8)
}

function assertSigningRegion(userConfig, localeLike) {
  if (userConfig && userConfig.region) {
    return
  }

  throw new Error(
    translateMessage(localeLike, 'err_required', {
      fieldLabel: formatPromptFieldLabel(localeLike, 'region')
    })
  )
}

function createSigningKey(secretAccessKey, dateStamp, region) {
  const kDate = createHmacValue(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = createHmacValue(kDate, region)
  const kService = createHmacValue(kRegion, AWS_SERVICE_NAME)
  return createHmacValue(kService, 'aws4_request')
}

function buildCanonicalHeaders(headers) {
  return Object.keys(headers)
    .sort()
    .map((key) => `${key}:${String(headers[key]).trim().replace(/\s+/g, ' ')}`)
    .join('\n')
}

function buildSignedHeaders(headers) {
  return Object.keys(headers)
    .sort()
    .join(';')
}

function buildAuthorizationHeader({
  userConfig,
  amzDate,
  canonicalRequest,
  signedHeaders
}) {
  const dateStamp = getDateStamp(amzDate)
  const credentialScope = `${dateStamp}/${userConfig.region}/${AWS_SERVICE_NAME}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHashValue('sha256', canonicalRequest, 'hex')
  ].join('\n')
  const signingKey = createSigningKey(
    userConfig.secretAccessKey,
    dateStamp,
    userConfig.region
  )
  const signature = createHmacValue(signingKey, stringToSign, 'hex')

  return `AWS4-HMAC-SHA256 Credential=${userConfig.accessKeyID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

function sendHttpRequest(requestOptions, bodyBuffer) {
  const requestFn = requestOptions.protocol === 'https:' ? https.request : http.request

  return new Promise((resolve, reject) => {
    const request = requestFn(requestOptions, (response) => {
      const chunks = []

      response.on('data', (chunk) => {
        chunks.push(chunk)
      })

      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks)
        })
      })
    })

    request.on('error', reject)
    request.write(bodyBuffer)
    request.end()
  })
}

async function uploadObjectToS3({ userConfig, key, payload, createDate, localeLike }) {
  assertSigningRegion(userConfig, localeLike)
  const requestTarget = buildRequestTarget(userConfig, userConfig.bucketName, key)
  const requestDate = createDate()
  const amzDate = formatAmzDate(requestDate)
  const bodyHash = createHashValue('sha256', payload.body, 'hex')

  const headers = {
    host: requestTarget.hostHeader,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
    'content-length': String(payload.body.length)
  }

  if (payload.contentType) {
    headers['content-type'] = payload.contentType
  }

  if (payload.contentEncoding) {
    headers['content-encoding'] = payload.contentEncoding
  }

  if (userConfig.acl) {
    headers['x-amz-acl'] = userConfig.acl
  }

  const signedHeaders = buildSignedHeaders(headers)
  const canonicalRequest = [
    'PUT',
    requestTarget.path,
    '',
    `${buildCanonicalHeaders(headers)}\n`,
    signedHeaders,
    bodyHash
  ].join('\n')

  headers.authorization = buildAuthorizationHeader({
    userConfig,
    amzDate,
    canonicalRequest,
    signedHeaders
  })

  const response = await sendHttpRequest(
    {
      protocol: requestTarget.protocol,
      hostname: requestTarget.hostname,
      port: requestTarget.port || undefined,
      path: requestTarget.path,
      method: 'PUT',
      headers,
      rejectUnauthorized: userConfig.rejectUnauthorized
    },
    payload.body
  )

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const responseText = response.body.toString('utf8')
    throw new Error(
      translateMessage(localeLike, 'err_s3_upload_failed_status', {
        statusCode: response.statusCode,
        responseText: responseText || translateMessage(localeLike, 'empty_response')
      })
    )
  }

  return {
    eTag: typeof response.headers.etag === 'string' ? response.headers.etag.replace(/"/g, '') : ''
  }
}

async function deleteObjectFromS3({ userConfig, key, createDate, localeLike }) {
  assertSigningRegion(userConfig, localeLike)
  const requestTarget = buildRequestTarget(userConfig, userConfig.bucketName, key)
  const requestDate = createDate()
  const amzDate = formatAmzDate(requestDate)
  const bodyBuffer = Buffer.from('')
  const bodyHash = createHashValue('sha256', bodyBuffer, 'hex')
  const headers = {
    host: requestTarget.hostHeader,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate
  }
  const signedHeaders = buildSignedHeaders(headers)
  const canonicalRequest = [
    'DELETE',
    requestTarget.path,
    '',
    `${buildCanonicalHeaders(headers)}\n`,
    signedHeaders,
    bodyHash
  ].join('\n')

  headers.authorization = buildAuthorizationHeader({
    userConfig,
    amzDate,
    canonicalRequest,
    signedHeaders
  })

  const response = await sendHttpRequest(
    {
      protocol: requestTarget.protocol,
      hostname: requestTarget.hostname,
      port: requestTarget.port || undefined,
      path: requestTarget.path,
      method: 'DELETE',
      headers,
      rejectUnauthorized: userConfig.rejectUnauthorized
    },
    bodyBuffer
  )

  if (response.statusCode === 404) {
    return {
      deleted: false,
      missing: true
    }
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const responseText = response.body.toString('utf8')
    throw new Error(
      translateMessage(localeLike, 'err_s3_delete_failed_status', {
        statusCode: response.statusCode,
        responseText: responseText || translateMessage(localeLike, 'empty_response')
      })
    )
  }

  return {
    deleted: true,
    missing: false
  }
}

function buildDefaultPublicUrl(userConfig, bucketName, objectKey) {
  const encodedObjectKey = encodeS3ObjectPath(objectKey)

  if (userConfig.endpoint) {
    const endpointContext = createEndpointContext(userConfig)

    if (userConfig.pathStyleAccess) {
      return `${endpointContext.normalizedEndpointUrl.origin}${joinAbsolutePath(
        endpointContext.basePath,
        bucketName,
        encodedObjectKey
      )}`
    }

    const origin = endpointContext.normalizedEndpointUrl.port
      ? `${endpointContext.normalizedEndpointUrl.protocol}//${bucketName}.${endpointContext.serviceHostname}:${endpointContext.normalizedEndpointUrl.port}`
      : `${endpointContext.normalizedEndpointUrl.protocol}//${bucketName}.${endpointContext.serviceHostname}`

    return `${removeTrailingSlashes(origin)}${joinAbsolutePath(
      endpointContext.basePath,
      encodedObjectKey
    )}`
  }

  const awsEndpointOrigin = getAwsEndpointOrigin(userConfig.region)
  const parsedAwsUrl = new URL(awsEndpointOrigin)

  if (userConfig.pathStyleAccess) {
    return `${parsedAwsUrl.origin}/${bucketName}/${removeLeadingSlashes(encodedObjectKey)}`
  }

  return `${parsedAwsUrl.protocol}//${bucketName}.${parsedAwsUrl.host}/${removeLeadingSlashes(encodedObjectKey)}`
}

function buildOutputUrl({
  userConfig,
  bucketName,
  objectKey,
  item,
  payload,
  uploadDate,
  templateSeed,
  eTag,
  localeLike
}) {
  const defaultUrl = buildDefaultPublicUrl(userConfig, bucketName, objectKey)

  if (!userConfig.outputURLPattern) {
    return normalizeHttpUrl(defaultUrl, 'defaultOutputUrl', localeLike)
  }

  const renderedUrl = renderTemplate(
    userConfig.outputURLPattern,
    createOutputUrlTemplateValueMap({
      userConfig,
      bucketName,
      objectKey,
      defaultUrl,
      item,
      payload,
      uploadDate,
      templateSeed,
      eTag
    }),
    localeLike
  ).trim()

  if (!renderedUrl) {
    throw new Error(translateMessage(localeLike, 'err_output_pattern_empty'))
  }

  return normalizeHttpUrl(renderedUrl, 'outputURLPattern', localeLike)
}

function buildImgproxySource(bucketName, uploadPath) {
  return {
    backend: 's3',
    bucket: bucketName,
    key: uploadPath
  }
}

function getItemDisplayName(item, index, localeLike) {
  if (item && typeof item.fileName === 'string' && item.fileName.trim() !== '') {
    return item.fileName.trim()
  }

  return translateMessage(localeLike, 'item_fallback_name', {
    index: index + 1
  })
}

function resolveRemoveKey(item) {
  if (!item || typeof item !== 'object') {
    return ''
  }

  if (
    item.imgproxySource &&
    typeof item.imgproxySource === 'object' &&
    item.imgproxySource.backend === 's3' &&
    typeof item.imgproxySource.key === 'string'
  ) {
    return item.imgproxySource.key.trim().replace(/^\/+/, '')
  }

  if (typeof item.uploadPath === 'string') {
    return item.uploadPath.trim().replace(/^\/+/, '')
  }

  return ''
}

function showGuiNotification(guiApi, title, body) {
  if (guiApi && typeof guiApi.showNotification === 'function') {
    guiApi.showNotification({
      title,
      body
    })
  }
}

function buildUserConfigErrorMessage(error, localeLike) {
  return translateMessage(localeLike, 'err_user_config_prefix', {
    message: formatErrorMessage(error)
  })
}

function isPluginEnabled(configHost) {
  if (!configHost || typeof configHost.getConfig !== 'function') {
    return true
  }

  return configHost.getConfig(`picgoPlugins.${PLUGIN_NAME}`) !== false
}

function createUploadPath({
  item,
  userConfig,
  payload,
  uploadDate,
  templateSeed,
  localeLike
}) {
  const renderedPath = renderTemplate(
    userConfig.uploadPath,
    createUploadPathTemplateValueMap({
      item,
      userConfig,
      payload,
      uploadDate,
      templateSeed
    }),
    localeLike
  )
    .trim()
    .replace(/^\/+/, '')

  if (!renderedPath) {
    throw new Error(translateMessage(localeLike, 'err_upload_path_empty'))
  }

  return renderedPath
}

function createPluginConfig(ctx) {
  const rawConfig =
    ctx && typeof ctx.getConfig === 'function' ? ctx.getConfig(`picBed.${UPLOADER_NAME}`) : {}
  const userConfig = normalizeUserConfig(rawConfig)
  const locale = resolveLocale(ctx)

  return [
    {
      name: 'accessKeyID',
      type: 'input',
      default: userConfig.accessKeyID,
      required: true,
      alias: translateMessage(locale, 'cfg_access_key_alias'),
      message: translateMessage(locale, 'cfg_access_key_message')
    },
    {
      name: 'secretAccessKey',
      type: 'password',
      default: userConfig.secretAccessKey,
      required: true,
      alias: translateMessage(locale, 'cfg_secret_key_alias'),
      message: translateMessage(locale, 'cfg_secret_key_message')
    },
    {
      name: 'bucketName',
      type: 'input',
      default: userConfig.bucketName,
      required: true,
      alias: translateMessage(locale, 'cfg_bucket_alias'),
      message: translateMessage(locale, 'cfg_bucket_message')
    },
    {
      name: 'uploadPath',
      type: 'input',
      default: userConfig.uploadPath,
      required: true,
      alias: translateMessage(locale, 'cfg_upload_path_alias'),
      message: translateMessage(locale, 'cfg_upload_path_message')
    },
    {
      name: 'outputURLPattern',
      type: 'input',
      default: userConfig.outputURLPattern,
      required: false,
      alias: translateMessage(locale, 'cfg_output_url_alias'),
      message: translateMessage(locale, 'cfg_output_url_message')
    },
    {
      name: 'region',
      type: 'input',
      default: userConfig.region,
      required: true,
      alias: translateMessage(locale, 'cfg_region_alias'),
      message: translateMessage(locale, 'cfg_region_message')
    },
    {
      name: 'endpoint',
      type: 'input',
      default: userConfig.endpoint,
      required: false,
      alias: translateMessage(locale, 'cfg_endpoint_alias'),
      message: translateMessage(locale, 'cfg_endpoint_message')
    },
    {
      name: 'pathStyleAccess',
      type: 'confirm',
      default: userConfig.pathStyleAccess,
      required: false,
      alias: translateMessage(locale, 'cfg_path_style_alias'),
      message: translateMessage(locale, 'cfg_path_style_message')
    },
    {
      name: 'rejectUnauthorized',
      type: 'confirm',
      default: userConfig.rejectUnauthorized,
      required: false,
      alias: translateMessage(locale, 'cfg_reject_unauthorized_alias'),
      message: translateMessage(locale, 'cfg_reject_unauthorized_message')
    },
    {
      name: 'acl',
      type: 'input',
      default: userConfig.acl,
      required: false,
      alias: translateMessage(locale, 'cfg_acl_alias'),
      message: translateMessage(locale, 'cfg_acl_message')
    }
  ]
}

function createUploadHandler(pluginCtx, runtimeOverrides = {}) {
  const createDate = runtimeOverrides.createDate || (() => new Date())
  const createSeed = runtimeOverrides.createTemplateSeed || createTemplateSeed
  const uploadObject = runtimeOverrides.uploadObject || uploadObjectToS3

  return async function handle(ctx) {
    const configHost = ctx && typeof ctx.getConfig === 'function' ? ctx : pluginCtx
    const logger = getLogger(ctx || pluginCtx)
    const locale = resolveLocale(ctx, pluginCtx, configHost)

    if (!ctx || !Array.isArray(ctx.output) || ctx.output.length === 0) {
      logger.info(translateMessage(locale, 'log_skip_no_output'))
      return ctx
    }

    let userConfig

    try {
      userConfig = normalizeUserConfig(configHost.getConfig(`picBed.${UPLOADER_NAME}`))
      validateUserConfig(userConfig, locale)
    } catch (error) {
      const message = buildUserConfigErrorMessage(error, locale)
      logger.warn(`[s3-uploader] ${message}`)
      throw new Error(`[s3-uploader] ${message}`)
    }

    const results = await Promise.all(
      ctx.output.map(async (item, index) => {
        try {
          const uploadDate = createDate()
          const payload = await extractUploadPayload(item, locale)
          const templateSeed = createSeed(item, index)
          const uploadPath = createUploadPath({
            item,
            userConfig,
            payload,
            uploadDate,
            templateSeed,
            localeLike: locale
          })
          const uploadedResult = await uploadObject({
            userConfig,
            key: uploadPath,
            payload,
            item,
            index,
            createDate,
            localeLike: locale
          })
          const publicUrl = buildOutputUrl({
            userConfig,
            bucketName: userConfig.bucketName,
            objectKey: uploadPath,
            item,
            payload,
            uploadDate,
            templateSeed,
            eTag: uploadedResult.eTag || '',
            localeLike: locale
          })

          return {
            index,
            uploadDate,
            uploadPath,
            publicUrl,
            eTag: uploadedResult.eTag || ''
          }
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error))

          return {
            index,
            error: new Error(
              `[${getItemDisplayName(item, index, locale)}] ${normalizedError.message}`
            )
          }
        }
      })
    )

    let successCount = 0
    let failureCount = 0
    let firstError = null

    for (const result of results) {
      const currentItem = ctx.output[result.index]

      if (result.error) {
        currentItem.error = result.error
        failureCount += 1
        firstError = firstError || result.error
        continue
      }

      currentItem.type = UPLOADER_NAME
      currentItem.uploadDate = result.uploadDate
      currentItem.uploadPath = result.uploadPath
      currentItem.url = result.publicUrl
      currentItem.imgUrl = result.publicUrl
      currentItem.eTag = result.eTag
      currentItem.imgproxySource = buildImgproxySource(
        userConfig.bucketName,
        result.uploadPath
      )

      delete currentItem.buffer
      delete currentItem.base64Image

      successCount += 1
    }

    if (failureCount > 0) {
      logger.warn(
        translateMessage(locale, 'log_upload_summary_partial', {
          successCount,
          failureCount
        })
      )
    }

    if (successCount === 0 && firstError) {
      throw firstError
    }

    if (failureCount === 0) {
      logger.info(
        translateMessage(locale, 'log_upload_summary_success', {
          successCount
        })
      )
    }
    return ctx
  }
}

function createRemoveHandler(pluginCtx, runtimeOverrides = {}) {
  const createDate = runtimeOverrides.createDate || (() => new Date())
  const deleteObject = runtimeOverrides.deleteObject || deleteObjectFromS3

  return async function handle(files, guiApi) {
    const logger = getLogger(pluginCtx)
    const locale = resolveLocale(pluginCtx)

    if (!pluginCtx || typeof pluginCtx.getConfig !== 'function') {
      return
    }

    if (!isPluginEnabled(pluginCtx)) {
      logger.info(translateMessage(locale, 'log_remove_skip_disabled'))
      return
    }

    if (!Array.isArray(files) || files.length === 0) {
      logger.info(translateMessage(locale, 'log_remove_skip_no_files'))
      return
    }

    const removableTargets = files
      .map((item, index) => {
        if (!item || item.type !== UPLOADER_NAME) {
          return null
        }

        const key = resolveRemoveKey(item)
        if (!key) {
          return null
        }

        return {
          index,
          key,
          displayName: getItemDisplayName(item, index, locale)
        }
      })
      .filter(Boolean)

    if (removableTargets.length === 0) {
      logger.info(translateMessage(locale, 'log_remove_skip_no_items'))
      return
    }

    let userConfig

    try {
      userConfig = normalizeUserConfig(pluginCtx.getConfig(`picBed.${UPLOADER_NAME}`))
      validateUserConfig(userConfig, locale)
    } catch (error) {
      const message = buildUserConfigErrorMessage(error, locale)
      logger.warn(
        translateMessage(locale, 'log_remove_skip_config', {
          message
        })
      )
      showGuiNotification(guiApi, translateMessage(locale, 'plugin_display_name'), message)
      return
    }

    const results = await Promise.all(
      removableTargets.map(async (target) => {
        try {
          const removeResult = await deleteObject({
            userConfig,
            key: target.key,
            createDate,
            localeLike: locale
          })

          return {
            target,
            removeResult
          }
        } catch (error) {
          return {
            target,
            error: error instanceof Error ? error : new Error(String(error))
          }
        }
      })
    )

    let successCount = 0
    let missingCount = 0
    let failureCount = 0

    for (const result of results) {
      if (result.error) {
        failureCount += 1
        logger.warn(
          translateMessage(locale, 'log_remove_failed_item', {
            displayName: result.target.displayName,
            message: result.error.message
          })
        )
        continue
      }

      if (result.removeResult && result.removeResult.missing) {
        missingCount += 1
        logger.info(
          translateMessage(locale, 'log_remove_missing_item', {
            displayName: result.target.displayName
          })
        )
        continue
      }

      successCount += 1
    }

    const summaryMessage =
      translateMessage(locale, 'log_remove_summary', {
        successCount,
        missingCount,
        failureSuffix:
          failureCount > 0
            ? translateMessage(locale, 'log_remove_summary_failed_suffix', {
                failureCount
              })
            : ''
      })

    if (failureCount > 0) {
      logger.warn(`[s3-uploader] ${summaryMessage}`)
    } else {
      logger.info(`[s3-uploader] ${summaryMessage}`)
    }

    showGuiNotification(guiApi, translateMessage(locale, 'plugin_display_name'), summaryMessage)
  }
}

module.exports = {
  DEFAULT_USER_CONFIG,
  PLUGIN_NAME,
  UPLOADER_NAME,
  buildDefaultPublicUrl,
  buildImgproxySource,
  buildOutputUrl,
  buildRequestTarget,
  createOutputUrlTemplateValueMap,
  createPluginConfig,
  createRemoveHandler,
  createTemplateSeed,
  createUploadHandler,
  createUploadPath,
  createUploadPathTemplateValueMap,
  deleteObjectFromS3,
  extractUploadPayload,
  getApiEndpointUrl,
  normalizeUserConfig,
  renderTemplate,
  sendHttpRequest,
  uploadObjectToS3,
  validateUserConfig
}

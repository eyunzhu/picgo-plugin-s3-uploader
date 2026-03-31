'use strict'

const SUPPORTED_LANGUAGES = {
  EN: 'en',
  ZH_CN: 'zh-CN'
}

const MESSAGES = {
  [SUPPORTED_LANGUAGES.ZH_CN]: {
    plugin_display_name: 'S3 上传器',
    host_uploader_missing: '[s3-uploader] 当前宿主未提供 helper.uploader.register，无法注册上传器',
    cfg_access_key_alias: 'AccessKey ID',
    cfg_access_key_message: '请输入 AccessKey ID',
    cfg_secret_key_alias: 'SecretAccessKey',
    cfg_secret_key_message: '请输入 SecretAccessKey',
    cfg_bucket_alias: '桶名',
    cfg_bucket_message: '例如 public',
    cfg_upload_path_alias: '上传路径模板',
    cfg_upload_path_message: '例如 img/{year}/{month}/{fullName}',
    cfg_output_url_alias: '自定义输出 URL 模板',
    cfg_output_url_message: '例如 https://cdn.example.com/{bucket}/{encodedKey}',
    cfg_region_alias: '签名区域',
    cfg_region_message: '例如 us-east-1',
    cfg_endpoint_alias: 'API Endpoint',
    cfg_endpoint_message: '必须写完整 http(s):// 地址',
    cfg_path_style_alias: '路径风格访问',
    cfg_path_style_message: 'Garage/MinIO 常见开启',
    cfg_reject_unauthorized_alias: '校验证书',
    cfg_reject_unauthorized_message: '是否拒绝无效 TLS 证书？',
    cfg_acl_alias: 'ACL',
    cfg_acl_message: '例如 public-read，不支持可留空',
    cfg_content_disposition_inline_alias: '内联预览',
    cfg_content_disposition_inline_message:
      '上传时写入 Content-Disposition: inline，让浏览器更倾向直接预览',
    field_accessKeyID: 'AccessKey ID',
    field_secretAccessKey: 'SecretAccessKey',
    field_bucketName: '桶名',
    field_uploadPath: '上传路径模板',
    field_outputURLPattern: '自定义输出 URL 模板',
    field_endpoint: 'API Endpoint',
    field_region: '签名区域',
    field_acl: 'ACL',
    field_contentDispositionInline: '内联预览',
    field_defaultOutputUrl: '默认输出 URL',
    empty_response: '空响应',
    unknown_file: '未知文件',
    err_required: '请填写${fieldLabel}',
    err_endpoint_or_region_required: '请至少填写 API Endpoint 或签名区域；AWS S3 可只填 region',
    err_endpoint_no_query_hash: 'API Endpoint 不能包含 query 或 hash',
    err_no_image_data: '“${fileName}” 未提供文件数据',
    err_field_required: '${fieldLabel} 不能为空',
    err_field_absolute_http_url: '${fieldLabel} 必须是完整的 http:// 或 https:// 地址',
    err_field_http_prefix: '${fieldLabel} 必须以 http:// 或 https:// 开头',
    err_url_resolved_empty: '${fieldLabel} 渲染结果为空',
    err_url_invalid_absolute: '${fieldLabel} 必须是有效的绝对 URL',
    err_url_http_only: '${fieldLabel} 必须使用 http 或 https',
    err_template_regex_invalid: '模板正则占位符无效：{${expression}}',
    err_template_name_invalid: '模板占位符名称无效：${name}',
    err_template_placeholder_unknown: '未知模板占位符：{${name}}',
    err_s3_upload_failed_status:
      'S3 上传失败，状态码 ${statusCode}：${responseText}',
    err_s3_delete_failed_status:
      'S3 删除失败，状态码 ${statusCode}：${responseText}',
    err_output_pattern_empty: 'outputURLPattern 渲染结果为空',
    err_upload_path_empty: 'uploadPath 渲染结果为空',
    err_user_config_prefix: '配置错误：${message}',
    item_fallback_name: '第 ${index} 项',
    log_skip_no_output: '[s3-uploader] 已跳过：未发现上传结果',
    log_upload_summary_success: '[s3-uploader] 上传完成：成功 ${successCount} 项',
    log_upload_summary_partial:
      '[s3-uploader] 上传完成：成功 ${successCount} 项，失败 ${failureCount} 项',
    log_remove_skip_disabled: '[s3-uploader] 删除已跳过：插件已禁用',
    log_remove_skip_no_files: '[s3-uploader] 删除已跳过：未选择任何文件',
    log_remove_skip_no_items: '[s3-uploader] 删除已跳过：选中文件中没有 s3-uploader 项',
    log_remove_skip_config: '[s3-uploader] 删除已跳过：${message}',
    log_remove_failed_item: '[s3-uploader] 删除“${displayName}”失败：${message}',
    log_remove_missing_item: '[s3-uploader] 对象“${displayName}”在云端已不存在',
    log_remove_summary: '云端删除完成：成功 ${successCount}，已不存在 ${missingCount}${failureSuffix}',
    log_remove_summary_failed_suffix: '，失败 ${failureCount}'
  },
  [SUPPORTED_LANGUAGES.EN]: {
    plugin_display_name: 'S3 Uploader',
    host_uploader_missing:
      '[s3-uploader] Current host does not expose helper.uploader.register, so the uploader cannot be registered',
    cfg_access_key_alias: 'AccessKey ID',
    cfg_access_key_message: 'Enter AccessKey ID',
    cfg_secret_key_alias: 'SecretAccessKey',
    cfg_secret_key_message: 'Enter SecretAccessKey',
    cfg_bucket_alias: 'Bucket Name',
    cfg_bucket_message: 'For example: public',
    cfg_upload_path_alias: 'Upload Path Template',
    cfg_upload_path_message: 'For example: img/{year}/{month}/{fullName}',
    cfg_output_url_alias: 'Custom Output URL Template',
    cfg_output_url_message: 'For example: https://cdn.example.com/{bucket}/{encodedKey}',
    cfg_region_alias: 'Signing Region',
    cfg_region_message: 'For example: us-east-1',
    cfg_endpoint_alias: 'API Endpoint',
    cfg_endpoint_message: 'Must be a full http(s):// URL',
    cfg_path_style_alias: 'Path-Style Access',
    cfg_path_style_message: 'Usually enabled for Garage/MinIO',
    cfg_reject_unauthorized_alias: 'Validate Certificates',
    cfg_reject_unauthorized_message: 'Reject invalid TLS certificates?',
    cfg_acl_alias: 'ACL',
    cfg_acl_message: 'For example: public-read; leave empty if unsupported',
    cfg_content_disposition_inline_alias: 'Inline Preview',
    cfg_content_disposition_inline_message:
      'Send Content-Disposition: inline so browsers prefer in-browser preview',
    field_accessKeyID: 'AccessKey ID',
    field_secretAccessKey: 'SecretAccessKey',
    field_bucketName: 'Bucket Name',
    field_uploadPath: 'Upload Path Template',
    field_outputURLPattern: 'Custom Output URL Template',
    field_endpoint: 'API Endpoint',
    field_region: 'Signing Region',
    field_acl: 'ACL',
    field_contentDispositionInline: 'Inline Preview',
    field_defaultOutputUrl: 'Default Output URL',
    empty_response: 'empty response',
    unknown_file: 'unknown file',
    err_required: 'Please provide ${fieldLabel}',
    err_endpoint_or_region_required:
      'Please provide either API Endpoint or Signing Region; AWS S3 can work with region only',
    err_endpoint_no_query_hash: 'API Endpoint must not contain query string or hash',
    err_no_image_data: '"${fileName}" has no file data',
    err_field_required: '${fieldLabel} is required',
    err_field_absolute_http_url:
      '${fieldLabel} must be a complete http:// or https:// URL',
    err_field_http_prefix: '${fieldLabel} must start with http:// or https://',
    err_url_resolved_empty: '${fieldLabel} resolved to an empty string',
    err_url_invalid_absolute: '${fieldLabel} must be a valid absolute URL',
    err_url_http_only: '${fieldLabel} must use http or https',
    err_template_regex_invalid: 'Invalid template regex token: {${expression}}',
    err_template_name_invalid: 'Invalid template placeholder name: ${name}',
    err_template_placeholder_unknown: 'Unknown template placeholder: {${name}}',
    err_s3_upload_failed_status:
      'S3 upload failed with status ${statusCode}: ${responseText}',
    err_s3_delete_failed_status:
      'S3 delete failed with status ${statusCode}: ${responseText}',
    err_output_pattern_empty: 'outputURLPattern resolved to an empty string',
    err_upload_path_empty: 'uploadPath resolved to an empty string',
    err_user_config_prefix: 'Configuration error: ${message}',
    item_fallback_name: 'item #${index}',
    log_skip_no_output: '[s3-uploader] skipped: no upload output found',
    log_upload_summary_success: '[s3-uploader] upload finished: ${successCount} succeeded',
    log_upload_summary_partial:
      '[s3-uploader] upload finished: ${successCount} succeeded, ${failureCount} failed',
    log_remove_skip_disabled: '[s3-uploader] remove skipped: plugin disabled',
    log_remove_skip_no_files: '[s3-uploader] remove skipped: no selected files',
    log_remove_skip_no_items:
      '[s3-uploader] remove skipped: no s3-uploader items in selection',
    log_remove_skip_config: '[s3-uploader] remove skipped: ${message}',
    log_remove_failed_item:
      '[s3-uploader] failed to remove "${displayName}": ${message}',
    log_remove_missing_item:
      '[s3-uploader] object already missing for "${displayName}"',
    log_remove_summary:
      'Cloud deletion completed: ${successCount} succeeded, ${missingCount} already missing${failureSuffix}',
    log_remove_summary_failed_suffix: ', ${failureCount} failed'
  }
}

function interpolate(template, variables) {
  return String(template).replace(/\$\{([^{}]+)\}/g, (_matchedText, variableName) => {
    const value = variables && Object.prototype.hasOwnProperty.call(variables, variableName)
      ? variables[variableName]
      : ''
    return String(value)
  })
}

function normalizeLocale(language) {
  if (typeof language !== 'string' || language.trim() === '') {
    return SUPPORTED_LANGUAGES.ZH_CN
  }

  const normalizedLanguage = language.trim().toLowerCase()

  if (normalizedLanguage.startsWith('en')) {
    return SUPPORTED_LANGUAGES.EN
  }

  return SUPPORTED_LANGUAGES.ZH_CN
}

function extractLanguage(candidate) {
  if (!candidate) {
    return ''
  }

  if (typeof candidate === 'string') {
    return candidate
  }

  if (candidate.i18n && typeof candidate.i18n.getLanguage === 'function') {
    return candidate.i18n.getLanguage()
  }

  if (typeof candidate.getConfig === 'function') {
    return candidate.getConfig('settings.language') || ''
  }

  return ''
}

function resolveLocale(...candidates) {
  for (const candidate of candidates) {
    const language = extractLanguage(candidate)
    if (language) {
      return normalizeLocale(language)
    }
  }

  return SUPPORTED_LANGUAGES.ZH_CN
}

function translate(localeLike, key, variables) {
  const locale = resolveLocale(localeLike)
  const messageTable = MESSAGES[locale] || MESSAGES[SUPPORTED_LANGUAGES.ZH_CN]
  const template = messageTable[key] || MESSAGES[SUPPORTED_LANGUAGES.ZH_CN][key] || key

  return interpolate(template, variables)
}

function getConfigFieldLabel(localeLike, fieldName) {
  const key = `field_${fieldName}`
  const translated = translate(localeLike, key)

  return translated === key ? fieldName : translated
}

module.exports = {
  getConfigFieldLabel,
  resolveLocale,
  translate
}

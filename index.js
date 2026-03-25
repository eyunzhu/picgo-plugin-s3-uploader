'use strict'

const {
  UPLOADER_NAME,
  createPluginConfig,
  createRemoveHandler,
  createUploadHandler
} = require('./lib/s3-uploader')
const { resolveLocale, translate } = require('./lib/i18n')

const removeHandlerStore = new WeakMap()

function getUploaderRegistry(ctx) {
  if (!ctx || !ctx.helper || !ctx.helper.uploader || typeof ctx.helper.uploader.register !== 'function') {
    throw new Error(translate(resolveLocale(ctx), 'host_uploader_missing'))
  }

  return ctx.helper.uploader
}

function syncRemoveHandler(ctx, removeHandler) {
  if (!ctx || typeof ctx.on !== 'function') {
    return
  }

  const previousRemoveHandler = removeHandlerStore.get(ctx)

  if (previousRemoveHandler && previousRemoveHandler !== removeHandler) {
    if (typeof ctx.off === 'function') {
      ctx.off('remove', previousRemoveHandler)
    } else if (typeof ctx.removeListener === 'function') {
      ctx.removeListener('remove', previousRemoveHandler)
    }
  }

  if (previousRemoveHandler !== removeHandler) {
    removeHandlerStore.set(ctx, removeHandler)
    ctx.on('remove', removeHandler)
  }
}

function picGoPlugin(ctx) {
  const uploadHandler = createUploadHandler(ctx)
  const removeHandler = createRemoveHandler(ctx)

  const register = () => {
    const locale = resolveLocale(ctx)

    getUploaderRegistry(ctx).register(UPLOADER_NAME, {
      handle: uploadHandler,
      config: createPluginConfig,
      name: translate(locale, 'plugin_display_name')
    })
    syncRemoveHandler(ctx, removeHandler)
  }

  return {
    register,
    uploader: UPLOADER_NAME
  }
}

module.exports = picGoPlugin
module.exports.default = picGoPlugin
module.exports.picgoPlugin = picGoPlugin
module.exports._test = require('./lib/s3-uploader')

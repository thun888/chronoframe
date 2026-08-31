/**
 * 储存方格式转换（如 CDN 图片缩放）支持。
 *
 * 该能力按「存储方案」配置，字段位于每个存储方案的 config 上：
 * - transformEnabled：是否启用
 * - transformSuffix：附加在原始链接后的后缀，
 *   例如阿里云 OSS：?x-oss-process=image/resize,w_600
 *
 * 启用后，缩略图不再由服务端生成，而是直接返回「原始链接 + 后缀」。
 */
import type { StorageConfig } from '~~/server/services/storage'

/** 从存储方案配置读取格式转换后缀；未配置时返回空字符串。 */
export function getStorageTransformSuffix(
  config?: StorageConfig | null,
): string {
  if (!config) return ''
  return (config.transformSuffix || '').trim()
}

/** 是否启用「原始链接 + 后缀」的缩略图方式（需启用且后缀非空）。 */
export function isStorageTransformActive(
  config?: StorageConfig | null,
): boolean {
  if (!config) return false
  return (
    config.transformEnabled === true &&
    getStorageTransformSuffix(config).length > 0
  )
}

interface ThumbnailSource {
  thumbnailUrl?: string | null
  originalUrl?: string | null
}

/**
 * 计算对外返回的缩略图链接：
 * - 已有缩略图链接时原样返回（兼容历史数据）；
 * - 否则，如果启用且后缀非空时，返回「原始链接 + 后缀」；
 * - 再没有就直接返回原始链接。
 */
export function resolveThumbnailUrl(
  photo: ThumbnailSource,
  config?: StorageConfig | null,
): string | null {
  if (photo.thumbnailUrl) return photo.thumbnailUrl

  // 仅当功能启用且后缀非空时才拼接后缀
  if (isStorageTransformActive(config) && photo.originalUrl) {
    return `${photo.originalUrl}${getStorageTransformSuffix(config)}`
  }

  return photo.originalUrl ?? null
}

/**
 * 批量为照片行补充缩略图链接（不修改入参，返回新数组）。
 * 适用于照片列表接口返回前统一处理。
 */
export function applyThumbnailTransform<T extends ThumbnailSource>(
  photos: T[],
  config?: StorageConfig | null,
): T[] {
  return photos.map((photo) => ({
    ...photo,
    thumbnailUrl: resolveThumbnailUrl(photo, config),
  }))
}

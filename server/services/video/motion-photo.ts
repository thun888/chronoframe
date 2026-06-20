import type { ConsolaInstance } from 'consola'
import type { NeededExif } from '~~/shared/types/photo'

interface MotionPhotoProcessParams {
  storageKey: string
  rawImageBuffer: Buffer
  exifData?: NeededExif | null
  logger?: ConsolaInstance
}

export interface MotionPhotoProcessResult {
  isMotionPhoto: boolean
  videoOffset?: number
  presentationTimestampUs?: number
}

const MAX_XMP_SCAN_BYTES = 512 * 1024 // 512KB should cover standard XMP blocks
const MIN_VIDEO_SIZE_BYTES = 8 * 1024 // 8KB minimal sanity check
const MP4_FTYP = Buffer.from('ftyp')

const toBoolean = (value: unknown): boolean => {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'bigint') return value !== BigInt(0)
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }
  return false
}

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const extractXmpSegment = (buffer: Buffer): string | null => {
  const scanSize = Math.min(buffer.length, MAX_XMP_SCAN_BYTES)
  if (scanSize === 0) {
    return null
  }

  const header = buffer.toString('utf8', 0, scanSize)
  const startIndex = header.indexOf('<x:xmpmeta')
  if (startIndex === -1) {
    return null
  }

  const endIndex = header.indexOf('</x:xmpmeta>')
  if (endIndex === -1) {
    return null
  }

  return header.slice(startIndex, endIndex + '</x:xmpmeta>'.length)
}

const extractXmpBoolean = (xmp: string, tagName: string): boolean | null => {
  const regex = new RegExp(`<[^:>]*:${tagName}>([^<]+)</[^>]+>`, 'i')
  const match = xmp.match(regex)
  if (!match) return null
  return toBoolean(match[1])
}

const extractXmpNumber = (xmp: string, tagName: string): number | null => {
  const regex = new RegExp(`<[^:>]*:${tagName}>([^<]+)</[^>]+>`, 'i')
  const match = xmp.match(regex)
  if (!match) return null
  return toNumber(match[1])
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const buildAttrPattern = (attrName: string) => {
  const escaped = escapeRegExp(attrName)
  if (attrName.includes(':')) {
    return escaped
  }
  return `(?:[\\w-]+:)?${escaped}`
}

const extractXmpAttributeBoolean = (
  xmp: string,
  attrName: string,
): boolean | null => {
  const regex = new RegExp(`${buildAttrPattern(attrName)}="([^"]+)"`, 'i')
  const match = xmp.match(regex)
  if (!match) return null
  return toBoolean(match[1])
}

const extractXmpAttributeNumber = (
  xmp: string,
  attrName: string,
): number | null => {
  const regex = new RegExp(`${buildAttrPattern(attrName)}="([^"]+)"`, 'i')
  const match = xmp.match(regex)
  if (!match) return null
  return toNumber(match[1])
}

/**
 * 在 Buffer 中定位嵌入的 MP4 视频偏移量
 * 与前端 findVideoOffset (useLivePhotoProcessor.ts) 保持一致的算法
 */
function findVideoOffset(buffer: Buffer): number {
  // 1. Google MicroVideoOffset (XMP 元数据)
  const text = buffer.toString('utf8', 0, Math.min(buffer.length, 512 * 1024))
  let match = text.match(/MicroVideoOffset=["']?(\d+)["']?/)
  if (!match) match = text.match(/MicroVideoOffset>(\d+)</)

  if (match) {
    const reverseOffset = parseInt(match[1], 10)
    const offset = buffer.length - reverseOffset
    if (offset > 0 && offset < buffer.length) {
      return offset
    }
  }

  // 2. 回退：扫描 ftyp 签名（兼容三星等设备）
  const ftyp = MP4_FTYP

  // 从文件末尾 8MB 开始扫描（视频通常在末尾）
  const scanStart = Math.max(0, buffer.length - 8 * 1024 * 1024)
  for (let i = scanStart; i < buffer.length - 4; i++) {
    if (
      buffer[i] === ftyp[0] &&
      buffer[i + 1] === ftyp[1] &&
      buffer[i + 2] === ftyp[2] &&
      buffer[i + 3] === ftyp[3]
    ) {
      const offset = i - 4
      // 验证：视频块至少 8KB
      if (offset > 0 && buffer.length - offset > MIN_VIDEO_SIZE_BYTES) {
        return offset
      }
    }
  }

  // 全文扫描兜底
  for (let i = 0; i < scanStart; i++) {
    if (
      buffer[i] === ftyp[0] &&
      buffer[i + 1] === ftyp[1] &&
      buffer[i + 2] === ftyp[2] &&
      buffer[i + 3] === ftyp[3]
    ) {
      const offset = i - 4
      if (offset > 0 && buffer.length - offset > MIN_VIDEO_SIZE_BYTES) {
        // 排除文件开头的 ftyp（那是图片格式的 ftyp，不是视频的）
        if (i > 32) return offset
      }
    }
  }

  return -1
}

export const processMotionPhotoFromXmp = async ({
  storageKey,
  rawImageBuffer,
  exifData,
  logger,
}: MotionPhotoProcessParams): Promise<MotionPhotoProcessResult | null> => {
  try {
    const exifIndicatesMotion =
      toBoolean(exifData?.MotionPhoto) || toBoolean(exifData?.MicroVideo)
    let detectedMotion = exifIndicatesMotion

    let presentationTimestampUs = toNumber(
      exifData?.MotionPhotoPresentationTimestampUs ??
        exifData?.MicroVideoPresentationTimestampUs,
    )

    const xmpSegment = extractXmpSegment(rawImageBuffer)
    if (xmpSegment) {
      if (!detectedMotion) {
        const motionFlags = [
          extractXmpBoolean(xmpSegment, 'MotionPhoto'),
          extractXmpBoolean(xmpSegment, 'GCamera:MotionPhoto'),
          extractXmpBoolean(xmpSegment, 'MicroVideo'),
          extractXmpBoolean(xmpSegment, 'GCamera:MicroVideo'),
          extractXmpAttributeBoolean(xmpSegment, 'MotionPhoto'),
          extractXmpAttributeBoolean(xmpSegment, 'GCamera:MotionPhoto'),
          extractXmpAttributeBoolean(xmpSegment, 'MicroVideo'),
          extractXmpAttributeBoolean(xmpSegment, 'GCamera:MicroVideo'),
        ].filter((flag) => flag !== null) as boolean[]

        if (motionFlags.some(Boolean)) {
          detectedMotion = true
          logger?.info(
            `[motion-photo] XMP detected MotionPhoto flags for ${storageKey}`,
          )
        }
      }

      if (presentationTimestampUs === null) {
        presentationTimestampUs =
          extractXmpNumber(xmpSegment, 'MotionPhotoPresentationTimestampUs') ??
          extractXmpNumber(xmpSegment, 'MicroVideoPresentationTimestampUs') ??
          extractXmpAttributeNumber(
            xmpSegment,
            'MotionPhotoPresentationTimestampUs',
          ) ??
          extractXmpAttributeNumber(
            xmpSegment,
            'MicroVideoPresentationTimestampUs',
          ) ??
          null
      }
    }

    if (!detectedMotion) {
      // 没有 XMP 标记时，尝试通过 ftyp 扫描检测
      const offset = findVideoOffset(rawImageBuffer)
      if (offset < 0) {
        return null
      }
      logger?.info(
        `[motion-photo] Detected Motion Photo via ftyp scan for ${storageKey} at offset ${offset}`,
      )
      return {
        isMotionPhoto: true,
        videoOffset: offset,
        presentationTimestampUs: presentationTimestampUs ?? undefined,
      }
    } else {
      // 有 XMP 标记时，用 findVideoOffset 验证嵌入视频确实存在
      const offset = findVideoOffset(rawImageBuffer)
      if (offset < 0) {
        logger?.warn(
          `[motion-photo] XMP indicates Motion Photo but no valid MP4 found for ${storageKey}`,
        )
        return null
      }
      logger?.success(
        `[motion-photo] Detected Motion Photo for ${storageKey}, video will be extracted client-side`,
      )
      return {
        isMotionPhoto: true,
        videoOffset: offset,
        presentationTimestampUs: presentationTimestampUs ?? undefined,
      }
    }
  } catch (error) {
    logger?.error(
      `[motion-photo] Unexpected error while processing ${storageKey}`,
      error,
    )
    return null
  }
}

export type MotionPhotoOffsetSource =
  | 'micro-video-offset'
  | 'container-directory'
  | 'ftyp-scan'

export interface MotionPhotoVideoOffset {
  offset: number
  source: MotionPhotoOffsetSource
}

const MAX_XMP_SCAN_BYTES = 512 * 1024 // XMP 块位于文件头部
const MIN_VIDEO_SIZE_BYTES = 8 * 1024
const TYPE_FTYP = 0x66747970 // 'ftyp'
const TYPE_MOOV = 0x6d6f6f76 // 'moov'
const TYPE_TRAK = 0x7472616b // 'trak'

function boxSize(dv: DataView, boxStart: number): number {
  const size = dv.getUint32(boxStart, false)
  if (size === 1) {
    // 64 位长度 box（极罕见）：高 32 位必须为 0
    if (dv.getUint32(boxStart + 8, false) !== 0) {
      return -1
    }
    return dv.getUint32(boxStart + 12, false)
  }
  return size
}

function looksLikeMp4Container(
  dv: DataView,
  viewLength: number,
  offset: number,
): boolean {
  if (offset < 0 || offset + 16 > viewLength) {
    return false
  }
  if (dv.getUint32(offset + 4, false) !== TYPE_FTYP) {
    return false
  }
  const ftypSize = boxSize(dv, offset)
  const moovStart = offset + ftypSize
  if (ftypSize < 8 || moovStart + 16 > viewLength) {
    return false
  }
  if (dv.getUint32(moovStart + 4, false) !== TYPE_MOOV) {
    return false
  }
  const moovSize = boxSize(dv, moovStart)
  const moovEnd = moovStart + moovSize
  if (moovSize < 8 || moovEnd > viewLength) {
    return false
  }
  let cursor = moovStart + 8
  while (cursor + 8 <= moovEnd) {
    const childSize = boxSize(dv, cursor)
    if (childSize < 8 || cursor + childSize > moovEnd) {
      return false
    }
    if (dv.getUint32(cursor + 4, false) === TYPE_TRAK) {
      return true
    }
    cursor += childSize
  }
  return false
}

interface ContainerItem {
  semantic: string
  length: number | null
  padding: number
}

function toNonNegativeInt(value: string | undefined): number | null {
  if (value === undefined) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

// Google Container:Directory 规范，OnePlus/Oppo 沿用
function parseContainerItems(xmpText: string): ContainerItem[] {
  const items: ContainerItem[] = []
  for (const match of xmpText.matchAll(/<(?:[\w-]+:)?Item\b[^>]*>/g)) {
    const tag = match[0]
    const semantic =
      /(?:[\w-]+:)?Semantic="([^"]+)"/.exec(tag)?.[1] ?? undefined
    if (!semantic) {
      continue
    }
    items.push({
      semantic,
      length: toNonNegativeInt(
        /(?:[\w-]+:)?Length="([^"]+)"/.exec(tag)?.[1],
      ),
      padding:
        toNonNegativeInt(
          /(?:[\w-]+:)?Padding="([^"]+)"/.exec(tag)?.[1],
        ) ?? 0,
    })
  }
  return items
}

function offsetFromContainerDirectory(
  dv: DataView,
  viewLength: number,
  xmpText: string,
): number | null {
  const items = parseContainerItems(xmpText)
  const videoIndex = items.findIndex(
    (item) => item.semantic.toLowerCase() === 'motionphoto',
  )
  if (videoIndex === -1) {
    return null
  }
  const video = items[videoIndex]
  if (video === undefined || video.length === null) {
    return null
  }

  const candidates: number[] = []

  let sum = 0
  let sumValid = true
  for (let i = 0; i < videoIndex; i += 1) {
    const item = items[i]
    if (item === undefined || item.length === null) {
      sumValid = false
      break
    }
    sum += item.length + item.padding
  }
  if (sumValid) {
    candidates.push(sum)
  }

  if (videoIndex === items.length - 1) {
    candidates.push(viewLength - (video.length + video.padding))
  }

  for (const candidate of candidates) {
    if (candidate >= 0 && candidate < viewLength) {
      if (looksLikeMp4Container(dv, viewLength, candidate)) {
        return candidate
      }
    }
  }
  return null
}

export function findMotionPhotoVideoOffset(
  view: Uint8Array,
): MotionPhotoVideoOffset | null {
  if (!view || view.length <= MIN_VIDEO_SIZE_BYTES) {
    return null
  }

  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength)
  const xmpText = new TextDecoder('utf-8').decode(
    view.subarray(0, Math.min(view.length, MAX_XMP_SCAN_BYTES)),
  )

  let match = xmpText.match(/MicroVideoOffset=["']?(\d+)["']?/)
  if (!match) match = xmpText.match(/MicroVideoOffset>(\d+)</)
  if (match?.[1] !== undefined) {
    const offset = view.length - Number.parseInt(match[1], 10)
    if (offset > 0 && offset < view.length) {
      return { offset, source: 'micro-video-offset' }
    }
  }

  const containerOffset = offsetFromContainerDirectory(dv, view.length, xmpText)
  if (containerOffset !== null) {
    return { offset: containerOffset, source: 'container-directory' }
  }

  for (let i = 0; i + 4 < view.length; i += 1) {
    if (dv.getUint32(i, false) !== TYPE_FTYP) {
      continue
    }
    // 文件开头的 ftyp 属于图片容器（如 HEIC），不是视频的
    if (i <= 32) {
      continue
    }
    const offset = i - 4
    if (view.length - offset <= MIN_VIDEO_SIZE_BYTES) {
      continue
    }
    // 校验顶层 MP4 结构，避开 mdat 内嵌套/水印 MP4 的 ftyp
    if (!looksLikeMp4Container(dv, view.length, offset)) {
      continue
    }
    return { offset, source: 'ftyp-scan' }
  }

  return null
}

import { desc, notInArray } from 'drizzle-orm'
import { applyThumbnailTransform } from '~~/server/utils/storageTransform'
import { useStorageProvider } from '~~/server/utils/useStorageProvider'

export default eventHandler(async (event) => {
  const db = useDB()
  const { storageProvider } = useStorageProvider(event)

  // 获取所有隐藏相册中的照片ID
  const hiddenAlbumPhotos = db
    .select({
      photoId: tables.albumPhotos.photoId,
    })
    .from(tables.albumPhotos)
    .innerJoin(tables.albums, eq(tables.albumPhotos.albumId, tables.albums.id))
    .where(eq(tables.albums.isHidden, true))
    .all()

  const hiddenPhotoIds = hiddenAlbumPhotos.map((row) => row.photoId)

  // 查询所有照片，排除隐藏相册中的照片
  if (hiddenPhotoIds.length > 0) {
    return applyThumbnailTransform(
      await db
        .select()
        .from(tables.photos)
        .where(notInArray(tables.photos.id, hiddenPhotoIds))
        .orderBy(desc(tables.photos.dateTaken))
        .all(),
      storageProvider.config,
    )
  }

  // 如果没有隐藏的照片，直接返回所有照片
  return applyThumbnailTransform(
    await db
      .select()
      .from(tables.photos)
      .orderBy(desc(tables.photos.dateTaken))
      .all(),
    storageProvider.config,
  )
})

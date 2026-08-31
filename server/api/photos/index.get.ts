import { desc } from 'drizzle-orm'
import { applyThumbnailTransform } from '~~/server/utils/storageTransform'
import { useStorageProvider } from '~~/server/utils/useStorageProvider'

export default eventHandler(async (event) => {
  const { storageProvider } = useStorageProvider(event)
  return applyThumbnailTransform(
    await useDB()
      .select()
      .from(tables.photos)
      .orderBy(desc(tables.photos.dateTaken))
      .all(),
    storageProvider.config,
  )
})

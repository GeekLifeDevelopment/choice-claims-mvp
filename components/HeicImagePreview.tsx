'use client'

import { useEffect, useState } from 'react'

type HeicImagePreviewProps = {
  sourceUrl: string
  filename: string
  className?: string
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; imageUrl: string }
  | { status: 'error'; message: string }

function isHeicLike(filename: string): boolean {
  return /\.(heic|heif)$/i.test(filename)
}

export function HeicImagePreview({ sourceUrl, filename, className }: HeicImagePreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })

  useEffect(() => {
    let disposed = false
    let objectUrl: string | null = null

    async function convertHeicToJpeg(): Promise<void> {
      try {
        const response = await fetch(sourceUrl)
        if (!response.ok) {
          throw new Error('Failed to load image source')
        }

        const blob = await response.blob()
        const mimeType = blob.type.toLowerCase()
        const needsConversion = mimeType.includes('heic') || mimeType.includes('heif') || isHeicLike(filename)

        let outputBlob: Blob = blob
        if (needsConversion) {
          const converterModule = await import('heic2any')
          const converter = converterModule.default as (input: {
            blob: Blob
            toType?: string
            quality?: number
          }) => Promise<Blob | Blob[]>

          const converted = await converter({
            blob,
            toType: 'image/jpeg',
            quality: 0.9
          })

          outputBlob = Array.isArray(converted) ? converted[0] : converted
        }

        objectUrl = URL.createObjectURL(outputBlob)
        if (!disposed) {
          setState({ status: 'ready', imageUrl: objectUrl })
        }
      } catch {
        if (!disposed) {
          setState({
            status: 'error',
            message: 'HEIC preview unavailable in this browser. Use Open file to view the original image.'
          })
        }
      }
    }

    setState({ status: 'loading' })
    void convertHeicToJpeg()

    return () => {
      disposed = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [filename, sourceUrl])

  if (state.status === 'loading') {
    return <p className="text-xs text-slate-600">Preparing HEIC preview...</p>
  }

  if (state.status === 'error') {
    return <p className="text-xs text-slate-600">{state.message}</p>
  }

  return <img src={state.imageUrl} alt={filename} className={className} />
}

import { useEffect, useMemo } from 'react';

/** Miniatura de la foto guardada en IndexedDB (crea y libera la URL del Blob). */
export function Miniatura({ foto, alt, className = 'miniatura' }: { foto: Blob | null | undefined; alt: string; className?: string }) {
  const url = useMemo(() => (foto ? URL.createObjectURL(foto) : null), [foto]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url ? <img src={url} alt={alt} className={className} /> : null;
}

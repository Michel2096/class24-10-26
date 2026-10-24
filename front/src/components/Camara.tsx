import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  onCapturar: (foto: Blob) => void;
  onCerrar: () => void;
}

type Estado = 'aviso' | 'abriendo' | 'vista' | 'error';

const LADO_MAX = 800;

/** Traduce los errores de getUserMedia a mensajes que el usuario pueda resolver. */
function mensajeError(e: unknown): string {
  const nombre = e instanceof DOMException ? e.name : '';
  switch (nombre) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permiso de cámara denegado. Actívalo en el candado de la barra de direcciones → Cámara → Permitir, y vuelve a intentarlo.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No se encontró ninguna cámara en este dispositivo.';
    case 'NotReadableError':
    case 'AbortError':
      return 'La cámara está siendo usada por otra aplicación o no responde.';
    default:
      return `No se pudo abrir la cámara${e instanceof Error ? `: ${e.message}` : ''}.`;
  }
}

/** Redimensiona y comprime a JPEG para no llenar IndexedDB con fotos de varios MB. */
async function comprimir(fuente: CanvasImageSource, ancho: number, alto: number): Promise<Blob> {
  const escala = Math.min(1, LADO_MAX / Math.max(ancho, alto));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(ancho * escala);
  lienzo.height = Math.round(alto * escala);
  lienzo.getContext('2d')!.drawImage(fuente, 0, 0, lienzo.width, lienzo.height);
  return new Promise((ok, falla) => lienzo.toBlob((b) => (b ? ok(b) : falla(new Error('No se pudo generar la imagen'))), 'image/jpeg', 0.8));
}

const soportaGetUserMedia = () => !!navigator.mediaDevices?.getUserMedia;

/**
 * Captura de imagen con la cámara (MediaDevices.getUserMedia).
 * Antes de pedir el permiso se explica para qué se usa; si el navegador no permite la API
 * (sin HTTPS, iOS antiguo, permiso bloqueado) se ofrece el selector nativo `capture`.
 */
export function Camara({ onCapturar, onCerrar }: Props) {
  const [estado, setEstado] = useState<Estado>('aviso');
  const [error, setError] = useState<string | null>(null);
  const [permiso, setPermiso] = useState<PermissionState | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const flujo = useRef<MediaStream | null>(null);

  // Estado del permiso (Chrome/Edge lo exponen; Firefox y Safari no para la cámara).
  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((p) => {
        setPermiso(p.state);
        p.onchange = () => setPermiso(p.state);
      })
      .catch(() => {});
  }, []);

  const detener = () => {
    flujo.current?.getTracks().forEach((t) => t.stop());
    flujo.current = null;
  };
  useEffect(() => detener, []);

  async function abrir() {
    setEstado('abriendo');
    setError(null);
    try {
      if (!window.isSecureContext) throw new Error('la cámara solo está disponible en HTTPS o localhost');
      flujo.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      setEstado('vista');
    } catch (e) {
      setError(mensajeError(e));
      setEstado('error');
    }
  }

  useEffect(() => {
    if (estado === 'vista' && video.current && flujo.current) video.current.srcObject = flujo.current;
  }, [estado]);

  async function capturar() {
    const v = video.current;
    if (!v?.videoWidth) return;
    const foto = await comprimir(v, v.videoWidth, v.videoHeight);
    detener();
    onCapturar(foto);
  }

  async function desdeArchivo(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    if (!archivo) return;
    try {
      const img = await createImageBitmap(archivo);
      onCapturar(await comprimir(img, img.width, img.height));
    } catch {
      setError('El archivo seleccionado no es una imagen válida.');
      setEstado('error');
    }
  }

  const cerrar = () => {
    detener();
    onCerrar();
  };

  // Portal a <body>: el modal del formulario tiene su propio contexto de apilamiento y recortaría la cámara.
  return createPortal(
    <div className="modal modal--encima" role="dialog" aria-modal="true" aria-labelledby="camara-titulo" onClick={cerrar}>
      <div className="modal__caja camara" onClick={(e) => e.stopPropagation()}>
        <h2 id="camara-titulo">Foto del lápiz</h2>

        {(estado === 'aviso' || estado === 'abriendo') && (
          <div className="aviso-permiso">
            <span aria-hidden="true">📷</span>
            <p>
              <strong>LapiStock pedirá permiso para usar la cámara.</strong> Solo se usa para fotografiar el lápiz o su
              empaque; la imagen se guarda <strong>únicamente en este dispositivo</strong> y funciona sin conexión.
            </p>
            {permiso === 'denied' && (
              <p className="alerta alerta--error">El permiso de cámara está bloqueado para este sitio. Cámbialo en la configuración del navegador.</p>
            )}
          </div>
        )}

        {estado === 'vista' && <video ref={video} className="camara__video" autoPlay playsInline muted />}

        {error && <p className="alerta alerta--error">{error}</p>}

        <div className="acciones">
          <button type="button" className="btn btn--fantasma" onClick={cerrar}>
            Cancelar
          </button>
          <label className="btn btn--fantasma" title="Usa la cámara o galería del sistema">
            Elegir archivo
            <input type="file" accept="image/*" capture="environment" hidden onChange={desdeArchivo} />
          </label>
          {estado === 'vista' ? (
            <button type="button" className="btn" onClick={capturar}>
              Capturar
            </button>
          ) : (
            soportaGetUserMedia() && (
              <button type="button" className="btn" onClick={abrir} disabled={estado === 'abriendo'}>
                {estado === 'abriendo' ? 'Esperando permiso…' : estado === 'error' ? 'Reintentar' : 'Permitir y abrir cámara'}
              </button>
            )
          )}
        </div>
        {!soportaGetUserMedia() && <p className="nota">Este navegador no permite la cámara en vivo; usa «Elegir archivo».</p>}
      </div>
    </div>,
    document.body,
  );
}

/** Miniatura de la foto guardada en IndexedDB (crea y libera la URL del Blob). */
export function Miniatura({ foto, alt, className = 'miniatura' }: { foto: Blob | null | undefined; alt: string; className?: string }) {
  const url = useMemo(() => (foto ? URL.createObjectURL(foto) : null), [foto]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url ? <img src={url} alt={alt} className={className} /> : null;
}

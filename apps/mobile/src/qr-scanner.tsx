import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Flashlight, RefreshCw, Video } from 'lucide-react';
import jsQR from 'jsqr';

interface DetectedBarcode {
  rawValue?: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

type CameraStatus = 'idle' | 'starting' | 'streaming' | 'stopped' | 'error';
type FacingMode = 'environment' | 'user';

function createBarcodeDetector(): BarcodeDetectorLike | null {
  const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: ['qr_code'] });
  } catch {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

async function decodeWithBarcodeDetector(
  source: CanvasImageSource,
  detector: BarcodeDetectorLike | null,
): Promise<string | null> {
  if (!detector) return null;
  try {
    const results = await detector.detect(source);
    for (const item of results) {
      const value = item.rawValue?.trim();
      if (value) return value;
    }
  } catch {
    // Fall back to jsQR when native BarcodeDetector fails on a frame/source.
  }
  return null;
}

export function decodeQrFromImageData(imageData: ImageData): string | null {
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  const value = result?.data?.trim();
  return value || null;
}

export async function decodeQrFromCanvas(
  canvas: HTMLCanvasElement,
  detector: BarcodeDetectorLike | null = createBarcodeDetector(),
): Promise<string | null> {
  const nativeValue = await decodeWithBarcodeDetector(canvas, detector);
  if (nativeValue) return nativeValue;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || canvas.width < 1 || canvas.height < 1) return null;

  const fullPixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const fullValue = decodeQrFromImageData(fullPixels);
  if (fullValue) return fullValue;

  // Retry a 65% center crop for monitor photos with surrounding bezels or glare.
  if (canvas.width >= 80 && canvas.height >= 80) {
    const cropWidth = Math.round(canvas.width * 0.65);
    const cropHeight = Math.round(canvas.height * 0.65);
    const cropX = Math.round((canvas.width - cropWidth) / 2);
    const cropY = Math.round((canvas.height - cropHeight) / 2);
    const cropPixels = context.getImageData(cropX, cropY, cropWidth, cropHeight);
    const cropValue = decodeQrFromImageData(cropPixels);
    if (cropValue) return cropValue;
  }

  return null;
}

export async function decodeQrFromImageFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not open this image.'));
    });

    const detector = createBarcodeDetector();
    const directNative = await decodeWithBarcodeDetector(image, detector);
    if (directNative) return directNative;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not read the image.');

    const maxNatural = Math.max(image.naturalWidth, image.naturalHeight);
    if (maxNatural < 1) throw new Error('Could not read the image.');

    const scales = [1800, 1000]
      .map(limit => Math.min(1, limit / maxNatural))
      .filter((scale, index, list) => list.indexOf(scale) === index);

    for (const scale of scales) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const decoded = await decodeQrFromCanvas(canvas, detector);
      if (decoded) return decoded;
    }

    throw new Error('No QR code found. Try again with the whole code in view.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function describeCameraError(cause: unknown): string {
  const name = cause instanceof DOMException || cause instanceof Error ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission denied. Allow camera access or use a QR photo below.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found on this device. Use a QR photo or enter the code below.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is in use by another app. Close it and retry, or use a QR photo.';
  }
  if (name === 'SecurityError') {
    return 'Live camera requires a secure context (HTTPS or app container).';
  }
  return 'Could not start live camera. Use a QR photo or enter the pairing code below.';
}

export function LiveQrScanner({
  onDetected,
  active,
}: {
  onDetected: (data: string) => void | Promise<void>;
  active: boolean;
}) {
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [facingMode, setFacingMode] = useState<FacingMode>('environment');
  const [message, setMessage] = useState('Starting live camera…');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const sessionRef = useRef(0);
  const detectedRef = useRef(false);
  const busyFrameRef = useRef(false);
  const lastScanAtRef = useRef(0);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  const stopTracks = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    busyFrameRef.current = false;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors during cleanup.
        }
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchSupported(false);
    setTorchOn(false);
  }, []);

  const stopCamera = useCallback(
    (nextStatus: CameraStatus = 'stopped', nextMessage = 'Live camera stopped.') => {
      sessionRef.current++;
      stopTracks();
      setStatus(nextStatus);
      setMessage(nextMessage);
    },
    [stopTracks],
  );

  const scanLoop = useCallback(
    (sessionId: number) => {
      const tick = (now: number) => {
        if (sessionRef.current !== sessionId || detectedRef.current) return;
        rafRef.current = window.requestAnimationFrame(tick);

        if (now - lastScanAtRef.current < 75 || busyFrameRef.current) return;
        const video = videoRef.current;
        if (!video || video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return;

        lastScanAtRef.current = now;
        busyFrameRef.current = true;

        void (async () => {
          try {
            const nativeCode = await decodeWithBarcodeDetector(video, detectorRef.current);
            if (sessionRef.current !== sessionId || detectedRef.current) return;
            if (nativeCode) {
              detectedRef.current = true;
              stopCamera('idle', 'QR code detected. Connecting…');
              await onDetectedRef.current(nativeCode);
              return;
            }

            const canvas = canvasRef.current ?? (canvasRef.current = document.createElement('canvas'));
            const maxSide = Math.max(video.videoWidth, video.videoHeight);
            const scale = Math.min(1, 960 / maxSide);
            const width = Math.max(1, Math.round(video.videoWidth * scale));
            const height = Math.max(1, Math.round(video.videoHeight * scale));
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width;
              canvas.height = height;
            }

            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) return;
            context.drawImage(video, 0, 0, width, height);

            const fullPixels = context.getImageData(0, 0, width, height);
            let decoded = decodeQrFromImageData(fullPixels);
            if (!decoded && width >= 80 && height >= 80) {
              const cropWidth = Math.round(width * 0.65);
              const cropHeight = Math.round(height * 0.65);
              const cropX = Math.round((width - cropWidth) / 2);
              const cropY = Math.round((height - cropHeight) / 2);
              decoded = decodeQrFromImageData(context.getImageData(cropX, cropY, cropWidth, cropHeight));
            }

            if (decoded && sessionRef.current === sessionId && !detectedRef.current) {
              detectedRef.current = true;
              stopCamera('idle', 'QR code detected. Connecting…');
              await onDetectedRef.current(decoded);
            }
          } finally {
            busyFrameRef.current = false;
          }
        })();
      };

      rafRef.current = window.requestAnimationFrame(tick);
    },
    [stopCamera],
  );

  const startCamera = useCallback(
    async (mode: FacingMode) => {
      const sessionId = ++sessionRef.current;
      stopTracks();
      detectedRef.current = false;

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setMessage('Live camera is unavailable here. Use a QR photo or enter the code below.');
        return;
      }

      setStatus('starting');
      setMessage('Starting live camera…');

      if (!detectorRef.current) {
        detectorRef.current = createBarcodeDetector();
      }

      const attempts: MediaStreamConstraints[] = [
        { audio: false, video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        { audio: false, video: { facingMode: mode } },
        { audio: false, video: true },
      ];

      let stream: MediaStream | null = null;
      let lastError: unknown = null;

      for (const constraints of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (cause) {
          lastError = cause;
          const name = cause instanceof DOMException || cause instanceof Error ? cause.name : '';
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
            break;
          }
        }
      }

      if (!stream) {
        if (sessionRef.current !== sessionId) return;
        setStatus('error');
        setMessage(describeCameraError(lastError));
        return;
      }

      if (sessionRef.current !== sessionId) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorchSupported(Boolean(capabilities?.torch));

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }

      if (sessionRef.current !== sessionId) return;
      setStatus('streaming');
      setMessage('Point camera at the QR code on desktop.');
      scanLoop(sessionId);
    },
    [scanLoop, stopTracks],
  );

  useEffect(() => {
    if (!active) {
      stopCamera('idle', 'Camera paused.');
      return;
    }
    void startCamera(facingMode);
    const onVisibility = () => {
      if (document.hidden) {
        stopCamera('stopped', 'Camera paused while app is in background.');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      sessionRef.current++;
      stopTracks();
    };
  }, [active, facingMode, startCamera, stopCamera, stopTracks]);

  const switchCamera = () => {
    setFacingMode(current => (current === 'environment' ? 'user' : 'environment'));
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  };

  return (
    <section className="qr-scanner" data-testid="live-qr-scanner" aria-label="Live QR scanner">
      <div className="qr-viewfinder">
        <video
          ref={videoRef}
          data-testid="qr-scanner-video"
          aria-label="Live QR camera preview"
          className={`qr-video ${status === 'streaming' ? 'is-live' : ''}`}
          playsInline
          muted
          autoPlay
          {...({ 'webkit-playsinline': 'true' } as Record<string, string>)}
        />
        {status === 'streaming' ? (
          <div className="qr-reticle" aria-hidden="true">
            <span className="qr-corner qr-corner-tl" />
            <span className="qr-corner qr-corner-tr" />
            <span className="qr-corner qr-corner-bl" />
            <span className="qr-corner qr-corner-br" />
            <span className="qr-scanline" />
          </div>
        ) : (
          <div className="qr-placeholder">
            {status === 'starting' ? <Camera size={24} /> : <CameraOff size={24} />}
            <p>{message}</p>
          </div>
        )}
        <span className={`qr-status-badge ${status === 'streaming' ? 'is-live' : ''}`}>
          <i />
          {status === 'streaming' ? 'Live camera' : status === 'starting' ? 'Starting…' : 'Camera off'}
        </span>
      </div>

      {status === 'streaming' && (
        <p className="qr-status-text">{message}</p>
      )}

      <div className="qr-controls">
        {status === 'streaming' ? (
          <>
            <button
              type="button"
              className="qr-control-button"
              aria-label="Switch camera"
              onClick={switchCamera}
            >
              <RefreshCw size={15} />
              <span>Switch</span>
            </button>
            {torchSupported && (
              <button
                type="button"
                className={`qr-control-button ${torchOn ? 'is-active' : ''}`}
                aria-label="Toggle flashlight"
                aria-pressed={torchOn}
                onClick={() => void toggleTorch()}
              >
                <Flashlight size={15} />
                <span>Light</span>
              </button>
            )}
            <button
              type="button"
              className="qr-control-button"
              aria-label="Stop camera"
              onClick={() => stopCamera('stopped')}
            >
              <CameraOff size={15} />
              <span>Stop</span>
            </button>
          </>
        ) : status !== 'starting' ? (
          <button
            type="button"
            className="qr-control-button qr-control-primary"
            aria-label="Start live camera"
            onClick={() => void startCamera(facingMode)}
          >
            <Video size={15} />
            <span>Start live camera</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

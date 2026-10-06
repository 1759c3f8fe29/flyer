import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { Env, Limits } from '@/src/config/env';
import { ensureCallPermissions, request } from './PermissionManager';

/**
 * MediaManager — picking, compression, Cloudinary upload, and voice notes.
 *
 * Storage is Cloudinary via an *unsigned* upload preset, which is the intended
 * client-side flow: the preset name is public, and Cloudinary enforces limits
 * (size, format, folder) on the preset itself. Configure the preset with
 * "Incoming transformation" c_limit,w_1280 for video so large uploads are
 * transcoded server-side.
 */

export interface UploadResult {
  url: string;
  publicId: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bytes: number;
}

export interface PickedMedia {
  uri: string;
  type: 'image' | 'video';
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Poster frame, generated locally for video so the preview is instant. */
  thumbnailUri: string | null;
}

type ResourceType = 'image' | 'video';

function endpoint(resource: ResourceType): string {
  return `https://api.cloudinary.com/v1_1/${Env.cloudinaryCloudName}/${resource}/upload`;
}

/**
 * Cloudinary delivers transformations by URL, so we never need a second upload
 * to get a smaller variant. `f_auto,q_auto` alone typically cuts payloads by
 * half with no visible loss.
 */
export function transformed(
  url: string,
  opts: { width?: number; height?: number; crop?: string; quality?: string } = {}
): string {
  if (!url.includes('/upload/')) return url;
  const parts = ['f_auto', `q_${opts.quality ?? 'auto'}`];
  if (opts.width) parts.push(`w_${opts.width}`);
  if (opts.height) parts.push(`h_${opts.height}`);
  parts.push(`c_${opts.crop ?? 'limit'}`);
  return url.replace('/upload/', `/upload/${parts.join(',')}/`);
}

/** Poster frame for a Cloudinary-hosted video, no extra upload required. */
export function videoPoster(url: string, width = 640): string {
  if (!url.includes('/upload/')) return url;
  return url
    .replace('/upload/', `/upload/so_0,w_${width},c_limit,f_jpg,q_auto/`)
    .replace(/\.(mp4|mov|m4v|webm)$/i, '.jpg');
}

export function thumbUrl(url: string, size = 400): string {
  return transformed(url, { width: size, crop: 'limit' });
}

// --- upload ---------------------------------------------------------------

/**
 * Uploads with XMLHttpRequest rather than fetch because we need real upload
 * progress for the in-bubble indicator; fetch has no progress event in RN.
 */
export function uploadToCloudinary(
  uri: string,
  resource: ResourceType,
  onProgress?: (fraction: number) => void,
  signal?: { aborted: boolean }
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (!Env.cloudinaryCloudName || !Env.cloudinaryUploadPreset) {
      reject(new Error('Cloudinary is not configured. See .env.example.'));
      return;
    }

    const name = uri.split('/').pop() ?? `upload-${Date.now()}`;
    const form = new FormData();
    form.append('file', {
      uri,
      name,
      type: resource === 'image' ? 'image/jpeg' : 'video/mp4',
    } as unknown as Blob);
    form.append('upload_preset', Env.cloudinaryUploadPreset);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint(resource));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            `Cloudinary upload failed (${xhr.status}). ` +
              `Check that the preset "${Env.cloudinaryUploadPreset}" exists and is set to Unsigned. ` +
              xhr.responseText.slice(0, 200)
          )
        );
        return;
      }
      try {
        const json = JSON.parse(xhr.responseText);
        resolve({
          url: json.secure_url,
          publicId: json.public_id,
          width: json.width ?? null,
          height: json.height ?? null,
          durationMs: json.duration ? Math.round(json.duration * 1000) : null,
          bytes: json.bytes ?? 0,
        });
      } catch (e) {
        reject(new Error(`Cloudinary returned malformed JSON: ${String(e)}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));

    if (signal) {
      const poll = setInterval(() => {
        if (signal.aborted) {
          clearInterval(poll);
          xhr.abort();
        }
        if (xhr.readyState === 4) clearInterval(poll);
      }, 250);
    }

    xhr.send(form);
  });
}

// --- compression ----------------------------------------------------------

/** Downscale + re-encode to JPEG. Typically 3-8x smaller than a phone original. */
export async function compressImage(uri: string): Promise<{
  uri: string;
  width: number;
  height: number;
}> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: Limits.imageMaxDimension } }],
    {
      compress: Limits.imageQuality,
      format: ImageManipulator.SaveFormat.JPEG,
    }
  );
  return { uri: result.uri, width: result.width, height: result.height };
}

/**
 * Generates a local poster frame so the send-preview and the pending bubble can
 * render before the upload finishes.
 *
 * On-device video *transcoding* is not available in Expo without a native module
 * (react-native-compressor). We reduce video weight two other ways instead:
 * capture quality is capped at pick time, and delivery goes through a Cloudinary
 * width-limited transformation. If you need true pre-upload transcoding, add
 * react-native-compressor and call it here.
 */
export async function videoThumbnail(uri: string): Promise<string | null> {
  try {
    const { uri: thumb } = await VideoThumbnails.getThumbnailAsync(uri, {
      time: 300,
      quality: 0.6,
    });
    return thumb;
  } catch (e) {
    console.warn('[Flyer/media] thumbnail generation failed', e);
    return null;
  }
}

export async function fileSize(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    return info.exists && 'size' in info ? (info.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

// --- picking --------------------------------------------------------------

async function toPicked(
  asset: ImagePicker.ImagePickerAsset
): Promise<PickedMedia> {
  const isVideo = asset.type === 'video';

  if (isVideo) {
    return {
      uri: asset.uri,
      type: 'video',
      width: asset.width ?? null,
      height: asset.height ?? null,
      durationMs: asset.duration ?? null,
      thumbnailUri: await videoThumbnail(asset.uri),
    };
  }

  const compressed = await compressImage(asset.uri);
  return {
    uri: compressed.uri,
    type: 'image',
    width: compressed.width,
    height: compressed.height,
    durationMs: null,
    thumbnailUri: compressed.uri,
  };
}

export async function pickFromLibrary(
  kind: 'image' | 'video' | 'both' = 'both'
): Promise<PickedMedia[]> {
  const perm = await request('mediaLibrary');
  if (perm !== 'granted') return [];

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes:
      kind === 'image' ? ['images'] : kind === 'video' ? ['videos'] : ['images', 'videos'],
    allowsMultipleSelection: kind !== 'video',
    selectionLimit: 8,
    quality: Limits.imageQuality,
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    videoMaxDuration: 120,
    exif: false,
  });

  if (result.canceled) return [];
  return Promise.all(result.assets.map(toPicked));
}

export async function captureWithCamera(
  kind: 'image' | 'video' = 'image'
): Promise<PickedMedia | null> {
  const perm = await request('camera');
  if (perm !== 'granted') return null;

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: kind === 'image' ? ['images'] : ['videos'],
    quality: Limits.imageQuality,
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    videoMaxDuration: 120,
    exif: false,
  });

  if (result.canceled || !result.assets[0]) return null;
  return toPicked(result.assets[0]);
}

// --- voice notes ----------------------------------------------------------

export interface RecordingSample {
  /** 0..1 normalised loudness, sampled ~10x/sec for the waveform. */
  level: number;
  durationMs: number;
}

/**
 * Wraps expo-av's Recording with metering, a hard duration cap, and the audio
 * mode juggling that iOS needs (without setting playsInSilentModeIOS the
 * recording is silent when the ringer switch is off).
 */
export class VoiceRecorder {
  private recording: Audio.Recording | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onSample?: (s: RecordingSample) => void;
  private onAutoStop?: () => void;

  async start(
    onSample: (s: RecordingSample) => void,
    onAutoStop?: () => void
  ): Promise<boolean> {
    // Re-entrant guard: a double-tap otherwise orphans the first Recording
    // (still metering, still auto-stopping) while the handle is overwritten.
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.recording) {
      try {
        await this.recording.stopAndUnloadAsync();
      } catch {
        /* already dead — the handle is what matters */
      }
      this.recording = null;
    }

    const perm = await ensureCallPermissions(false);
    if (!perm.ok) return false;

    this.onSample = onSample;
    this.onAutoStop = onAutoStop;

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });

    const recording = new Audio.Recording();
    await recording.prepareToRecordAsync({
      ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    await recording.startAsync();
    this.recording = recording;

    this.timer = setInterval(async () => {
      const status = await recording.getStatusAsync();
      if (!status.isRecording) return;

      // metering is dBFS: -160 (silence) .. 0 (clipping). Map to 0..1 with a
      // -50dB floor, which is roughly where room noise sits.
      const db = status.metering ?? -160;
      const level = Math.max(0, Math.min(1, (db + 50) / 50));

      this.onSample?.({ level, durationMs: status.durationMillis ?? 0 });

      if ((status.durationMillis ?? 0) >= Limits.voiceNoteMaxMs) {
        this.onAutoStop?.();
      }
    }, 100);

    return true;
  }

  async stop(): Promise<{ uri: string; durationMs: number } | null> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const recording = this.recording;
    this.recording = null;
    if (!recording) return null;

    try {
      const status = await recording.getStatusAsync();
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      if (!uri) return null;
      return { uri, durationMs: status.durationMillis ?? 0 };
    } catch (e) {
      console.warn('[Flyer/media] failed to finalise recording', e);
      return null;
    }
  }

  async cancel(): Promise<void> {
    const result = await this.stop();
    if (result?.uri) {
      FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
    }
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

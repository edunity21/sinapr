// 카메라·녹화·마이크 레벨

// H.264 MP4(어디서나 재생) → WebM(Chrome·안드로이드) → 기본 MP4(Safari) 순서
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* 다음 후보 */ }
  }
  return '';
}

export function extOf(mime) {
  return /mp4/.test(mime || '') ? 'mp4' : 'webm';
}

export async function openCamera(facingMode = 'user') {
  if (!navigator.mediaDevices?.getUserMedia) {
    const e = new Error('이 브라우저는 카메라를 지원하지 않습니다.');
    e.code = 'NO_MEDIA';
    throw e;
  }
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio,
    });
  } catch (err) {
    if (err?.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ video: true, audio });
    throw err;
  }
}

export function cameraErrorText(err) {
  const n = err?.name || err?.code || '';
  if (!window.isSecureContext) return 'https 주소(또는 localhost)에서만 카메라를 쓸 수 있습니다. GitHub Pages 주소로 접속해 주세요.';
  if (n === 'NotAllowedError' || n === 'SecurityError') return '카메라·마이크 권한이 거부되었습니다. 주소창의 자물쇠(또는 설정 > 사이트 권한)에서 허용한 뒤 다시 시도해 주세요.';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return '카메라나 마이크를 찾지 못했습니다. 장치 연결을 확인해 주세요.';
  if (n === 'NotReadableError' || n === 'TrackStartError') return '다른 앱이 카메라를 쓰고 있습니다. 화상회의 앱 등을 닫고 다시 시도해 주세요.';
  if (n === 'NO_MEDIA') return '이 브라우저는 카메라를 지원하지 않습니다. 최신 Chrome·Safari·Edge를 사용해 주세요.';
  return `카메라를 열지 못했습니다 (${n || '알 수 없는 오류'}).`;
}

export class Recorder {
  constructor(stream, { mime, videoBitsPerSecond = 1_500_000, onChunk } = {}) {
    this.stream = stream;
    this.mime = mime;
    this.vbps = videoBitsPerSecond;
    this.onChunk = onChunk || (() => {});
    this.mr = null;
  }

  start() {
    const opts = { videoBitsPerSecond: this.vbps, audioBitsPerSecond: 96_000 };
    if (this.mime) opts.mimeType = this.mime;
    try {
      this.mr = new MediaRecorder(this.stream, opts);
    } catch {
      this.mr = new MediaRecorder(this.stream);
    }
    this.mr.ondataavailable = (e) => {
      if (e.data && e.data.size) this.onChunk(e.data);
    };
    this.mr.start(1000);
  }

  get mimeType() {
    return this.mr?.mimeType || this.mime || 'video/webm';
  }

  pause() {
    if (this.mr?.state === 'recording') this.mr.pause();
  }

  resume() {
    if (this.mr?.state === 'paused') this.mr.resume();
  }

  stop() {
    return new Promise((resolve) => {
      const mr = this.mr;
      if (!mr || mr.state === 'inactive') return resolve();
      mr.addEventListener('stop', () => resolve(), { once: true });
      try {
        mr.requestData?.();
      } catch { /* 일부 브라우저 미지원 */ }
      mr.stop();
    });
  }
}

/** 마이크 입력 크기(0~1). 음성 인식이 멈췄는지 판단하고 레벨 표시에 씁니다. */
export class Meter {
  constructor(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ok = false;
    if (!AC || !stream.getAudioTracks().length) return;
    try {
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(stream);
      this.an = this.ctx.createAnalyser();
      this.an.fftSize = 1024;
      src.connect(this.an);
      this.buf = new Uint8Array(this.an.fftSize);
      this.ok = true;
      this.ctx.resume?.();
    } catch {
      this.ok = false;
    }
  }

  level() {
    if (!this.ok) return 0;
    this.an.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = (this.buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 5);
  }

  close() {
    try {
      this.ctx?.close();
    } catch { /* 무시 */ }
  }
}

/** 화면 꺼짐 방지 */
export class WakeLock {
  async request() {
    try {
      if ('wakeLock' in navigator) this.lock = await navigator.wakeLock.request('screen');
    } catch { /* 지원 안 함 */ }
  }

  release() {
    try {
      this.lock?.release();
    } catch { /* 무시 */ }
    this.lock = null;
  }
}

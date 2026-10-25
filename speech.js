// 브라우저 음성 인식(Web Speech API) 래퍼
//
// 휴대폰·태블릿에서도 오래 버티도록:
// - 모바일에서는 인식기 하나를 계속 다시 씁니다(매번 새로 만들면 알림음·권한 문제가 잦음).
//   PC에서는 세션마다 새로 만듭니다(Edge·Chrome에서 검증된 방식).
// - 아이폰·아이패드는 짧은 세션(continuous=false)을 빠르게 이어 붙이는 방식이 더 안정적입니다.
// - 마이크 입력: 기본은 브라우저 자체 마이크. 말하는데도 결과가 계속 없으면 녹화용 마이크 트랙으로
//   바꿔 보고(지원 브라우저), 그래도 없으면 다시 바꿉니다. 결과가 들어오는 입력을 찾으면 고정합니다.
//   (Edge는 트랙을 넘기면 오류 없이 결과를 주지 않는 경우가 있었습니다.)
// - 브라우저가 지원하면 기기 안 인식(processLocally)과 표현 힌트(phrases)를 씁니다.
// - 세션이 끝나면 곧바로 다시 시작하고, 오류가 이어지면 간격을 늘립니다.
// - PC에서는 한 세션을 45초 넘게 쓰면 말이 끊긴 틈에 새 세션으로 바꿉니다(늦어도 90초).
// - 한 번이라도 동작한 뒤에는 스스로 포기하지 않습니다. 탭 없이는 다시 켤 수 없는 상태(blocked)만 알립니다.
// - 앞서 확정한 문장을 다시 붙여 보내는 기기에서는 새로 말한 부분만 넘깁니다.

import { newPart } from './core.js';

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const Phrase = typeof window !== 'undefined' ? window.SpeechRecognitionPhrase : null;
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const IS_IOS =
  /iPad|iPhone|iPod/.test(UA) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const IS_ANDROID = /Android/i.test(UA);
const IS_MOBILE = IS_IOS || IS_ANDROID || /Mobile/i.test(UA);
const PERMISSION = new Set(['not-allowed', 'service-not-allowed']);
const TEST = (typeof window !== 'undefined' && window.__bridgeTest) || {};
const ROTATE_AFTER_MS = TEST.rotateAfterMs || 45_000;
const ROTATE_FORCE_MS = TEST.rotateForceMs || 90_000;

export class Speech {
  static supported() {
    return !!SR;
  }

  /** 기기 안 인식 가능 여부: 'available' | 'downloadable' | 'downloading' | 'unavailable' | null(기능 없음) */
  static async checkLocal(lang = 'ko-KR') {
    try {
      if (!SR || typeof SR.available !== 'function') return null;
      return await SR.available({ langs: [lang], processLocally: true });
    } catch {
      return null;
    }
  }

  /** 기기 안 인식용 한국어 자료 내려받기 (사용자 탭 안에서 호출) */
  static async installLocal(lang = 'ko-KR') {
    try {
      if (!SR || typeof SR.install !== 'function') return false;
      return !!(await SR.install({ langs: [lang], processLocally: true }));
    } catch {
      return false;
    }
  }

  constructor({ lang = 'ko-KR', onInterim, onFinal, onStatus, onError, onLog, track = null, local = false, phrases = [] } = {}) {
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.onLog = onLog || (() => {});
    this.track = track;
    this.useTrack = TEST.useTrack ?? false;
    this.inputLocked = false;
    this.reuse = TEST.reuse ?? IS_MOBILE;
    this.stats = { sessions: 0, interims: 0, finals: 0, errors: 0, inputSwitches: 0 };
    this.local = !!local;
    this.phrases = phrases;
    this.usePhrases = !!(Phrase && phrases.length);
    this.continuous = TEST.continuous ?? !IS_IOS;
    this.rotate = TEST.rotate ?? !IS_MOBILE;
    this.want = false;
    this.running = false;
    this.rec = null;
    this.sess = null;
    this.everWorked = false;
    this.errorStreak = 0;
    this.blocked = false;
    this.restarts = 0;
    this.rotations = 0;
    this.refreshes = 0;
    this.lastResultAt = 0;
  }

  /** 시작(또는 멈춘 뒤 다시 시작). 사용자 탭 안에서 부르면 아이폰·아이패드에서도 다시 켜집니다. */
  start() {
    if (!SR) return false;
    this.want = true;
    this.blocked = false;
    this.errorStreak = 0;
    clearTimeout(this._timer);
    if (!this.running) this._begin();
    return true;
  }

  stop() {
    this.want = false;
    clearTimeout(this._timer);
    clearTimeout(this._rotTimer);
    clearTimeout(this._killTimer);
    if (this.rec && this.running) {
      try { this.rec.abort(); } catch { /* 이미 멈춤 */ }
    }
    this.running = false;
    this.onInterim('');
    this.onStatus('stopped');
  }

  /** 지금 세션을 정리하고 바로 새 세션으로 바꿉니다 (응답이 멈췄을 때). */
  refresh(reason = 'refresh') {
    if (!this.want) return;
    this.refreshes++;
    this.onLog('asr-refresh', reason);
    if (!this.running) {
      clearTimeout(this._timer);
      this._begin();
      return;
    }
    this._end(reason);
  }

  _ensure() {
    if (this.rec) return this.rec;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = this.continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if ('processLocally' in rec) {
      try { rec.processLocally = this.local; } catch { this.local = false; }
    }
    if (this.usePhrases) {
      try {
        rec.phrases = this.phrases.map((p) => new Phrase(p, 3.0));
      } catch {
        this.usePhrases = false;
      }
    }
    rec.onstart = () => this._onStart(rec);
    rec.onresult = (e) => this._onResult(rec, e);
    rec.onerror = (e) => this._onError(rec, e);
    rec.onend = () => this._onEnd(rec);
    this.rec = rec;
    return rec;
  }

  /** 인식기를 버리고 새로 만듭니다 (멈춘 인식기가 응답하지 않을 때만). */
  _discard() {
    const r = this.rec;
    this.rec = null;
    if (r) {
      r.onstart = r.onresult = r.onerror = r.onend = null;
      try { r.abort(); } catch { /* 무시 */ }
    }
    this.running = false;
  }

  _begin() {
    if (!this.want || this.running) return;
    let rec;
    try {
      rec = this._ensure();
    } catch (err) {
      this._retryLater(err?.name || 'create-failed');
      return;
    }
    this.sess = { done: new Set(), text: '', startedAt: Date.now(), got: false, ending: null };
    this.running = true;
    try {
      if (this.useTrack && this.track && this.track.readyState === 'live') rec.start(this.track);
      else rec.start();
    } catch (err) {
      if (err?.name === 'InvalidStateError' && (!(this.useTrack && this.track) || this.track.readyState === 'live')) {
        // 이미 듣는 중(직전 세션이 아직 끝나는 중) — 이어지는 onend에서 다시 시작됩니다
        return;
      }
      if (this.useTrack && this.track) {
        // 트랙 입력을 지원하지 않거나 거부 → 기본 마이크로
        this.useTrack = false;
        this.onLog('asr-track-off', err?.name || 'error');
        try {
          rec.start();
          return;
        } catch (e2) {
          if (e2?.name === 'InvalidStateError') return;
        }
      }
      this.running = false;
      this._retryLater(err?.name || 'start-failed');
    }
  }

  /** 마이크 입력 바꾸기 (말하는데 결과가 계속 없을 때 앱이 부름). 바꿨으면 true */
  switchInput(reason = '') {
    if (!this.track || this.inputLocked) return false;
    this.useTrack = !this.useTrack;
    this.stats.inputSwitches++;
    this.onLog('asr-input', (this.useTrack ? 'track' : 'mic') + (reason ? ':' + reason : ''));
    // 다음 세션은 새 인식기로
    if (this.running) this._end('input');
    else this._discard();
    return true;
  }

  get input() {
    return this.useTrack && this.track ? 'track' : 'mic';
  }

  _onStart(rec) {
    if (rec !== this.rec) return;
    this.stats.sessions++;
    this.onStatus('listening');
    if (this.rotate) {
      clearTimeout(this._rotTimer);
      this._rotTimer = setTimeout(() => {
        this.rotations++;
        this.onLog('asr-rotate', 'force');
        this._end('rotate');
      }, ROTATE_FORCE_MS);
    }
  }

  _onResult(rec, e) {
    if (rec !== this.rec || !this.sess) return;
    const s = this.sess;
    const now = Date.now();
    this.lastResultAt = now;
    s.got = true;
    this.everWorked = true;
    this.inputLocked = true; // 이 입력으로 결과가 들어옴 → 고정
    this.errorStreak = 0;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const txt = r?.[0]?.transcript || '';
      if (r.isFinal) {
        if (s.done.has(i)) continue;
        s.done.add(i);
        const part = newPart(s.text, txt);
        s.text = part !== txt ? txt : (s.text ? s.text + ' ' : '') + txt;
        if (part.trim()) {
          this.stats.finals++;
          this.onFinal(part);
        }
      } else interim += txt;
    }
    interim = newPart(s.text, interim);
    if (interim.trim()) this.stats.interims++;
    this.onInterim(interim);
    // PC: 오래 쓴 세션은 말이 끊긴 틈(확정 직후, 잠정 결과 없음)에 새 세션으로 교체
    if (this.rotate && !interim.trim() && now - s.startedAt > ROTATE_AFTER_MS) {
      this.rotations++;
      this.onLog('asr-rotate', 'pause');
      this._end('rotate');
    }
  }

  _onError(rec, e) {
    if (rec !== this.rec) return;
    const code = e?.error || 'unknown';
    if (code === 'no-speech' || code === 'aborted') return;
    this.errorStreak++;
    this.stats.errors++;
    this.onLog('asr-error', code);
    // 표현 힌트를 지원하지 않으면 끄고 계속
    if (/phrase/i.test(code) && this.usePhrases) {
      this.usePhrases = false;
      try { rec.phrases = []; } catch { this._discard(); }
      return this.onError(code, 'transient');
    }
    // 기기 안 인식이 안 되면 서버 인식으로 바꿔 계속
    if (this.local && (code === 'language-not-supported' || code === 'service-not-allowed')) {
      this.local = false;
      try { rec.processLocally = false; } catch { this._discard(); }
      this.onLog('asr-local-off', code);
      return this.onError(code, 'transient');
    }
    // 처음부터 시작이 안 되는 경우(권한·언어·마이크 충돌)만 포기
    if (!this.everWorked && (PERMISSION.has(code) || code === 'language-not-supported')) return this._giveUp(code, 'fatal');
    if (!this.everWorked && code === 'audio-capture' && this.errorStreak >= 3) return this._giveUp(code, 'fatal');
    // 동작하다가 권한 오류가 이어지면: 탭 없이는 다시 켤 수 없는 상태
    if (PERMISSION.has(code) && this.errorStreak >= 2) return this._giveUp(code, 'blocked');
    this.onError(code, 'transient');
  }

  _onEnd(rec) {
    if (rec !== this.rec) return;
    clearTimeout(this._killTimer);
    clearTimeout(this._rotTimer);
    const s = this.sess || {};
    this.running = false;
    this.onInterim('');
    if (!this.want) return;
    this.restarts++;
    let delay;
    if (s.ending) delay = 30; // 계획된 교체·새로고침
    else if (s.got || this.errorStreak === 0) delay = IS_IOS ? 200 : 100;
    else delay = Math.min(4000, 250 * 2 ** Math.min(4, this.errorStreak));
    if (!s.ending) this.onStatus('restarting');
    if (!this.reuse || s.ending === 'input') {
      rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
      this.rec = null;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._begin(), delay);
  }

  _end(reason) {
    if (!this.running || !this.sess || this.sess.ending) return;
    this.sess.ending = reason;
    try { this.rec.stop(); } catch { /* 무시 */ }
    // stop()에 응답이 없으면 abort, 그래도 없으면 인식기를 새로 만듭니다
    clearTimeout(this._killTimer);
    this._killTimer = setTimeout(() => {
      if (!this.running) return;
      try { this.rec.abort(); } catch { /* 무시 */ }
      this._killTimer = setTimeout(() => {
        if (!this.running) return;
        this.onLog('asr-kill', reason);
        this._discard();
        this._begin();
      }, 1000);
    }, 1500);
  }

  _retryLater(code) {
    this.errorStreak++;
    this.onLog('asr-error', code);
    this.onStatus('restarting');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._begin(), Math.min(4000, 400 * this.errorStreak));
  }

  _giveUp(code, kind) {
    this.want = false;
    if (kind === 'blocked') this.blocked = true;
    clearTimeout(this._timer);
    this.onStatus(kind === 'blocked' ? 'blocked' : 'stopped');
    this.onError(code, kind);
  }
}

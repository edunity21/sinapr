// BRIDGE 발표 리허설 — 화면과 흐름
import * as C from './core.js';
import { Speech } from './speech.js';
import { openCamera, cameraErrorText, pickMime, extOf, Recorder, Meter, WakeLock } from './recorder.js';
import * as DB from './storage.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = C.escapeHTML;
const fmt = C.fmtTime;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* 저장소 사용 불가 */ }
  },
};

const DEFAULTS = {
  targetMin: 10,
  rateSpm: C.DEFAULT_RATE_SPM,
  level: 'full',
  mode: 'auto',
  mirror: true,
  font: 1,
  quality: 'std',
  dict: C.DEFAULT_DICTIONARY,
  forbidden: '',
  overrides: {},
  overrideSig: '',
  localASR: false,
  localStatus: '',
};
const S = { ...DEFAULTS, ...store.get('br.settings', {}) };
const saveSettings = () => store.set('br.settings', S);

const QUALITY = { low: 700_000, std: 1_500_000, high: 3_000_000 };
const LEVEL_HINT = {
  full: '원고 전체가 보이고, 말한 부분이 초록색으로 바뀝니다.',
  hint: '어절의 첫 글자만 보이고 나머지는 빈칸입니다. 말하면 채워집니다.',
  hidden: '자막이 빈칸으로만 보이고 말한 부분만 드러납니다. 4초 이상 막히면 다음 어절을 흐리게 보여 줍니다.',
};
const MODE_HINT = {
  auto: '말을 알아듣고 자막 위치를 정확히 따라갑니다. 인식이 잠깐 끊겨도 목소리를 감지해 자막이 계속 이어집니다. 어긋나면 ◀ ▶로 바로잡습니다.',
  voice: '음성 인식 없이 목소리가 나는 동안 자막을 채우고, 말을 쉬면 다음 문장으로 넘어갑니다. 인터넷이 없어도, 어느 기기에서도 끊기지 않습니다. 위치는 추정이라 가끔 ◀ ▶로 맞춰 주세요.',
  manual: '문장을 말하는 동안 자막이 채워지고, 다 말하면 자막을 탭하거나 ▶(키보드 →, 프레젠터)를 눌러 넘깁니다.',
};
const MODE_NAME = { auto: '음성 인식', voice: '음성 감지', manual: '탭 넘기기' };
const STATUS_LABEL = { ok: '말함', partial: '일부', missed: '누락', notReached: '미도달', manual: '넘김', estimated: '추정' };
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let localASR = null; // 기기 안 음성 인식 확인 결과(이번 화면에서): 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable'
const localReady = () => S.localASR && S.localStatus === 'available';

const wake = new WakeLock();
let model = null;
let schedule = [];
let R = null; // 진행 중인 연습

/* ═════════════ 공통 ═════════════ */

function show(view) {
  for (const id of ['setup', 'stage', 'review']) $('#' + id).hidden = id !== view;
  document.body.dataset.view = view;
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast on ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2800);
}

function vibrate(p) {
  try {
    navigator.vibrate?.(p);
  } catch { /* 지원 안 함 */ }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function dateText(ts) {
  const d = new Date(ts);
  const day = '일월화수목금토'[d.getDay()];
  return `${d.getMonth() + 1}.${d.getDate()} (${day}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ═════════════ 타임라인 막대 ═════════════ */

/**
 * d: { rec, pred, t, target, total, delta, status, recNow, kc, rate, frozen }
 * 권장 막대(구간별 권장 시간)와 예측 막대(실제+예상)를 같은 시간축에 그립니다.
 */
function renderTimeline(el, d, { live = true, predLabel = '예측', titles = [] } = {}) {
  const max = Math.min(C.MAX_RECORD_SEC, Math.max(d.target * 1.15, (d.total || 0) * 1.04, (d.t || 0) * 1.04, 60));
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const pct = (s) => clamp((s / max) * 100).toFixed(3) + '%';
  const wid = (a, b) => clamp(((Math.min(b, max) - a) / max) * 100).toFixed(3) + '%';
  const labeled = new Set();
  const label = (k, a, b) => {
    if (labeled.has(k) || ((b - a) / max) * 100 < 3.2) return '';
    labeled.add(k);
    return `<b>${k + 1}</b>`;
  };

  const recSegs = d.rec
    .map((s) => {
      const cur = live && s.k === d.recNow ? ' cur' : '';
      return `<i class="bar r${s.k % 2}${cur}" style="left:${pct(s.start)};width:${wid(s.start, s.end)}" title="${esc(titles[s.k] || '')} · 권장 ${fmt(Math.round(s.dur))}">${label(s.k, s.start, s.end)}</i>`;
    })
    .join('');
  labeled.clear();
  const predSegs = d.pred
    .map((s) => {
      if (s.start >= max) return '';
      const cls = s.kind === 'done' ? `done ${s.cmp}` : `${s.kind} ${d.status}`;
      return `<i class="bar ${cls}" style="left:${pct(s.start)};width:${wid(s.start, s.end)}">${label(s.k, s.start, s.end)}</i>`;
    })
    .join('');
  const over = d.total > d.target
    ? `<i class="tl-over" style="left:${pct(d.target)};width:${wid(d.target, d.total)}"></i>`
    : '';
  const marks = (withNow) =>
    `<i class="mk target" style="left:${pct(d.target)}"></i>` +
    (max >= C.MAX_RECORD_SEC - 0.5 ? `<i class="mk limit" style="left:100%"></i>` : '') +
    (withNow ? `<i class="mk now" style="left:${pct(d.t)}"></i>` : '');

  const narrow = (el.clientWidth || 600) < 520;
  const step = max > 12 * 60 || narrow ? 120 : 60;
  let ticks = '';
  for (let s = 0; s <= max + 0.1; s += step) {
    if (Math.abs(s - d.target) < step * 0.75) continue;
    ticks += `<span style="left:${pct(s)}">${s / 60}분</span>`;
  }
  ticks += `<span class="tgt" style="left:${pct(d.target)}">목표 ${fmt(d.target)}</span>`;

  let info;
  if (live) {
    const st = d.status;
    const where = d.kc < d.rec.length ? `지금 ${d.kc + 1}구간 · 권장 ${d.recNow + 1}구간` : '원고 끝';
    info = `<span class="st ${st}"><b>예상 종료 ${fmt(Math.round(d.total))}</b> ${C.humanDelta(d.delta)}${d.frozen ? ' (추정 보류)' : ''}</span><span class="meta">${where}</span>`;
  } else {
    info = `<span class="st ${d.status}"><b>${predLabel} ${fmt(Math.round(d.total))}</b> ${C.humanDelta(d.delta)}</span>`;
  }

  el.innerHTML = `
    <div class="tl-row"><span class="tl-lab">권장</span><div class="tl-track"><div class="tl-fill">${recSegs}</div>${marks(live)}</div></div>
    <div class="tl-row"><span class="tl-lab">${predLabel}</span><div class="tl-track"><div class="tl-fill">${predSegs}${over}</div>${marks(live)}</div></div>
    <div class="tl-axis">${ticks}</div>
    <div class="tl-info">${info}</div>`;
}

/* ═════════════ 준비 화면 ═════════════ */

function rebuild() {
  const text = $('#script').value;
  store.set('br.script', text);
  const parsed = C.parseScript(text);
  model = parsed.sentences.length ? C.buildModel(parsed, S.dict) : null;
  const sig = model ? model.sections.map((s) => s.title).join('|') : '';
  if (sig !== S.overrideSig) {
    S.overrides = {};
    S.overrideSig = sig;
    saveSettings();
  }
  schedule = model ? C.recommendedSchedule(model.sections.map((s) => s.n), S.targetMin * 60, S.overrides) : [];
  renderSummary(parsed);
  renderSchedule();
}

function renderSummary(parsed) {
  const el = $('#script-summary');
  if (!model) {
    el.innerHTML = '<p class="muted">원고를 넣으면 구간·문장·음절 수와 예상 시간이 여기에 나타납니다.</p>';
    return;
  }
  const target = S.targetMin * 60;
  const spm = S.rateSpm;
  const est = (model.N / spm) * 60;
  const d = est - target;
  const st = C.classifyDelta(d);
  let tip = '';
  if (d < -40) {
    const need = Math.round((model.N / target) * 60);
    const add = Math.round(((target - est) / 60) * spm);
    const avg = model.N / model.sentences.length;
    tip = `<p class="tip">목표를 채우려면 분당 <b>${need}음절</b>로 천천히 말하거나, 약 <b>${add.toLocaleString()}음절</b>(문장 ${Math.round(add / avg)}개 정도)을 보충해야 합니다.</p>`;
  } else if (d > 40) {
    const cut = Math.round(((est - target) / 60) * spm);
    tip = `<p class="tip">목표 안에 끝내려면 약 <b>${cut.toLocaleString()}음절</b>을 줄이거나 분당 <b>${Math.round((model.N / target) * 60)}음절</b>로 말해야 합니다.</p>`;
  }
  const notes = parsed.notes.length
    ? `<p class="muted small-text">메모로 처리한 줄(말하지 않음): ${parsed.notes.map((n) => `“${esc(n)}”`).join(', ')}</p>`
    : '';
  el.innerHTML = `
    <div class="stats">
      <span><b>${model.sections.length}</b>구간</span>
      <span><b>${model.sentences.length}</b>문장</span>
      <span><b>${model.N.toLocaleString()}</b>음절</span>
    </div>
    <p class="estimate st-${st}">분당 ${spm}음절로 말하면 약 <b>${fmt(Math.round(est))}</b> · 목표 ${fmt(target)}보다 <b>${fmt(Math.round(Math.abs(d)))} ${d < 0 ? '짧음' : '김'}</b></p>
    ${tip}
    <div class="tl light" id="tl-preview"></div>
    <p class="legend"><i class="lg rec"></i>권장 배분 <i class="lg ok"></i>적정 <i class="lg fast"></i>빠름 <i class="lg warn"></i>늦음 <i class="lg over"></i>초과 <i class="lg proj"></i>예측(빗금)</p>
    ${notes}`;
  // 기준 속도로 말했을 때의 예측 막대
  const r = spm / 60;
  let at = 0;
  const pred = model.sections.map((s, k) => {
    const seg = { k, start: at, end: at + s.n / r, kind: 'proj' };
    at = seg.end;
    return seg;
  });
  renderTimeline($('#tl-preview'), { rec: schedule, pred, t: 0, target, total: est, delta: d, status: st }, { live: false, predLabel: '예상', titles: model.sections.map((s) => s.title) });
}

function renderSchedule() {
  const el = $('#schedule');
  if (!model) {
    el.innerHTML = '';
    return;
  }
  const sum = schedule.reduce((a, s) => a + s.dur, 0);
  el.innerHTML = `
    <div class="sch-head"><span>구간</span><span>음절</span><span>권장</span></div>
    ${model.sections
      .map(
        (s, k) => `<div class="sch-row${schedule[k].manual ? ' manual' : ''}">
          <span class="sch-title"><em>${k + 1}</em>${esc(s.title)}</span>
          <span class="sch-n">${s.n}</span>
          <input class="sch-in" data-k="${k}" value="${fmt(Math.round(schedule[k].dur))}" inputmode="numeric" aria-label="${k + 1}구간 권장 시간">
        </div>`,
      )
      .join('')}
    <div class="sch-sum${Math.abs(sum - S.targetMin * 60) > 1 ? ' bad' : ''}">합계 <b>${fmt(Math.round(sum))}</b> / 목표 ${fmt(S.targetMin * 60)}</div>
    <p class="hint">시간을 직접 고친 구간(굵게)은 그대로 두고, 나머지 구간을 음절 수에 맞춰 다시 나눕니다. "1:30"처럼 입력하세요.</p>`;
  $$('.sch-in', el).forEach((inp) =>
    inp.addEventListener('change', () => {
      const k = +inp.dataset.k;
      const v = C.parseTime(inp.value);
      if (v == null || v <= 0) delete S.overrides[k];
      else S.overrides[k] = v;
      saveSettings();
      rebuild();
    }),
  );
}

function renderEnv() {
  const mime = pickMime();
  const items = [
    ['보안 연결', window.isSecureContext, window.isSecureContext ? '' : 'https 주소 필요'],
    ['카메라·마이크', !!navigator.mediaDevices?.getUserMedia, ''],
    ['녹화', mime !== null, mime ? extOf(mime).toUpperCase() : ''],
    ['음성 인식', Speech.supported(), Speech.supported() ? (localReady() ? '기기 안 처리' : IS_IOS ? '음성 감지 권장' : '') : '음성 감지 사용'],
    ['기기 저장', DB.available(), ''],
  ];
  $('#env').innerHTML = items
    .map(([label, ok, note]) => `<li class="${ok ? 'ok' : 'no'}"><i>${ok ? '✓' : '!'}</i>${label}${note ? `<small>${esc(note)}</small>` : ''}</li>`)
    .join('');
}

async function renderHistory() {
  const ul = $('#history');
  let list = [];
  try {
    list = await DB.listSessions();
  } catch {
    ul.innerHTML = '<li class="muted">이 브라우저에서는 기록을 저장할 수 없습니다.</li>';
    return;
  }
  if (!list.length) {
    ul.innerHTML = '<li class="empty">아직 연습 기록이 없습니다. 첫 리허설을 시작해 보세요.</li>';
  } else {
    const maxDur = Math.max(...list.map((s) => s.durationSec), 60);
    ul.innerHTML = list
      .map((s) => {
        const st = C.classifyDelta(s.durationSec - s.targetSec);
        const miss = (s.summary?.count?.missed || 0) + (s.summary?.count?.partial || 0);
        const lv = { full: '전체', hint: '첫 글자', hidden: '숨김' }[s.level] || '';
        return `<li><button type="button" data-id="${s.id}">
          <span class="h-date">${dateText(s.createdAt)}</span>
          <span class="h-bar"><i class="st-bg-${st}" style="width:${((s.durationSec / maxDur) * 100).toFixed(1)}%"></i></span>
          <span class="h-dur">${fmt(s.durationSec)}</span>
          <span class="h-delta st-${st}">${C.fmtDelta(s.durationSec - s.targetSec)}</span>
          <span class="h-meta">${lv} · ${MODE_NAME[s.mode] || ''}${s.mode === 'auto' && miss ? ` · 놓친 문장 ${miss}` : ''}</span>
        </button></li>`;
      })
      .join('');
    $$('button[data-id]', ul).forEach((b) => b.addEventListener('click', () => openReview(b.dataset.id)));
  }
  const e = await DB.estimate();
  $('#storage-info').textContent = e ? `사용 중 ${(e.usage / 1048576).toFixed(0)}MB` : '';
}

function syncSegs() {
  for (const [id, key] of [['#level', 'level'], ['#mode', 'mode']]) {
    $$(`${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === S[key])));
  }
  $('#level-hint').textContent = LEVEL_HINT[S.level];
  let extra = '';
  if (S.mode === 'auto' && !Speech.supported()) extra = ' (이 브라우저는 음성 인식이 없어 음성 감지로 진행합니다.)';
  else if (S.mode === 'auto' && IS_IOS) extra = ' 아이폰·아이패드는 음성 인식이 자주 끊기므로 "음성 감지"를 권장합니다.';
  $('#mode-hint').textContent = MODE_HINT[S.mode] + extra;
  renderLocalASR();
}

/** 기기 안 음성 인식(Chrome 최신, 실험 기능): 사용자가 켤 때만 확인합니다. */
function renderLocalASR() {
  const el = $('#local-asr');
  if (!el) return;
  const hasAPI = typeof window.SpeechRecognition?.available === 'function';
  if (S.mode !== 'auto' || !hasAPI) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const st = localASR || S.localStatus;
  let msg;
  if (!S.localASR) msg = '이 기기 안에서 처리하면 인터넷 없이 더 빠르고 덜 끊깁니다. (Chrome 최신 · 실험 기능)';
  else if (st === 'checking') msg = '확인하는 중…';
  else if (st === 'available') msg = '<b>사용 중</b> — 이 기기에서 한국어를 처리합니다.';
  else if (st === 'downloading') msg = '한국어 자료를 내려받는 중입니다…';
  else if (st === 'downloadable') msg = '한국어 자료가 필요합니다. <button type="button" class="ghost small" id="btn-local">내려받기</button>';
  else msg = '이 기기에서는 쓸 수 없어 서버 인식을 씁니다.';
  el.innerHTML = `<label class="toggle"><input type="checkbox" id="chk-local" ${S.localASR ? 'checked' : ''}><span>기기 안 음성 인식</span></label><span class="local-msg">${msg}</span>`;
  $('#chk-local').addEventListener('change', async (e) => {
    S.localASR = e.target.checked;
    saveSettings();
    if (S.localASR) {
      localASR = 'checking';
      renderLocalASR();
      localASR = (await Speech.checkLocal('ko-KR')) || 'unavailable';
      S.localStatus = localASR;
      saveSettings();
    }
    renderLocalASR();
    renderEnv();
  });
  $('#btn-local')?.addEventListener('click', async () => {
    localASR = 'downloading';
    renderLocalASR();
    const ok = await Speech.installLocal('ko-KR');
    localASR = ok ? 'available' : (await Speech.checkLocal('ko-KR')) || 'unavailable';
    S.localStatus = localASR;
    saveSettings();
    toast(ok ? '기기 안 음성 인식을 쓸 수 있습니다' : '내려받지 못했습니다. 서버 인식으로 진행합니다.', ok ? '' : 'warn');
    renderLocalASR();
    renderEnv();
  });
}

function initSetup() {
  const ta = $('#script');
  const saved = store.get('br.script', null);
  ta.value = saved ?? '';
  let deb;
  ta.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(rebuild, 250);
  });
  $('#btn-sample').addEventListener('click', loadSample);
  $('#btn-clear').addEventListener('click', () => {
    ta.value = '';
    rebuild();
    ta.focus();
  });
  $('#file-script').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    ta.value = await f.text();
    e.target.value = '';
    rebuild();
  });

  const target = $('#target');
  target.value = S.targetMin;
  const setTarget = (v) => {
    v = Math.min(15, Math.max(1, Math.round(v * 2) / 2));
    S.targetMin = v;
    target.value = v;
    saveSettings();
    rebuild();
  };
  target.addEventListener('change', () => setTarget(+target.value || 10));
  $$('.stepper button').forEach((b) => b.addEventListener('click', () => setTarget(S.targetMin + +b.dataset.step)));

  const rate = $('#rate');
  rate.value = S.rateSpm;
  rate.addEventListener('change', () => {
    S.rateSpm = Math.min(500, Math.max(150, +rate.value || C.DEFAULT_RATE_SPM));
    rate.value = S.rateSpm;
    saveSettings();
    rebuild();
  });
  $('#btn-auto').addEventListener('click', () => {
    S.overrides = {};
    saveSettings();
    rebuild();
  });

  for (const [id, key] of [['#level', 'level'], ['#mode', 'mode']]) {
    $$(`${id} button`).forEach((b) =>
      b.addEventListener('click', () => {
        S[key] = b.dataset.v;
        saveSettings();
        syncSegs();
      }),
    );
  }
  const mirror = $('#mirror');
  mirror.checked = S.mirror;
  mirror.addEventListener('change', () => {
    S.mirror = mirror.checked;
    saveSettings();
  });
  const dict = $('#dict');
  dict.value = S.dict;
  dict.addEventListener('change', () => {
    S.dict = dict.value;
    saveSettings();
    rebuild();
  });
  const forb = $('#forbidden');
  forb.value = S.forbidden;
  forb.addEventListener('change', () => {
    S.forbidden = forb.value;
    saveSettings();
  });
  const q = $('#quality');
  q.value = S.quality;
  q.addEventListener('change', () => {
    S.quality = q.value;
    saveSettings();
  });

  $('#btn-open').addEventListener('click', openStage);
  syncSegs();
  renderEnv();
  if (saved == null) loadSample(true);
  else rebuild();
  renderHistory();
}

async function loadSample(silent = false) {
  try {
    const res = await fetch('sample-script.txt', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    $('#script').value = await res.text();
    rebuild();
    if (silent !== true) toast('예시 원고를 불러왔습니다');
  } catch {
    rebuild();
    if (silent !== true) toast('예시 원고를 불러오지 못했습니다. 웹 주소로 열었는지 확인해 주세요.', 'warn');
  }
}

function setupError(msg) {
  const el = $('#setup-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/* ═════════════ 연습 화면 ═════════════ */

async function openStage() {
  rebuild();
  setupError('');
  if (!model) return setupError('원고를 먼저 넣어 주세요.');
  const btn = $('#btn-open');
  btn.disabled = true;
  btn.textContent = '카메라 여는 중…';
  try {
    const stream = await openCamera('user');
    R = newSession(stream);
    show('stage');
    const cam = $('#cam');
    cam.srcObject = stream;
    cam.classList.toggle('mirror', S.mirror);
    await cam.play().catch(() => {});
    applyFont();
    $('#btn-full').hidden = !document.documentElement.requestFullscreen;
    renderStage();
    renderSubs();
    updatePrediction(0);
    renderAsrChip();
  } catch (err) {
    console.error(err);
    setupError(cameraErrorText(err));
  } finally {
    btn.disabled = false;
    btn.textContent = '카메라 켜고 연습 화면으로';
  }
}

function newSession(stream) {
  const mode = S.mode === 'auto' ? (Speech.supported() ? 'auto' : 'voice') : S.mode === 'voice' ? 'voice' : 'manual';
  return {
    stream,
    mode,
    modeStart: mode,
    state: 'ready',
    tracker: new C.Tracker(model),
    schedule: schedule.slice(),
    targetSec: S.targetMin * 60,
    level: S.level,
    acc: 0,
    since: 0,
    history: [],
    transcript: [],
    events: [],
    warned: new Set(),
    seq: 0,
    bytes: 0,
    mem: [],
    writes: Promise.resolve(),
    forbidden: C.parseList(S.forbidden),
    forbidHits: [],
    lastForbid: {},
    hints: 0,
    peekLevel: 0,
    rate: S.rateSpm / 60,
    frozen: false,
    lastAsrAt: 0,
    voiceAt: 0,
    asrStatus: mode === 'auto' ? 'idle' : 'manual',
    paceRate: null,
    vad: new C.VoiceActivity(),
    follower: new C.VoiceFollower(model, { rate: Math.min(9, Math.max(4, S.rateSpm / 60 / 0.8)) }),
    followMode: '',
    refreshStreak: 0,
    lastRefreshAt: 0,
    lastWarnToast: 0,
  };
}

function elapsed() {
  if (!R) return 0;
  return R.acc + (R.state === 'recording' ? (performance.now() - R.since) / 1000 : 0);
}

function event(type, data) {
  if (R) R.events.push({ t: Math.round(elapsed() * 10) / 10, type, ...(data !== undefined ? { data } : {}) });
}

function applyFont() {
  $('#stage').style.setProperty('--sub-scale', S.font);
}

/** 큰 시계: 목표 시간에서 0:00으로 내려오고, 넘기면 빨간 "+초과 시간" */
function renderClock(t) {
  const cd = C.countdown(t, R?.targetSec ?? S.targetMin * 60);
  const el = $('#elapsed');
  el.textContent = cd.text;
  el.classList.toggle('over', cd.over);
}

function renderStage() {
  const st = R?.state || 'ready';
  const main = $('#btn-main');
  const label = { ready: '● 녹화 시작', countdown: '준비…', recording: '❚❚ 일시정지', paused: '▶ 계속', stopping: '저장 중…' }[st];
  main.textContent = label;
  main.dataset.state = st;
  main.disabled = st === 'countdown' || st === 'stopping';
  $('#btn-stop').disabled = !(st === 'recording' || st === 'paused');
  $('#btn-prev').disabled = $('#btn-next').disabled = !(st === 'recording' || st === 'paused');
  const rs = $('#rec-state');
  rs.dataset.state = st;
  $('span', rs).textContent = { ready: '준비', countdown: '곧 시작', recording: '녹화 중', paused: '일시정지', stopping: '저장 중' }[st];
  $('#clock-sub').textContent = `/ ${fmt(R?.targetSec ?? S.targetMin * 60)}`;
  renderClock(elapsed());
  $('#stage').dataset.state = st;
  $('#stage').dataset.mode = R?.mode || S.mode;
}

function renderAsrChip() {
  const chip = $('#asr-chip');
  if (!R) return;
  const map = {
    idle: ['음성 인식 대기', ''],
    listening: ['● 듣는 중', 'ok'],
    restarting: ['다시 연결 중', 'warn'],
    stopped: ['음성 인식 멈춤', ''],
    blocked: ['멈춤 · 눌러서 다시 듣기', 'bad'],
    manual: ['탭해서 넘기기', 'manual'],
  };
  let [text, cls] = R.mode === 'manual' ? map.manual : map[R.asrStatus] || map.idle;
  if (R.mode === 'voice') [text, cls] = R.modeStart === 'auto' ? ['인식 꺼짐 · 눌러서 켜기', 'warn'] : ['음성 감지', 'manual'];
  else if (R.mode === 'auto' && R.speech?.blocked) [text, cls] = ['인식 꺼짐 · 눌러서 켜기', 'warn'];
  else if (R.mode === 'auto' && R.state === 'recording' && R.followMode === 'lead') [text, cls] = ['인식 대기 · 위치 추정 중', 'warn'];
  chip.textContent = text;
  chip.className = `chip ${cls}`;
}

function banner(msg, actions = []) {
  const el = $('#banner');
  if (!msg) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<span>${esc(msg)}</span>${actions.map((a, i) => `<button type="button" data-i="${i}">${esc(a.label)}</button>`).join('')}<button type="button" class="x" aria-label="닫기">✕</button>`;
  el.hidden = false;
  $$('button[data-i]', el).forEach((b) => b.addEventListener('click', () => {
    actions[+b.dataset.i].fn();
    banner('');
  }));
  $('.x', el).addEventListener('click', () => banner(''));
}

/* ── 자막 ── */

function wordRangeFrom(sen, unit, words) {
  // unit이 속한 조각부터 words개 어절 범위를 돌려줍니다.
  const segs = sen.segs.filter((s) => !s.punct);
  let i = segs.findIndex((s) => unit < s.u1);
  if (i < 0) return null;
  const u0 = segs[i].u0;
  let count = 0;
  let u1 = segs[i].u1;
  for (let j = i; j < segs.length; j++) {
    if (j > i && segs[j].wordStart) {
      count++;
      if (count >= words) break;
    }
    u1 = segs[j].u1;
  }
  return { u0, u1 };
}

function sentenceHTML(sen, level, isCur) {
  const tr = R.tracker;
  const peek = isCur && R.peekLevel > 0 ? wordRangeFrom(sen, tr.focus, R.peekLevel) : null;
  let out = '';
  let prev = 'todo';
  for (const seg of sen.segs) {
    if (seg.punct) {
      out += `<span class="p ${prev}">${esc(seg.text)}</span>`;
      continue;
    }
    const st = tr.segState(seg);
    prev = st;
    let cls = st;
    if (st === 'todo') {
      const masked = level === 'hidden' || (level === 'hint' && !seg.wordStart);
      if (masked) cls += peek && seg.u0 >= peek.u0 && seg.u0 < peek.u1 ? ' peek' : ' mask';
    }
    out += `<span class="w ${cls}">${esc(seg.text)}</span>`;
  }
  return out;
}

function renderSubs() {
  if (!R) return;
  const tr = R.tracker;
  const s = tr.current();
  const sen = model.sentences[s];
  const sec = sen ? model.sections[sen.sectionId] : null;
  $('#sec-label').innerHTML = sec
    ? `<b>${sec.id + 1}/${model.sections.length}</b>${esc(sec.title)}<span>문장 ${s + 1}/${model.sentences.length}</span>`
    : '<b>끝</b>원고를 모두 지났습니다';
  $('#sub-cur').innerHTML = sen ? sentenceHTML(sen, R.level, true) : '<span class="w said">감사합니다 — ■를 눌러 마칩니다</span>';
  const next = model.sentences[s + 1];
  $('#sub-next').innerHTML = next && R.level !== 'hidden' ? sentenceHTML(next, R.level, false) : '';
}

/* ── 시간 예측 ── */

function effCursor() {
  // 확정 위치 + 잠정 인식 + 음성 감지로 채운 위치 중 가장 앞
  return R.tracker.focus;
}

function updatePrediction(t) {
  if (!R) return;
  const tr = R.tracker;
  const c = effCursor(t);
  if (!R.frozen) R.rate = C.estimateRate({ t, cursor: c, history: R.history, baseline: S.rateSpm / 60 });
  const tl = C.timeline({
    sections: model.sections,
    schedule: R.schedule,
    sectionEnter: tr.sectionEnter(),
    t,
    cursor: c,
    rate: R.rate,
    targetSec: R.targetSec,
  });
  R.tl = tl;
  renderTimeline($('#tl'), { ...tl, t, target: R.targetSec, rate: R.rate, frozen: R.frozen }, { titles: model.sections.map((s) => s.title) });
  renderPace(t, c);
}

/** 속도계: 지금 속도(최근 20초)를 '목표 시간에 맞게 끝내려면 필요한 속도'와 비교합니다. */
function renderPace(t, c) {
  const ses = R;
  const live = ses.state === 'recording' || ses.state === 'paused';
  const r = live ? C.recentRate(ses.history, t, c, 20) : null;
  if (r != null && !ses.frozen && ses.state === 'recording') ses.paceRate = ses.paceRate == null ? r : ses.paceRate * 0.7 + r * 0.3;
  const p = C.paceAdvice({ t, cursor: c, N: model.N, targetSec: ses.targetSec, nowRate: live ? ses.paceRate : null });
  let info = C.PACE[p.level];
  // 음성 인식 방식인데 인식 결과가 한동안 없으면, 추정 위치로 속도를 판정하지 않습니다
  if (live && ses.mode === 'auto' && ses.followMode === 'lead' && p.level !== 'over' && p.level !== 'done') {
    p.level = 'measuring';
    p.x = 0.5;
    p.nowSpm = null;
    info = { word: '인식 대기', tip: '음성 인식이 돌아오면 다시 알려 드려요' };
  }
  const el = $('#pace');
  el.dataset.level = p.level;
  $('#pace-word').textContent = !live ? '알맞은 속도' : info.word;
  $('#pace-tip').textContent = !live ? '' : ses.frozen ? '음성 인식을 기다리는 중' : info.tip;
  $('#pace-needle').style.left = `${(p.x * 100).toFixed(1)}%`;
  $('#pace-num').innerHTML =
    p.nowSpm != null && p.needSpm != null
      ? `지금 <b>${p.nowSpm}</b> · 알맞은 속도 <b>${p.needSpm}</b> <small>음절/분</small>`
      : p.needSpm != null
        ? `목표 ${fmt(ses.targetSec)}에 맞추려면 분당 <b>${p.needSpm}</b>음절`
        : '';
}

/* ── 녹화 흐름 ── */

function countdown(n) {
  return new Promise((resolve) => {
    const el = $('#countdown');
    el.hidden = false;
    let k = n;
    const step = () => {
      if (!R || R.state !== 'countdown') {
        el.hidden = true;
        return resolve(false);
      }
      if (k === 0) {
        el.hidden = true;
        return resolve(true);
      }
      el.innerHTML = `<b>${k}</b><span>${k === n ? '심호흡 한 번' : '시선은 카메라로'}</span>`;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
      k--;
      setTimeout(step, 1000);
    };
    step();
  });
}

async function startRecording() {
  if (!R || R.state !== 'ready') return;
  const ses = R;
  ses.state = 'countdown';
  renderStage();
  ses.meter = new Meter(ses.stream);
  if (ses.mode === 'auto') startSpeech(ses); // 사용자 탭 안에서 시작해야 하는 브라우저가 있어 미리 켭니다
  wake.request();
  DB.persist();
  ses.sessionId = 's' + Date.now().toString(36);
  ses.createdAt = Date.now();
  meterLoop(ses);
  const go = await countdown(3);
  if (!go || R !== ses) return;

  const mime = pickMime();
  if (mime !== null) {
    ses.recorder = new Recorder(ses.stream, {
      mime,
      videoBitsPerSecond: QUALITY[S.quality] || QUALITY.std,
      onChunk: (blob) => {
        const seq = ses.seq++;
        ses.bytes += blob.size;
        ses.writes = ses.writes.then(async () => {
          if (ses.dbFailed) return ses.mem.push(blob);
          try {
            await DB.addChunk(ses.sessionId, seq, blob);
          } catch {
            ses.dbFailed = true;
            ses.mem.push(blob);
          }
        });
      },
    });
    try {
      ses.recorder.start();
    } catch (err) {
      console.error(err);
      ses.recorder = null;
      toast('이 기기에서 녹화를 시작하지 못했습니다. 자막·타이머만 진행합니다.', 'warn');
    }
  } else toast('이 브라우저는 녹화를 지원하지 않아 자막·타이머만 진행합니다.', 'warn');

  ses.state = 'recording';
  ses.since = performance.now();
  ses.lastAsrAt = performance.now();
  ses.tracker.lastProgress = 0;
  event('start', { mode: ses.mode, level: ses.level });
  renderStage();
  renderSubs();
  ses.tick = setInterval(tick, 250);
}

function startSpeech(ses) {
  ses.speech = new Speech({
    track: ses.stream.getAudioTracks()[0] || null, // 녹화와 같은 마이크를 인식기에 넘겨 충돌을 피함(지원 브라우저)
    local: localReady(),
    phrases: localReady() ? C.biasPhrases(model) : [],
    onInterim: (txt) => {
      if (R !== ses || ses.state !== 'recording') return;
      ses.pendingInterim = txt;
      if (!txt) return;
      asrAlive(ses);
      if (ses.interimTimer) return;
      ses.interimTimer = setTimeout(() => {
        ses.interimTimer = null;
        const t = elapsed();
        if (R !== ses || ses.state !== 'recording' || !ses.pendingInterim) return;
        if (ses.tracker.ingestInterim(ses.pendingInterim, t)) ses.peekLevel = 0;
        checkForbidden(ses.pendingInterim, t);
        renderSubs();
      }, 70);
    },
    onFinal: (txt) => {
      if (R !== ses || ses.state !== 'recording') return;
      const t = elapsed();
      asrAlive(ses);
      ses.pendingInterim = '';
      ses.transcript.push({ t: Math.round(t * 10) / 10, text: txt });
      if (ses.tracker.ingestFinal(txt, t)) ses.peekLevel = 0;
      checkForbidden(txt, t);
      renderSubs();
    },
    onStatus: (s) => {
      ses.asrStatus = s;
      if (R === ses) renderAsrChip();
    },
    onLog: (type, data) => {
      if (R === ses) event(type, data);
    },
    onError: (code, kind) => {
      if (R !== ses) return;
      // 처음부터 시작이 안 될 때만 음성 감지로 바꿉니다.
      if (kind === 'fatal') return fallbackVoice(code);
      if (kind === 'blocked') {
        // 화면을 가리지 않고 음성 감지로 이어 갑니다. 칩이나 자막을 누르면 다시 켜집니다.
        event('asr-blocked', code);
        renderAsrChip();
        if (!ses.blockedToast) {
          ses.blockedToast = true;
          toast('음성 인식이 멈춰 목소리 감지로 이어 갑니다. 자막을 누르면 인식이 다시 켜집니다.', 'warn');
        }
        return;
      }
      // 일시적인 오류는 알아서 다시 연결합니다. 30초에 한 번만 알려 줍니다.
      const now = performance.now();
      if ((code === 'network' || code === 'audio-capture') && now - ses.lastWarnToast > 30000) {
        ses.lastWarnToast = now;
        toast(code === 'network' ? '음성 인식 연결이 불안정해 다시 연결하는 중입니다' : '마이크를 다시 연결하는 중입니다', 'warn');
      }
    },
  });
  ses.speech.start();
}

/** 인식 결과가 들어오면 지킴이 상태를 풀어 줍니다. */
function asrAlive(ses) {
  ses.lastAsrAt = performance.now();
  ses.refreshStreak = 0;
  if (ses.frozen) {
    ses.frozen = false;
    banner('');
  }
}

/** 사용자가 직접 음성 인식을 다시 켬. 탭 안에서 불려야 아이폰·아이패드에서도 다시 켜집니다. */
function restartSpeech() {
  const ses = R;
  if (!ses || ses.state !== 'recording') return;
  if (ses.mode !== 'auto') {
    if (ses.modeStart !== 'auto' || !Speech.supported()) return;
    ses.mode = 'auto';
    renderStage();
  }
  if (!ses.speech) startSpeech(ses);
  else {
    ses.speech.stop();
    ses.speech.start();
  }
  ses.lastAsrAt = performance.now();
  ses.refreshStreak = 0;
  ses.frozen = false;
  banner('');
  event('asr-manual-restart');
  renderAsrChip();
  toast('음성 인식을 다시 켰습니다');
}

/** 음성 인식을 쓸 수 없을 때: 목소리 감지로 자막을 이어 갑니다(녹화는 계속). */
function fallbackVoice(code) {
  if (!R || R.mode !== 'auto') return;
  R.speech?.stop();
  R.mode = 'voice';
  event('fallback-voice', code);
  const why = {
    'not-allowed': '음성 인식 권한이 없어',
    'service-not-allowed': '이 브라우저에서 음성 인식을 쓸 수 없어',
    'audio-capture': '이 기기는 녹화와 음성 인식이 마이크를 함께 쓰지 못해',
    'language-not-supported': '한국어 음성 인식을 지원하지 않아',
  }[code] || '음성 인식이 멈춰';
  banner(`${why} '음성 감지'로 자막을 이어 갑니다. 녹화는 계속됩니다.`, [{ label: '탭해서 넘기기로', fn: () => switchMode('manual') }]);
  renderAsrChip();
  renderStage();
}

function switchMode(mode) {
  if (!R) return;
  if (mode !== 'auto') R.speech?.stop();
  R.mode = mode;
  event('mode', mode);
  renderAsrChip();
  renderStage();
}

function checkForbidden(text, t) {
  if (!R.forbidden.length) return;
  for (const w of C.findForbidden(text, R.forbidden, model.dict)) {
    const now = performance.now();
    if (now - (R.lastForbid[w] || 0) < 6000) continue;
    R.lastForbid[w] = now;
    R.forbidHits.push({ t: Math.round(t * 10) / 10, word: w });
    const f = $('#flash');
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
    toast(`금칙어: ${w}`, 'danger');
    vibrate([200, 100, 200]);
  }
}

function meterLoop(ses) {
  const bar = $('#meter');
  let last = performance.now();
  const loop = () => {
    if (R !== ses || ses.state === 'stopping') return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    let voiced = false;
    if (ses.meter?.ok) {
      const lv = ses.meter.level();
      bar.style.transform = `scaleX(${lv.toFixed(3)})`;
      voiced = ses.vad.update(lv, dt);
      bar.classList.toggle('on', voiced);
      if (voiced && ses.state === 'recording') ses.voiceAt = now;
    }
    if (ses.state === 'recording') followStep(ses, dt, voiced, now);
    ses.raf = requestAnimationFrame(loop);
  };
  loop();
}

/** 음성 인식이 잘 되는지: 최근 3초 안에 결과가 있었는가 */
function asrHealthy(ses, now) {
  return ses.mode === 'auto' && ses.speech && !ses.speech.blocked && now - ses.lastAsrAt < 3000;
}

/**
 * 말하는 동안 자막을 음절 단위로 부드럽게 채웁니다.
 * 음성 인식이 잘 되면 인식 위치보다 조금 앞서(follow), 끊기면 목소리만으로(lead), 탭 모드는 문장 안에서만(hold).
 */
function followStep(ses, dt, voiced, now) {
  const tr = ses.tracker;
  let fm;
  if (ses.mode === 'manual') fm = 'hold';
  else if (ses.mode === 'voice') fm = 'lead';
  else if (ses.speech && !ses.speech.blocked && now - ses.lastAsrAt < 12000) fm = 'asr'; // 음성 인식 결과로만 색칠
  else fm = 'lead'; // 인식 결과가 12초 넘게 없음: 목소리와 쉼으로 위치를 추정(다른 표시)
  if (fm !== ses.followMode) {
    ses.followMode = fm;
    renderAsrChip();
  }
  // 음성 감지로 앞서 나갔는데, 음성 인식이 '실제 위치는 25음절 넘게 뒤'라고 연달아 두 번 알려 줄 때만 되돌립니다.
  if ((fm === 'follow' || fm === 'asr') && tr.matchSeq !== ses.seenMatch) {
    ses.seenMatch = tr.matchSeq;
    if (tr.lastMatchEnd < ses.follower.pos - 25) ses.behind = (ses.behind || 0) + 1;
    else ses.behind = 0;
    if (ses.behind >= 2) {
      ses.behind = 0;
      event('correct', { from: Math.round(ses.follower.pos), to: tr.lastMatchEnd });
      tr.correctTo(tr.lastMatchEnd, elapsed());
      ses.follower.reset(tr.focus);
      renderSubs();
    }
  }
  const anchor = Math.max(tr.cursor, tr.tentCursor);
  if (ses.follower.step(dt, voiced, anchor, fm)) {
    const before = tr.current();
    tr.setPred(Math.max(ses.follower.pos, tr.pred), elapsed());
    if (tr.current() !== before) ses.peekLevel = 0;
    renderSubs();
  }
}

function tick() {
  const ses = R;
  if (!ses) return;
  const t = elapsed();
  renderClock(t);
  const left = C.MAX_RECORD_SEC - t;
  const cl = $('#clock-left');
  cl.textContent = `녹화 한도까지 ${fmt(left)}`;
  cl.classList.toggle('warn', left <= 60);
  if (ses.state !== 'recording') return;

  if (!ses.history.length || t - ses.history[ses.history.length - 1].t >= 1) ses.history.push({ t, c: effCursor(t) });

  for (const w of C.WARN_AT_SEC) {
    if (t >= w && !ses.warned.has(w)) {
      ses.warned.add(w);
      toast(`녹화 종료까지 ${C.MAX_RECORD_SEC - w >= 60 ? '1분' : '30초'} 남았습니다`, 'warn');
      vibrate([120, 80, 120]);
    }
  }
  if (t >= C.MAX_RECORD_SEC) {
    stopRecording('limit');
    return;
  }

  const now = performance.now();
  // 음성 인식 지킴이: 말하는데 7초 넘게(말이 없어도 20초 넘게) 결과가 없으면 세션을 새로 고칩니다.
  if (ses.mode === 'auto' && ses.speech && !ses.speech.blocked && t > 8) {
    const quiet = now - ses.lastAsrAt;
    const talking = now - ses.voiceAt < 1500;
    if (((talking && quiet > 7000) || quiet > 20000) && now - ses.lastRefreshAt > 7000) {
      ses.lastRefreshAt = now;
      ses.refreshStreak++;
      // 말하는데 두 번 연속 결과가 없으면 마이크 입력을 바꿔 봅니다 (브라우저 마이크 ↔ 녹화용 마이크 트랙)
      // (한 번도 결과가 없었다면 첫 번째에 바로 바꿔 봄)
      const need = ses.speech.everWorked ? 2 : 1;
      if (talking && ses.refreshStreak >= need && ses.speech.switchInput('no-results')) ses.refreshStreak = 0;
      else ses.speech.refresh('watchdog');
    }
  }

  // 숨김·첫 글자 단계: 말이 멈추고 4초가 지나면 다음 어절을 살짝 보여 줍니다.
  if (ses.level !== 'full') {
    const stuck = t - ses.tracker.lastProgress;
    const silent = now - ses.voiceAt > 2500;
    const want = stuck > 4 && silent ? Math.min(4, Math.floor((stuck - 4) / 4) + 1) : 0;
    if (want > ses.peekLevel) {
      ses.hints += want - ses.peekLevel;
      ses.peekLevel = want;
      renderSubs();
    } else if (want === 0 && ses.peekLevel && stuck <= 4) {
      ses.peekLevel = 0;
      renderSubs();
    }
  }

  updatePrediction(t);
}

function pauseRecording(auto = false) {
  const ses = R;
  if (!ses || ses.state !== 'recording') return;
  ses.acc = elapsed();
  ses.state = 'paused';
  ses.recorder?.pause();
  ses.speech?.stop();
  ses.autoPaused = auto;
  event('pause', auto ? 'auto' : undefined);
  renderStage();
  updatePrediction(ses.acc);
}

function resumeRecording() {
  const ses = R;
  if (!ses || ses.state !== 'paused') return;
  if (ses.stream.getTracks().some((tr) => tr.readyState === 'ended')) {
    toast('카메라가 꺼져서 여기까지 저장합니다.', 'warn');
    stopRecording('camera-ended');
    return;
  }
  ses.state = 'recording';
  ses.since = performance.now();
  ses.lastAsrAt = performance.now();
  ses.recorder?.resume();
  if (ses.mode === 'auto') ses.speech?.start();
  wake.request();
  event('resume');
  renderStage();
}

async function stopRecording(reason = 'user') {
  const ses = R;
  if (!ses || (ses.state !== 'recording' && ses.state !== 'paused')) return;
  const t = elapsed();
  ses.acc = t;
  ses.state = 'stopping';
  clearInterval(ses.tick);
  cancelAnimationFrame(ses.raf);
  clearTimeout(ses.interimTimer);
  ses.speech?.stop();
  event('stop', reason);
  renderStage();
  banner('');
  toast(reason === 'limit' ? '15분이 되어 녹화를 마치고 저장합니다' : '저장하는 중입니다…');
  try {
    await ses.recorder?.stop();
  } catch (err) {
    console.error(err);
  }
  await ses.writes;
  const record = buildRecord(ses, t, reason);
  let direct = null;
  try {
    await DB.saveSession(record);
  } catch {
    ses.dbFailed = true;
  }
  if (ses.dbFailed) direct = { record, blob: ses.recorder ? new Blob(ses.mem, { type: record.mime }) : null };
  releaseStage(ses);
  R = null;
  await openReview(record.id, direct);
}

function buildRecord(ses, t, reason) {
  const tr = ses.tracker;
  const stats = tr.sentenceStats();
  const act = C.sectionActuals({ sections: model.sections, sectionEnter: tr.sectionEnter(), t, cursor: tr.focus });
  return {
    id: ses.sessionId,
    createdAt: ses.createdAt,
    durationSec: t,
    targetSec: ses.targetSec,
    reason,
    mode: ses.mode,
    modeStart: ses.modeStart,
    level: ses.level,
    mime: ses.recorder?.mimeType || '',
    bytes: ses.bytes,
    hasVideo: !!ses.recorder,
    dbFailed: !!ses.dbFailed,
    N: model.N,
    covered: tr.focus,
    sections: model.sections.map((s, k) => ({
      title: s.title,
      n: s.n,
      recStart: ses.schedule[k].start,
      recSec: ses.schedule[k].dur,
      start: act[k]?.start ?? null,
      end: act[k]?.end ?? null,
      done: !!act[k]?.done,
    })),
    sentences: model.sentences.map((s, i) => ({
      text: s.text,
      sectionId: s.sectionId,
      status: stats[i].status,
      ratio: Math.round(stats[i].ratio * 100) / 100,
      t: stats[i].tStart,
    })),
    summary: C.summarize({ stats, durationSec: t, targetSec: ses.targetSec, covered: tr.focus, N: model.N }),
    hints: ses.hints,
    forbidden: ses.forbidHits,
    transcript: ses.transcript,
    events: ses.events,
    asrRestarts: ses.speech?.restarts || 0,
    asr: ses.speech ? { ...ses.speech.stats, input: ses.speech.input, locked: ses.speech.inputLocked } : null,
    userAgent: navigator.userAgent,
  };
}

function releaseStage(ses) {
  clearInterval(ses.tick);
  cancelAnimationFrame(ses.raf);
  ses.speech?.stop();
  ses.meter?.close();
  ses.stream?.getTracks().forEach((t) => t.stop());
  $('#cam').srcObject = null;
  wake.release();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  banner('');
}

function closeStage() {
  if (!R) return show('setup');
  if (R.state === 'recording' || R.state === 'paused') return stopRecording('user');
  if (R.state === 'stopping') return;
  const ses = R;
  ses.state = 'closed';
  releaseStage(ses);
  R = null;
  show('setup');
  renderHistory();
}

function moveSentence(dir) {
  if (!R || !(R.state === 'recording' || R.state === 'paused')) return;
  const t = elapsed();
  if (dir > 0) R.tracker.next(t, R.mode === 'manual');
  else R.tracker.prev(t);
  if (dir > 0) R.tracker.pred = Math.max(R.tracker.pred, R.tracker.cursor);
  R.follower.reset(R.tracker.focus);
  R.peekLevel = 0;
  event(dir > 0 ? 'next' : 'prev', R.tracker.current());
  renderSubs();
  updatePrediction(t);
}

function initStage() {
  $('#btn-main').addEventListener('click', () => {
    if (!R) return;
    if (R.state === 'ready') startRecording();
    else if (R.state === 'recording') pauseRecording();
    else if (R.state === 'paused') resumeRecording();
  });
  $('#btn-stop').addEventListener('click', () => stopRecording('user'));
  $('#btn-next').addEventListener('click', () => moveSentence(1));
  $('#btn-prev').addEventListener('click', () => moveSentence(-1));
  $('#subs').addEventListener('click', () => {
    if (!R || R.state !== 'recording') return;
    if (R.mode === 'manual') moveSentence(1);
    else if ((R.mode === 'auto' && R.speech?.blocked) || (R.mode === 'voice' && R.modeStart === 'auto')) restartSpeech();
  });
  $('#btn-close').addEventListener('click', closeStage);
  $('#asr-chip').addEventListener('click', () => {
    if (R?.state === 'recording' && (R.mode === 'auto' || R.modeStart === 'auto')) restartSpeech();
  });
  $('#btn-font-up').addEventListener('click', () => {
    S.font = Math.min(1.8, Math.round((S.font + 0.1) * 10) / 10);
    saveSettings();
    applyFont();
  });
  $('#btn-font-down').addEventListener('click', () => {
    S.font = Math.max(0.7, Math.round((S.font - 0.1) * 10) / 10);
    saveSettings();
    applyFont();
  });
  $('#btn-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else $('#stage').requestFullscreen?.().catch(() => {});
  });

  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.view !== 'stage' || !R) return;
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.code === 'Space' || e.key === 'Enter' || e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      $('#btn-main').click();
    } else if (['ArrowRight', 'PageDown', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      moveSentence(1);
    } else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      moveSentence(-1);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!R) return;
    if (document.hidden && R.state === 'recording') pauseRecording(true);
    else if (!document.hidden && R.state === 'paused' && R.autoPaused) {
      R.autoPaused = false;
      toast('다른 화면으로 가서 일시정지했습니다. ▶ 계속을 누르세요.');
    }
  });
}

/* ═════════════ 결과 화면 ═════════════ */

let reviewURL = null;

async function openReview(id, direct = null) {
  const rec = direct?.record || (await DB.getSession(id).catch(() => null));
  if (!rec) {
    toast('기록을 찾지 못했습니다.', 'warn');
    show('setup');
    return renderHistory();
  }
  let blob = direct?.blob ?? null;
  if (!direct && rec.hasVideo) blob = await DB.getVideo(id, rec.mime).catch(() => null);
  if (reviewURL) URL.revokeObjectURL(reviewURL);
  reviewURL = blob ? URL.createObjectURL(blob) : null;

  const sum = rec.summary;
  const st = C.classifyDelta(sum.delta);
  const ext = extOf(rec.mime);
  const fileName = `발표연습_${stamp(rec.createdAt)}.${ext}`;
  const lvText = { full: '전체 보기', hint: '첫 글자', hidden: '숨김' }[rec.level];
  const auto = rec.mode === 'auto';
  const voice = rec.mode === 'voice';
  const c = sum.count;
  const cards = [
    ['총 시간', fmt(rec.durationSec), `목표 ${fmt(rec.targetSec)}`, ''],
    ['목표 대비', C.fmtDelta(sum.delta), C.STATUS_TEXT[st], `st-${st}`],
    ['평균 속도', `${sum.spm}`, '음절/분', ''],
    auto
      ? ['인식된 문장', `${c.ok}/${sum.total}`, `일부 ${c.partial} · 누락 ${c.missed}${c.estimated ? ` · 추정 ${c.estimated}` : ''}`, c.missed ? 'st-over' : '']
      : voice
        ? ['지나간 문장', `${c.estimated + c.ok + c.partial}/${sum.total}`, '목소리 감지로 추정', '']
        : ['넘긴 문장', `${c.manual}/${sum.total}`, `미도달 ${c.notReached}`, ''],
    ['힌트', `${rec.hints}`, lvText, ''],
    ['금칙어', `${rec.forbidden.length}`, rec.forbidden.length ? [...new Set(rec.forbidden.map((f) => f.word))].join(', ') : '없음', rec.forbidden.length ? 'st-over' : ''],
  ];

  const secRows = rec.sections
    .map((s, k) => {
      const actual = s.start != null ? s.end - s.start : null;
      const cmp = actual != null && s.done ? C.compareSection(actual, s.recSec) : '';
      const diff = actual != null ? actual - s.recSec : null;
      const scale = Math.max(s.recSec, actual || 0, 1);
      return `<tr>
        <td><em>${k + 1}</em>${esc(s.title)}</td>
        <td>${fmt(Math.round(s.recSec))}</td>
        <td>${actual != null ? fmt(Math.round(actual)) : '—'}</td>
        <td class="${cmp ? 'cmp-' + cmp : ''}">${diff != null ? C.fmtDelta(diff) : '—'}</td>
        <td class="mini"><i class="r" style="width:${((s.recSec / scale) * 100).toFixed(0)}%"></i><i class="a ${cmp}" style="width:${(((actual || 0) / scale) * 100).toFixed(0)}%"></i></td>
      </tr>`;
    })
    .join('');

  const sentRows = rec.sentences
    .map((s, i) => {
      const prevSec = i > 0 ? rec.sentences[i - 1].sectionId : -1;
      const head = s.sectionId !== prevSec ? `<li class="sec-head">${s.sectionId + 1}. ${esc(rec.sections[s.sectionId].title)}</li>` : '';
      const ratio = auto && s.status !== 'notReached' && s.status !== 'estimated' ? ` <small>${Math.round(s.ratio * 100)}%</small>` : '';
      return `${head}<li class="sent ${s.status}" data-i="${i}" ${s.t != null ? `data-t="${s.t}"` : ''}>
        <span class="time">${s.t != null ? fmt(s.t) : '—'}</span>
        <span class="badge">${STATUS_LABEL[s.status]}${ratio}</span>
        <span class="txt">${esc(s.text)}</span>
      </li>`;
    })
    .join('');

  const el = $('#review');
  el.innerHTML = `
    <header class="rv-head">
      <button type="button" class="ghost" id="rv-back">← 처음으로</button>
      <div class="rv-title">
        <p class="eyebrow">연습 결과</p>
        <h1>${dateText(rec.createdAt)}</h1>
        <p class="muted">${MODE_NAME[rec.modeStart] || ''} · ${lvText}${rec.modeStart !== rec.mode ? ` · 도중에 ${MODE_NAME[rec.mode]}(으)로 전환` : ''}${rec.reason === 'limit' ? ' · 15분 한도로 자동 종료' : ''}</p>
      </div>
      <button type="button" class="primary" id="rv-again">다시 연습</button>
    </header>
    ${rec.mode === 'auto' && rec.asr && rec.asr.interims + rec.asr.finals < 3 && rec.durationSec > 20 ? '<p class="error">이번 연습에서는 음성 인식 결과가 거의 들어오지 않아 목소리 감지로만 위치를 추정했습니다. 주소창의 마이크 권한과 인터넷 연결을 확인하고, 계속되면 Chrome에서 해 보세요.</p>' : ''}
    ${rec.dbFailed ? '<p class="error">기기 저장 공간이 부족해 영상이 이 화면에만 남아 있습니다. 지금 <b>영상 저장</b>을 눌러 파일로 보관하세요.</p>' : ''}
    <div class="rv-grid">
      <div class="rv-player">
        ${
          reviewURL
            ? `<div class="vid-wrap"><video id="rv-video" src="${reviewURL}" controls playsinline preload="metadata"></video><p class="rv-sub" id="rv-sub"></p></div>`
            : '<div class="vid-wrap empty"><p>녹화된 영상이 없습니다.</p></div>'
        }
        <div class="rv-actions">
          <button type="button" class="primary" id="rv-save" ${blob ? '' : 'disabled'}>영상 저장</button>
          <button type="button" class="ghost" id="rv-share" hidden>공유 · 사진에 저장</button>
          <button type="button" class="ghost" id="rv-json">기록 JSON</button>
          <button type="button" class="ghost danger" id="rv-del">기록 삭제</button>
        </div>
        <p class="muted small-text">${blob ? `${fileName} · ${(blob.size / 1048576).toFixed(1)}MB` : ''} — PC는 다운로드 폴더, 휴대폰은 다운로드(파일 앱)에 저장됩니다. 아이폰·아이패드는 <b>공유 → 비디오 저장</b>으로 사진 앱에 넣을 수 있습니다.</p>
      </div>
      <div class="rv-side">
        <div class="cards">${cards.map(([k, v, sub, cls]) => `<div class="stat ${cls}"><span>${k}</span><b>${v}</b><small>${esc(sub)}</small></div>`).join('')}</div>
        <section class="card">
          <h2>시간 배분</h2>
          <div class="tl light" id="rv-tl"></div>
          <table class="sec-table"><thead><tr><th>구간</th><th>권장</th><th>실제</th><th>차이</th><th></th></tr></thead><tbody>${secRows}</tbody></table>
        </section>
      </div>
    </div>
    <section class="card">
      <div class="card-head"><h2>문장별 기록</h2><span class="muted small-text">문장을 누르면 그 장면으로 이동합니다</span></div>
      <ol class="sent-list" id="rv-sents">${sentRows}</ol>
    </section>`;

  show('review');
  if (direct !== null || document.querySelector('#toast.on')) toast(rec.dbFailed ? '영상을 파일로 저장해 주세요' : '저장했습니다');

  // 실제 시간 막대
  const pred = rec.sections
    .map((s, k) => (s.start != null ? { k, start: s.start, end: s.end, kind: 'done', cmp: s.done ? C.compareSection(s.end - s.start, s.recSec) : 'ok' } : null))
    .filter(Boolean);
  const recSegs = rec.sections.map((s, k) => ({ k, start: s.recStart, end: s.recStart + s.recSec, dur: s.recSec }));
  renderTimeline($('#rv-tl'), { rec: recSegs, pred, t: rec.durationSec, target: rec.targetSec, total: rec.durationSec, delta: sum.delta, status: st }, { live: false, predLabel: '실제', titles: rec.sections.map((s) => s.title) });

  $('#rv-back').addEventListener('click', () => {
    show('setup');
    renderHistory();
  });
  $('#rv-again').addEventListener('click', () => {
    show('setup');
    renderHistory();
    openStage();
  });
  $('#rv-json').addEventListener('click', () => {
    download(new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }), `발표연습_${stamp(rec.createdAt)}.json`);
  });
  if (blob) {
    $('#rv-save').addEventListener('click', () => download(blob, fileName));
    const file = new File([blob], fileName, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      const b = $('#rv-share');
      b.hidden = false;
      b.addEventListener('click', () => navigator.share({ files: [file], title: '발표 연습 영상' }).catch(() => {}));
    }
  }
  const del = $('#rv-del');
  let armed = 0;
  del.addEventListener('click', async () => {
    if (Date.now() - armed > 3000) {
      armed = Date.now();
      del.textContent = '한 번 더 누르면 삭제';
      setTimeout(() => (del.textContent = '기록 삭제'), 3000);
      return;
    }
    await DB.deleteSession(rec.id).catch(() => {});
    toast('기록을 삭제했습니다');
    show('setup');
    renderHistory();
  });

  const video = $('#rv-video');
  if (!video) return;
  // webm 녹화본은 길이 정보가 없어 한 번 끝으로 이동해 길이를 계산합니다.
  video.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(video.duration)) {
      const back = () => {
        video.removeEventListener('timeupdate', back);
        video.currentTime = 0;
      };
      video.addEventListener('timeupdate', back);
      video.currentTime = 1e7;
    }
  });
  const items = $$('#rv-sents .sent');
  const times = rec.sentences.map((s) => s.t);
  let active = -1;
  const sync = () => {
    const ct = video.currentTime;
    let idx = -1;
    for (let i = 0; i < times.length; i++) if (times[i] != null && times[i] <= ct + 0.05) idx = i;
    if (idx === active) return;
    active = idx;
    items.forEach((li) => li.classList.toggle('playing', +li.dataset.i === idx));
    const s = rec.sentences[idx];
    $('#rv-sub').innerHTML = s ? `<span class="${s.status}">${esc(s.text)}</span>` : '';
  };
  video.addEventListener('timeupdate', sync);
  video.addEventListener('seeked', sync);
  items.forEach((li) =>
    li.addEventListener('click', () => {
      if (li.dataset.t == null) return;
      video.currentTime = +li.dataset.t;
      video.play().catch(() => {});
      video.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }),
  );
}

/* ═════════════ 시작 ═════════════ */

initSetup();
initStage();
show('setup');

// 테스트·디버깅용
window.__bridge = { get session() { return R; }, get model() { return model; }, C };

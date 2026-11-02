'use strict';

const $ = id => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const preview = $('preview').getContext('2d');
const meter = $('meter');
const tracks = { low: $('low'), high: $('high') };
let stream = null, phase = 'idle', session = 0, facing = 'environment';
let frame = 0, lastTick = 0, lastFace = 0, smoothed = 0, faceScore = 0;
let muted = false, audioMode = 'low', audioRevision = 0;
let modelPromise = null, reference = null, referenceRevision = 0, referenceUrl = null;
let faceBusy = false;

for (let i = 0; i < 24; i++) {
  const bar = document.createElement('i');
  bar.style.setProperty('--color', `hsl(${115 - i * 5} 88% 50%)`);
  meter.appendChild(bar);
}
const message = text => { $('message').textContent = text; };
const faceMessage = text => { $('faceStatus').textContent = text; };
const alive = id => id === session && phase === 'running';

function render(value) {
  const n = Math.max(0, Math.min(100, Math.round(value)));
  $('value').textContent = String(n).padStart(2, '0');
  meter.setAttribute('aria-valuenow', n);
  [...meter.children].forEach((bar, i) => bar.classList.toggle('on', i < Math.ceil(n / 100 * 24)));
  $('status').textContent = phase !== 'running' ? 'ОЖИДАНИЕ СИГНАЛА' : n >= 80 ? 'ДВИЖУХА НА МАКСИМУМЕ' : n >= 40 ? 'НАБИРАЕМ ОБОРОТЫ' : 'ПОИСК ДВИЖУХИ';
  if (phase === 'running') {
    const next = audioMode === 'high' ? (n <= 76 ? 'low' : 'high') : (n >= 82 ? 'high' : 'low');
    if (next !== audioMode) { audioMode = next; syncAudio(); }
  }
}

// Unlock both media elements inside the user's click, before requesting permission.
function unlockAudio() {
  if (muted) return;
  const revision = ++audioRevision;
  for (const audio of Object.values(tracks)) {
    audio.muted = true;
    const attempt = audio.play();
    attempt?.then(() => {
      if (revision !== audioRevision) return;
      audio.pause(); audio.currentTime = 0; audio.muted = false;
      if (phase === 'running') syncAudio();
    }).catch(() => { audio.muted = false; });
  }
}
function syncAudio() {
  for (const [name, audio] of Object.entries(tracks)) {
    const selected = phase === 'running' && !muted && name === audioMode;
    if (!selected) { audio.pause(); audio.currentTime = 0; }
    else {
      audio.muted = false;
      audio.play()?.catch(() => {
        if (phase === 'running' && !muted) message('Нажми кнопку звука, чтобы разрешить воспроизведение.');
      });
    }
  }
}
function setPhase(next) {
  phase = next;
  $('start').textContent = next === 'starting' ? 'Отменить подключение' : next === 'running' ? 'Остановить' : 'Начать измерение';
  $('switch').disabled = next === 'starting';
  $('live').textContent = next === 'running' ? '● LIVE' : next === 'starting' ? '● ПОДКЛЮЧЕНИЕ' : '● OFFLINE';
  $('live').classList.toggle('active', next === 'running');
}
function stop(text = 'Измерение остановлено.') {
  session++;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  setPhase('idle');
  syncAudio();
  preview.clearRect(0, 0, 640, 480);
  $('placeholder').style.display = 'flex';
  smoothed = faceScore = lastTick = lastFace = 0;
  audioMode = 'low';
  render(0);
  ['white', 'blue', 'red', 'face'].forEach(id => { $(id).textContent = '—'; });
  message(text);
}
async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    message('Камера недоступна. Открой сайт через HTTPS или localhost.'); return;
  }
  const id = ++session;
  setPhase('starting');
  message('Разреши доступ к камере. Повторное нажатие отменит подключение.');
  let acquired;
  try {
    acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
    if (id !== session) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired;
    video.srcObject = stream;
    await video.play();
    if (id !== session) return;
    setPhase('running');
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (alive(id)) stop('Камера отключена. Подключи её и начни измерение снова.');
    }));
    $('placeholder').style.display = 'none';
    message('Анализируется вся область превью. Обработка остаётся на устройстве.');
    syncAudio();
    frame = requestAnimationFrame(tick);
    prepareReference();
  } catch (error) {
    acquired?.getTracks().forEach(t => t.stop());
    if (id !== session) return;
    const errors = {
      NotAllowedError: 'Доступ к камере запрещён. Разреши его в настройках сайта в браузере.',
      NotFoundError: 'Камера не найдена. Подключи камеру и повтори запуск.',
      NotReadableError: 'Камера занята другим приложением или недоступна.',
      OverconstrainedError: 'Эта камера не поддерживает запрошенные настройки.'
    };
    stop(errors[error.name] || 'Не удалось запустить камеру. Попробуй ещё раз.');
  }
}

async function loadModels() {
  if (!window.faceapi) throw new Error('library');
  if (!modelPromise) {
    const url = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
    modelPromise = Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(url),
      faceapi.nets.faceLandmark68Net.loadFromUri(url),
      faceapi.nets.faceRecognitionNet.loadFromUri(url)
    ]).catch(error => { modelPromise = null; throw error; });
  }
  return modelPromise;
}
async function prepareReference() {
  const revision = ++referenceRevision;
  reference = null; faceScore = 0; $('face').textContent = '—';
  const source = $('referencePreview').src;
  faceMessage('Загрузка модели и проверка образца…');
  try {
    await loadModels();
    const image = new Image(); image.src = source; await image.decode();
    const result = await faceapi.detectSingleFace(image, new faceapi.SsdMobilenetv1Options({ minConfidence: .45 })).withFaceLandmarks().withFaceDescriptor();
    if (revision !== referenceRevision) return;
    if (!result) { faceMessage('Лицо на образце не найдено. Выбери чёткое фото с целым лицом.'); return; }
    reference = result.descriptor;
    faceMessage(phase === 'running' ? 'Образец готов. Поиск лица в кадре…' : 'Образец готов. Запусти камеру.');
  } catch (error) {
    if (revision !== referenceRevision) return;
    faceMessage('Не удалось загрузить модель или фото. Проверь интернет и выбери фото повторно.');
  }
}
async function detectFace(id) {
  if (!alive(id) || !reference || faceBusy) return;
  faceBusy = true;
  const revision = referenceRevision;
  // Snapshot the exact cropped frame used for color analysis and preview.
  const snapshot = document.createElement('canvas');
  snapshot.width = 640; snapshot.height = 480;
  snapshot.getContext('2d').drawImage($('preview'), 0, 0);
  try {
    const faces = await faceapi.detectAllFaces(snapshot, new faceapi.SsdMobilenetv1Options({ minConfidence: .45 })).withFaceLandmarks().withFaceDescriptors();
    if (!alive(id) || revision !== referenceRevision) return;
    faceScore = faces.length ? Math.max(0, Math.min(1, (.85 - Math.min(...faces.map(face => faceapi.euclideanDistance(reference, face.descriptor)))) / .4)) : 0;
    $('face').textContent = faces.length ? `${Math.round(faceScore * 100)}%` : '—';
    faceMessage(faces.length ? 'Условное сходство с образцом' : 'Лицо не найдено');
  } catch (error) {
    if (alive(id) && revision === referenceRevision) {
      faceScore = 0; $('face').textContent = '—'; faceMessage('Ошибка анализа лица. Бонус сходства сброшен.');
    }
  } finally { faceBusy = false; }
}
function tick(time) {
  if (phase !== 'running') return;
  if (time - lastTick >= 80 && video.readyState >= 2) {
    lastTick = time;
    const width = video.videoWidth, height = video.videoHeight;
    if (width && height) {
      const cropWidth = Math.min(width, height * 4 / 3);
      const cropHeight = cropWidth * 3 / 4;
      preview.drawImage(video, (width - cropWidth) / 2, (height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, 640, 480);
      ctx.drawImage($('preview'), 0, 0, 160, 120);
      const data = ctx.getImageData(0, 0, 160, 120).data;
      let white = 0, blue = 0, red = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 175 && g > 175 && b > 175 && Math.max(r, g, b) - Math.min(r, g, b) < 55) white++;
        else if (b > 75 && b > r * 1.2 && b > g * 1.1) blue++;
        else if (r > 95 && r > g * 1.3 && r > b * 1.25) red++;
      }
      const total = data.length / 4;
      for (const [name, count] of [['white', white], ['blue', blue], ['red', red]]) $(name).textContent = `${(count / total * 100).toFixed(1)}%`;
      const target = Math.min(100, (white + blue + red) / total * 150 + faceScore * 45);
      smoothed = smoothed * .65 + target * .35;
      render(smoothed);
      if (time - lastFace > 1200) { lastFace = time; detectFace(session); }
    }
  }
  frame = requestAnimationFrame(tick);
}

$('start').onclick = () => {
  if (phase !== 'idle') stop('Подключение или измерение остановлено.');
  else { unlockAudio(); start(); }
};
$('switch').onclick = () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  if (phase === 'running') { stop(); unlockAudio(); start(); }
  else message(facing === 'user' ? 'Выбрана фронтальная камера.' : 'Выбрана основная камера.');
};
$('sound').onclick = () => {
  muted = !muted;
  $('sound').textContent = muted ? '♩' : '♪';
  $('sound').setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
  $('sound').setAttribute('aria-pressed', String(muted));
  if (!muted) unlockAudio();
  syncAudio();
};
$('referenceFile').onchange = () => {
  const file = $('referenceFile').files[0];
  if (!file) return;
  if (!file.type.startsWith('image/') || file.size > 15 * 1024 * 1024) {
    faceMessage('Выбери изображение размером до 15 МБ.'); return;
  }
  if (referenceUrl) URL.revokeObjectURL(referenceUrl);
  referenceUrl = URL.createObjectURL(file);
  $('referencePreview').src = referenceUrl;
  prepareReference();
};
$('resetReference').onclick = () => {
  if (referenceUrl) URL.revokeObjectURL(referenceUrl);
  referenceUrl = null; $('referenceFile').value = '';
  $('referencePreview').src = 'assets/reference.jpg';
  prepareReference();
};
window.addEventListener('pagehide', () => stop());
document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase !== 'idle') stop('Измерение остановлено при скрытии вкладки. Нажми «Начать измерение».');
});
render(0);

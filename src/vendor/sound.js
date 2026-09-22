'use strict';
// Thư viện âm thanh nhỏ, tự chứa (không cần mạng, không phụ thuộc thư viện ngoài).
// - Mặc định phát chuông 2 nốt sinh bằng Web Audio API nên app luôn có tiếng dù không kèm file âm thanh.
// - Muốn dùng âm thanh thật: bỏ file src/template/thong-bao.mp3 vào project (đã khai báo trong
//   package.json > pkg.assets để EXE mang theo). Không có file thì thư viện tự quay lại chuông sinh sẵn.
// - Trình duyệt chỉ cho phát tiếng sau khi người dùng đã tương tác một lần: thư viện tự "mở khoá"
//   audio ở lần bấm phím/chuột đầu tiên, nên tin nhắn đến trước lúc đó có thể không nghe thấy.
(() => {
  const FILE = 'template/thong-bao.mp3'; // đổi đường dẫn hoặc để '' nếu chỉ dùng chuông sinh sẵn
  const NOTES = [880, 1174.66]; // La5 → Rê6
  const state = { ctx: null, file: null, fileReady: false, enabled: true };

  function context() {
    if (state.ctx) return state.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { state.ctx = new Ctor(); } catch { state.ctx = null; }
    return state.ctx;
  }

  function chime() {
    const ctx = context();
    if (!ctx) return false;
    const start = ctx.currentTime + 0.01;
    NOTES.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const begin = start + index * 0.17;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, begin);
      gain.gain.exponentialRampToValueAtTime(0.28, begin + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, begin + 0.22);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(begin);
      oscillator.stop(begin + 0.26);
    });
    return true;
  }

  // Gọi ở lần tương tác đầu tiên: mở khoá AudioContext và nạp sẵn file âm thanh (nếu có).
  function unlock() {
    const ctx = context();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (state.file && !state.fileReady) { try { state.file.load(); } catch {} }
  }

  function play() {
    if (!state.enabled) return false;
    if (state.file && state.fileReady) {
      try {
        state.file.currentTime = 0;
        const started = state.file.play();
        if (started && typeof started.catch === 'function') started.catch(() => chime());
        return true;
      } catch { return chime(); }
    }
    return chime();
  }

  function setSource(file) {
    state.fileReady = false;
    state.file = null;
    if (!file) return;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('canplaythrough', () => { state.fileReady = true; });
    audio.addEventListener('error', () => { state.fileReady = false; state.file = null; });
    audio.src = file;
    state.file = audio;
  }

  window.HDSound = {
    play,
    unlock,
    setSource,
    setEnabled: value => { state.enabled = !!value; },
    get enabled() { return state.enabled; },
    get source() { return state.file ? String(state.file.getAttribute('src') || '') : ''; }
  };

  if (FILE) setSource(FILE);
  ['pointerdown', 'keydown', 'touchstart'].forEach(name => window.addEventListener(name, unlock, { once: true, passive: true }));
})();

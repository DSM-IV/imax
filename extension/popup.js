const THEATERS = [
  { code: '0013', name: 'CGV 용산아이파크몰', area: '01', type: 'IMAX 4K 레이저' },
  { code: '0074', name: 'CGV 왕십리', area: '01', type: 'IMAX 4K 레이저' },
  { code: '0056', name: 'CGV 강남', area: '01', type: 'IMAX' },
  { code: '0059', name: 'CGV 영등포', area: '01', type: 'IMAX 레이저' },
  { code: '0001', name: 'CGV 명동', area: '01', type: 'IMAX' },
  { code: '0229', name: 'CGV 여의도', area: '01', type: 'IMAX' },
  { code: '0014', name: 'CGV 건대입구', area: '01', type: 'IMAX' },
  { code: '0247', name: 'CGV 연수역', area: '03', type: 'IMAX' },
  { code: '0070', name: 'CGV 수원', area: '02', type: 'IMAX' },
  { code: '0218', name: 'CGV 센텀시티', area: '05', type: 'IMAX' },
  { code: '0088', name: 'CGV 대전', area: '042', type: 'IMAX' },
  { code: '0216', name: 'CGV 광주터미널', area: '04', type: 'IMAX' },
  { code: '0055', name: 'CGV 청주(서문)', area: '12', type: 'IMAX' },
  { code: '0131', name: 'CGV 대구 이시아', area: '11', type: 'IMAX' },
];

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function getNextDays(count = 21) {
  const days = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const weekday = d.toLocaleDateString('ko-KR', { weekday: 'short' });
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    days.push({
      value: formatDate(d),
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday,
      isWeekend,
    });
  }
  return days;
}

// --- State ---
let selectedTheater = null;
let selectedDates = [];
let monitoring = false;

// --- UI 렌더링 ---
function renderTheaters() {
  const grid = document.getElementById('theaterGrid');
  grid.innerHTML = THEATERS.map(
    (t) => `
    <button class="theater-btn ${selectedTheater === t.code ? 'active' : ''}" data-code="${t.code}">
      ${t.name.replace('CGV ', '')}
      <span class="type">${t.type}</span>
    </button>`
  ).join('');

  grid.querySelectorAll('.theater-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedTheater = btn.dataset.code;
      saveConfig();
      renderTheaters();
    });
  });
}

function renderDates() {
  const grid = document.getElementById('dateGrid');
  const days = getNextDays(21);
  grid.innerHTML = days
    .map(
      (d) => `
    <button class="date-btn ${selectedDates.includes(d.value) ? 'active' : ''} ${d.isWeekend ? 'weekend' : ''}" data-value="${d.value}">
      ${d.label}
      <span class="weekday">${d.weekday}</span>
    </button>`
    )
    .join('');

  grid.querySelectorAll('.date-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.value;
      if (selectedDates.includes(v)) {
        selectedDates = selectedDates.filter((d) => d !== v);
      } else {
        selectedDates.push(v);
      }
      saveConfig();
      renderDates();
    });
  });
}

function renderLogs(logs) {
  const list = document.getElementById('logList');
  list.innerHTML = (logs || [])
    .map(
      (l) =>
        `<li class="log-${l.type}"><span class="log-time">${l.time}</span>${l.msg}</li>`
    )
    .join('');
}

function renderFound(logs) {
  const section = document.getElementById('found-section');
  const found = (logs || []).filter((l) => l.type === 'success');
  if (found.length === 0) {
    section.innerHTML = '';
    return;
  }
  const theater = THEATERS.find((t) => t.code === selectedTheater);
  section.innerHTML = found
    .map(
      (f) => `
    <div class="found-card">
      <div class="movie">🎬 ${f.msg}</div>
      <a class="book-link" href="https://www.cgv.co.kr/ticket/?THEATER_CD=${selectedTheater}" target="_blank">
        CGV에서 예매하기 →
      </a>
    </div>`
    )
    .join('');
}

function updateUI() {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusBar = document.getElementById('statusBar');

  if (monitoring) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    statusBar.className = 'status on';
    statusBar.textContent = '● 모니터링 중 (30초 간격)';
  } else {
    startBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    statusBar.className = 'status off';
    statusBar.textContent = '대기 중';
  }

  startBtn.disabled = !selectedTheater || selectedDates.length === 0;
}

// --- 설정 저장/로드 ---
function saveConfig() {
  const theater = THEATERS.find((t) => t.code === selectedTheater);
  chrome.storage.local.set({
    theaterCode: selectedTheater,
    theaterName: theater?.name || '',
    areaCode: theater?.area || '',
    dates: selectedDates,
    movieKeyword: document.getElementById('movieKeyword').value,
  });
  updateUI();
}

async function loadConfig() {
  const config = await chrome.storage.local.get([
    'theaterCode',
    'dates',
    'movieKeyword',
    'monitoring',
    'logs',
  ]);
  selectedTheater = config.theaterCode || null;
  selectedDates = config.dates || [];
  monitoring = config.monitoring || false;
  document.getElementById('movieKeyword').value = config.movieKeyword || '';

  renderTheaters();
  renderDates();
  renderLogs(config.logs);
  renderFound(config.logs);
  updateUI();
}

// --- 이벤트 ---
document.getElementById('startBtn').addEventListener('click', () => {
  saveConfig();
  chrome.runtime.sendMessage({ type: 'START_MONITORING' }, () => {
    monitoring = true;
    updateUI();
  });
});

document.getElementById('stopBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_MONITORING' }, () => {
    monitoring = false;
    updateUI();
  });
});

document.getElementById('movieKeyword').addEventListener('input', () => {
  saveConfig();
});

document.getElementById('logClear').addEventListener('click', () => {
  chrome.storage.local.set({ logs: [] });
  renderLogs([]);
});

// storage 변경 감지 (백그라운드에서 로그 업데이트 시)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.logs) {
    renderLogs(changes.logs.newValue);
    renderFound(changes.logs.newValue);
  }
});

// 초기화
loadConfig();

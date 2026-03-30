const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

// CGV 메인 페이지를 열고, 그 안에서 same-origin fetch로 상영시간표 호출
async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  // CGV 메인 페이지 열기 (Cloudflare 통과를 위해)
  const tab = await chrome.tabs.create({ url: 'https://www.cgv.co.kr/', active: false });

  // 페이지 로드 완료 대기
  await new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
  });

  await new Promise((r) => setTimeout(r, 3000));

  // CGV 페이지 내부에서 same-origin fetch 실행
  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchFromInsideCgv,
      args: [theaterCode, areaCode, date],
    });
    results = injection[0]?.result || {};
  } catch (e) {
    results = { showtimes: [], debug: { error: e.message } };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return results;
}

// ★ CGV 페이지 컨텍스트에서 실행 — same-origin이므로 fetch 가능
async function fetchFromInsideCgv(theaterCode, areaCode, date) {
  const results = [];
  const debugInfo = { attempts: [] };

  // 시도 1: iframeTheater.aspx (기존 상영시간표)
  try {
    const res = await fetch(
      `/common/showtimes/iframeTheater.aspx?areacode=${areaCode}&theatercode=${theaterCode}&date=${date}`,
      { credentials: 'include' }
    );
    const html = await res.text();
    debugInfo.attempts.push({
      url: 'iframeTheater.aspx',
      status: res.status,
      length: html.length,
      hasImax: html.toUpperCase().includes('IMAX'),
      snippet: html.substring(0, 500),
    });

    // HTML 파싱
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const movieItems = doc.querySelectorAll('.sect-showtimes > ul > li');

    for (const item of movieItems) {
      const titleEl = item.querySelector('.info-movie a strong') || item.querySelector('.info-movie strong');
      if (!titleEl) continue;
      const movieName = titleEl.textContent.trim();

      const hallDivs = item.querySelectorAll('.type-hall');
      for (const hall of hallDivs) {
        const hallNameEl = hall.querySelector('.info-hall ul li:first-child') || hall.querySelector('.info-hall li');
        const hallName = hallNameEl ? hallNameEl.textContent.trim() : '';
        const isImax = hall.innerHTML.toUpperCase().includes('IMAX');

        const times = [];
        for (const em of hall.querySelectorAll('.info-timetable a em, .info-timetable em')) {
          const time = em.textContent.trim();
          if (/\d{2}:\d{2}/.test(time)) {
            const parent = em.closest('a');
            times.push({ time, isSoldOut: parent?.classList.contains('soldout') || false });
          }
        }
        if (isImax && times.length > 0) {
          results.push({ movieName, hallName, times, source: 'iframe' });
        }
      }
    }

    // 모든 영화 이름도 디버그에 포함
    debugInfo.allMovies = [...movieItems].map((item) => {
      const el = item.querySelector('.info-movie a strong') || item.querySelector('.info-movie strong');
      return el ? el.textContent.trim() : '?';
    });

    // IMAX가 HTML에 있는데 파싱 못한 경우, IMAX 근처 텍스트 캡처
    if (results.length === 0 && html.toUpperCase().includes('IMAX')) {
      const idx = html.toUpperCase().indexOf('IMAX');
      debugInfo.imaxContext = html.substring(Math.max(0, idx - 300), idx + 300);
    }
  } catch (e) {
    debugInfo.attempts.push({ url: 'iframeTheater.aspx', error: e.message });
  }

  // 시도 2: 새 CGV API 엔드포인트 탐색
  if (results.length === 0) {
    try {
      const res = await fetch(
        `/reserve/show-times/`,
        { credentials: 'include' }
      );
      const html = await res.text();
      debugInfo.attempts.push({
        url: '/reserve/show-times/',
        status: res.status,
        length: html.length,
        hasImax: html.toUpperCase().includes('IMAX'),
      });
    } catch (e) {
      debugInfo.attempts.push({ url: '/reserve/show-times/', error: e.message });
    }
  }

  // 시도 3: 극장 페이지
  if (results.length === 0) {
    try {
      const res = await fetch(
        `/theaters/?areacode=${areaCode}&theatercode=${theaterCode}&date=${date}`,
        { credentials: 'include' }
      );
      const html = await res.text();
      debugInfo.attempts.push({
        url: '/theaters/',
        status: res.status,
        length: html.length,
        hasImax: html.toUpperCase().includes('IMAX'),
        snippet: html.substring(0, 500),
      });
    } catch (e) {
      debugInfo.attempts.push({ url: '/theaters/', error: e.message });
    }
  }

  return { showtimes: results, debug: debugInfo };
}

// 설정 기반으로 체크
async function checkImax() {
  const config = await chrome.storage.local.get([
    'monitoring', 'theaterCode', 'theaterName', 'areaCode',
    'dates', 'movieKeyword', 'notifiedKeys',
  ]);

  if (!config.monitoring) return;
  if (!config.theaterCode || !config.dates?.length) return;

  const notifiedKeys = config.notifiedKeys || [];
  const logs = [];

  for (const date of config.dates) {
    try {
      const result = await fetchCgvShowtimes(config.theaterCode, config.areaCode, date);
      const showtimes = result.showtimes || [];
      const debug = result.debug || {};

      // API 시도 결과 로그
      for (const attempt of (debug.attempts || [])) {
        if (attempt.error) {
          logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[${attempt.url}] 오류: ${attempt.error}`, type: 'error' });
        } else {
          logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[${attempt.url}] ${attempt.status} | ${attempt.length}자 | IMAX: ${attempt.hasImax}`, type: 'info' });
        }
      }

      // 영화 목록 로그
      if (debug.allMovies?.length) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[영화 목록] ${debug.allMovies.join(', ')}`, type: 'info' });
      }

      // IMAX 컨텍스트 로그
      if (debug.imaxContext) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[IMAX 근처 HTML] ${debug.imaxContext.substring(0, 200)}`, type: 'info' });
      }

      let filtered = showtimes;
      if (config.movieKeyword) {
        const kw = config.movieKeyword.toLowerCase();
        filtered = showtimes.filter((s) => s.movieName.toLowerCase().includes(kw));
      }

      if (filtered.length > 0) {
        for (const s of filtered) {
          const availTimes = s.times.filter((t) => !t.isSoldOut).map((t) => t.time);
          if (availTimes.length === 0) continue;

          const key = `${s.movieName}-${date}-${availTimes.join(',')}`;
          if (notifiedKeys.includes(key)) continue;

          chrome.notifications.create(key, {
            type: 'basic',
            iconUrl: 'icon.png',
            title: 'IMAX 예매 오픈!',
            message: `${s.movieName}\n${config.theaterName} | ${date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}\n${availTimes.join(', ')}`,
            priority: 2,
            requireInteraction: true,
          });

          notifiedKeys.push(key);
          logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `🎬 IMAX 발견! ${s.movieName} @ ${config.theaterName} ${date} (${availTimes.join(', ')})`, type: 'success' });
        }
        await chrome.storage.local.set({ notifiedKeys });
      } else {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `${config.theaterName} ${date} — IMAX 상영 없음 (${showtimes.length}건)`, type: 'info' });
      }
    } catch (e) {
      logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `오류 (${date}): ${e.message}`, type: 'error' });
    }
  }

  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...logs, ...prev].slice(0, 100) });
}

chrome.notifications.onClicked.addListener(async () => {
  const config = await chrome.storage.local.get(['theaterCode', 'dates']);
  chrome.tabs.create({ url: `https://www.cgv.co.kr/ticket/?THEATER_CD=${config.theaterCode}&PLAY_YMD=${config.dates?.[0] || ''}` });
});

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM_NAME) checkImax(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_MONITORING') {
    chrome.storage.local.set({ monitoring: true, notifiedKeys: [], logs: [] });
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL });
    checkImax();
    sendResponse({ ok: true });
  } else if (msg.type === 'STOP_MONITORING') {
    chrome.storage.local.set({ monitoring: false });
    chrome.alarms.clear(ALARM_NAME);
    sendResponse({ ok: true });
  } else if (msg.type === 'CHECK_NOW') {
    checkImax().then(() => sendResponse({ ok: true }));
    return true;
  }
});

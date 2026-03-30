const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  const tab = await chrome.tabs.create({ url: 'https://www.cgv.co.kr/', active: false });

  await new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 20000);
  });

  await new Promise((r) => setTimeout(r, 3000));

  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: discoverAndFetch,
      args: [theaterCode, areaCode, date],
    });
    results = injection[0]?.result || {};
  } catch (e) {
    results = { showtimes: [], debug: { error: e.message } };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return results;
}

// CGV 페이지 내부에서 실행: 새 사이트 구조 탐색 + 상영시간표 가져오기
async function discoverAndFetch(theaterCode, areaCode, date) {
  const debug = { attempts: [], links: [] };
  const results = [];

  // 1단계: 현재 페이지에서 링크/API 패턴 수집
  const allLinks = [...document.querySelectorAll('a[href]')].map((a) => a.href);
  const relevantLinks = allLinks.filter((l) =>
    l.includes('theater') || l.includes('movie') || l.includes('schedule') ||
    l.includes('showtime') || l.includes('ticket') || l.includes('book') ||
    l.includes('cnm') || l.includes('reserve')
  );
  debug.links = [...new Set(relevantLinks)].slice(0, 20);

  // 2단계: 다양한 새 CGV URL 패턴 시도
  const urlsToTry = [
    `/cnm/movieBook/theater?theaterCd=${theaterCode}001`,
    `/cnm/movieBook/theater?theaterCd=${theaterCode}`,
    `/cnm/bzplcCgv/${theaterCode}001`,
    `/cnm/bzplcCgv/${theaterCode}`,
    `/cnm/movieBook/movie`,
    `/ticket/`,
    `/ticket/?THEATER_CD=${theaterCode}&PLAY_YMD=${date}`,
  ];

  for (const path of urlsToTry) {
    try {
      const res = await fetch(path, { credentials: 'include', redirect: 'follow' });
      const html = await res.text();
      const hasImax = html.toUpperCase().includes('IMAX');
      const hasMovie = html.includes('movie') || html.includes('영화');
      const hasTime = /\d{2}:\d{2}/.test(html);

      debug.attempts.push({
        url: path,
        status: res.status,
        length: html.length,
        hasImax,
        hasMovie,
        hasTime,
        finalUrl: res.url,
      });

      // 상영 정보가 있는 페이지 발견 시 파싱
      if (res.status === 200 && hasImax && hasTime) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // IMAX + 시간 패턴 파싱
        const text = doc.body?.innerText || '';
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        let imaxBlock = false;
        let movieName = '';

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toUpperCase().includes('IMAX')) {
            imaxBlock = true;
            for (let j = Math.max(0, i - 5); j < i; j++) {
              if (lines[j].length > 2 && lines[j].length < 50 && !/\d{2}:\d{2}/.test(lines[j])) {
                movieName = lines[j];
              }
            }
          }
          if (imaxBlock) {
            const times = lines[i].match(/\d{2}:\d{2}/g);
            if (times) {
              results.push({
                movieName: movieName || 'IMAX 상영',
                hallName: 'IMAX',
                times: times.map((t) => ({ time: t, isSoldOut: false })),
              });
              imaxBlock = false;
            }
          }
        }

        // 성공했으면 더 시도할 필요 없음
        if (results.length > 0) break;

        // IMAX 근처 텍스트 캡처
        const idx = text.toUpperCase().indexOf('IMAX');
        if (idx >= 0) {
          debug.imaxContext = text.substring(Math.max(0, idx - 200), idx + 300);
        }
      }
    } catch (e) {
      debug.attempts.push({ url: path, error: e.message });
    }
  }

  // 3단계: Next.js 데이터 라우트 탐색
  if (results.length === 0) {
    try {
      // __NEXT_DATA__ 확인
      const nextDataEl = document.getElementById('__NEXT_DATA__');
      if (nextDataEl) {
        const nextData = JSON.parse(nextDataEl.textContent);
        debug.nextDataBuildId = nextData.buildId;
        debug.nextDataPage = nextData.page;
        debug.nextDataKeys = Object.keys(nextData.props?.pageProps || {}).slice(0, 10);
      }

      // Next.js _next/data 경로로 API 호출 시도
      const scripts = [...document.querySelectorAll('script[src]')];
      const nextScripts = scripts.filter((s) => s.src.includes('_next'));
      debug.hasNextJs = nextScripts.length > 0;
    } catch (e) {
      debug.nextError = e.message;
    }
  }

  return { showtimes: results, debug };
}

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

      // 발견된 링크 로그
      if (debug.links?.length) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[사이트 링크] ${debug.links.slice(0, 5).join(' | ')}`, type: 'info' });
      }

      // API 시도 결과
      for (const a of (debug.attempts || [])) {
        if (a.error) {
          logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[${a.url}] 오류: ${a.error}`, type: 'error' });
        } else {
          logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[${a.url}] ${a.status} | ${a.length}자 | IMAX:${a.hasImax} | 시간:${a.hasTime} → ${a.finalUrl}`, type: a.hasImax ? 'success' : 'info' });
        }
      }

      if (debug.imaxContext) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[IMAX 근처] ${debug.imaxContext.substring(0, 200)}`, type: 'info' });
      }

      if (debug.hasNextJs !== undefined) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[Next.js] ${debug.hasNextJs} | buildId: ${debug.nextDataBuildId} | page: ${debug.nextDataPage}`, type: 'info' });
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
            type: 'basic', iconUrl: 'icon.png',
            title: 'IMAX 예매 오픈!',
            message: `${s.movieName}\n${config.theaterName} | ${date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}\n${availTimes.join(', ')}`,
            priority: 2, requireInteraction: true,
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

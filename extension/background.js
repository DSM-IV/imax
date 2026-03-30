const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  // CGV 예매 페이지 열기
  const url = 'https://cgv.co.kr/cnm/movieBook/movie';
  const tab = await chrome.tabs.create({ url, active: false });

  // 페이지 로드 완료 대기
  await new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 25000);
  });

  // Next.js 렌더링 + API 호출 대기
  await new Promise((r) => setTimeout(r, 10000));

  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: analyzePageAndApis,
      args: [theaterCode, date],
    });
    results = injection[0]?.result || {};
  } catch (e) {
    results = { showtimes: [], debug: { error: e.message } };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return results;
}

// CGV 예매 페이지에서 실행: API 호출 감지 + 페이지 분석
function analyzePageAndApis(theaterCode, targetDate) {
  const debug = {};
  const results = [];

  const bodyText = document.body?.innerText || '';
  const bodyHtml = document.body?.innerHTML || '';

  debug.url = location.href;
  debug.title = document.title;
  debug.textLength = bodyText.length;
  debug.hasImax = bodyText.toUpperCase().includes('IMAX');
  debug.hasHailMary = bodyText.includes('헤일메리');

  // __NEXT_DATA__ 확인
  try {
    const nextEl = document.getElementById('__NEXT_DATA__');
    if (nextEl) {
      const nd = JSON.parse(nextEl.textContent);
      debug.buildId = nd.buildId;
      debug.page = nd.page;
      const pp = nd.props?.pageProps || {};
      debug.pagePropsKeys = Object.keys(pp);
      // pageProps 안에 상영 데이터가 있을 수 있음
      debug.pagePropsPreview = JSON.stringify(pp).substring(0, 500);
    }
  } catch (e) {
    debug.nextDataError = e.message;
  }

  // Performance API로 페이지가 호출한 API 엔드포인트 수집
  try {
    const resources = performance.getEntriesByType('resource');
    const apis = resources
      .filter((r) => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
      .map((r) => r.name);
    debug.apiCalls = apis.slice(0, 30);
  } catch (e) {
    debug.perfError = e.message;
  }

  // 페이지에서 영화 목록 요소 찾기
  const movieElements = [];
  document.querySelectorAll('[class*="movie"], [class*="Movie"], [class*="film"], [class*="Film"]').forEach((el) => {
    const text = el.innerText?.substring(0, 100);
    if (text && text.length > 2) {
      movieElements.push({ class: el.className.substring(0, 60), text: text.substring(0, 80) });
    }
  });
  debug.movieElements = movieElements.slice(0, 10);

  // 모든 이미지의 alt 텍스트 (영화 포스터일 수 있음)
  const imgAlts = [...document.querySelectorAll('img[alt]')]
    .map((img) => img.alt)
    .filter((alt) => alt.length > 1);
  debug.imgAlts = imgAlts.slice(0, 20);

  // 페이지 텍스트 처음 3000자
  debug.pageText = bodyText.substring(0, 3000);

  // IMAX 근처 텍스트
  if (debug.hasImax) {
    const idx = bodyText.toUpperCase().indexOf('IMAX');
    debug.imaxContext = bodyText.substring(Math.max(0, idx - 200), idx + 300);
  }

  // 헤일메리 근처 텍스트
  if (debug.hasHailMary) {
    const idx = bodyText.indexOf('헤일메리');
    debug.hailMaryContext = bodyText.substring(Math.max(0, idx - 100), idx + 300);
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

  const logs = [];

  for (const date of config.dates) {
    try {
      const result = await fetchCgvShowtimes(config.theaterCode, config.areaCode, date);
      const debug = result.debug || {};

      logs.push({ time: now(), msg: `[페이지] ${debug.url} | ${debug.title} | ${debug.textLength}자`, type: 'info' });
      logs.push({ time: now(), msg: `[감지] IMAX: ${debug.hasImax} | 헤일메리: ${debug.hasHailMary}`, type: debug.hasImax || debug.hasHailMary ? 'success' : 'info' });

      if (debug.buildId) {
        logs.push({ time: now(), msg: `[Next.js] buildId: ${debug.buildId} | page: ${debug.page}`, type: 'info' });
      }
      if (debug.pagePropsKeys?.length) {
        logs.push({ time: now(), msg: `[데이터] keys: ${debug.pagePropsKeys.join(', ')}`, type: 'info' });
      }
      if (debug.pagePropsPreview) {
        logs.push({ time: now(), msg: `[데이터 미리보기] ${debug.pagePropsPreview.substring(0, 200)}`, type: 'info' });
      }
      if (debug.apiCalls?.length) {
        for (const api of debug.apiCalls.slice(0, 10)) {
          logs.push({ time: now(), msg: `[API] ${api}`, type: 'info' });
        }
      }
      if (debug.movieElements?.length) {
        for (const me of debug.movieElements.slice(0, 5)) {
          logs.push({ time: now(), msg: `[영화요소] ${me.class} → ${me.text}`, type: 'info' });
        }
      }
      if (debug.imgAlts?.length) {
        logs.push({ time: now(), msg: `[포스터] ${debug.imgAlts.join(', ')}`, type: 'info' });
      }
      if (debug.imaxContext) {
        logs.push({ time: now(), msg: `[IMAX] ${debug.imaxContext.substring(0, 200)}`, type: 'success' });
      }
      if (debug.hailMaryContext) {
        logs.push({ time: now(), msg: `[헤일메리] ${debug.hailMaryContext.substring(0, 200)}`, type: 'success' });
      }
      if (debug.pageText) {
        logs.push({ time: now(), msg: `[텍스트] ${debug.pageText.substring(0, 300)}`, type: 'info' });
      }
    } catch (e) {
      logs.push({ time: now(), msg: `오류 (${date}): ${e.message}`, type: 'error' });
    }
  }

  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...logs, ...prev].slice(0, 300) });
}

function now() { return new Date().toLocaleTimeString('ko-KR'); }

chrome.notifications.onClicked.addListener(async () => {
  chrome.tabs.create({ url: 'https://cgv.co.kr/cnm/movieBook/movie' });
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

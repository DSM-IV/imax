const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  const url = 'https://cgv.co.kr/cnm/movieBook/movie';
  const tab = await chrome.tabs.create({ url, active: false });

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

  await new Promise((r) => setTimeout(r, 8000));

  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: findScheduleApi,
      args: [theaterCode, date],
    });
    results = injection[0]?.result || {};
  } catch (e) {
    results = { showtimes: [], debug: { error: e.message } };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return results;
}

// CGV 페이지 내부에서 API 호출하여 상영시간표 찾기
async function findScheduleApi(theaterCode, targetDate) {
  const debug = { apiResults: [] };
  const results = [];
  const API = 'https://api.cgv.co.kr';
  const CO = 'A420';

  // 1단계: 영화 목록 API 호출하여 영화 코드 확인
  try {
    const res = await fetch(`${API}/cnm/atkt/searchAtktTopPostrList?coCd=${CO}&movNm=&div=&attrCd=`);
    const data = await res.json();
    debug.movieListStatus = res.status;
    debug.movieListKeys = Object.keys(data);

    // 영화 데이터 구조 파악
    const movies = data.data || data.list || data.movieList || data.result || data.body || [];
    if (Array.isArray(movies)) {
      debug.movieCount = movies.length;
      debug.movieSample = movies.slice(0, 3).map((m) => JSON.stringify(m).substring(0, 200));
      debug.movieAllNames = movies.map((m) => m.movNm || m.movieNm || m.name || m.title || JSON.stringify(m).substring(0, 50));
    } else {
      debug.movieListRaw = JSON.stringify(data).substring(0, 1000);
    }
  } catch (e) {
    debug.movieListError = e.message;
  }

  // 2단계: 특별관(IMAX 등) 속성 목록
  try {
    const res = await fetch(`${API}/cnm/atkt/searchAtktTopPostrAttrList?coCd=${CO}`);
    const data = await res.json();
    debug.attrListRaw = JSON.stringify(data).substring(0, 500);
  } catch (e) {
    debug.attrListError = e.message;
  }

  // 3단계: 상영시간표 API 엔드포인트 탐색
  const scheduleEndpoints = [
    `/cnm/atkt/searchAtktPlaySchdl?coCd=${CO}&bzplcNo=${theaterCode}&playDe=${targetDate}`,
    `/cnm/atkt/searchAtktPlaySchdl?coCd=${CO}&bzplcNo=${theaterCode}001&playDe=${targetDate}`,
    `/cnm/atkt/searchAtktSchdlList?coCd=${CO}&bzplcNo=${theaterCode}&playDe=${targetDate}`,
    `/cnm/atkt/searchPlaySchdl?coCd=${CO}&bzplcNo=${theaterCode}&playDe=${targetDate}`,
    `/cnm/atkt/searchPlaySchdlList?coCd=${CO}&bzplcCd=${theaterCode}&playDe=${targetDate}`,
    `/cnm/atkt/searchAtktMovSchdl?coCd=${CO}&bzplcNo=${theaterCode}&playDe=${targetDate}`,
    `/cnm/atkt/searchMovPlaySchdl?coCd=${CO}&bzplcNo=${theaterCode}&playDe=${targetDate}`,
    `/cnm/atkt/searchTimeTable?coCd=${CO}&bzplcNo=${theaterCode}&playDe=${targetDate}`,
    `/cnm/site/searchBzplcSchdl?coCd=${CO}&bzplcNo=${theaterCode}&playDe=${targetDate}`,
    `/cnm/site/searchBzplcSchdl?coCd=${CO}&bzplcNo=${theaterCode}001&playDe=${targetDate}`,
  ];

  for (const ep of scheduleEndpoints) {
    try {
      const res = await fetch(`${API}${ep}`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }

      const hasImax = text.toUpperCase().includes('IMAX');
      const hasTime = /\d{2}:\d{2}/.test(text);
      const isSuccess = res.status === 200 && text.length > 100 && data;

      debug.apiResults.push({
        url: ep,
        status: res.status,
        length: text.length,
        hasImax,
        hasTime,
        preview: text.substring(0, 300),
      });

      // 상영시간표 발견!
      if (isSuccess && (hasImax || hasTime)) {
        debug.foundEndpoint = ep;
        debug.foundData = text.substring(0, 2000);
        break;
      }
    } catch (e) {
      debug.apiResults.push({ url: ep, error: e.message });
    }
  }

  // 4단계: 페이지에서 fetch를 가로채서 추가 API 엔드포인트 발견
  // (이미 호출된 것 중 schedule/play 관련 확인)
  try {
    const resources = performance.getEntriesByType('resource');
    const scheduleApis = resources
      .filter((r) => (r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest'))
      .map((r) => r.name)
      .filter((url) => url.includes('schdl') || url.includes('play') || url.includes('time') || url.includes('Schdl') || url.includes('Play'));
    debug.scheduleRelatedApis = scheduleApis;
  } catch {}

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

      // 영화 목록 결과
      if (debug.movieCount !== undefined) {
        logs.push({ time: now(), msg: `[영화 목록] ${debug.movieCount}편`, type: 'info' });
      }
      if (debug.movieAllNames?.length) {
        logs.push({ time: now(), msg: `[영화] ${debug.movieAllNames.slice(0, 10).join(', ')}`, type: 'info' });
      }
      if (debug.movieSample?.length) {
        for (const s of debug.movieSample) {
          logs.push({ time: now(), msg: `[영화 샘플] ${s}`, type: 'info' });
        }
      }
      if (debug.movieListRaw) {
        logs.push({ time: now(), msg: `[영화 RAW] ${debug.movieListRaw.substring(0, 200)}`, type: 'info' });
      }
      if (debug.movieListError) {
        logs.push({ time: now(), msg: `[영화 목록 오류] ${debug.movieListError}`, type: 'error' });
      }

      // 속성 목록
      if (debug.attrListRaw) {
        logs.push({ time: now(), msg: `[특별관] ${debug.attrListRaw.substring(0, 200)}`, type: 'info' });
      }

      // 상영시간표 API 탐색 결과
      for (const ar of (debug.apiResults || [])) {
        if (ar.error) {
          logs.push({ time: now(), msg: `[${ar.url.substring(0, 50)}] 오류`, type: 'error' });
        } else {
          const icon = ar.hasImax || ar.hasTime ? '✅' : '❌';
          logs.push({ time: now(), msg: `${icon} [${ar.status}] ${ar.url.substring(0, 60)} | ${ar.length}자 | IMAX:${ar.hasImax} | 시간:${ar.hasTime}`, type: ar.hasImax ? 'success' : 'info' });
          if (ar.hasImax || ar.hasTime) {
            logs.push({ time: now(), msg: `[데이터] ${ar.preview.substring(0, 200)}`, type: 'info' });
          }
        }
      }

      // 발견된 엔드포인트
      if (debug.foundEndpoint) {
        logs.push({ time: now(), msg: `🎯 상영시간표 API 발견: ${debug.foundEndpoint}`, type: 'success' });
        logs.push({ time: now(), msg: `[상영 데이터] ${(debug.foundData || '').substring(0, 300)}`, type: 'success' });
      }

      // 스케줄 관련 API
      if (debug.scheduleRelatedApis?.length) {
        for (const api of debug.scheduleRelatedApis) {
          logs.push({ time: now(), msg: `[스케줄 API 감지] ${api}`, type: 'success' });
        }
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

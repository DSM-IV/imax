const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

async function fetchCgvShowtimes(theaterCode, areaCode, date, movieKeyword) {
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

  // 초기 렌더링 대기
  await new Promise((r) => setTimeout(r, 5000));

  // 1단계: 영화 클릭
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickMovie,
      args: [movieKeyword || ''],
    });
  } catch {}

  await new Promise((r) => setTimeout(r, 3000));

  // 2단계: 극장 + 날짜 선택
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: selectTheaterAndDate,
      args: [theaterCode, date],
    });
  } catch {}

  await new Promise((r) => setTimeout(r, 5000));

  // 3단계: 가로챈 API 데이터 + 페이지 DOM 읽기
  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readResults,
      args: [movieKeyword || ''],
    });
    results = injection[0]?.result || {};
  } catch (e) {
    results = { showtimes: [], debug: { error: e.message } };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return results;
}

// 영화 포스터/이름 클릭
function clickMovie(keyword) {
  if (!keyword) return;
  const kw = keyword.toLowerCase();

  // 영화 포스터 이미지의 alt에서 찾기
  const imgs = document.querySelectorAll('img[alt]');
  for (const img of imgs) {
    if (img.alt.toLowerCase().includes(kw)) {
      const clickable = img.closest('a') || img.closest('button') || img.closest('[role="button"]') || img;
      clickable.click();
      return 'clicked_img: ' + img.alt;
    }
  }

  // 텍스트에서 찾기
  const allEls = document.querySelectorAll('a, button, li, div, span, strong');
  for (const el of allEls) {
    const text = el.textContent.trim();
    if (text.toLowerCase().includes(kw) && text.length < 50) {
      el.click();
      return 'clicked_text: ' + text;
    }
  }
  return 'not_found';
}

// 극장과 날짜 선택
function selectTheaterAndDate(theaterCode, date) {
  const bodyText = document.body?.innerText || '';

  // 극장 이름 매핑
  const theaterNames = {
    '0013': '용산', '0074': '왕십리', '0056': '강남', '0059': '영등포',
    '0001': '명동', '0229': '여의도', '0014': '건대', '0247': '연수',
    '0070': '수원', '0218': '센텀', '0088': '대전', '0216': '광주',
    '0055': '청주', '0131': '대구',
  };
  const theaterName = theaterNames[theaterCode] || theaterCode;

  // 극장 클릭
  const allEls = document.querySelectorAll('a, button, li, div, span');
  for (const el of allEls) {
    const text = el.textContent.trim();
    if (text.includes(theaterName) && text.length < 30) {
      el.click();
      break;
    }
  }

  // IMAX 필터 클릭
  setTimeout(() => {
    const allEls2 = document.querySelectorAll('a, button, li, div, span');
    for (const el of allEls2) {
      if (el.textContent.trim().toUpperCase() === 'IMAX') {
        el.click();
        break;
      }
    }
  }, 1000);

  // 날짜 선택 (4/3 등)
  if (date) {
    const month = parseInt(date.substring(4, 6));
    const day = parseInt(date.substring(6, 8));
    setTimeout(() => {
      const dateEls = document.querySelectorAll('a, button, li, span, div');
      for (const el of dateEls) {
        const text = el.textContent.trim();
        if (text === String(day) || text === `${month}/${day}` || text === `${day}일`) {
          el.click();
          break;
        }
      }
    }, 2000);
  }
}

// 결과 읽기: 가로챈 API + 페이지 DOM
function readResults(movieKeyword) {
  const debug = {};
  const showtimes = [];

  // 가로챈 API 데이터 확인
  const captured = window.__cgvCapturedApis || [];
  debug.capturedCount = captured.length;
  debug.capturedApis = captured.map((c) => ({
    url: c.url,
    status: c.status,
    length: c.length,
    hasImax: c.hasImax,
    bodyPreview: c.body?.substring(0, 300),
  }));

  // 페이지 DOM 분석
  const bodyText = document.body?.innerText || '';
  debug.textLength = bodyText.length;
  debug.hasImax = bodyText.toUpperCase().includes('IMAX');
  debug.url = location.href;

  // IMAX 근처 텍스트
  if (debug.hasImax) {
    const text = bodyText;
    const positions = [];
    let idx = 0;
    while (idx < text.length) {
      const pos = text.toUpperCase().indexOf('IMAX', idx);
      if (pos === -1) break;
      positions.push(text.substring(Math.max(0, pos - 100), Math.min(text.length, pos + 200)));
      idx = pos + 4;
      if (positions.length >= 3) break;
    }
    debug.imaxContexts = positions;
  }

  // 시간 패턴 찾기 (HH:MM)
  const timePattern = /\d{2}:\d{2}/g;
  const timesInPage = bodyText.match(timePattern) || [];
  debug.timesFound = timesInPage;

  // IMAX + 시간이 있는 섹션 파싱
  if (debug.hasImax && timesInPage.length > 0) {
    // IMAX 근처에 시간이 있으면 상영 정보로 판단
    const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
    let inImaxSection = false;
    let currentMovie = movieKeyword || '';

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toUpperCase().includes('IMAX')) {
        inImaxSection = true;
      }
      if (inImaxSection) {
        const times = lines[i].match(/\d{2}:\d{2}/g);
        if (times) {
          showtimes.push({
            movieName: currentMovie || 'IMAX 상영',
            hallName: 'IMAX',
            times: times.map((t) => ({ time: t, isSoldOut: false })),
          });
          inImaxSection = false;
        }
      }
    }
  }

  // 페이지 텍스트 (디버그용)
  debug.pageText = bodyText.substring(0, 2000);

  return { showtimes, debug };
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
      const result = await fetchCgvShowtimes(config.theaterCode, config.areaCode, date, config.movieKeyword);
      const showtimes = result.showtimes || [];
      const debug = result.debug || {};

      logs.push({ time: now(), msg: `[페이지] ${debug.url} | ${debug.textLength}자 | IMAX: ${debug.hasImax}`, type: 'info' });

      // 가로챈 API 로그
      if (debug.capturedCount > 0) {
        logs.push({ time: now(), msg: `[가로챈 API] ${debug.capturedCount}건`, type: 'success' });
        for (const api of (debug.capturedApis || []).slice(0, 15)) {
          const icon = api.hasImax ? '🎯' : '📡';
          logs.push({ time: now(), msg: `${icon} ${api.url.substring(0, 80)} | ${api.status} | ${api.length}자 | IMAX:${api.hasImax}`, type: api.hasImax ? 'success' : 'info' });
          if (api.hasImax) {
            logs.push({ time: now(), msg: `[IMAX 데이터] ${api.bodyPreview}`, type: 'success' });
          }
        }
      } else {
        logs.push({ time: now(), msg: `[가로챈 API] 없음 (intercept.js 미작동?)`, type: 'error' });
      }

      // IMAX 컨텍스트
      for (const ctx of (debug.imaxContexts || []).slice(0, 2)) {
        logs.push({ time: now(), msg: `[IMAX 근처] ${ctx.substring(0, 200)}`, type: 'info' });
      }

      // 시간 정보
      if (debug.timesFound?.length) {
        logs.push({ time: now(), msg: `[시간] ${debug.timesFound.join(', ')}`, type: 'info' });
      }

      // 상영 결과
      if (showtimes.length > 0) {
        for (const s of showtimes) {
          const availTimes = s.times.map((t) => t.time).join(', ');
          const key = `${s.movieName}-${date}-${availTimes}`;
          if (!notifiedKeys.includes(key)) {
            chrome.notifications.create(key, {
              type: 'basic', iconUrl: 'icon.png',
              title: 'IMAX 예매 오픈!',
              message: `${s.movieName}\n${config.theaterName} | ${date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}\n${availTimes}`,
              priority: 2, requireInteraction: true,
            });
            notifiedKeys.push(key);
          }
          logs.push({ time: now(), msg: `🎬 IMAX 발견! ${s.movieName} (${availTimes})`, type: 'success' });
        }
        await chrome.storage.local.set({ notifiedKeys });
      } else {
        logs.push({ time: now(), msg: `${config.theaterName} ${date} — IMAX 상영 없음`, type: 'info' });
      }
    } catch (e) {
      logs.push({ time: now(), msg: `오류: ${e.message}`, type: 'error' });
    }
  }

  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...logs, ...prev].slice(0, 300) });
}

function now() { return new Date().toLocaleTimeString('ko-KR'); }

chrome.notifications.onClicked.addListener(() => {
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

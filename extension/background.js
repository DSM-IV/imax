const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

// CGV 극장 페이지를 탭으로 열고, JS 렌더링 후 DOM 읽기
async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  // 새 CGV 극장 페이지 URL
  const url = `https://cgv.co.kr/cnm/bzplcCgv/${theaterCode}001`;
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
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 20000);
  });

  // Next.js 클라이언트 렌더링 대기
  await new Promise((r) => setTimeout(r, 7000));

  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readRenderedPage,
      args: [date],
    });
    results = injection[0]?.result || {};
  } catch (e) {
    results = { showtimes: [], debug: { error: e.message } };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return results;
}

// 렌더링 완료된 CGV 페이지에서 상영 정보 읽기
function readRenderedPage(targetDate) {
  const debug = {};
  const results = [];

  const bodyText = document.body?.innerText || '';
  const bodyHtml = document.body?.innerHTML || '';

  debug.url = location.href;
  debug.title = document.title;
  debug.bodyLength = bodyHtml.length;
  debug.textLength = bodyText.length;
  debug.hasImax = bodyText.toUpperCase().includes('IMAX');
  debug.hasHailMary = bodyText.includes('헤일메리');

  // 페이지에 있는 모든 텍스트에서 영화/상영관/시간 구조 파악
  // IMAX가 포함된 부분의 주변 텍스트 캡처
  if (debug.hasImax) {
    const text = bodyText;
    let idx = 0;
    const snippets = [];
    while (idx < text.length) {
      const pos = text.toUpperCase().indexOf('IMAX', idx);
      if (pos === -1) break;
      snippets.push(text.substring(Math.max(0, pos - 150), Math.min(text.length, pos + 200)));
      idx = pos + 4;
      if (snippets.length >= 5) break;
    }
    debug.imaxSnippets = snippets;
  }

  // 헤일메리가 있는 부분 캡처
  if (debug.hasHailMary) {
    const pos = bodyText.indexOf('헤일메리');
    debug.hailMarySnippet = bodyText.substring(Math.max(0, pos - 100), Math.min(bodyText.length, pos + 300));
  }

  // 페이지 전체 텍스트의 처음 3000자 캡처 (구조 파악용)
  debug.pageStart = bodyText.substring(0, 2000);

  // DOM 구조에서 상영시간 관련 요소 찾기
  const allElements = document.querySelectorAll('[class]');
  const classNames = new Set();
  for (const el of allElements) {
    for (const cls of el.classList) {
      if (cls.match(/movie|screen|imax|hall|time|schedule|show|book|seat/i)) {
        classNames.add(cls);
      }
    }
  }
  debug.relevantClasses = [...classNames].slice(0, 30);

  // 시간 패턴이 있는 요소 찾기
  const timeElements = [];
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length === 0) {
      const text = el.textContent.trim();
      if (/^\d{2}:\d{2}$/.test(text)) {
        const parentText = el.parentElement?.parentElement?.innerText?.substring(0, 100) || '';
        timeElements.push({ time: text, context: parentText, tag: el.tagName, classes: el.className });
      }
    }
  });
  debug.timeElements = timeElements.slice(0, 20);

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

      logs.push({
        time: new Date().toLocaleTimeString('ko-KR'),
        msg: `[페이지] ${debug.url} | ${debug.title} | 텍스트: ${debug.textLength}자`,
        type: 'info',
      });
      logs.push({
        time: new Date().toLocaleTimeString('ko-KR'),
        msg: `[감지] IMAX: ${debug.hasImax} | 헤일메리: ${debug.hasHailMary}`,
        type: debug.hasImax ? 'success' : 'info',
      });

      if (debug.imaxSnippets?.length) {
        for (const s of debug.imaxSnippets.slice(0, 2)) {
          logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[IMAX 근처] ${s.substring(0, 150)}`, type: 'info' });
        }
      }

      if (debug.hailMarySnippet) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[헤일메리] ${debug.hailMarySnippet.substring(0, 150)}`, type: 'info' });
      }

      if (debug.relevantClasses?.length) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[CSS] ${debug.relevantClasses.join(', ')}`, type: 'info' });
      }

      if (debug.timeElements?.length) {
        const times = debug.timeElements.slice(0, 5).map((t) => `${t.time}(${t.context.substring(0, 40)})`);
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[시간] ${times.join(' | ')}`, type: 'info' });
      }

      if (debug.pageStart) {
        logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `[페이지 시작] ${debug.pageStart.substring(0, 200)}`, type: 'info' });
      }

      logs.push({
        time: new Date().toLocaleTimeString('ko-KR'),
        msg: `${config.theaterName} ${date} — 분석 완료`,
        type: 'info',
      });
    } catch (e) {
      logs.push({ time: new Date().toLocaleTimeString('ko-KR'), msg: `오류 (${date}): ${e.message}`, type: 'error' });
    }
  }

  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...logs, ...prev].slice(0, 200) });
}

chrome.notifications.onClicked.addListener(async () => {
  const config = await chrome.storage.local.get(['theaterCode', 'dates']);
  chrome.tabs.create({ url: `https://cgv.co.kr/cnm/movieBook/movie` });
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

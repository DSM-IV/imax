const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

// CGV 상영시간표 페이지를 실제 탭으로 열고 DOM을 읽는 방식
async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  const url = `https://www.cgv.co.kr/common/showtimes/iframeTheater.aspx?areacode=${areaCode}&theatercode=${theaterCode}&date=${date}`;

  // 백그라운드 탭 열기
  const tab = await chrome.tabs.create({ url, active: false });

  // 페이지 로드 대기
  await new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // 15초 타임아웃
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  // 잠시 대기 (렌더링 완료)
  await new Promise((r) => setTimeout(r, 2000));

  // 탭에서 DOM 파싱 스크립트 실행
  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: parsePageContent,
    });
    results = injection[0]?.result || [];
  } catch (e) {
    results = [];
  }

  // 탭 닫기
  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  return results;
}

// 이 함수는 CGV 페이지 컨텍스트에서 실행됨
function parsePageContent() {
  const results = [];

  // 디버그: 페이지 전체 텍스트에서 IMAX 확인
  const bodyText = document.body?.innerText || '';
  const bodyHtml = document.body?.innerHTML || '';
  const hasImax = bodyHtml.toUpperCase().includes('IMAX');

  // 방법 1: sect-showtimes 구조 파싱
  const movieItems = document.querySelectorAll('.sect-showtimes > ul > li');
  for (const item of movieItems) {
    const titleEl = item.querySelector('.info-movie a strong') || item.querySelector('.info-movie strong');
    if (!titleEl) continue;
    const movieName = titleEl.textContent.trim();

    const hallDivs = item.querySelectorAll('.type-hall');
    for (const hall of hallDivs) {
      const hallNameEl = hall.querySelector('.info-hall ul li:first-child') || hall.querySelector('.info-hall li');
      const hallName = hallNameEl ? hallNameEl.textContent.trim() : '';

      const hallHtml = hall.innerHTML.toUpperCase();
      const isImax =
        hallName.toUpperCase().includes('IMAX') ||
        hallHtml.includes('IMAX') ||
        !!hall.querySelector('[class*="imax"]') ||
        !!hall.querySelector('[class*="IMAX"]');

      const times = [];
      const timeEls = hall.querySelectorAll('.info-timetable a em, .info-timetable em');
      for (const em of timeEls) {
        const time = em.textContent.trim();
        if (time && /\d{2}:\d{2}/.test(time)) {
          const parent = em.closest('a');
          const isSoldOut = parent ? parent.classList.contains('soldout') : false;
          times.push({ time, isSoldOut });
        }
      }

      if (isImax && times.length > 0) {
        results.push({ movieName, hallName, times });
      }
    }
  }

  // 방법 2: 구조가 다를 경우 전체 HTML에서 IMAX 섹션 탐색
  if (results.length === 0 && hasImax) {
    // 모든 상영관 이름 요소에서 IMAX 찾기
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length === 0 && el.textContent.toUpperCase().includes('IMAX')) {
        // IMAX가 포함된 텍스트 노드의 부모를 탐색하여 영화/시간 정보 찾기
        let parent = el.closest('li') || el.closest('div') || el.parentElement;
        if (parent) {
          const text = parent.innerText;
          results.push({
            movieName: 'IMAX 상영 감지',
            hallName: el.textContent.trim(),
            times: [{ time: '시간 확인 필요', isSoldOut: false }],
            rawText: text.substring(0, 500),
          });
          break; // 하나만 잡으면 됨
        }
      }
    }
  }

  // 디버그 정보 포함
  return {
    showtimes: results,
    debug: {
      url: location.href,
      title: document.title,
      hasImax,
      movieCount: movieItems.length,
      bodyLength: bodyHtml.length,
      bodySnippet: bodyHtml.substring(0, 1000),
    },
  };
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

      // 디버그 로그
      logs.push({
        time: new Date().toLocaleTimeString('ko-KR'),
        msg: `[${date}] 페이지: ${debug.url || '?'} | 제목: ${debug.title || '?'} | HTML: ${debug.bodyLength}자 | IMAX: ${debug.hasImax} | 영화수: ${debug.movieCount}`,
        type: 'info',
      });

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
          logs.push({
            time: new Date().toLocaleTimeString('ko-KR'),
            msg: `🎬 IMAX 발견! ${s.movieName} @ ${config.theaterName} ${date} (${availTimes.join(', ')})`,
            type: 'success',
          });
        }
        await chrome.storage.local.set({ notifiedKeys });
      } else {
        logs.push({
          time: new Date().toLocaleTimeString('ko-KR'),
          msg: `${config.theaterName} ${date} — IMAX 상영 없음`,
          type: 'info',
        });
      }
    } catch (e) {
      logs.push({
        time: new Date().toLocaleTimeString('ko-KR'),
        msg: `오류 (${date}): ${e.message}`,
        type: 'error',
      });
    }
  }

  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...logs, ...prev].slice(0, 100) });
}

// 알림 클릭
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const config = await chrome.storage.local.get(['theaterCode', 'dates']);
  const date = config.dates?.[0] || '';
  chrome.tabs.create({
    url: `https://www.cgv.co.kr/ticket/?THEATER_CD=${config.theaterCode}&PLAY_YMD=${date}`,
  });
});

// 알람
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkImax();
  }
});

// 메시지 핸들러
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

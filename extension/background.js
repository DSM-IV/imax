const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

// CGV 극장 상영시간표 페이지를 탭으로 열고 DOM 파싱
async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  // CGV 극장별 상영시간표 페이지 URL (실제 사용자가 접속하는 페이지)
  const url = `https://www.cgv.co.kr/theaters/?areacode=${areaCode}&theatercode=${theaterCode}&date=${date}`;

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
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
  });

  // 동적 콘텐츠 렌더링 대기 (Next.js 등)
  await new Promise((r) => setTimeout(r, 5000));

  let results;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: parsePageContent,
    });
    results = injection[0]?.result || {};
  } catch (e) {
    results = { showtimes: [], debug: { error: e.message } };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return results;
}

// CGV 페이지 DOM에서 상영 정보 파싱 (페이지 컨텍스트에서 실행)
function parsePageContent() {
  const results = [];
  const bodyHtml = document.body?.innerHTML || '';
  const bodyText = document.body?.innerText || '';
  const hasImax = bodyHtml.toUpperCase().includes('IMAX');
  const currentUrl = location.href;

  // === 방법 1: 기존 CGV 상영시간표 구조 ===
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
      const isImax = hallName.toUpperCase().includes('IMAX') || hallHtml.includes('IMAX');

      const times = [];
      const timeEls = hall.querySelectorAll('.info-timetable a em, .info-timetable em');
      for (const em of timeEls) {
        const time = em.textContent.trim();
        if (/\d{2}:\d{2}/.test(time)) {
          const parent = em.closest('a');
          times.push({ time, isSoldOut: parent?.classList.contains('soldout') || false });
        }
      }
      if (isImax && times.length > 0) {
        results.push({ movieName, hallName, times });
      }
    }
  }

  // === 방법 2: 새 CGV 사이트 구조 파싱 ===
  if (results.length === 0) {
    // 새 CGV는 다양한 클래스명을 사용할 수 있음
    // 상영관 이름에 IMAX가 포함된 요소 찾기
    const allText = bodyText;
    const imaxSections = [];

    // 모든 요소에서 IMAX 텍스트를 포함하는 것 찾기
    document.querySelectorAll('span, div, p, li, a, strong, em, h2, h3, h4').forEach((el) => {
      const text = el.textContent.trim();
      if (text.toUpperCase().includes('IMAX') && text.length < 100) {
        // 이 요소 주변에서 영화 제목과 시간 정보 찾기
        let container = el.closest('[class*="movie"]') ||
                        el.closest('[class*="schedule"]') ||
                        el.closest('[class*="show"]') ||
                        el.closest('[class*="time"]') ||
                        el.closest('li') ||
                        el.parentElement?.parentElement;

        if (container) {
          const containerText = container.innerText || '';
          // 시간 패턴 (HH:MM) 찾기
          const timeMatches = containerText.match(/\d{2}:\d{2}/g) || [];
          if (timeMatches.length > 0) {
            // 영화 제목 추출 시도 (첫 번째 줄이나 굵은 텍스트)
            const strongEl = container.querySelector('strong, h3, h4, [class*="title"]');
            const movieName = strongEl ? strongEl.textContent.trim() : containerText.split('\n')[0].trim();

            results.push({
              movieName: movieName.substring(0, 50),
              hallName: text,
              times: timeMatches.map((t) => ({ time: t, isSoldOut: false })),
            });
          }
        }
      }
    });
  }

  // === 방법 3: 텍스트 기반 IMAX + 시간 패턴 매칭 ===
  if (results.length === 0 && hasImax) {
    // 페이지 전체 텍스트에서 IMAX 근처의 시간 패턴 찾기
    const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
    let imaxContext = false;
    let currentMovie = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toUpperCase().includes('IMAX')) {
        imaxContext = true;
        // IMAX 앞뒤로 영화 제목 찾기
        for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 5); j++) {
          const nearby = lines[j];
          if (nearby.length > 2 && nearby.length < 50 && !/\d{2}:\d{2}/.test(nearby) && !nearby.toUpperCase().includes('IMAX')) {
            currentMovie = nearby;
            break;
          }
        }
      }
      if (imaxContext) {
        const timeMatches = line.match(/\d{2}:\d{2}/g);
        if (timeMatches) {
          results.push({
            movieName: currentMovie || 'IMAX 상영',
            hallName: 'IMAX',
            times: timeMatches.map((t) => ({ time: t, isSoldOut: false })),
          });
          imaxContext = false;
        }
      }
    }
  }

  // 디버그: IMAX 포함된 텍스트 조각 수집
  const imaxSnippets = [];
  if (hasImax) {
    const text = bodyText;
    const idx = text.toUpperCase().indexOf('IMAX');
    if (idx >= 0) {
      imaxSnippets.push(text.substring(Math.max(0, idx - 100), idx + 200));
    }
    // 두 번째 IMAX 위치
    const idx2 = text.toUpperCase().indexOf('IMAX', idx + 4);
    if (idx2 >= 0) {
      imaxSnippets.push(text.substring(Math.max(0, idx2 - 100), idx2 + 200));
    }
  }

  return {
    showtimes: results,
    debug: {
      url: currentUrl,
      title: document.title,
      hasImax,
      movieCount: movieItems.length,
      bodyLength: bodyHtml.length,
      imaxSnippets,
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
        msg: `[${date}] URL: ${debug.url} | 제목: ${debug.title} | IMAX: ${debug.hasImax} | 영화수: ${debug.movieCount} | 결과: ${showtimes.length}건`,
        type: 'info',
      });

      // IMAX 스니펫 로그
      if (debug.imaxSnippets?.length) {
        for (const snip of debug.imaxSnippets) {
          logs.push({
            time: new Date().toLocaleTimeString('ko-KR'),
            msg: `[디버그] IMAX 근처: ${snip.substring(0, 150)}`,
            type: 'info',
          });
        }
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
          msg: `${config.theaterName} ${date} — IMAX 상영 없음 (파싱 ${showtimes.length}건)`,
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
  if (alarm.name === ALARM_NAME) checkImax();
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

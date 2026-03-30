const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초 (분 단위)

// 상영시간표 HTML 파싱
function parseShowtimes(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const results = [];

  // 영화별 상영 정보
  const movieItems = doc.querySelectorAll('.sect-showtimes > ul > li');
  for (const item of movieItems) {
    const titleEl = item.querySelector('.info-movie a strong');
    if (!titleEl) continue;
    const movieName = titleEl.textContent.trim();

    const hallDivs = item.querySelectorAll('.type-hall');
    for (const hall of hallDivs) {
      const hallNameEl = hall.querySelector('.info-hall ul li:first-child');
      const hallName = hallNameEl ? hallNameEl.textContent.trim() : '';

      // IMAX 감지
      const isImax =
        hallName.toUpperCase().includes('IMAX') ||
        !!hall.querySelector('span.imax') ||
        !!hall.querySelector('.ico-imax') ||
        !!hall.querySelector('[class*="imax"]');

      if (!isImax) continue;

      const times = [];
      const timeLinks = hall.querySelectorAll('.info-timetable a');
      for (const link of timeLinks) {
        const timeEl = link.querySelector('em');
        if (!timeEl) continue;
        const time = timeEl.textContent.trim();
        const isSoldOut = link.classList.contains('soldout');
        times.push({ time, isSoldOut });
      }

      if (times.length > 0) {
        results.push({ movieName, hallName, times });
      }
    }
  }
  return results;
}

// 오프스크린 문서 없이 파싱하기 위한 대안: 정규식 기반 파싱
function parseShowtimesRegex(html) {
  const results = [];

  // IMAX 관련 섹션 찾기
  const imax = html.toUpperCase().includes('IMAX');
  if (!imax) return results;

  // 영화 블록 추출
  const movieBlocks = html.split(/class="col-times"/g);
  for (let i = 1; i < movieBlocks.length; i++) {
    const block = movieBlocks[i];

    // 영화 제목
    const titleMatch = block.match(/<strong[^>]*>([^<]+)<\/strong>/);
    const movieName = titleMatch ? titleMatch[1].trim() : '';

    // 상영관 정보에서 IMAX 확인
    if (!block.toUpperCase().includes('IMAX')) continue;

    // 시간 추출
    const times = [];
    const timeRegex = /<em>(\d{2}:\d{2})<\/em>/g;
    let match;
    while ((match = timeRegex.exec(block)) !== null) {
      times.push({ time: match[1], isSoldOut: false });
    }

    if (movieName && times.length > 0) {
      results.push({ movieName, hallName: 'IMAX', times });
    }
  }

  return results;
}

// CGV 상영시간표 가져오기
async function fetchCgvShowtimes(theaterCode, areaCode, date) {
  const url = `https://www.cgv.co.kr/common/showtimes/iframeTheater.aspx?areacode=${areaCode}&theatercode=${theaterCode}&date=${date}`;

  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return parseShowtimesRegex(html);
}

// 설정 기반으로 체크
async function checkImax() {
  const config = await chrome.storage.local.get([
    'monitoring',
    'theaterCode',
    'theaterName',
    'areaCode',
    'dates',
    'movieKeyword',
    'notifiedKeys',
  ]);

  if (!config.monitoring) return;
  if (!config.theaterCode || !config.dates?.length) return;

  const notifiedKeys = config.notifiedKeys || [];
  const logs = [];

  for (const date of config.dates) {
    try {
      const showtimes = await fetchCgvShowtimes(config.theaterCode, config.areaCode, date);

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

          // 알림 발송
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

  // 로그 저장
  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...logs, ...prev].slice(0, 100) });
}

// 알림 클릭 시 CGV 예매 페이지로 이동
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const config = await chrome.storage.local.get(['theaterCode', 'dates']);
  const date = config.dates?.[0] || '';
  chrome.tabs.create({
    url: `https://www.cgv.co.kr/ticket/?THEATER_CD=${config.theaterCode}&PLAY_YMD=${date}`,
  });
});

// 알람 설정
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkImax();
  }
});

// 메시지 핸들러
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_MONITORING') {
    chrome.storage.local.set({ monitoring: true, notifiedKeys: [] });
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL });
    checkImax(); // 즉시 1회 실행
    sendResponse({ ok: true });
  } else if (msg.type === 'STOP_MONITORING') {
    chrome.storage.local.set({ monitoring: false });
    chrome.alarms.clear(ALARM_NAME);
    sendResponse({ ok: true });
  } else if (msg.type === 'CHECK_NOW') {
    checkImax().then(() => sendResponse({ ok: true }));
    return true; // async
  }
});

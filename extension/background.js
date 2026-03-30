const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

async function fetchCgvShowtimes(theaterCode, areaCode, date, movieKeyword) {
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

  // 2단계: 극장 + IMAX + 날짜 선택
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: selectTheaterAndDate,
      args: [theaterCode, date],
    });
  } catch {}

  await new Promise((r) => setTimeout(r, 5000));

  // 3단계: 결과 읽기
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

function clickMovie(keyword) {
  if (!keyword) return;
  const kw = keyword.toLowerCase();
  const imgs = document.querySelectorAll('img[alt]');
  for (const img of imgs) {
    if (img.alt.toLowerCase().includes(kw)) {
      const clickable = img.closest('a') || img.closest('button') || img;
      clickable.click();
      return;
    }
  }
}

function selectTheaterAndDate(theaterCode, date) {
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

  // 날짜 선택
  if (date) {
    const day = parseInt(date.substring(6, 8));
    const dayStr = String(day).padStart(2, '0');
    setTimeout(() => {
      const dateEls = document.querySelectorAll('a, button, li, span, div');
      for (const el of dateEls) {
        const text = el.textContent.trim();
        if (text === String(day) || text === dayStr) {
          el.click();
          break;
        }
      }
    }, 2000);
  }
}

// 렌더링된 페이지에서 IMAX 상영 정보 파싱
function readResults(movieKeyword) {
  const debug = {};
  const showtimes = [];

  const bodyText = document.body?.innerText || '';
  debug.textLength = bodyText.length;
  debug.hasImax = bodyText.toUpperCase().includes('IMAX');
  debug.url = location.href;

  // IMAX 섹션 파싱: "IMAX관" 또는 "IMAX LASER" 뒤의 상영시간 추출
  // 형식: "09:30-12:16 201/282석 12:35-15:21 229/282석"
  const imaxPattern = /IMAX[^\n]*?\n?((?:\d{2}:\d{2}-\d{2}:\d{2}\s+\d+\/\d+석\s*)+)/gi;
  const imaxMatches = bodyText.match(imaxPattern);

  if (imaxMatches) {
    for (const block of imaxMatches) {
      // 개별 상영 시간 추출: "09:30-12:16 201/282석"
      const showPattern = /(\d{2}:\d{2})-(\d{2}:\d{2})\s+(\d+)\/(\d+)석/g;
      let match;
      const times = [];
      while ((match = showPattern.exec(block)) !== null) {
        times.push({
          startTime: match[1],
          endTime: match[2],
          remainSeats: parseInt(match[3]),
          totalSeats: parseInt(match[4]),
          isSoldOut: parseInt(match[3]) === 0,
        });
      }

      if (times.length > 0) {
        // IMAX 앞에서 영화 제목 찾기
        const imaxIdx = bodyText.toUpperCase().indexOf('IMAX');
        let movieName = movieKeyword || '';
        if (!movieName && imaxIdx > 0) {
          const before = bodyText.substring(Math.max(0, imaxIdx - 200), imaxIdx);
          const lines = before.split('\n').map((l) => l.trim()).filter((l) => l.length > 2 && l.length < 50);
          movieName = lines[lines.length - 1] || 'IMAX 상영';
        }

        showtimes.push({ movieName, hallName: 'IMAX', times });
      }
    }
  }

  // 패턴 매칭 실패 시 텍스트 기반 파싱
  if (showtimes.length === 0 && debug.hasImax) {
    const text = bodyText;
    // "IMAX" 키워드 이후 "HH:MM-HH:MM" 패턴 찾기
    const idx = text.toUpperCase().indexOf('IMAX');
    if (idx >= 0) {
      const afterImax = text.substring(idx, Math.min(text.length, idx + 1000));
      const showPattern = /(\d{2}:\d{2})-(\d{2}:\d{2})\s+(\d+)\/(\d+)석/g;
      let match;
      const times = [];
      while ((match = showPattern.exec(afterImax)) !== null) {
        times.push({
          startTime: match[1],
          endTime: match[2],
          remainSeats: parseInt(match[3]),
          totalSeats: parseInt(match[4]),
          isSoldOut: parseInt(match[3]) === 0,
        });
      }
      if (times.length > 0) {
        showtimes.push({ movieName: movieKeyword || 'IMAX 상영', hallName: 'IMAX', times });
      }

      debug.afterImaxText = afterImax.substring(0, 300);
    }
  }

  // 디버그: IMAX 근처 텍스트
  if (debug.hasImax) {
    const idx = bodyText.toUpperCase().indexOf('IMAX');
    debug.imaxContext = bodyText.substring(Math.max(0, idx - 50), Math.min(bodyText.length, idx + 400));
  }

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

      logs.push({ time: now(), msg: `[${date}] IMAX: ${debug.hasImax} | ${debug.textLength}자`, type: 'info' });

      if (debug.imaxContext) {
        logs.push({ time: now(), msg: `[IMAX] ${debug.imaxContext.substring(0, 200)}`, type: 'info' });
      }

      if (showtimes.length > 0) {
        for (const s of showtimes) {
          const timeStr = s.times
            .filter((t) => !t.isSoldOut)
            .map((t) => `${t.startTime}(${t.remainSeats}/${t.totalSeats}석)`)
            .join(' ');

          const key = `${s.movieName}-${date}-${s.times.map((t) => t.startTime).join(',')}`;
          if (!notifiedKeys.includes(key)) {
            chrome.notifications.create(key, {
              type: 'basic',
              iconUrl: 'icon.png',
              title: '🎬 IMAX 예매 오픈!',
              message: `${s.movieName}\n${config.theaterName}\n${timeStr}`,
              priority: 2,
              requireInteraction: true,
            });
            notifiedKeys.push(key);
          }
          logs.push({ time: now(), msg: `🎬 ${s.movieName} IMAX | ${timeStr}`, type: 'success' });
        }
        await chrome.storage.local.set({ notifiedKeys });
      } else {
        logs.push({ time: now(), msg: `${config.theaterName} ${date} — IMAX 없음`, type: 'info' });
      }
    } catch (e) {
      logs.push({ time: now(), msg: `오류: ${e.message}`, type: 'error' });
    }
  }

  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...logs, ...prev].slice(0, 200) });
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

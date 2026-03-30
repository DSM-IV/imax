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

  // 2단계: 극장 선택 + 날짜 클릭
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
      args: [date],
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
    '0013': '용산아이파크몰', '0074': '왕십리', '0056': '강남', '0059': '영등포',
    '0001': '명동', '0229': '여의도', '0014': '건대입구', '0247': '연수',
    '0070': '수원', '0218': '센텀시티', '0088': '대전', '0216': '광주터미널',
    '0055': '청주', '0131': '대구',
  };
  const theaterName = theaterNames[theaterCode] || theaterCode;

  // 극장 선택: 정확한 이름 매칭
  const allEls = document.querySelectorAll('a, button, li, div, span, strong');
  for (const el of allEls) {
    const text = el.textContent.trim();
    if (text === theaterName || text.includes(theaterName)) {
      if (text.length < 30) {
        el.click();
        break;
      }
    }
  }

  // 날짜 클릭
  if (date) {
    const day = parseInt(date.substring(6, 8));
    const dayStr = String(day).padStart(2, '0');
    setTimeout(() => {
      // 날짜 버튼 찾기 (CGV 날짜 형식: "03", "04" 등)
      const dateEls = document.querySelectorAll('a, button, li, span, div');
      for (const el of dateEls) {
        const text = el.textContent.trim();
        // 정확히 날짜 숫자만 매칭 (길이 2-3)
        if ((text === dayStr || text === String(day)) && text.length <= 3) {
          el.click();
          break;
        }
      }
    }, 2000);
  }
}

function readResults(targetDate) {
  const debug = {};
  const showtimes = [];

  const bodyText = document.body?.innerText || '';
  debug.textLength = bodyText.length;
  debug.url = location.href;

  const targetDay = parseInt(targetDate.substring(6, 8));
  const targetDayStr = String(targetDay).padStart(2, '0');

  // 선택된 날짜 확인: 활성화된 날짜 버튼 찾기
  // CGV에서 선택된 날짜는 빨간 원으로 표시됨
  let activeDateFound = false;
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    const text = el.textContent.trim();
    if ((text === targetDayStr || text === String(targetDay)) && text.length <= 3) {
      const styles = window.getComputedStyle(el);
      const parentStyles = window.getComputedStyle(el.parentElement || el);
      const cls = (el.className + ' ' + (el.parentElement?.className || '')).toLowerCase();

      // 활성 상태 판단: 클래스에 active/selected/on 포함, 또는 빨간 배경
      const bgColor = styles.backgroundColor || parentStyles.backgroundColor;
      const isActive = cls.includes('active') || cls.includes('select') || cls.includes('on') ||
                       cls.includes('current') || bgColor.includes('rgb(2');  // 빨간계열

      // 비활성 상태 판단: opacity 낮음, 회색 텍스트
      const opacity = parseFloat(styles.opacity);
      const color = styles.color;
      const isDisabled = opacity < 0.5 || cls.includes('disabled') || cls.includes('dim') ||
                         color.includes('rgb(200') || color.includes('rgb(180') || color.includes('rgb(150');

      if (isActive && !isDisabled) {
        activeDateFound = true;
      }

      debug.dateCheck = { text, cls: cls.substring(0, 80), bgColor, opacity, color, isActive, isDisabled };
      break;
    }
  }

  debug.activeDateFound = activeDateFound;

  // "스케줄이 없습니다" 확인
  const noSchedule = bodyText.includes('스케줄이 없습니다');
  debug.noSchedule = noSchedule;

  // 날짜가 활성화되지 않았으면 미오픈
  if (!activeDateFound && !noSchedule) {
    // 날짜 버튼을 못 찾았을 수 있으므로, IMAX 데이터가 있는지도 확인
    // 없으면 미오픈으로 판단
  }

  if (noSchedule) {
    debug.dateNotOpen = true;
    return { showtimes: [], debug };
  }

  // IMAX 상영 정보 파싱
  // 페이지 텍스트에서 "IMAX관" 이후 상영시간 블록 추출
  const hasImaxSection = bodyText.includes('IMAX관') || bodyText.includes('IMAX LASER');
  debug.hasImaxSection = hasImaxSection;

  if (hasImaxSection) {
    // "IMAX관" 또는 "IMAX LASER" 이후 텍스트에서 시간 추출
    const imaxIdx = bodyText.indexOf('IMAX관');
    const laserIdx = bodyText.indexOf('IMAX LASER');
    const startIdx = Math.max(imaxIdx, laserIdx);

    if (startIdx >= 0) {
      const afterImax = bodyText.substring(startIdx, Math.min(bodyText.length, startIdx + 500));
      debug.imaxSection = afterImax.substring(0, 300);

      // 영화 이름: IMAX관 앞에서 찾기
      const beforeImax = bodyText.substring(Math.max(0, startIdx - 300), startIdx);
      const titleMatch = beforeImax.match(/([가-힣a-zA-Z0-9\s:·\-]+)\s+\d+시간\s*\d*분/);
      const movieName = titleMatch ? titleMatch[1].trim() : '';

      // 시간 패턴: "11:00-13:46" 다음 줄에 "65·624석" 또는 "65/624석"
      // 또는 한 줄에 "11:00-13:46 65·624석"
      const showPattern = /(\d{2}:\d{2})-(\d{2}:\d{2})\s*[\n]?\s*(\d+)[·/:](\d+)석/g;
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
        showtimes.push({ movieName: movieName || 'IMAX 상영', hallName: 'IMAX', times });
      }
    }
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

      if (debug.noSchedule) {
        logs.push({ time: now(), msg: `📅 ${config.theaterName} ${date} — 예매 미오픈`, type: 'info' });
        continue;
      }

      if (!debug.activeDateFound) {
        logs.push({ time: now(), msg: `📅 ${config.theaterName} ${date} — 날짜 미오픈 (선택 불가)`, type: 'info' });
        if (debug.dateCheck) {
          logs.push({ time: now(), msg: `[날짜 상태] ${JSON.stringify(debug.dateCheck).substring(0, 150)}`, type: 'info' });
        }
        // IMAX 섹션이 없으면 스킵
        if (!debug.hasImaxSection) continue;
      }

      if (debug.imaxSection) {
        logs.push({ time: now(), msg: `[IMAX 섹션] ${debug.imaxSection.substring(0, 200)}`, type: 'info' });
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

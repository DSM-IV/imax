const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

async function checkDateOpen(theaterCode, date, movieKeyword) {
  const url = 'https://cgv.co.kr/cnm/movieBook/movie';
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
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 25000);
  });
  await new Promise((r) => setTimeout(r, 6000));

  // 1단계: 영화 클릭 (여러 방법 시도)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (kw) => {
        if (!kw) return;
        const keyword = kw.toLowerCase();
        // 방법 1: 포스터 이미지 클릭
        for (const img of document.querySelectorAll('img[alt]')) {
          if (img.alt.toLowerCase().includes(keyword)) {
            const target = img.closest('a, button, [role="button"], li') || img;
            target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
          }
        }
        // 방법 2: 텍스트 클릭
        for (const el of document.querySelectorAll('strong, span, a, button, p')) {
          if (el.textContent.trim().toLowerCase().includes(keyword) && el.textContent.length < 30) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
          }
        }
      },
      args: [movieKeyword || ''],
    });
  } catch {}
  await new Promise((r) => setTimeout(r, 4000));

  // 2단계: 극장 선택
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (code) => {
        const names = {
          '0013': '용산아이파크몰', '0074': '왕십리', '0056': '강남', '0059': '영등포',
          '0001': '명동', '0229': '여의도', '0014': '건대입구', '0247': '연수',
          '0070': '수원', '0218': '센텀시티', '0088': '대전', '0216': '광주터미널',
        };
        const name = names[code] || code;
        for (const el of document.querySelectorAll('*')) {
          if (el.textContent.trim() === name && el.children.length === 0) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
          }
        }
      },
      args: [theaterCode],
    });
  } catch {}
  await new Promise((r) => setTimeout(r, 3000));

  // 3단계: 날짜 상태 확인 + IMAX 데이터 읽기
  let result;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: checkPage,
      args: [date],
    });
    result = injection[0]?.result || {};
  } catch (e) {
    result = { error: e.message };
  }

  try { await chrome.tabs.remove(tab.id); } catch {}
  return result;
}

function checkPage(targetDate) {
  const targetDay = parseInt(targetDate.substring(6, 8));
  const targetDayStr = String(targetDay).padStart(2, '0');
  const bodyText = document.body?.innerText || '';

  const result = {
    url: location.href,
    textLength: bodyText.length,
    movieFound: false,
    dateOpen: false,
    imaxTimes: [],
    movieName: '',
    debug: {},
  };

  // 영화가 선택되었는지 확인 ("전체보기", "시간", 날짜 버튼이 보이면 선택된 것)
  result.movieFound = bodyText.includes('전체보기') && /\d{2}:\d{2}/.test(bodyText) || bodyText.includes('IMAX관');

  // 영화 이름 추출
  const titleMatch = bodyText.match(/([\uAC00-\uD7A3a-zA-Z0-9 :·\-]+)\s+\d+시간\s*\d*분/);
  if (titleMatch) {
    let name = titleMatch[1].trim();
    // 마지막 줄만 (앞에 노이즈 제거)
    const parts = name.split('\n');
    result.movieName = parts[parts.length - 1].trim();
  }

  // 날짜 버튼들 분석
  // CGV 날짜 버튼: 숫자(01~31)를 포함하는 작은 요소들
  const dateButtons = [];
  for (const el of document.querySelectorAll('*')) {
    const text = el.textContent.trim();
    if (text.length > 3 || text.length === 0) continue;
    if (!/^\d{1,2}$/.test(text)) continue;
    const num = parseInt(text);
    if (num < 1 || num > 31) continue;

    // 이 요소 또는 부모의 스타일 확인
    const target = el.closest('button, a, li, div') || el;
    const style = window.getComputedStyle(target);
    const elStyle = window.getComputedStyle(el);

    const opacity = parseFloat(style.opacity);
    const color = elStyle.color;
    const pointerEvents = style.pointerEvents;
    const cls = target.className?.toLowerCase() || '';

    // RGB 값 파싱
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    const r = rgbMatch ? parseInt(rgbMatch[1]) : 0;
    const g = rgbMatch ? parseInt(rgbMatch[2]) : 0;
    const b = rgbMatch ? parseInt(rgbMatch[3]) : 0;

    // 회색/연한색 = 비활성 (R,G,B가 모두 150 이상이면 연한색)
    const isLight = r > 150 && g > 150 && b > 150;
    const isDisabled = isLight || opacity < 0.5 || pointerEvents === 'none' ||
                       cls.includes('disabled') || cls.includes('dim') || cls.includes('off');

    dateButtons.push({
      day: num,
      text,
      isDisabled,
      color,
      opacity,
      cls: cls.substring(0, 50),
    });
  }

  result.debug.dateButtons = dateButtons.filter((d) => d.day >= targetDay - 2 && d.day <= targetDay + 2);

  // 타겟 날짜 상태 확인
  const targetBtn = dateButtons.find((d) => d.day === targetDay);
  if (targetBtn) {
    result.dateOpen = !targetBtn.isDisabled;
    result.debug.targetDate = targetBtn;
  }

  // IMAX 상영 시간 추출 (날짜가 열렸거나 이미 표시되는 경우)
  if (bodyText.includes('IMAX관')) {
    const imaxIdx = bodyText.indexOf('IMAX관');
    const afterImax = bodyText.substring(imaxIdx);
    // IMAX 섹션만 (다음 상영관 전까지)
    const nextScreen = afterImax.match(/\n\s*(2D|3D|\d+관|DOLBY|SCREENX|4DX|ULTRA|COMFORT)/);
    const section = afterImax.substring(0, nextScreen ? nextScreen.index : 300);
    result.debug.imaxSection = section.substring(0, 200);

    const showPattern = /(\d{2}:\d{2})-(\d{2}:\d{2})\s*[\n]?\s*(\d+)[·/:](\d+)석/g;
    let match;
    while ((match = showPattern.exec(section)) !== null) {
      result.imaxTimes.push({
        start: match[1],
        end: match[2],
        remain: parseInt(match[3]),
        total: parseInt(match[4]),
      });
    }
  }

  // 페이지에 "스케줄이 없습니다" 표시
  result.noSchedule = bodyText.includes('스케줄이 없습니다');

  return result;
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
      const r = await checkDateOpen(config.theaterCode, date, config.movieKeyword);

      const day = date.substring(4, 6) + '/' + date.substring(6, 8);

      if (r.error) {
        logs.push({ time: now(), msg: `❌ ${day} 오류: ${r.error}`, type: 'error' });
        continue;
      }

      // 영화 선택 확인
      if (!r.movieFound) {
        logs.push({ time: now(), msg: `⚠️ ${day} 영화 선택 실패 (${r.textLength}자)`, type: 'error' });
        continue;
      }

      // 날짜 상태 로그
      const dateInfo = r.debug.targetDate;
      if (dateInfo) {
        logs.push({ time: now(), msg: `📅 ${day} 날짜 상태: ${r.dateOpen ? '오픈 ✅' : '미오픈 ❌'} (색상: ${dateInfo.color}, opacity: ${dateInfo.opacity})`, type: r.dateOpen ? 'success' : 'info' });
      } else {
        logs.push({ time: now(), msg: `📅 ${day} 날짜 버튼 못 찾음`, type: 'error' });
      }

      // 미오픈이면 알림 없이 스킵
      if (!r.dateOpen) {
        continue;
      }

      // IMAX 상영 정보
      if (r.imaxTimes.length > 0) {
        const timeStr = r.imaxTimes
          .filter((t) => t.remain > 0)
          .map((t) => `${t.start}(${t.remain}/${t.total}석)`)
          .join(' ');

        const movieName = r.movieName || config.movieKeyword || 'IMAX';
        const key = `${movieName}-${date}`;

        if (!notifiedKeys.includes(key)) {
          chrome.notifications.create(key, {
            type: 'basic',
            iconUrl: 'icon.png',
            title: '🎬 IMAX 예매 오픈!',
            message: `${movieName}\n${config.theaterName} ${day}\n${timeStr}`,
            priority: 2,
            requireInteraction: true,
          });
          notifiedKeys.push(key);
          await chrome.storage.local.set({ notifiedKeys });
        }

        logs.push({ time: now(), msg: `🎬 ${movieName} IMAX | ${timeStr}`, type: 'success' });
      } else if (r.noSchedule) {
        logs.push({ time: now(), msg: `${config.theaterName} ${day} — 스케줄 없음`, type: 'info' });
      } else {
        logs.push({ time: now(), msg: `${config.theaterName} ${day} — IMAX 없음`, type: 'info' });
      }
    } catch (e) {
      logs.push({ time: now(), msg: `❌ 오류: ${e.message}`, type: 'error' });
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

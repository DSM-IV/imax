const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runStep(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result[0]?.result;
}

async function checkDateOpen(theaterCode, date, movieKeyword) {
  const tab = await chrome.tabs.create({ url: 'https://cgv.co.kr/cnm/movieBook/movie', active: false });

  // 페이지 로드 대기
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 25000);
  });
  await wait(6000);

  const theaterNames = {
    '0013': '용산아이파크몰', '0074': '왕십리', '0056': '강남', '0059': '영등포',
    '0001': '명동', '0229': '여의도', '0014': '건대입구', '0247': '연수역',
    '0070': '수원', '0218': '센텀시티', '0088': '대전', '0216': '광주터미널',
    '0055': '청주', '0131': '대구이시아',
  };
  const theaterName = theaterNames[theaterCode] || theaterCode;
  const targetDay = parseInt(date.substring(6, 8));

  try {
    // 1단계: 영화 클릭
    await runStep(tab.id, (kw) => {
      for (const img of document.querySelectorAll('img[alt]')) {
        if (img.alt.toLowerCase().includes(kw.toLowerCase())) {
          (img.closest('a,button,[role="button"],li') || img).dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'ok';
        }
      }
      return 'not_found';
    }, [movieKeyword || '헤일메리']);
    await wait(4000);

    // 2단계: ⊕ 버튼 클릭 (극장 추가 버튼)
    await runStep(tab.id, () => {
      // SVG 또는 ⊕ 아이콘이 있는 버튼 찾기
      for (const el of document.querySelectorAll('button, a, div, span, svg')) {
        const text = el.textContent?.trim();
        const ariaLabel = el.getAttribute('aria-label') || '';
        const cls = el.className?.toString() || '';
        // + 아이콘 또는 추가 버튼
        if (text === '+' || text === '＋' || ariaLabel.includes('추가') ||
            cls.includes('add') || cls.includes('plus') || cls.includes('more')) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked_plus';
        }
      }
      // SVG circle with + (plus icon)
      for (const svg of document.querySelectorAll('svg')) {
        const parent = svg.closest('button, a, div');
        if (parent) {
          const rect = svg.getBoundingClientRect();
          // ⊕ 버튼은 극장 목록 오른쪽에 있음
          if (rect.width < 40 && rect.width > 10) {
            parent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return 'clicked_svg';
          }
        }
      }
      return 'not_found';
    });
    await wait(2000);

    // 3단계: 검색창에 극장명 입력
    await runStep(tab.id, (name) => {
      const inputs = document.querySelectorAll('input[type="text"], input[placeholder*="지역"], input[placeholder*="검색"], input:not([type="hidden"])');
      for (const input of inputs) {
        if (input.placeholder?.includes('지역') || input.placeholder?.includes('검색') || input.offsetParent !== null) {
          input.focus();
          input.value = name;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          // React setState 트리거를 위한 nativeInputValueSetter
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, name);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return 'typed';
        }
      }
      return 'no_input';
    }, [theaterName]);
    await wait(2000);

    // 4단계: 자동완성 결과에서 극장 클릭
    await runStep(tab.id, (name) => {
      for (const el of document.querySelectorAll('li, div, a, button, span')) {
        const text = el.textContent?.trim();
        if (text === name && el.offsetParent !== null) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked_theater';
        }
      }
      // 부분 매칭
      for (const el of document.querySelectorAll('li, div, a, button, span')) {
        const text = el.textContent?.trim();
        if (text?.includes(name) && text.length < name.length + 10 && el.offsetParent !== null) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked_theater_partial';
        }
      }
      return 'not_found';
    }, [theaterName]);
    await wait(3000);

    // 5단계: 날짜 클릭
    await runStep(tab.id, (day) => {
      const dayStr = String(day).padStart(2, '0');
      for (const el of document.querySelectorAll('*')) {
        const text = el.textContent?.trim();
        if ((text === dayStr || text === String(day)) && text.length <= 2 && el.offsetParent !== null) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked_date';
        }
      }
      return 'not_found';
    }, [targetDay]);
    await wait(3000);

    // 6단계: 결과 읽기
    const result = await runStep(tab.id, (day, tName) => {
      const bodyText = document.body?.innerText || '';
      const r = {
        textLength: bodyText.length,
        movieName: '',
        theaterMatched: bodyText.includes(tName),
        hasImaxSection: bodyText.includes('IMAX관'),
        noSchedule: bodyText.includes('스케줄이 없습니다'),
        imaxTimes: [],
      };

      // 영화 이름
      const titleMatch = bodyText.match(/([\uAC00-\uD7A3a-zA-Z0-9 :·\-]+)\s+\d+시간\s*\d*분/);
      if (titleMatch) {
        const parts = titleMatch[1].trim().split('\n');
        r.movieName = parts[parts.length - 1].trim();
      }

      // 현재 선택된 극장 확인
      // 극장 버튼 중 활성화된 것 찾기
      for (const el of document.querySelectorAll('button, div, span')) {
        const text = el.textContent?.trim();
        if (text === tName) {
          const cls = el.className?.toString().toLowerCase() || '';
          const style = window.getComputedStyle(el);
          r.theaterActive = cls.includes('active') || cls.includes('select') || cls.includes('on') ||
                            style.backgroundColor !== 'rgba(0, 0, 0, 0)';
          r.theaterEl = { text, cls: cls.substring(0, 60), bg: style.backgroundColor };
        }
      }

      // IMAX 상영 파싱
      if (r.hasImaxSection) {
        const imaxIdx = bodyText.indexOf('IMAX관');
        const afterImax = bodyText.substring(imaxIdx);
        const nextScreen = afterImax.match(/\n\s*(4DX|2D|3D|\d+관|DOLBY|SCREENX|ULTRA|COMFORT)/);
        const section = afterImax.substring(0, nextScreen ? nextScreen.index : 300);
        r.imaxSection = section.substring(0, 200);

        const pat = /(\d{2}:\d{2})-(\d{2}:\d{2})\s*[\n]?\s*(\d+)[·/:](\d+)석/g;
        let m;
        while ((m = pat.exec(section)) !== null) {
          r.imaxTimes.push({ start: m[1], end: m[2], remain: parseInt(m[3]), total: parseInt(m[4]) });
        }
      }

      return r;
    }, [targetDay, theaterName]);

    try { await chrome.tabs.remove(tab.id); } catch {}
    return result || {};
  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch {}
    return { error: e.message };
  }
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

      // 극장 매칭 확인
      logs.push({ time: now(), msg: `[${day}] 극장: ${r.theaterMatched ? config.theaterName + ' ✅' : '미매칭 ❌'} | IMAX: ${r.hasImaxSection}`, type: r.theaterMatched ? 'info' : 'error' });

      if (r.noSchedule) {
        logs.push({ time: now(), msg: `📅 ${day} ${config.theaterName} — 예매 미오픈`, type: 'info' });
        continue;
      }

      if (!r.hasImaxSection) {
        logs.push({ time: now(), msg: `${day} ${config.theaterName} — IMAX 상영 없음`, type: 'info' });
        continue;
      }

      if (r.imaxSection) {
        logs.push({ time: now(), msg: `[IMAX] ${r.imaxSection.substring(0, 150)}`, type: 'info' });
      }

      if (r.imaxTimes.length > 0) {
        const movieName = r.movieName || config.movieKeyword || 'IMAX';
        const timeStr = r.imaxTimes
          .filter((t) => t.remain > 0)
          .map((t) => `${t.start}(${t.remain}/${t.total}석)`)
          .join(' ');

        const key = `${movieName}-${date}`;
        if (!notifiedKeys.includes(key)) {
          chrome.notifications.create(key, {
            type: 'basic', iconUrl: 'icon.png',
            title: '🎬 IMAX 예매 오픈!',
            message: `${movieName}\n${config.theaterName} ${day}\n${timeStr}`,
            priority: 2, requireInteraction: true,
          });
          notifiedKeys.push(key);
          await chrome.storage.local.set({ notifiedKeys });
        }
        logs.push({ time: now(), msg: `🎬 ${movieName} IMAX | ${timeStr}`, type: 'success' });
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

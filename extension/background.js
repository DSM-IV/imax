const ALARM_NAME = 'cgv-imax-check';
const CHECK_INTERVAL = 0.5; // 30초

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run(tabId, func, args = []) {
  const r = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r[0]?.result;
}

async function checkDateOpen(theaterCode, date, movieKeyword) {
  const tab = await chrome.tabs.create({ url: 'https://cgv.co.kr/cnm/movieBook/movie', active: false });
  const logs = [];

  await new Promise((resolve) => {
    const fn = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(fn); resolve(); } };
    chrome.tabs.onUpdated.addListener(fn);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, 25000);
  });
  await wait(5000);

  const theaterNames = {
    '0013': '용산아이파크몰', '0074': '왕십리', '0056': '강남', '0059': '영등포',
    '0001': '명동', '0229': '여의도', '0014': '건대입구', '0247': '연수역',
    '0070': '수원', '0218': '센텀시티', '0088': '대전', '0216': '광주터미널',
  };
  const theaterName = theaterNames[theaterCode] || theaterCode;
  const targetDay = parseInt(date.substring(6, 8));

  try {
    // ===== 1단계: 포스터 직접 클릭 =====
    const s1 = await run(tab.id, (kw) => {
      // 포스터 이미지 클릭 (가장 확실한 방법)
      for (const img of document.querySelectorAll('img[alt]')) {
        if (img.alt.toLowerCase().includes(kw.toLowerCase()) && img.alt.includes('포스터')) {
          const target = img.closest('a,button,li,div,[role="button"]') || img;
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'clicked: ' + img.alt.substring(0, 30);
        }
      }
      // 포스터 못 찾으면 텍스트로
      for (const img of document.querySelectorAll('img[alt]')) {
        if (img.alt.toLowerCase().includes(kw.toLowerCase())) {
          const target = img.closest('a,button,li,div,[role="button"]') || img;
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'clicked: ' + img.alt.substring(0, 30);
        }
      }
      return 'fail';
    }, [movieKeyword || '헤일메리']);
    logs.push(`1.영화: ${s1}`);
    await wait(5000); // 예매 화면 전환 대기

    // 전환 확인
    const movieOk = await run(tab.id, () => {
      const text = document.body?.innerText || '';
      return text.includes('시간') && (text.includes('광교') || text.includes('CGV') || text.includes('전체보기'));
    });
    logs.push(`1b.화면전환: ${movieOk ? '성공' : '실패'}`);

    // ===== 2단계: ⊕ 버튼 클릭 (극장 변경) =====
    // ⊕ 버튼을 여러 방법으로 시도하고 바텀시트 열릴 때까지 재시도
    let sheetOpen = false;
    for (let attempt = 0; attempt < 3 && !sheetOpen; attempt++) {
      await run(tab.id, (attempt) => {
        const methods = [];
        // 극장 칩(광교 등) 옆의 ⊕ 아이콘 찾기
        // 극장 칩들이 있는 컨테이너에서 마지막 클릭 가능 요소
        const chips = [];
        document.querySelectorAll('*').forEach(el => {
          const t = el.textContent?.trim();
          if ((t === '광교' || t === '동수원' || t === '광교상현') && el.children.length === 0 && el.offsetParent) {
            chips.push(el);
          }
        });
        if (chips.length > 0) {
          // 칩들의 공통 부모 찾기
          const parent = chips[0].closest('div, section, nav, ul');
          if (parent) {
            // 부모 안의 모든 클릭 가능 요소 중 마지막 것 (⊕ 버튼)
            const clickables = parent.querySelectorAll('button, a, [role="button"], svg');
            for (let i = clickables.length - 1; i >= 0; i--) {
              const el = clickables[i];
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.width < 50) {
                (el.closest('button, a, div') || el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                methods.push('chip_sibling');
                break;
              }
            }
          }
        }
        if (methods.length === 0 && attempt >= 1) {
          // 대안: 페이지의 모든 작은 원형 버튼 클릭 시도
          document.querySelectorAll('button, [role="button"]').forEach(btn => {
            const rect = btn.getBoundingClientRect();
            if (rect.width >= 20 && rect.width <= 45 && rect.height >= 20 && rect.height <= 45) {
              const text = btn.textContent?.trim();
              if (!text || text.length <= 1) {
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                methods.push('small_btn');
              }
            }
          });
        }
        return methods.join(',') || 'none';
      }, [attempt]);
      await wait(2000);

      sheetOpen = await run(tab.id, () => {
        return document.body.innerText.includes('지역을 입력해주세요') ||
               document.body.innerText.includes('지역별') ||
               !!document.querySelector('input[placeholder*="지역"]');
      });
    }
    logs.push(`2.바텀시트: ${sheetOpen ? '열림 ✅' : '안열림 ❌'}`);

    // ===== 3단계: 검색창에 극장 입력 =====
    if (sheetOpen) {
      const s3 = await run(tab.id, (name) => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          if (input.placeholder?.includes('지역') || input.placeholder?.includes('검색')) {
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, name);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return 'typed';
          }
        }
        return 'no_input';
      }, [theaterName]);
      logs.push(`3.극장검색: ${s3}`);
      await wait(2000);

      // 자동완성에서 클릭
      const s4 = await run(tab.id, (name) => {
        for (const el of document.querySelectorAll('li, div, a, button, span')) {
          const text = el.textContent?.trim();
          if (text === name && el.offsetParent !== null && el.children.length <= 2) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return 'clicked';
          }
        }
        return 'fail';
      }, [theaterName]);
      logs.push(`4.극장선택: ${s4}`);
      await wait(3000);
    }

    // ===== 5단계: 날짜 클릭 =====
    const s5 = await run(tab.id, (day) => {
      const dayStr = String(day).padStart(2, '0');
      for (const el of document.querySelectorAll('*')) {
        const text = el.textContent?.trim();
        if ((text === dayStr || text === String(day)) && text.length <= 2 && el.offsetParent !== null && el.children.length === 0) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked';
        }
      }
      return 'fail';
    }, [targetDay]);
    logs.push(`5.날짜(${targetDay}): ${s5}`);
    await wait(3000);

    // ===== 6단계: 결과 읽기 =====
    const result = await run(tab.id, (tName) => {
      const bodyText = document.body?.innerText || '';
      const r = {
        theaterMatched: bodyText.includes(tName),
        hasImaxSection: bodyText.includes('IMAX관'),
        noSchedule: bodyText.includes('스케줄이 없습니다'),
        imaxTimes: [],
        movieName: '',
        imaxSection: '',
      };

      // 영화 이름
      const m = bodyText.match(/([\uAC00-\uD7A3a-zA-Z0-9 :·\-]+)\s+\d+시간\s*\d*분/);
      if (m) { const p = m[1].trim().split('\n'); r.movieName = p[p.length - 1].trim(); }

      // IMAX 파싱
      if (r.hasImaxSection) {
        const idx = bodyText.indexOf('IMAX관');
        const after = bodyText.substring(idx);
        const next = after.match(/\n\s*(4DX|2D|3D|\d+관|DOLBY|SCREENX|ULTRA|COMFORT)/);
        const section = after.substring(0, next ? next.index : 300);
        r.imaxSection = section.substring(0, 200);

        const pat = /(\d{2}:\d{2})-(\d{2}:\d{2})\s*[\n]?\s*(\d+)[·/:](\d+)석/g;
        let match;
        while ((match = pat.exec(section)) !== null) {
          r.imaxTimes.push({ start: match[1], end: match[2], remain: parseInt(match[3]), total: parseInt(match[4]) });
        }
      }
      return r;
    }, [theaterName]);

    try { await chrome.tabs.remove(tab.id); } catch {}
    return { ...result, logs };
  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch {}
    return { error: e.message, logs };
  }
}

async function checkImax() {
  const config = await chrome.storage.local.get([
    'monitoring', 'theaterCode', 'theaterName', 'areaCode',
    'dates', 'movieKeyword', 'notifiedKeys',
  ]);
  if (!config.monitoring || !config.theaterCode || !config.dates?.length) return;

  const notifiedKeys = config.notifiedKeys || [];
  const allLogs = [];

  for (const date of config.dates) {
    try {
      const r = await checkDateOpen(config.theaterCode, date, config.movieKeyword);
      const day = date.substring(4, 6) + '/' + date.substring(6, 8);

      // 단계별 로그
      for (const l of (r.logs || [])) {
        allLogs.push({ time: now(), msg: `[${day}] ${l}`, type: 'info' });
      }

      if (r.error) { allLogs.push({ time: now(), msg: `❌ ${day}: ${r.error}`, type: 'error' }); continue; }

      allLogs.push({ time: now(), msg: `[${day}] 극장: ${r.theaterMatched ? config.theaterName + ' ✅' : '미매칭 ❌'} | IMAX: ${r.hasImaxSection}`, type: r.theaterMatched ? 'info' : 'error' });

      if (r.noSchedule) { allLogs.push({ time: now(), msg: `📅 ${day} — 예매 미오픈`, type: 'info' }); continue; }
      if (!r.hasImaxSection) { allLogs.push({ time: now(), msg: `${day} — IMAX 없음`, type: 'info' }); continue; }

      if (r.imaxSection) allLogs.push({ time: now(), msg: `[IMAX] ${r.imaxSection.substring(0, 150)}`, type: 'info' });

      if (r.imaxTimes.length > 0) {
        const movieName = r.movieName || config.movieKeyword || 'IMAX';
        const timeStr = r.imaxTimes.filter((t) => t.remain > 0).map((t) => `${t.start}(${t.remain}/${t.total}석)`).join(' ');
        const key = `${movieName}-${date}`;
        if (!notifiedKeys.includes(key)) {
          chrome.notifications.create(key, {
            type: 'basic', iconUrl: 'icon.png', title: '🎬 IMAX 예매 오픈!',
            message: `${movieName}\n${config.theaterName} ${day}\n${timeStr}`,
            priority: 2, requireInteraction: true,
          });
          notifiedKeys.push(key);
          await chrome.storage.local.set({ notifiedKeys });
        }
        allLogs.push({ time: now(), msg: `🎬 ${movieName} IMAX | ${timeStr}`, type: 'success' });
      }
    } catch (e) {
      allLogs.push({ time: now(), msg: `❌ ${e.message}`, type: 'error' });
    }
  }

  const prev = (await chrome.storage.local.get('logs')).logs || [];
  await chrome.storage.local.set({ logs: [...allLogs, ...prev].slice(0, 200) });
}

function now() { return new Date().toLocaleTimeString('ko-KR'); }
chrome.notifications.onClicked.addListener(() => { chrome.tabs.create({ url: 'https://cgv.co.kr/cnm/movieBook/movie' }); });
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

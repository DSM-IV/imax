// CGV 페이지 로드 전에 fetch를 가로채서 모든 API 호출 기록
(function () {
  const capturedApis = [];
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const response = await originalFetch.apply(this, args);

    // API 호출만 기록 (이미지, 스크립트 등 제외)
    if (url.includes('api.cgv.co.kr') || url.includes('/cnm/')) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        capturedApis.push({
          url,
          status: response.status,
          length: text.length,
          hasImax: text.toUpperCase().includes('IMAX'),
          body: text.substring(0, 3000),
          time: Date.now(),
        });
        // storage에 저장
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ capturedApis: capturedApis.slice(-50) });
        }
      } catch {}
    }

    return response;
  };

  // 전역에 노출
  window.__cgvCapturedApis = capturedApis;
})();

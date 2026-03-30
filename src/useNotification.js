import { useState, useCallback, useEffect } from 'react';

export function useNotification() {
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return 'denied';
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, []);

  const notify = useCallback(
    (title, body) => {
      if (permission !== 'granted') return;
      new Notification(title, {
        body,
        icon: '/favicon.svg',
        tag: 'imax-alert',
        requireInteraction: true,
      });
      // 소리 알림
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.value = 0.3;
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      } catch {
        // 소리 재생 실패 무시
      }
    },
    [permission]
  );

  return { permission, requestPermission, notify };
}

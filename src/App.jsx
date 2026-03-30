import { useState, useEffect, useRef, useCallback } from 'react';
import { IMAX_THEATERS, fetchShowtimes, findImaxForMovie } from './cgvApi';
import { useNotification } from './useNotification';
import './App.css';

const POLL_INTERVAL = 30_000;

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function getNextDays(count = 21) {
  const days = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const weekday = d.toLocaleDateString('ko-KR', { weekday: 'short' });
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    days.push({
      value: formatDate(d),
      label: d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }),
      weekday,
      isWeekend,
    });
  }
  return days;
}

function App() {
  const [movieKeyword, setMovieKeyword] = useState('');
  const [selectedTheater, setSelectedTheater] = useState('');
  const [selectedDates, setSelectedDates] = useState([]);
  const [monitoring, setMonitoring] = useState(false);
  const [logs, setLogs] = useState([]);
  const [found, setFound] = useState([]);
  const [checkCount, setCheckCount] = useState(0);
  const timerRef = useRef(null);
  const { permission, requestPermission, notify } = useNotification();
  const dates = getNextDays(21);

  // 저장된 설정 불러오기
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('imax-config-v2') || '{}');
      if (saved.movie) setMovieKeyword(saved.movie);
      if (saved.theater) setSelectedTheater(saved.theater);
      if (saved.dates) setSelectedDates(saved.dates);
    } catch {}
  }, []);

  // 설정 저장
  useEffect(() => {
    localStorage.setItem(
      'imax-config-v2',
      JSON.stringify({ movie: movieKeyword, theater: selectedTheater, dates: selectedDates })
    );
  }, [movieKeyword, selectedTheater, selectedDates]);

  const addLog = useCallback((msg, type = 'info') => {
    setLogs((prev) =>
      [{ time: new Date().toLocaleTimeString('ko-KR'), msg, type }, ...prev].slice(0, 100)
    );
  }, []);

  const toggleDate = (dateVal) => {
    setSelectedDates((prev) =>
      prev.includes(dateVal) ? prev.filter((d) => d !== dateVal) : [...prev, dateVal]
    );
  };

  const checkOnce = useCallback(async () => {
    if (!selectedTheater || selectedDates.length === 0) return false;

    const theater = IMAX_THEATERS.find((t) => t.code === selectedTheater);
    if (!theater) return false;

    setCheckCount((c) => c + 1);
    let foundAny = false;

    for (const date of selectedDates) {
      try {
        const movies = await fetchShowtimes(theater.code, theater.area, date);
        const imaxResults = findImaxForMovie(movies, movieKeyword);

        if (imaxResults.length > 0) {
          foundAny = true;
          const dateLabel = dates.find((d) => d.value === date)?.label || date;

          for (const result of imaxResults) {
            const allTimes = result.halls
              .flatMap((h) => h.times.filter((t) => !t.isSoldOut).map((t) => t.time))
              .join(', ');

            const entry = {
              movieName: result.movieName,
              theaterName: theater.name,
              date: dateLabel,
              dateRaw: date,
              times: allTimes,
              halls: result.halls,
            };

            setFound((prev) => {
              const exists = prev.some(
                (p) =>
                  p.movieName === entry.movieName &&
                  p.dateRaw === entry.dateRaw &&
                  p.theaterName === entry.theaterName
              );
              return exists ? prev : [...prev, entry];
            });

            addLog(
              `🎬 IMAX 발견! ${result.movieName} @ ${theater.name} ${dateLabel} (${allTimes})`,
              'success'
            );
            notify('IMAX 예매 가능!', `${result.movieName}\n${theater.name} ${dateLabel} ${allTimes}`);
          }
        } else {
          addLog(`${theater.name} ${date} — IMAX 상영 없음`);
        }
      } catch (e) {
        addLog(`오류 (${date}): ${e.message}`, 'error');
      }
    }

    return foundAny;
  }, [selectedTheater, selectedDates, movieKeyword, dates, addLog, notify]);

  const startMonitoring = useCallback(async () => {
    if (permission !== 'granted') {
      const result = await requestPermission();
      if (result !== 'granted') {
        addLog('⚠️ 알림 권한이 필요합니다', 'error');
        return;
      }
    }
    setMonitoring(true);
    setFound([]);
    setCheckCount(0);
    addLog('모니터링 시작 (30초 간격)', 'info');

    await checkOnce();

    timerRef.current = setInterval(() => {
      checkOnce();
    }, POLL_INTERVAL);
  }, [permission, requestPermission, checkOnce, addLog]);

  const stopMonitoring = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setMonitoring(false);
    addLog('모니터링 중지');
  }, [addLog]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const selectedTheaterObj = IMAX_THEATERS.find((t) => t.code === selectedTheater);

  return (
    <div className="app">
      <header>
        <h1>🎬 IMAX 예매 알림</h1>
        <p className="subtitle">CGV IMAX 상영이 열리면 즉시 알려드립니다</p>
      </header>

      {/* 발견된 IMAX 상영 */}
      {found.length > 0 && (
        <div className="found-section">
          <h2 className="found-title">IMAX 예매 가능!</h2>
          {found.map((f, i) => (
            <div key={i} className="found-card">
              <div className="found-movie">{f.movieName}</div>
              <div className="found-detail">
                {f.theaterName} · {f.date}
              </div>
              <div className="found-times">
                {f.halls.map((hall, hi) =>
                  hall.times
                    .filter((t) => !t.isSoldOut)
                    .map((t, ti) => (
                      <span key={`${hi}-${ti}`} className="time-badge">
                        {t.time}
                        {t.remain && <small> ({t.remain})</small>}
                      </span>
                    ))
                )}
              </div>
              <a
                href={`http://www.cgv.co.kr/ticket/?THEATER_CD=${selectedTheater}&PLAY_YMD=${f.dateRaw}`}
                target="_blank"
                rel="noopener noreferrer"
                className="book-btn"
              >
                CGV에서 예매하기 →
              </a>
            </div>
          ))}
        </div>
      )}

      <div className="config-grid">
        {/* 영화 키워드 */}
        <section className="config-card">
          <h2>🔍 영화 키워드</h2>
          <p className="hint">비워두면 모든 IMAX 상영을 감지합니다</p>
          <input
            type="text"
            placeholder="예: 인터스텔라, 어벤져스..."
            value={movieKeyword}
            onChange={(e) => setMovieKeyword(e.target.value)}
            className="search-input"
          />
        </section>

        {/* 극장 선택 */}
        <section className="config-card">
          <h2>🏢 IMAX 극장</h2>
          <p className="hint">모니터링할 극장을 선택하세요</p>
          {selectedTheaterObj && (
            <div className="selected-tag">
              {selectedTheaterObj.name}
              <span className="theater-type">{selectedTheaterObj.type}</span>
              <button onClick={() => setSelectedTheater('')}>✕</button>
            </div>
          )}
          <ul className="select-list">
            {IMAX_THEATERS.map((t) => (
              <li
                key={t.code}
                className={selectedTheater === t.code ? 'active' : ''}
                onClick={() => setSelectedTheater(t.code)}
              >
                <span>{t.name}</span>
                <small className="theater-badge">{t.type}</small>
              </li>
            ))}
          </ul>
        </section>

        {/* 날짜 선택 */}
        <section className="config-card">
          <h2>📅 날짜 (복수 선택)</h2>
          <p className="hint">{selectedDates.length}일 선택됨</p>
          <div className="date-grid">
            {dates.map((d) => (
              <button
                key={d.value}
                className={`date-btn ${selectedDates.includes(d.value) ? 'active' : ''} ${d.isWeekend ? 'weekend' : ''}`}
                onClick={() => toggleDate(d.value)}
              >
                <span className="date-day">{d.label}</span>
                <span className="date-weekday">{d.weekday}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* 컨트롤 */}
      <div className="controls">
        {permission !== 'granted' && (
          <button onClick={requestPermission} className="btn btn-secondary">
            🔔 알림 권한 허용
          </button>
        )}
        {!monitoring ? (
          <button
            onClick={startMonitoring}
            disabled={!selectedTheater || selectedDates.length === 0}
            className="btn btn-primary"
          >
            모니터링 시작
          </button>
        ) : (
          <button onClick={stopMonitoring} className="btn btn-stop">
            모니터링 중지
          </button>
        )}
        {monitoring && (
          <span className="pulse">● 모니터링 중... ({checkCount}회 확인)</span>
        )}
      </div>

      {/* 로그 */}
      {logs.length > 0 && (
        <section className="log-section">
          <div className="log-header">
            <h2>📋 활동 로그</h2>
            <button className="log-clear" onClick={() => setLogs([])}>
              지우기
            </button>
          </div>
          <ul className="log-list">
            {logs.map((l, i) => (
              <li key={i} className={`log-${l.type}`}>
                <span className="log-time">{l.time}</span> {l.msg}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default App;

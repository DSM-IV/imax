import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchMovies, fetchTheaters, fetchShowtimes, hasImaxShowtime, getImaxShowtimes } from './cgvApi';
import { useNotification } from './useNotification';
import './App.css';

const POLL_INTERVAL = 30_000; // 30초마다 확인

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function getNextDays(count = 14) {
  const days = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push({
      value: formatDate(d),
      label: d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }),
    });
  }
  return days;
}

function App() {
  const [movies, setMovies] = useState([]);
  const [theaters, setTheaters] = useState([]);
  const [selectedMovie, setSelectedMovie] = useState('');
  const [selectedTheater, setSelectedTheater] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [movieSearch, setMovieSearch] = useState('');
  const [theaterSearch, setTheaterSearch] = useState('');
  const [monitoring, setMonitoring] = useState(false);
  const [logs, setLogs] = useState([]);
  const [found, setFound] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef(null);
  const { permission, requestPermission, notify } = useNotification();
  const dates = getNextDays(14);

  // 저장된 설정 불러오기
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('imax-config') || '{}');
      if (saved.movie) setSelectedMovie(saved.movie);
      if (saved.theater) setSelectedTheater(saved.theater);
      if (saved.date) setSelectedDate(saved.date);
    } catch {}
  }, []);

  // 설정 저장
  useEffect(() => {
    if (selectedMovie || selectedTheater || selectedDate) {
      localStorage.setItem(
        'imax-config',
        JSON.stringify({ movie: selectedMovie, theater: selectedTheater, date: selectedDate })
      );
    }
  }, [selectedMovie, selectedTheater, selectedDate]);

  // 영화/극장 목록 로드
  useEffect(() => {
    setLoading(true);
    Promise.all([fetchMovies(), fetchTheaters()])
      .then(([m, t]) => {
        setMovies(m);
        setTheaters(t);
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const addLog = useCallback((msg) => {
    setLogs((prev) => [{ time: new Date().toLocaleTimeString('ko-KR'), msg }, ...prev].slice(0, 50));
  }, []);

  const checkOnce = useCallback(async () => {
    if (!selectedMovie || !selectedTheater || !selectedDate) return false;
    try {
      const data = await fetchShowtimes(selectedTheater, selectedMovie, selectedDate);
      if (hasImaxShowtime(data)) {
        const showtimes = getImaxShowtimes(data);
        const times = showtimes.map((s) => s.StartTime || s.PlayStartTime).join(', ');
        const movieName = movies.find((m) => m.MovieCode === selectedMovie)?.MovieName || selectedMovie;
        const theaterName =
          theaters.find((t) => t.TheaterCode === selectedTheater)?.TheaterName || selectedTheater;

        setFound({ movieName, theaterName, date: selectedDate, times, showtimes });
        addLog(`🎬 IMAX 예매 오픈! ${movieName} @ ${theaterName} (${times})`);
        notify(
          'IMAX 예매 오픈!',
          `${movieName} - ${theaterName}\n${selectedDate} ${times}`
        );
        return true;
      } else {
        addLog('확인 완료 - 아직 IMAX 상영 없음');
        return false;
      }
    } catch (e) {
      addLog(`오류: ${e.message}`);
      return false;
    }
  }, [selectedMovie, selectedTheater, selectedDate, movies, theaters, addLog, notify]);

  const startMonitoring = useCallback(async () => {
    if (permission !== 'granted') {
      const result = await requestPermission();
      if (result !== 'granted') {
        addLog('알림 권한이 필요합니다. 브라우저 설정에서 허용해주세요.');
        return;
      }
    }
    setMonitoring(true);
    setFound(null);
    addLog('모니터링 시작 (30초 간격)');

    const isFound = await checkOnce();
    if (isFound) {
      setMonitoring(false);
      return;
    }

    timerRef.current = setInterval(async () => {
      const isFound = await checkOnce();
      if (isFound) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        setMonitoring(false);
      }
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

  const filteredMovies = movies.filter((m) =>
    m.MovieName?.toLowerCase().includes(movieSearch.toLowerCase())
  );
  const filteredTheaters = theaters.filter((t) =>
    t.TheaterName?.includes(theaterSearch)
  );

  const selectedMovieName = movies.find((m) => m.MovieCode === selectedMovie)?.MovieName;
  const selectedTheaterName = theaters.find((t) => t.TheaterCode === selectedTheater)?.TheaterName;
  const selectedDateLabel = dates.find((d) => d.value === selectedDate)?.label;

  return (
    <div className="app">
      <header>
        <h1>IMAX 예매 알림</h1>
        <p className="subtitle">CGV IMAX 상영이 열리면 알려드립니다</p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {found && (
        <div className="found-banner">
          <div className="found-icon">🎬</div>
          <div>
            <strong>IMAX 예매가 열렸습니다!</strong>
            <p>
              {found.movieName} — {found.theaterName}
              <br />
              {found.date} {found.times}
            </p>
            <a
              href={`http://www.cgv.co.kr/ticket/?MOVIE_CD=${selectedMovie}&THEATER_CD=${selectedTheater}&PLAY_YMD=${selectedDate}`}
              target="_blank"
              rel="noopener noreferrer"
              className="book-btn"
            >
              지금 예매하기 →
            </a>
          </div>
        </div>
      )}

      <div className="config-grid">
        {/* 영화 선택 */}
        <section className="config-card">
          <h2>영화 선택</h2>
          {selectedMovieName && (
            <div className="selected-tag">
              {selectedMovieName}
              <button onClick={() => setSelectedMovie('')}>✕</button>
            </div>
          )}
          <input
            type="text"
            placeholder="영화 검색..."
            value={movieSearch}
            onChange={(e) => setMovieSearch(e.target.value)}
            className="search-input"
          />
          <ul className="select-list">
            {loading ? (
              <li className="loading">불러오는 중...</li>
            ) : (
              filteredMovies.map((m) => (
                <li
                  key={m.MovieCode}
                  className={selectedMovie === m.MovieCode ? 'active' : ''}
                  onClick={() => setSelectedMovie(m.MovieCode)}
                >
                  {m.MovieName}
                </li>
              ))
            )}
          </ul>
        </section>

        {/* 극장 선택 */}
        <section className="config-card">
          <h2>극장 선택 (IMAX)</h2>
          {selectedTheaterName && (
            <div className="selected-tag">
              {selectedTheaterName}
              <button onClick={() => setSelectedTheater('')}>✕</button>
            </div>
          )}
          <input
            type="text"
            placeholder="극장 검색..."
            value={theaterSearch}
            onChange={(e) => setTheaterSearch(e.target.value)}
            className="search-input"
          />
          <ul className="select-list">
            {loading ? (
              <li className="loading">불러오는 중...</li>
            ) : (
              filteredTheaters.map((t) => (
                <li
                  key={t.TheaterCode}
                  className={selectedTheater === t.TheaterCode ? 'active' : ''}
                  onClick={() => setSelectedTheater(t.TheaterCode)}
                >
                  {t.TheaterName}
                </li>
              ))
            )}
          </ul>
        </section>

        {/* 날짜 선택 */}
        <section className="config-card">
          <h2>날짜 선택</h2>
          {selectedDateLabel && (
            <div className="selected-tag">
              {selectedDateLabel}
              <button onClick={() => setSelectedDate('')}>✕</button>
            </div>
          )}
          <ul className="select-list date-list">
            {dates.map((d) => (
              <li
                key={d.value}
                className={selectedDate === d.value ? 'active' : ''}
                onClick={() => setSelectedDate(d.value)}
              >
                {d.label}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* 컨트롤 */}
      <div className="controls">
        {permission !== 'granted' && (
          <button onClick={requestPermission} className="btn btn-secondary">
            알림 권한 허용
          </button>
        )}
        {!monitoring ? (
          <button
            onClick={startMonitoring}
            disabled={!selectedMovie || !selectedTheater || !selectedDate}
            className="btn btn-primary"
          >
            모니터링 시작
          </button>
        ) : (
          <button onClick={stopMonitoring} className="btn btn-stop">
            모니터링 중지
          </button>
        )}
        {monitoring && <span className="pulse">● 모니터링 중...</span>}
      </div>

      {/* 로그 */}
      {logs.length > 0 && (
        <section className="log-section">
          <h2>활동 로그</h2>
          <ul className="log-list">
            {logs.map((l, i) => (
              <li key={i}>
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

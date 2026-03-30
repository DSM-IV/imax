const CGV_BASE = '/api/cgv';

// CGV 영화 목록 가져오기 (현재 상영 + 상영 예정)
export async function fetchMovies() {
  const res = await fetch(
    `${CGV_BASE}/common/showtimes/iframeBy498498498.aspx/GetMovieList`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paramList: {
          MethodName: 'GetMovieList',
          channelType: 'HO',
          osType: '',
          osVersion: '',
          multiLanguageID: 'KR',
        },
      }),
    }
  );
  if (!res.ok) throw new Error('영화 목록을 불러올 수 없습니다');
  const data = await res.json();
  return data?.d?.MovieList?.Items || [];
}

// CGV 극장 목록 가져오기
export async function fetchTheaters() {
  const res = await fetch(
    `${CGV_BASE}/common/showtimes/iframeBy498498498.aspx/GetTheaterList`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paramList: {
          MethodName: 'FilterTheaterList',
          channelType: 'HO',
          osType: '',
          osVersion: '',
          multiLanguageID: 'KR',
        },
      }),
    }
  );
  if (!res.ok) throw new Error('극장 목록을 불러올 수 없습니다');
  const data = await res.json();
  return data?.d?.TheaterList?.Items || [];
}

// 특정 극장+영화+날짜의 상영 시간표 조회
export async function fetchShowtimes(theaterCode, movieCode, date) {
  const res = await fetch(
    `${CGV_BASE}/common/showtimes/iframeBy498498498.aspx/GetShowtimeData`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paramList: {
          MethodName: 'GetShowtimeData',
          channelType: 'HO',
          osType: '',
          osVersion: '',
          multiLanguageID: 'KR',
          CinemaID: theaterCode,
          MovieCode: movieCode,
          ViewDate: date, // YYYYMMDD
        },
      }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.d;
}

// IMAX 상영 여부 확인
export function hasImaxShowtime(showtimeData) {
  if (!showtimeData) return false;
  const items = showtimeData?.ShowtimeList?.Items || [];
  return items.some(
    (item) =>
      item.ScreenName?.includes('IMAX') ||
      item.ScreenKindName?.includes('IMAX') ||
      item.TranslationKindName?.includes('IMAX')
  );
}

// IMAX 상영 정보만 필터링
export function getImaxShowtimes(showtimeData) {
  if (!showtimeData) return [];
  const items = showtimeData?.ShowtimeList?.Items || [];
  return items.filter(
    (item) =>
      item.ScreenName?.includes('IMAX') ||
      item.ScreenKindName?.includes('IMAX') ||
      item.TranslationKindName?.includes('IMAX')
  );
}

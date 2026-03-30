// CGV IMAX 극장 목록 (코드, 이름, 지역코드)
export const IMAX_THEATERS = [
  { code: '0013', name: 'CGV 용산아이파크몰', area: '01', type: 'IMAX 4K 레이저' },
  { code: '0074', name: 'CGV 왕십리', area: '01', type: 'IMAX 4K 레이저' },
  { code: '0056', name: 'CGV 강남', area: '01', type: 'IMAX' },
  { code: '0059', name: 'CGV 영등포', area: '01', type: 'IMAX 레이저' },
  { code: '0001', name: 'CGV 명동', area: '01', type: 'IMAX' },
  { code: '0229', name: 'CGV 여의도', area: '01', type: 'IMAX' },
  { code: '0014', name: 'CGV 건대입구', area: '01', type: 'IMAX' },
  { code: '0131', name: 'CGV 대구 이시아', area: '11', type: 'IMAX' },
  { code: '0247', name: 'CGV 연수역', area: '03', type: 'IMAX' },
  { code: '0070', name: 'CGV 수원', area: '02', type: 'IMAX' },
  { code: '0218', name: 'CGV 센텀시티', area: '05', type: 'IMAX' },
  { code: '0088', name: 'CGV 대전', area: '042', type: 'IMAX' },
  { code: '0216', name: 'CGV 광주터미널', area: '04', type: 'IMAX' },
  { code: '0055', name: 'CGV 청주(서문)', area: '12', type: 'IMAX' },
];

/**
 * CGV 상영시간표 HTML을 가져와서 파싱합니다.
 * iframeTheater.aspx 엔드포인트를 사용합니다.
 */
export async function fetchShowtimes(theaterCode, areaCode, date) {
  const url =
    `/api/cgv/common/showtimes/iframeTheater.aspx` +
    `?areacode=${areaCode}&theatercode=${theaterCode}&date=${date}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`CGV 응답 오류 (${res.status})`);

  const html = await res.text();
  return parseShowtimeHtml(html);
}

/**
 * 상영시간표 HTML을 파싱하여 영화별 상영 정보를 추출합니다.
 */
function parseShowtimeHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const movies = [];
  const movieItems = doc.querySelectorAll('.sect-showtimes > ul > li');

  for (const item of movieItems) {
    const titleEl = item.querySelector('.info-movie a strong');
    if (!titleEl) continue;

    const movieName = titleEl.textContent.trim();
    const halls = [];

    const hallInfos = item.querySelectorAll('.type-hall');
    for (const hall of hallInfos) {
      const hallNameEl = hall.querySelector('.info-hall li:first-child');
      const hallName = hallNameEl ? hallNameEl.textContent.trim() : '';

      const totalSeatsEl = hall.querySelector('.info-hall li:nth-child(2)');
      const totalSeats = totalSeatsEl ? totalSeatsEl.textContent.trim() : '';

      const isImax =
        hallName.toUpperCase().includes('IMAX') ||
        !!hall.querySelector('span.imax') ||
        !!hall.querySelector('.imax');

      const times = [];
      const timeLinks = hall.querySelectorAll('.info-timetable a');
      for (const link of timeLinks) {
        const timeEl = link.querySelector('em');
        const time = timeEl ? timeEl.textContent.trim() : '';

        // 잔여석 정보
        const remainEl = link.querySelector('.txt-info');
        const remain = remainEl ? remainEl.textContent.trim() : '';

        // 예매 링크
        const href = link.getAttribute('href') || '';

        if (time) {
          times.push({ time, remain, href, isSoldOut: link.classList.contains('soldout') });
        }
      }

      halls.push({ hallName, totalSeats, isImax, times });
    }

    movies.push({ movieName, halls });
  }

  return movies;
}

/**
 * 파싱된 상영 데이터에서 IMAX 상영 정보만 필터링합니다.
 */
export function filterImaxShowtimes(movies) {
  const results = [];
  for (const movie of movies) {
    const imaxHalls = movie.halls.filter((h) => h.isImax);
    if (imaxHalls.length > 0) {
      results.push({ movieName: movie.movieName, halls: imaxHalls });
    }
  }
  return results;
}

/**
 * 특정 영화의 IMAX 상영 여부를 확인합니다.
 * movieKeyword가 비어있으면 모든 IMAX 상영을 반환합니다.
 */
export function findImaxForMovie(movies, movieKeyword) {
  const imaxMovies = filterImaxShowtimes(movies);
  if (!movieKeyword) return imaxMovies;

  const keyword = movieKeyword.toLowerCase();
  return imaxMovies.filter((m) => m.movieName.toLowerCase().includes(keyword));
}

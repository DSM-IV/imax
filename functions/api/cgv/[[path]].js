// Cloudflare Pages Function — CGV 프록시
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const cgvPath = url.pathname.replace(/^\/api\/cgv/, '');
  const targetUrl = `http://www.cgv.co.kr${cgvPath}${url.search}`;

  const res = await fetch(targetUrl, {
    method: context.request.method,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'http://www.cgv.co.kr/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'text/html',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

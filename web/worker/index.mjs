const OWNER = "apoorvdarshan";
const REPOSITORY = "crossposter";
const CACHE_SECONDS = 6 * 60 * 60;
const ONE_DAY = 24 * 60 * 60 * 1000;

const THEMES = {
  dark: {
    background: "#0C120F",
    border: "#26362D",
    grid: "#24322A",
    text: "#F2F8F4",
    muted: "#91A398",
    icon: "#14251B",
  },
  light: {
    background: "#FBFEFC",
    border: "#D7E5DC",
    grid: "#DDEAE1",
    text: "#142019",
    muted: "#66786D",
    icon: "#ECF8F0",
  },
};

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/star-history.svg") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const themeName = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const cacheUrl = new URL(url);
    cacheUrl.search = `?theme=${themeName}&v=2`;
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cached = await caches.default.match(cacheKey);

    if (cached) {
      return request.method === "HEAD"
        ? new Response(null, { status: cached.status, headers: cached.headers })
        : cached;
    }

    try {
      const stars = await fetchStarHistory(env.GITHUB_TOKEN);
      const response = svgResponse(renderStarHistorySvg(stars, themeName), CACHE_SECONDS);
      context.waitUntil(caches.default.put(cacheKey, response.clone()));

      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    } catch (error) {
      console.error("Unable to render Crossposter star history", error);
      const response = svgResponse(renderErrorSvg(themeName), 60, 503);

      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
  },
};

export async function fetchStarHistory(token, fetchImplementation = fetch) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is not configured");
  }

  const stars = [];
  let page = 1;

  while (true) {
    const headers = {
      Accept: "application/vnd.github.star+json",
      "User-Agent": "crossposter-star-history",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    headers.Authorization = `Bearer ${token}`;

    const response = await fetchImplementation(
      `https://api.github.com/repos/${OWNER}/${REPOSITORY}/stargazers?per_page=100&page=${page}`,
      { headers },
    );

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }

    const payload = await response.json();

    if (!Array.isArray(payload)) {
      throw new Error("GitHub returned an unexpected response");
    }

    for (const item of payload) {
      if (typeof item?.starred_at === "string") {
        stars.push(item.starred_at);
      }
    }

    if (payload.length < 100) {
      break;
    }

    page += 1;

    if (page > 100) {
      throw new Error("Star history exceeded the pagination safety limit");
    }
  }

  return stars.sort((left, right) => left.localeCompare(right));
}

export function renderStarHistorySvg(starredAtValues, themeName = "light") {
  const theme = THEMES[themeName] ?? THEMES.light;
  const width = 960;
  const height = 520;
  const plot = { left: 76, top: 176, right: 904, bottom: 395 };
  const now = Date.now();
  const dates = starredAtValues
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const earliestStar = dates[0] ?? now;
  const rangeStart = Math.min(earliestStar - ONE_DAY, now - 30 * ONE_DAY);
  const rangeEnd = Math.max(now, rangeStart + ONE_DAY);
  const yMaximum = niceMaximum(Math.max(dates.length, 1));
  const x = (timestamp) =>
    plot.left +
    ((timestamp - rangeStart) / (rangeEnd - rangeStart)) *
      (plot.right - plot.left);
  const y = (count) =>
    plot.bottom - (count / yMaximum) * (plot.bottom - plot.top);
  const points = cumulativeSamples(dates, rangeStart, rangeEnd, 48).map(
    ([timestamp, count]) => [x(timestamp), y(count)],
  );
  const linePath = curvePath(points);
  const areaPath = `${linePath} L${plot.right} ${plot.bottom} L${plot.left} ${plot.bottom} Z`;
  const yTicks = tickValues(yMaximum, 6);
  const xTicks = dateTicks(rangeStart, rangeEnd, 4);
  const currentStars = dates.length;
  const currentY = y(currentStars);
  const yGrid = yTicks
    .map((value) => {
      const position = y(value);
      return `<line x1="${plot.left}" y1="${position}" x2="${plot.right}" y2="${position}" class="grid" />
      <text x="${plot.left - 16}" y="${position + 5}" text-anchor="end" class="axis">${value}</text>`;
    })
    .join("");
  const xLabels = xTicks
    .map((timestamp, index) => {
      const anchor = index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle";
      return `<text x="${x(timestamp)}" y="${plot.bottom + 38}" text-anchor="${anchor}" class="axis">${formatDate(timestamp, rangeEnd - rangeStart)}</text>`;
    })
    .join("");
  const deliveries = [0.28, 0.54, 0.78]
    .map((ratio, index) => {
      const point = points[Math.round((points.length - 1) * ratio)];
      const direction = index % 2 === 0 ? -1 : 1;
      return `<g transform="translate(${point[0]} ${point[1]}) rotate(${direction * 7})" filter="url(#soft-sketch)">
        <path d="M-3 -4 L17 -13 L10 7 L4 1 L-3 -4 Z" fill="${theme.background}" stroke="#28C76F" stroke-width="2" stroke-linejoin="round"/>
        <path d="M4 1 L15 -11" stroke="#28C76F" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="18" cy="-13" r="5.5" fill="#28C76F" stroke="${theme.background}" stroke-width="2"/>
        <path d="M15.5 -13 L17.2 -11.2 L20.8 -15.3" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
    })
    .join("");
  const dark = themeName === "dark";
  const panel = dark ? "#121A15" : "#FFFFFF";
  const ink = dark ? "#F2FFF6" : "#15221A";
  const softGreen = dark ? "#92F4B9" : "#159653";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Crossposter GitHub star history</title>
  <desc id="description">${currentStars} GitHub stars over time for ${OWNER}/${REPOSITORY}.</desc>
  <defs>
    <linearGradient id="line-gradient" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#0EA85A"/><stop offset="55%" stop-color="#28C76F"/><stop offset="100%" stop-color="#8AF0B3"/></linearGradient>
    <linearGradient id="area-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#28C76F" stop-opacity="0.34"/><stop offset="100%" stop-color="#28C76F" stop-opacity="0.02"/>
    </linearGradient>
    <pattern id="route-dots" width="23" height="23" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r=".85" fill="${theme.grid}" opacity=".38"/></pattern>
    <filter id="soft-sketch" x="-35%" y="-35%" width="170%" height="170%"><feTurbulence type="fractalNoise" baseFrequency=".025" numOctaves="2" seed="13" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale=".8"/></filter>
    <filter id="green-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="plot-clip"><rect x="${plot.left}" y="${plot.top - 20}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top + 20}"/></clipPath>
    <style>
      .axis{fill:${theme.muted};font:600 13px 'Trebuchet MS',sans-serif}.grid{stroke:${theme.grid};stroke-width:1.2;stroke-dasharray:4 8;stroke-linecap:round}.rounded{fill:${ink};font:800 25px ui-rounded,'Arial Rounded MT Bold','Trebuchet MS',sans-serif}.muted{fill:${theme.muted};font:600 13.5px 'Trebuchet MS',sans-serif}.chip{fill:${theme.muted};font:800 11px ui-rounded,'Arial Rounded MT Bold',sans-serif}
    </style>
  </defs>
  <rect width="960" height="520" rx="29" fill="${theme.background}"/>
  <rect x="16" y="16" width="928" height="488" rx="26" fill="${panel}" stroke="${theme.border}" stroke-width="1.5"/>
  <rect x="27" y="27" width="906" height="466" rx="20" fill="url(#route-dots)" stroke="${theme.border}" stroke-dasharray="7 8" opacity=".9"/>
  <g transform="translate(46 35)" filter="url(#soft-sketch)">
    <rect x="13" y="13" width="25" height="25" rx="8" fill="#28C76F"/>
    <path d="M15 16 L3 4 M3 4 H12 M3 4 V13 M36 16 L48 4 M48 4 H39 M48 4 V13 M15 36 L3 48 M3 48 H12 M3 48 V39 M36 36 L48 48 M48 48 H39 M48 48 V39" fill="none" stroke="${ink}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="113" y="55" class="rounded">Crossposter is spreading!</text>
  <text x="114" y="79" class="muted">Every star sends this tiny publisher a little farther.</text>
  <g transform="translate(746 35)" filter="url(#soft-sketch)"><path d="M17 0 H125 Q141 0 141 16 V38 Q141 52 125 52 H17 Q0 52 0 35 V17 Q0 0 17 0Z" fill="${dark ? "#153823" : "#E9FAEF"}" stroke="#28C76F" stroke-width="1.5" stroke-dasharray="6 4"/><path d="M25 12 L29 21 L39 22 L31 29 L33 39 L25 34 L16 39 L19 29 L11 22 L21 21Z" fill="#FFD166" filter="url(#green-glow)"/><text x="49" y="34" fill="${ink}" font-family="ui-rounded,'Arial Rounded MT Bold',sans-serif" font-size="21" font-weight="800">${currentStars}</text><text x="100" y="32" class="chip">STARS</text></g>
  <path d="M460 112 C390 126 343 116 304 137 M500 112 C570 126 617 116 656 137" fill="none" stroke="#28C76F" stroke-width="1.7" stroke-dasharray="5 7" opacity=".45"/>
  <g transform="translate(282 128)"><rect width="44" height="25" rx="9" fill="${theme.icon}" stroke="${theme.border}"/><text x="22" y="17" text-anchor="middle" class="chip">X</text></g>
  <g transform="translate(338 119)"><rect width="44" height="25" rx="9" fill="${theme.icon}" stroke="${theme.border}"/><text x="22" y="17" text-anchor="middle" class="chip">in</text></g>
  <g transform="translate(394 113)"><rect width="44" height="25" rx="9" fill="${theme.icon}" stroke="${theme.border}"/><text x="22" y="17" text-anchor="middle" class="chip">B</text></g>
  <g transform="translate(522 113)"><rect width="44" height="25" rx="9" fill="${theme.icon}" stroke="${theme.border}"/><text x="22" y="17" text-anchor="middle" class="chip">M</text></g>
  <g transform="translate(578 119)"><rect width="44" height="25" rx="9" fill="${theme.icon}" stroke="${theme.border}"/><text x="22" y="17" text-anchor="middle" class="chip">▶</text></g>
  <g transform="translate(634 128)"><rect width="44" height="25" rx="9" fill="${theme.icon}" stroke="${theme.border}"/><text x="22" y="17" text-anchor="middle" class="chip">N</text></g>
  ${yGrid}
  ${xLabels}
  <g clip-path="url(#plot-clip)"><path d="${areaPath}" fill="url(#area-gradient)"/><path d="${linePath}" fill="none" stroke="#28C76F" stroke-width="8" opacity=".13"/><path d="${linePath}" fill="none" stroke="url(#line-gradient)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#soft-sketch)"/></g>
  ${deliveries}
  <g transform="translate(${plot.right} ${currentY})" filter="url(#soft-sketch)"><circle r="8" fill="#28C76F" stroke="${panel}" stroke-width="3"/><path d="M2 -8 L8 -17 L6 -8 L14 -10 L6 -4" fill="#FFD166" stroke="#FFD166" stroke-linejoin="round"/></g>
  <g transform="translate(61 456)" opacity=".72" filter="url(#soft-sketch)"><path d="M0 10 H31 M5 3 L0 10 L5 17 M26 3 L31 10 L26 17" fill="none" stroke="${softGreen}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><text x="42" y="15" class="muted">compose once</text></g>
  <g transform="translate(754 454)" opacity=".72" filter="url(#soft-sketch)"><path d="M1 14 C12 2 21 2 32 14 C43 26 52 26 63 14" fill="none" stroke="${softGreen}" stroke-width="2.2" stroke-linecap="round"/><circle cx="1" cy="14" r="3" fill="#28C76F"/><circle cx="63" cy="14" r="3" fill="#28C76F"/></g>
</svg>`;
}

export function niceMaximum(value) {
  if (value <= 5) return 5;
  if (value <= 10) return 10;
  if (value <= 20) return Math.ceil(value / 5) * 5;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const step = magnitude * (fraction <= 1.25 ? 0.25 : 0.5);
  return Math.ceil(value / step) * step;
}

function curvePath(points) {
  if (points.length === 0) return "";

  return points.reduce((path, [x, y], index) => {
    if (index === 0) return `M${x.toFixed(2)} ${y.toFixed(2)}`;

    const [previousX, previousY] = points[index - 1];
    const controlX = (previousX + x) / 2;
    return `${path} C${controlX.toFixed(2)} ${previousY.toFixed(2)} ${controlX.toFixed(2)} ${y.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }, "");
}

function cumulativeSamples(stars, start, end, count) {
  let starIndex = 0;

  return dateTicks(start, end, count).map((timestamp) => {
    while (starIndex < stars.length && stars[starIndex] <= timestamp) {
      starIndex += 1;
    }
    return [timestamp, starIndex];
  });
}

function tickValues(maximum, count) {
  return Array.from({ length: count }, (_, index) =>
    Math.round((maximum / (count - 1)) * index),
  );
}

function dateTicks(start, end, count) {
  return Array.from(
    { length: count },
    (_, index) => start + ((end - start) / (count - 1)) * index,
  );
}

function formatDate(timestamp, range) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    ...(range >= 365 * ONE_DAY ? { year: "numeric" } : { day: "numeric" }),
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function svgResponse(svg, cacheSeconds, status = 200) {
  return new Response(svg, {
    status,
    headers: {
      "Cache-Control": `public, max-age=3600, s-maxage=${cacheSeconds}, stale-if-error=86400`,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function renderErrorSvg(themeName) {
  const theme = THEMES[themeName] ?? THEMES.light;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="180" viewBox="0 0 960 180" role="img" aria-label="Star history is temporarily unavailable">
  <rect x="0.5" y="0.5" width="959" height="179" rx="12" fill="${theme.background}" stroke="${theme.border}" />
  <text x="48" y="78" fill="${theme.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="650">Star history is refreshing</text>
  <text x="48" y="116" fill="${theme.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="17">The cached chart will return shortly.</text>
</svg>`;
}

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
    cacheUrl.search = `?theme=${themeName}&v=1`;
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
  const plot = { left: 76, top: 138, right: 904, bottom: 424 };
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Crossposter GitHub star history</title>
  <desc id="description">${currentStars} GitHub stars over time for ${OWNER}/${REPOSITORY}.</desc>
  <defs>
    <linearGradient id="line-gradient" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#19A95B" />
      <stop offset="55%" stop-color="#28C76F" />
      <stop offset="100%" stop-color="#71E6A2" />
    </linearGradient>
    <linearGradient id="area-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#28C76F" stop-opacity="0.28" />
      <stop offset="100%" stop-color="#28C76F" stop-opacity="0" />
    </linearGradient>
    <radialGradient id="ambient-glow" cx="82%" cy="14%" r="72%">
      <stop offset="0%" stop-color="#28C76F" stop-opacity="${themeName === "dark" ? "0.12" : "0.07"}" />
      <stop offset="100%" stop-color="#28C76F" stop-opacity="0" />
    </radialGradient>
    <clipPath id="plot-clip">
      <rect x="${plot.left}" y="${plot.top - 12}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top + 12}" />
    </clipPath>
    <style>
      .axis { fill: ${theme.muted}; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .grid { stroke: ${theme.grid}; stroke-width: 1; stroke-dasharray: 2 8; stroke-linecap: round; }
      .label { fill: ${theme.text}; font: 700 17px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .muted { fill: ${theme.muted}; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .eyebrow { fill: ${theme.muted}; font: 650 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 1.8px; }
    </style>
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="20" fill="${theme.background}" stroke="${theme.border}" />
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="19" fill="url(#ambient-glow)" />
  <g transform="translate(42 32)">
    <rect width="48" height="48" rx="14" fill="${theme.icon}" stroke="${theme.border}" />
    <path d="M13 16h22M13 24h16M13 32h22" fill="none" stroke="#28C76F" stroke-width="3.5" stroke-linecap="round" />
    <path d="M32 21l6 3-6 3z" fill="#71E6A2" />
  </g>
  <text x="108" y="50" class="label">${OWNER}/${REPOSITORY}</text>
  <text x="108" y="72" class="muted">Compose once. Publish everywhere.</text>
  <text x="${plot.right}" y="41" text-anchor="end" class="eyebrow">CURRENT</text>
  <text x="${plot.right}" y="76" text-anchor="end" fill="${theme.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="34" font-weight="730">${currentStars}<tspan dx="8" fill="${theme.muted}" font-size="15" font-weight="550">STARS</tspan></text>
  <line x1="${plot.left}" y1="106" x2="${plot.right}" y2="106" stroke="${theme.border}" />
  ${yGrid}
  ${xLabels}
  <g clip-path="url(#plot-clip)">
    <path d="${areaPath}" fill="url(#area-gradient)" />
    <path d="${linePath}" fill="none" stroke="url(#line-gradient)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" />
  </g>
  <circle cx="${plot.right}" cy="${currentY}" r="10" fill="#28C76F" opacity="0.16" />
  <circle cx="${plot.right}" cy="${currentY}" r="6" fill="#28C76F" stroke="${theme.background}" stroke-width="3" />
  <line x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}" stroke="${theme.border}" />
</svg>`;
}

export function niceMaximum(value) {
  if (value <= 5) return 5;

  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const niceFraction = [1, 1.25, 2, 2.5, 5, 10].find(
    (candidate) => candidate >= fraction,
  );

  return niceFraction * exponent;
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

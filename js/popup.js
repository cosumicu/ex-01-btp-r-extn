const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const WINDOW_DAYS = 28;
const MIN_POST_AGE_HOURS = 48;
const MAX_PAGES = 10;
const MIN_POSTS_PER_SLOT = 5;
const HOUR_MS = 60 * 60 * 1000;

let subreddit = "";
let chart = null;

/* ------------------------ Heatmap scaling helpers ------------------------ */
const EPS = 0.0001;

const nonZero = (stats) =>
  stats.flat().filter((v) => Number.isFinite(v) && v > 0);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function buildRanges(stats) {
  const values = nonZero(stats);
  if (!values.length)
    return [{ from: 0, to: 0, color: "#f0f0f0", name: "No data" }];

  const p25 = percentile(values, 0.25);
  const p50 = percentile(values, 0.5);
  const p75 = percentile(values, 0.75);
  const p95 = percentile(values, 0.95);

  const a = Math.max(0, p25);
  const b = Math.max(a + EPS, p50);
  const c = Math.max(b + EPS, p75);
  const d = Math.max(c + EPS, p95);

  return [
    { from: 0, to: a, color: "#f0f0f0", name: "Low" },
    { from: a, to: b, color: "#FEC5F6", name: "Medium" },
    { from: b, to: c, color: "#DB8DD0", name: "High" },
    { from: c, to: d, color: "#C562AF", name: "Very High" },
    { from: d, to: Number.MAX_SAFE_INTEGER, color: "#B33791", name: "Top" },
  ];
}
/* ------------------------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", init);

function init() {
  detectSubreddit();
  document.getElementById("analyzeBtn").addEventListener("click", onAnalyze);
}

function detectSubreddit() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs?.[0]?.url || "";
    const el = document.getElementById("subreddit");
    const btn = document.getElementById("analyzeBtn");

    let name = "";
    try {
      const page = new URL(url);
      if (["www.reddit.com", "old.reddit.com", "reddit.com"].includes(page.hostname)) {
        const match = page.pathname.match(/^\/r\/([A-Za-z0-9_]+)(?:\/|$)/i);
        name = match?.[1] || "";
      }
    } catch (_) {
      // The active tab may not have a readable URL.
    }
    if (!name) {
      el.textContent = "Not a subreddit page";
      btn.disabled = true;
      return;
    }

    subreddit = name;
    el.textContent = `r/${subreddit}`;
    btn.disabled = false;
  });
}

async function onAnalyze() {
  if (!subreddit) return alert("No subreddit detected!");

  const analyzeBtn = document.getElementById("analyzeBtn");
  const loading = document.getElementById("loading");
  const results = document.getElementById("results");
  const heatmapContainer = document.getElementById("heatmap-container");

  analyzeBtn.disabled = true;
  loading.style.display = "block";
  results.textContent = "";
  heatmapContainer.style.display = "none";

  try {
    const sample = await fetchPosts(subreddit);
    const analysis = analyze(sample);
    await renderHeatmap(analysis);
    heatmapContainer.style.display = "block";
  } catch (err) {
    results.textContent = `Error: ${err?.message || String(err)}`;
  } finally {
    analyzeBtn.disabled = false;
    loading.style.display = "none";
  }
}

/* ---------------------------- Reddit fetching ---------------------------- */
async function fetchPosts(subreddit, { nowMs = Date.now(), pages = MAX_PAGES } = {}) {
  const windowStartMs = nowMs - WINDOW_DAYS * 24 * HOUR_MS;
  const windowEndMs = nowMs - MIN_POST_AGE_HOURS * HOUR_MS;
  const posts = [];
  const seen = new Set();
  let after = null;
  let coverageComplete = false;

  for (let i = 0; i < pages; i++) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);

    const res = await fetch(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?${params}`);

    if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data?.data?.children)) throw new Error("Unexpected Reddit response.");
    const children = data.data.children;
    let reachedWindowStart = false;
    for (const child of children) {
      const post = child?.data;
      const createdMs = post?.created_utc * 1000;
      if (!Number.isFinite(createdMs)) continue;
      if (createdMs < windowStartMs) {
        reachedWindowStart = true;
        continue;
      }
      if (createdMs > windowEndMs || post.stickied || !Number.isFinite(post.score)) continue;
      if (post.id && seen.has(post.id)) continue;
      if (post.id) seen.add(post.id);
      posts.push(post);
    }

    after = data?.data?.after;
    if (reachedWindowStart || !after || children.length === 0) {
      // A full final page may be a listing cap rather than the end of the subreddit.
      coverageComplete = reachedWindowStart || (!after && children.length < 100);
      break;
    }
  }

  return { posts, coverageComplete, windowStartMs, windowEndMs };
}
/* ------------------------------------------------------------------------ */

/* ------------------------------- Analysis -------------------------------- */
function analyze({ posts, coverageComplete, windowStartMs, windowEndMs }) {
  const buckets = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ scoreTotal: 0, count: 0 })),
  );

  posts.forEach((post) => {
    const dt = new Date(post.created_utc * 1000);
    const day = dt.getUTCDay() === 0 ? 6 : dt.getUTCDay() - 1; // Monday=0 ... Sunday=6
    const hour = dt.getUTCHours();

    buckets[day][hour].scoreTotal += post.score;
    buckets[day][hour].count += 1;
  });

  let bestDay = null;
  let bestHour = null;
  let maxAvg = -Infinity;

  const stats = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      const { scoreTotal, count } = buckets[day][hour];
      const avg = count ? scoreTotal / count : null;

      if (coverageComplete && count >= MIN_POSTS_PER_SLOT && avg > maxAvg) {
        maxAvg = avg;
        bestDay = day;
        bestHour = hour;
      }
      return avg;
    }),
  );

  return {
    stats,
    counts: buckets.map((day) => day.map((slot) => slot.count)),
    bestDay,
    bestHour,
    maxAvg,
    totalPosts: posts.length,
    oldestPostMs: posts.length ? Math.min(...posts.map((p) => p.created_utc * 1000)) : null,
    newestPostMs: posts.length ? Math.max(...posts.map((p) => p.created_utc * 1000)) : null,
    coverageComplete,
    windowStartMs,
    windowEndMs,
  };
}
/* ------------------------------------------------------------------------ */

/* ------------------------------- Render ---------------------------------- */
async function renderHeatmap({
  stats, counts, bestDay, bestHour, maxAvg, totalPosts,
  oldestPostMs, newestPostMs, coverageComplete, windowStartMs, windowEndMs,
}) {
  const bestTimeInfo = document.getElementById("bestTimeInfo");

  const ranges = buildRanges(stats);

  const series = DAY_ABBR.map((day, dayIndex) => ({
    name: day,
    data: HOURS.map((hour) => ({
      x: `${hour.toString().padStart(2, "0")}:00`,
      y: stats[dayIndex][hour] ?? 0,
    })),
  }));

  if (chart) chart.destroy();

  const options = {
    series,
    chart: {
      height: 275,
      type: "heatmap",
      toolbar: { show: false },
      animations: { enabled: true, speed: 800 },
    },
    dataLabels: { enabled: false },

    plotOptions: {
      heatmap: {
        radius: 4,
        enableShades: false,
        shadeIntensity: 0,
        colorScale: { ranges },
      },
    },

    xaxis: {
      type: "category",
      categories: HOURS.map((hour) => `${String(hour).padStart(2, "0")}:00`),
      labels: {
        style: { fontSize: "10px", colors: "#000" },
      },
      title: {
        text: "Hour (UTC)",
        style: { fontSize: "12px", fontWeight: 600, color: "#000" },
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },

    yaxis: {
      labels: {
        style: { fontSize: "12px", fontWeight: 600, colors: "#000" },
      },
    },

    grid: { show: false },

    tooltip: {
      custom: ({ seriesIndex, dataPointIndex }) => {
        const day = DAY_NAMES[seriesIndex];
        const hour = HOURS[dataPointIndex];
        const count = counts[seriesIndex][dataPointIndex];
        const value = stats[seriesIndex][dataPointIndex];
        return `
          <div class="heatmap-tooltip">
            <div class="tooltip-header">${day} ${hour.toString().padStart(2, "0")}:00 UTC</div>
            <div class="tooltip-value">Average score: ${count ? value.toFixed(2) : "No data"}</div>
            <div>Posts: ${count}</div>
          </div>
        `;
      },
    },

    title: {
      text: "Best Time to Post - Heatmap",
      align: "center",
      style: { fontSize: "16px", fontWeight: 600, color: "#000" },
    },

    subtitle: {
      text: "Average score by day and hour (UTC); hover for post count",
      align: "center",
      style: { fontSize: "12px", color: "#000" },
    },
  };

  if (typeof ApexCharts === "undefined") {
    throw new Error("Chart library failed to load.");
  }

  chart = new ApexCharts(document.querySelector("#heatmap-chart"), options);
  await chart.render();

  renderHourlyTable(stats, counts);
  const actualRange = oldestPostMs === null
    ? "No eligible posts fetched"
    : `${formatUtc(oldestPostMs)} to ${formatUtc(newestPostMs)}`;
  let recommendation;
  if (!coverageComplete) {
    recommendation = "No recommendation: the available listing did not cover the full 28-day window.";
  } else if (bestDay === null) {
    recommendation = `No recommendation: fewer than ${MIN_POSTS_PER_SLOT} posts in every day/hour slot.`;
  } else {
    recommendation = `Best among sampled recent posts: ${DAY_NAMES[bestDay]} at ${String(bestHour).padStart(2, "0")}:00 UTC (${maxAvg.toFixed(2)} average score from ${counts[bestDay][bestHour]} posts).`;
  }
  bestTimeInfo.textContent = [
    recommendation,
    `Posts analyzed: ${totalPosts.toLocaleString()}`,
    `Window: ${WINDOW_DAYS} days, excluding posts newer than ${MIN_POST_AGE_HOURS} hours (${formatUtc(windowStartMs)} to ${formatUtc(windowEndMs)}).`,
    `Actual post dates: ${actualRange}.`,
    coverageComplete
      ? "Sampled from the new listing; posting time does not prove causation."
      : "Partial sample: high activity can exhaust the accessible listing before the full window is covered.",
  ].join("\n");
}

function formatUtc(timestamp) {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function renderHourlyTable(stats, counts) {
  const body = document.getElementById("hourly-table-body");
  body.replaceChildren();
  HOURS.forEach((hour) => {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = `${String(hour).padStart(2, "0")}:00`;
    row.appendChild(heading);
    DAY_NAMES.forEach((_, day) => {
      const cell = document.createElement("td");
      const count = counts[day][hour];
      cell.textContent = count ? `${stats[day][hour].toFixed(1)} · ${count}` : "— · 0";
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
}
/* ------------------------------------------------------------------------ */

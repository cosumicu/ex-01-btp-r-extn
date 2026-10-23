// popup.js (rewritten + cleaner + correct Reddit pagination)

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

let subreddit = "";
let chart = null;
let commentsChart = null;

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
    { from: a, to: b, color: "#f7c4c4", name: "Medium" },
    { from: b, to: c, color: "#e98e8e", name: "High" },
    { from: c, to: d, color: "#d45152", name: "Very High" },
    { from: d, to: Number.MAX_SAFE_INTEGER, color: "#b31718", name: "Top" },
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

    const match = url.match(/reddit\.com\/r\/([^/]+)/i);
    if (!match) {
      el.textContent = "Not a subreddit page";
      btn.disabled = true;
      return;
    }

    subreddit = match[1];
    el.textContent = `r/${subreddit}`;
    btn.disabled = false;
  });
}

async function onAnalyze() {
  if (!subreddit) return alert("No subreddit detected!");

  const analyzeBtn = document.getElementById("analyzeBtn");
  const analyzeBtnLabel = document.getElementById("analyzeBtnLabel");
  const spinner = analyzeBtn.querySelector(".button-spinner");
  const results = document.getElementById("results");
  const heatmapContainer = document.getElementById("heatmap-container");
  const evidenceCards = document.getElementById("evidence-cards");
  const commentsChartContainer = document.getElementById("comments-chart-container");

  setLoading(true);

  try {
    // ✅ Better: use /top.json with limit=100 + after pagination
    const posts = await fetchPosts(subreddit, {
      pages: 6,
      sort: "top",
      t: "year",
    });

    const analysis = analyze(posts);
    heatmapContainer.style.display = "block";
    commentsChartContainer.style.display = "block";
    renderHeatmap(analysis);
    renderEvidenceCards(posts, analysis);
    renderCommentsAreaChart(posts);
  } catch (err) {
    heatmapContainer.style.display = "none";
    evidenceCards.style.display = "none";
    commentsChartContainer.style.display = "none";
    results.textContent = `Error: ${err?.message || String(err)}`;
  } finally {
    setLoading(false);
  }

  function setLoading(isLoading) {
    analyzeBtn.disabled = isLoading;
    analyzeBtn.setAttribute("aria-busy", String(isLoading));
    analyzeBtnLabel.textContent = isLoading ? "Analyzing..." : "Analyze";
    spinner.hidden = !isLoading;
    if (isLoading) results.textContent = "";
    if (isLoading) {
      heatmapContainer.style.display = "none";
      evidenceCards.style.display = "none";
      commentsChartContainer.style.display = "none";
    }
  }
}

/* ---------------------------- Reddit fetching ---------------------------- */
async function fetchPosts(
  subreddit,
  { pages = 5, sort = "top", t = "year" } = {},
) {
  let posts = [];
  let after = null;

  for (let i = 0; i < pages; i++) {
    const base = `https://www.reddit.com/r/${subreddit}/${sort}.json`;

    const params = new URLSearchParams({ limit: "100" });
    if (sort === "top") params.set("t", t);
    if (after) params.set("after", after);

    const res = await fetch(`${base}?${params.toString()}`, {
      headers: { "User-Agent": "RedditTimingAnalyzer/1.0" },
    });

    if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status}`);

    const data = await res.json();
    const children = data?.data?.children || [];
    posts.push(...children);

    after = data?.data?.after;
    if (!after) break;
  }

  if (!posts.length)
    throw new Error("No posts found or subreddit doesn't exist.");
  return posts;
}
/* ------------------------------------------------------------------------ */

function renderEvidenceCards(posts, { bestDay, bestHour, alternativeTime }) {
  const matchingPosts = posts
    .map(({ data }) => data)
    .filter((data) => {
      const date = new Date(data.created_utc * 1000);
      const day = (date.getUTCDay() + 6) % 7;
      return day === bestDay && date.getUTCHours() === bestHour;
    });
  const scores = matchingPosts
    .map((data) => data.score)
    .filter(Number.isFinite);
  const comments = matchingPosts
    .map((data) => data.num_comments)
    .filter(Number.isFinite);
  const formatMedian = (values) =>
    values.length >= 3
      ? percentile(values, 0.5).toLocaleString(undefined, { maximumFractionDigits: 1 })
      : "—";

  document.getElementById("slot-post-count").textContent =
    matchingPosts.length.toLocaleString();
  document.getElementById("slot-median-score").textContent =
    formatMedian(scores);
  document.getElementById("slot-median-comments").textContent =
    formatMedian(comments);
  document.getElementById("slot-score-note").hidden = scores.length >= 3;
  document.getElementById("slot-comments-note").hidden = comments.length >= 3;
  document.getElementById("alternative-time").textContent = alternativeTime
    ? `${DAY_ABBR[alternativeTime.day]} · ${alternativeTime.hour.toString().padStart(2, "0")}:00 UTC`
    : "Unavailable";
  document.getElementById("alternative-post-count").textContent = alternativeTime
    ? `Based on ${alternativeTime.count.toLocaleString()} ${alternativeTime.count === 1 ? "post" : "posts"}`
    : "No other supported time";
  document.getElementById("evidence-cards").style.display = "grid";
}

function buildHourlyCommentMedians(posts) {
  const commentsByHour = Array.from({ length: 24 }, () => []);

  posts.forEach(({ data }) => {
    const hour = new Date(data.created_utc * 1000).getUTCHours();
    const comments = data.num_comments;
    if (Number.isInteger(hour) && Number.isFinite(comments) && comments >= 0) {
      commentsByHour[hour].push(comments);
    }
  });

  return {
    medians: commentsByHour.map((values) =>
      values.length ? percentile(values, 0.5) : null,
    ),
    counts: commentsByHour.map((values) => values.length),
  };
}

function renderCommentsAreaChart(posts) {
  const { medians, counts } = buildHourlyCommentMedians(posts);

  if (commentsChart) commentsChart.destroy();

  commentsChart = new ApexCharts(document.querySelector("#comments-chart"), {
    series: [{ name: "Median comments", data: medians }],
    chart: {
      height: 235,
      type: "area",
      fontFamily: "Inter, sans-serif",
      toolbar: { show: false },
      animations: { enabled: false },
      zoom: { enabled: false },
    },
    colors: ["#b31718"],
    dataLabels: { enabled: false },
    stroke: { curve: "smooth", width: 2 },
    fill: {
      type: "gradient",
      gradient: {
        type: "vertical",
        shadeIntensity: 0,
        inverseColors: false,
        opacityFrom: 0.55,
        opacityTo: 0.14,
        stops: [0, 100],
      },
    },
    markers: { size: 0, hover: { size: 5 } },
    legend: { show: false },
    grid: { borderColor: "#eceff2", strokeDashArray: 3 },
    xaxis: {
      categories: HOURS.map(String),
      labels: {
        formatter: (value) => (Number(value) % 4 === 0 ? value : ""),
        style: { fontSize: "10px", colors: "#667085" },
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
      title: {
        text: "Posting hour (UTC)",
        style: { fontSize: "11px", fontWeight: 500, color: "#667085" },
      },
      tooltip: { enabled: false },
    },
    yaxis: {
      min: 0,
      tickAmount: 4,
      labels: {
        formatter: (value) => Math.round(value).toLocaleString(),
        style: { fontSize: "10px", colors: "#667085" },
      },
    },
    tooltip: {
      custom: ({ dataPointIndex }) => {
        if (dataPointIndex < 0) return "";
        const median = medians[dataPointIndex];
        const count = counts[dataPointIndex];
        return `
          <div class="heatmap-tooltip">
            <div class="tooltip-header">${HOURS[dataPointIndex].toString().padStart(2, "0")}:00 UTC</div>
            <div class="tooltip-value">Median comments: ${median === null ? "No data" : median.toLocaleString()}</div>
            <div class="tooltip-meta">${count} top ${count === 1 ? "post" : "posts"}</div>
          </div>
        `;
      },
    },
    title: {
      text: "Discussion by Posting Hour",
      align: "center",
      style: { fontSize: "16px", fontWeight: 600, color: "#000" },
    },
    subtitle: {
      text: "Median current comments on top posts (past year)",
      align: "center",
      style: { fontSize: "12px", color: "#000" },
    },
    noData: { text: "No comment data available" },
  });

  commentsChart.render();
}

/* ------------------------------- Analysis -------------------------------- */
function analyze(posts) {
  const buckets = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ scoreTotal: 0, count: 0 })),
  );

  posts.forEach(({ data }) => {
    const dt = new Date(data.created_utc * 1000);
    const day = dt.getUTCDay() === 0 ? 6 : dt.getUTCDay() - 1; // Monday=0 ... Sunday=6
    const hour = dt.getUTCHours();

    buckets[day][hour].scoreTotal += data.score;
    buckets[day][hour].count += 1;
  });

  // Prefer a time supported by at least three posts when the sample allows it.
  const minimumCount = [3, 2, 1].find((threshold) =>
    buckets.some((row) => row.some(({ count }) => count >= threshold)),
  );
  const eligibleSlots = [];

  const stats = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      const { scoreTotal, count } = buckets[day][hour];
      const avg = count ? scoreTotal / count : 0;

      if (count >= minimumCount) eligibleSlots.push({ day, hour, avg, count });
      return avg;
    }),
  );

  eligibleSlots.sort(
    (a, b) => b.avg - a.avg || b.count - a.count || a.day - b.day || a.hour - b.hour,
  );
  const [bestTime, alternativeTime] = eligibleSlots;

  return {
    stats,
    bestDay: bestTime.day,
    bestHour: bestTime.hour,
    maxAvg: bestTime.avg,
    alternativeTime,
    totalPosts: posts.length,
  };
}
/* ------------------------------------------------------------------------ */

/* ------------------------------- Render ---------------------------------- */
function squareHeatmapCells() {
  document
    .querySelectorAll("#heatmap-chart .apexcharts-heatmap-rect")
    .forEach((cell) => cell.setAttribute("height", cell.getAttribute("width")));
}

function renderHeatmap({ stats, bestDay, bestHour, maxAvg, totalPosts }) {
  const results = document.getElementById("results");
  const bestTimeInfo = document.getElementById("bestTimeInfo");

  results.innerHTML = "";

  const ranges = buildRanges(stats);

  const series = DAY_ABBR.map((day, dayIndex) => ({
    name: day,
    data: HOURS.map((hour) => ({
      x: `${hour.toString().padStart(2, "0")}:00`,
      y: stats[dayIndex][hour],
    })),
  }));

  if (chart) chart.destroy();

  const options = {
    series,
    chart: {
      height: 262,
      type: "heatmap",
      fontFamily: "Inter, sans-serif",
      toolbar: { show: false },
      animations: { enabled: false },
      events: { updated: squareHeatmapCells },
    },
    dataLabels: { enabled: false },
    states: {
      hover: { filter: { type: "none" } },
      active: { filter: { type: "none" } },
    },

    // ✅ Exact colors: remove `colors` and disable shades
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
      categories: HOURS.map(String),
      labels: {
        style: { fontSize: "10px", colors: "#000" },
      },
      title: {
        text: "Hour (UTC)",
        style: { fontSize: "12px", fontWeight: 600, color: "#000" },
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tooltip: { enabled: false },
    },

    yaxis: {
      labels: {
        align: "left",
        offsetX: 20,
        style: { fontSize: "12px", fontWeight: 400, colors: "#000" },
      },
    },

    grid: { show: false },

    tooltip: {
      custom: ({ series, seriesIndex, dataPointIndex }) => {
        const day = DAY_NAMES[seriesIndex];
        const hour = HOURS[dataPointIndex];
        const value = series[seriesIndex][dataPointIndex];
        return `
          <div class="heatmap-tooltip">
            <div class="tooltip-header">${day} ${hour.toString().padStart(2, "0")}:00 UTC</div>
            <div class="tooltip-value">Avg Score: ${Number(value).toFixed(2)}</div>
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
      text: "Average post score by day and hour (UTC)",
      align: "center",
      style: { fontSize: "12px", color: "#000" },
    },
  };

  if (typeof ApexCharts === "undefined") {
    alert("Chart library failed to load. Please check your extension files.");
    return;
  }

  chart = new ApexCharts(document.querySelector("#heatmap-chart"), options);
  chart.render().then(squareHeatmapCells);

  bestTimeInfo.innerHTML = `
    <strong>Best Time to Post:</strong> ${DAY_NAMES[bestDay]} at ${bestHour.toString().padStart(2, "0")}:00 UTC<br>
    <strong>Average Score:</strong> ${maxAvg.toFixed(2)} points<br>
    <strong>Posts Analyzed:</strong> ${totalPosts.toLocaleString()}<br>
    <small>Based on analysis of recent top posts in r/${subreddit}</small>
  `;
}
/* ------------------------------------------------------------------------ */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/popup.js"), "utf8");
const nowMs = Date.parse("2026-10-22T12:00:00Z");

function loadPopup(fetchImpl = async () => { throw new Error("Unexpected fetch"); }, overrides = {}) {
  const context = vm.createContext({
    document: { addEventListener() {} },
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    ...overrides,
  });
  vm.runInContext(source, context);
  return {
    fetchPosts: vm.runInContext("fetchPosts", context),
    analyze: vm.runInContext("analyze", context),
    renderHeatmap: vm.runInContext("renderHeatmap", context),
  };
}

function post(id, ageHours, score, extra = {}) {
  return { data: { id, created_utc: (nowMs - ageHours * 3600000) / 1000, score, ...extra } };
}

function response(children, after) {
  return { ok: true, json: async () => ({ data: { children, after } }) };
}

test("pages through new posts and retains only eligible, unique, non-stickied posts", async () => {
  const urls = [];
  const pages = [
    response([post("fresh", 4, 30), post("a", 72, 10), post("pin", 72, 50, { stickied: true })], "next"),
    response([post("a", 72, 10), post("b", 96, 20), post("old", 29 * 24, 100)], null),
  ];
  const { fetchPosts, analyze } = loadPopup(async (url) => {
    urls.push(url);
    return pages.shift();
  });
  const sample = await fetchPosts("example", { nowMs });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/r\/example\/new\.json\?limit=100$/);
  assert.match(urls[1], /after=next/);
  assert.deepEqual(Array.from(sample.posts, (p) => p.id), ["a", "b"]);
  assert.equal(sample.coverageComplete, true);
  assert.equal(analyze(sample).totalPosts, 2);
});

test("only recommends a slot with at least five posts and full window coverage", () => {
  const { analyze } = loadPopup();
  const posts = Array.from({ length: 5 }, (_, i) => ({
    id: String(i), created_utc: (Date.parse("2026-10-19T09:00:00Z") + i * 60000) / 1000, score: 10 + i,
  }));
  const base = { posts, windowStartMs: nowMs - 28 * 86400000, windowEndMs: nowMs - 48 * 3600000 };
  const complete = analyze({ ...base, coverageComplete: true });
  assert.equal(complete.bestDay, 0);
  assert.equal(complete.bestHour, 9);
  assert.equal(complete.maxAvg, 12);
  assert.equal(complete.counts[0][9], 5);
  assert.equal(complete.stats[0][8], null);
  assert.equal(analyze({ ...base, posts: posts.slice(0, 4), coverageComplete: true }).bestDay, null);
  assert.equal(analyze({ ...base, coverageComplete: false }).bestDay, null);
});

test("marks a capped listing as partial even when its sampled slot is strong", async () => {
  const { fetchPosts, analyze } = loadPopup(async () => response(
    Array.from({ length: 5 }, (_, i) => post(String(i), 72, 20)),
    "another-page",
  ));
  const sample = await fetchPosts("example", { nowMs, pages: 1 });
  assert.equal(sample.coverageComplete, false);
  assert.equal(analyze(sample).bestDay, null);
});

test("does not treat a full final page as proof of complete coverage", async () => {
  const { fetchPosts } = loadPopup(async () => response(
    Array.from({ length: 100 }, (_, i) => post(String(i), 72, 20)),
    null,
  ));
  const sample = await fetchPosts("example", { nowMs, pages: 1 });
  assert.equal(sample.coverageComplete, false);
});

test("renders actual dates and average-score/count pairs for every hour", async () => {
  const nodes = {};
  const element = () => ({
    children: [],
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  });
  let chartOptions;
  const document = {
    addEventListener() {},
    getElementById(id) { return nodes[id] ??= element(); },
    querySelector() { return element(); },
    createElement() { return element(); },
  };
  class ApexCharts {
    constructor(_, options) { chartOptions = options; }
    async render() {}
  }
  const { analyze, renderHeatmap } = loadPopup(undefined, { document, ApexCharts });
  const posts = Array.from({ length: 5 }, (_, i) => ({
    id: String(i), created_utc: (Date.parse("2026-10-19T09:00:00Z") + i * 60000) / 1000, score: 10 + i,
  }));
  const analysis = analyze({
    posts, coverageComplete: true,
    windowStartMs: nowMs - 28 * 86400000,
    windowEndMs: nowMs - 48 * 3600000,
  });
  await renderHeatmap(analysis);
  assert.match(nodes.bestTimeInfo.textContent, /Best among sampled recent posts: Monday at 09:00 UTC/);
  assert.match(nodes.bestTimeInfo.textContent, /Actual post dates: 2026-10-19 09:00 UTC to 2026-10-19 09:04 UTC/);
  assert.equal(nodes["hourly-table-body"].children.length, 24);
  assert.equal(nodes["hourly-table-body"].children[9].children[1].textContent, "12.0 · 5");
  assert.match(chartOptions.tooltip.custom({ seriesIndex: 0, dataPointIndex: 9 }), /Posts: 5/);
});

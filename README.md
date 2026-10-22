# Best Time to Post for Reddit

A Chrome extension that compares post scores by UTC day and hour for a subreddit. The popup reads recent posts from Reddit's `new.json` listing, displays a heatmap and an hourly table, and shows how many posts support each average.

The analysis covers a 28-day window and excludes posts newer than 48 hours. It recommends a time only when the available listing covers the window and the selected day/hour slot contains at least five posts. The result describes the **best time among sampled recent posts**, not a proven effect of posting time.

## How to use

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Select **Load unpacked** and choose this repository's root directory.
3. Open a subreddit page, select the extension, and click **Analyze Best Times**.
4. Check the sampled date range and post counts. Expand the hourly table to inspect every day/hour slot.

## Stack and dependencies

- **Chrome Manifest V3.** [The manifest](manifest.json) defines the action popup, tab access, Reddit host permission, and extension content security policy. See Chrome's [manifest documentation](https://developer.chrome.com/docs/extensions/reference/manifest).
- **[ApexCharts](https://apexcharts.com/docs/chart-types/heatmap-chart/) 3.41.0.** A local copy in `js/` renders the heatmap. The popup does not load chart code from a CDN.
- **[Node.js test runner](https://nodejs.org/api/test.html).** The tests check pagination, filtering, recommendation thresholds, and displayed values without an additional test framework.

## Limits

The scan can read at most 1,000 listing entries. In a busy subreddit, those entries may not reach the start of the 28-day window; the popup then shows the partial sample without recommending a time. Scores also reflect post content, moderation, and time since publication.

This release calls Reddit's public `.json` URLs directly. Reddit's [Data API guidance](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) states that clients need registered OAuth access, so API availability should be checked before distribution.

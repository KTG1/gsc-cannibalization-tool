const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3";
const $ = (id) => document.getElementById(id);

let accessToken = "";
let results = [];
let isExample = true;

const exampleResults = [
  ["brand running shoes", "/running-shoes/", 1840, 1610],
  ["lightweight trainers", "/collections/lightweight/", 920, 1380],
  ["everyday running shoes", "/daily-trainers/", 1260, 740],
  ["best shoes for jogging", "/guides/jogging-shoes/", 610, 590],
  ["comfortable sneakers", "/comfort/", 440, 870],
  ["road running footwear", "/road-running/", 780, 330],
  ["men's running trainers", "/mens/running/", 260, 710],
  ["women's running trainers", "/womens/running/", 520, 630],
  ["cushioned running shoes", "/cushioned-shoes/", 390, 350],
  ["running shoe shop", "/shop/", 1050, 460],
].map(([query, path, homepageImpressions, pageImpressions]) => {
  const mutual = Math.min(homepageImpressions, pageImpressions);
  const total = homepageImpressions + pageImpressions;
  return {
    query, homepage: "https://example.com/", subpage: `https://example.com${path}`,
    homepageImpressions, pageImpressions, mutual, total,
    homepageShare: homepageImpressions / total, commonPercentage: (2 * mutual) / total,
  };
}).sort((a, b) => b.mutual - a.mutual);

const today = new Date();
const end = new Date(today); end.setDate(end.getDate() - 3);
const start = new Date(end); start.setDate(start.getDate() - 89);
const iso = (d) => d.toISOString().slice(0, 10);
$("startDate").value = iso(start);
$("endDate").value = iso(end);
$("clientId").value = localStorage.getItem("gsc_oauth_client_id") || "";

function setStatus(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function inferHomepage(siteUrl) {
  if (siteUrl.startsWith("sc-domain:")) return `https://${siteUrl.slice(10).replace(/\/$/, "")}/`;
  const url = new URL(siteUrl);
  return `${url.protocol}//${url.host}/`;
}

function normalizeUrl(value) {
  const url = new URL(value);
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/$/, "") || "/"}`;
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || `Google API returned ${response.status}`);
  }
  return response.json();
}

async function loadProperties() {
  setStatus("Loading Search Console properties…");
  const data = await apiFetch("/sites");
  const sites = (data.siteEntry || []).filter((site) => site.permissionLevel !== "siteUnverifiedUser");
  const select = $("property");
  select.innerHTML = sites.length ? "" : "<option>No verified properties found</option>";
  for (const site of sites) select.add(new Option(site.siteUrl, site.siteUrl));
  select.disabled = !sites.length;
  $("homepage").disabled = !sites.length;
  $("analyzeButton").disabled = !sites.length;
  if (sites.length) {
    $("homepage").value = inferHomepage(sites[0].siteUrl);
    setStatus(`${sites.length} ${sites.length === 1 ? "property" : "properties"} available.`);
  }
}

$("connectButton").addEventListener("click", () => {
  const clientId = $("clientId").value.trim();
  if (!clientId) return setStatus("Enter a Google OAuth client ID.", true);
  if (!window.google?.accounts?.oauth2) return setStatus("Google sign-in has not loaded. Try again.", true);
  localStorage.setItem("gsc_oauth_client_id", clientId);
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: async (response) => {
      if (response.error) return setStatus(response.error_description || response.error, true);
      accessToken = response.access_token;
      try { await loadProperties(); } catch (error) { setStatus(error.message, true); }
    },
    error_callback: (error) => setStatus(error.message || error.type || "Google sign-in failed.", true),
  });
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
});

$("property").addEventListener("change", (event) => {
  $("homepage").value = inferHomepage(event.target.value);
});
$("threshold").addEventListener("input", (event) => { $("thresholdValue").value = event.target.value; });

async function fetchAllRows(siteUrl) {
  const rows = [];
  let startRow = 0;
  while (true) {
    setStatus(`Fetching Search Console rows… ${startRow.toLocaleString()} loaded`);
    const body = {
      startDate: $("startDate").value, endDate: $("endDate").value,
      dimensions: ["query", "page"], type: "web", dataState: "final",
      rowLimit: 25000, startRow,
    };
    const page = await apiFetch(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { method: "POST", body: JSON.stringify(body) });
    const batch = page.rows || [];
    rows.push(...batch);
    if (batch.length < 25000) break;
    startRow += batch.length;
  }
  return rows;
}

function analyze(rows, homepage, threshold) {
  const home = normalizeUrl(homepage);
  const queries = new Map();
  for (const row of rows) {
    const [query, page] = row.keys;
    if (!queries.has(query)) queries.set(query, { home: 0, pages: new Map() });
    const record = queries.get(query);
    if (normalizeUrl(page) === home) record.home += Number(row.impressions || 0);
    else record.pages.set(page, (record.pages.get(page) || 0) + Number(row.impressions || 0));
  }
  const output = [];
  for (const [query, record] of queries) {
    if (!record.home) continue;
    for (const [subpage, pageImpressions] of record.pages) {
      const mutual = Math.min(record.home, pageImpressions);
      if (mutual >= threshold) output.push({
        query, homepage, subpage, homepageImpressions: record.home,
        pageImpressions, mutual, total: record.home + pageImpressions,
        homepageShare: record.home / (record.home + pageImpressions),
        commonPercentage: (2 * mutual) / (record.home + pageImpressions),
      });
    }
  }
  return output.sort((a, b) => b.mutual - a.mutual);
}

function render() {
  $("sampleBadge").hidden = !isExample;
  $("resultCount").textContent = results.length.toLocaleString();
  $("resultsBody").innerHTML = results.map((row) => `<tr>
    <td>${escapeHtml(row.query)}</td><td>${escapeHtml(row.subpage)}</td>
    <td>${row.homepageImpressions.toLocaleString()}</td><td>${row.pageImpressions.toLocaleString()}</td>
    <td>${row.mutual.toLocaleString()}</td><td>${(row.commonPercentage * 100).toFixed(1)}%</td><td>${(row.homepageShare * 100).toFixed(1)}%</td>
  </tr>`).join("");
  renderMap();
  $("emptyState").hidden = true;
  $("report").hidden = false;
}

function renderMap() {
  const visible = results.slice(0, 80);
  const maxMutual = Math.max(...visible.map((row) => row.mutual), 1);
  $("queryMap").innerHTML = visible.map((row, index) => {
    const size = 12 + Math.sqrt(row.mutual / maxMutual) * 25;
    const x = 6 + (1 - row.homepageShare) * 88;
    const lane = index % 10;
    const band = Math.floor(index / 10);
    const jitter = ((hashString(`${row.query}|${row.subpage}`) % 13) - 6) * 0.45;
    const y = 7 + lane * 9.5 + (band % 2 ? 2.4 : 0) + jitter;
    const score = Math.round(row.commonPercentage * 100);
    return `<button class="query-point" style="--x:${x}%;--y:${Math.min(96, Math.max(4, y))}%;--size:${size}px;--score:${score}%" data-index="${index}" aria-label="${escapeHtml(row.query)}, ${score}% common impressions"></button>`;
  }).join("");
  document.querySelectorAll(".query-point").forEach((point) => {
    point.addEventListener("pointerenter", showTooltip);
    point.addEventListener("pointermove", moveTooltip);
    point.addEventListener("pointerleave", hideTooltip);
    point.addEventListener("focus", showTooltip);
    point.addEventListener("blur", hideTooltip);
  });
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function showTooltip(event) {
  const row = results[Number(event.currentTarget.dataset.index)];
  const tooltip = $("mapTooltip");
  tooltip.innerHTML = `<strong>${escapeHtml(row.query)}</strong><dl>
    <dt>Common impression score</dt><dd class="common">${(row.commonPercentage * 100).toFixed(1)}%</dd>
    <dt>Homepage impressions</dt><dd>${row.homepageImpressions.toLocaleString()}</dd>
    <dt>Sub-page impressions</dt><dd>${row.pageImpressions.toLocaleString()}</dd>
    <dt>Mutual impressions</dt><dd>${row.mutual.toLocaleString()}</dd>
    <dt>Sub-page</dt><dd>${escapeHtml(shortUrl(row.subpage))}</dd>
  </dl>`;
  tooltip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  const tooltip = $("mapTooltip");
  const source = event.pointerType ? { x: event.clientX, y: event.clientY } : event.currentTarget.getBoundingClientRect();
  const x = source.x ?? source.left;
  const y = source.y ?? source.bottom;
  const left = Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, x + 16));
  const top = Math.min(window.innerHeight - tooltip.offsetHeight - 12, Math.max(12, y + 16));
  tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
}

function hideTooltip() { $("mapTooltip").hidden = true; }
function shortUrl(value) { try { const url = new URL(value); return `${url.host}${url.pathname}`; } catch { return value; } }

document.querySelectorAll(".view-button").forEach((button) => {
  button.addEventListener("click", () => {
    const showMap = button.dataset.view === "map";
    $("mapView").hidden = !showMap;
    $("tableView").hidden = showMap;
    document.querySelectorAll(".view-button").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
  });
});

function escapeHtml(value) {
  const node = document.createElement("div"); node.textContent = value; return node.innerHTML;
}

$("analyzeButton").addEventListener("click", async () => {
  const button = $("analyzeButton");
  try {
    if (!$("homepage").value) throw new Error("Enter the homepage URL.");
    if (!$("startDate").value || !$("endDate").value) throw new Error("Choose a complete date range.");
    button.disabled = true; button.firstChild.textContent = "Analyzing… ";
    const rows = await fetchAllRows($("property").value);
    isExample = false;
    results = analyze(rows, $("homepage").value, Number($("threshold").value));
    render(); setStatus(`Analyzed ${rows.length.toLocaleString()} query-page rows.`);
  } catch (error) { setStatus(error.message, true); }
  finally { button.disabled = false; button.firstChild.textContent = "Analyze overlap "; }
});

$("downloadButton").addEventListener("click", () => {
  const header = ["query","homepage","subpage","homepage_impressions","subpage_impressions","mutual_impressions","common_impression_percentage","total_impressions","homepage_share"];
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const lines = results.map((r) => [r.query,r.homepage,r.subpage,r.homepageImpressions,r.pageImpressions,r.mutual,(r.commonPercentage * 100).toFixed(2),r.total,r.homepageShare.toFixed(4)].map(quote).join(","));
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "homepage-cannibalization.csv"; link.click();
  URL.revokeObjectURL(link.href);
});

results = exampleResults;
render();

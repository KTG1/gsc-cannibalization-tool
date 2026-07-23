const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3";
const $ = (id) => document.getElementById(id);

let accessToken = "";
let results = [];

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
      });
    }
  }
  return output.sort((a, b) => b.mutual - a.mutual);
}

function render() {
  $("resultCount").textContent = results.length.toLocaleString();
  $("resultsBody").innerHTML = results.map((row) => `<tr>
    <td>${escapeHtml(row.query)}</td><td>${escapeHtml(row.subpage)}</td>
    <td>${row.homepageImpressions.toLocaleString()}</td><td>${row.pageImpressions.toLocaleString()}</td>
    <td>${row.mutual.toLocaleString()}</td><td>${(row.homepageShare * 100).toFixed(1)}%</td>
  </tr>`).join("");
  $("emptyState").hidden = true;
  $("report").hidden = false;
}

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
    results = analyze(rows, $("homepage").value, Number($("threshold").value));
    render(); setStatus(`Analyzed ${rows.length.toLocaleString()} query-page rows.`);
  } catch (error) { setStatus(error.message, true); }
  finally { button.disabled = false; button.firstChild.textContent = "Analyze overlap "; }
});

$("downloadButton").addEventListener("click", () => {
  const header = ["query","homepage","subpage","homepage_impressions","subpage_impressions","mutual_impressions","total_impressions","homepage_share"];
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const lines = results.map((r) => [r.query,r.homepage,r.subpage,r.homepageImpressions,r.pageImpressions,r.mutual,r.total,r.homepageShare.toFixed(4)].map(quote).join(","));
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "homepage-cannibalization.csv"; link.click();
  URL.revokeObjectURL(link.href);
});

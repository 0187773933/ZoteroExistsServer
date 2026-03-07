// ==UserScript==
// @name         Zotero Saved + Visited Highlighter (Scholar + Web of Science + PubMed)
// @namespace    local.zotero.multi
// @version      0.1.1
// @description  Highlight items already saved in Zotero AND highlight WOS items you have clicked (persists across refreshes)
// @match        https://scholar.google.com/*
// @match        https://scholar.google.com/scholar_labs/search/session/*
// @match        *://www-webofscience-com.ezproxy.libraries.wright.edu/wos/woscc/summary/*
// @match        https://pubmed.ncbi.nlm.nih.gov/*
// @match        https://arxiv.org/search/advanced?*
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(() => {
	"use strict";

	console.warn("ZOTERO+VISITED HIGHLIGHTER LOADED", location.href);

	const API = "http://127.0.0.1:9371/exists";
	const ZOTERO_COLOR = "#22c55e";

	const WOS_VISITED_KEY = "wosVisitedRecords_v1";
	const WOS_VISITED_OUTLINE = "2px solid #7c3aed";

	/* =========================
	 * HTTP helper
	 * ========================= */
	const httpRequest =
		(typeof GM !== "undefined" && GM.xmlHttpRequest) ?
		GM.xmlHttpRequest :
		(typeof GM_xmlhttpRequest !== "undefined" ? GM_xmlhttpRequest : null);

	if (!httpRequest) {
		console.error("No GM HTTP API available");
		return;
	}

	function postJSON(url, data) {
		return new Promise((resolve, reject) => {
			httpRequest({
				method: "POST",
				url,
				headers: {
					"Content-Type": "application/json"
				},
				data: JSON.stringify(data),
				onload: res => {
					try {
						resolve(JSON.parse(res.responseText));
					} catch (e) {
						reject(e);
					}
				},
				onerror: reject,
			});
		});
	}

	/* =========================
	 * Cache + pending state
	 * ========================= */
	const zoteroCache = new Map(); // known answers
	const zoteroPending = new Set(); // in-flight queries

	function normalizeTitle(t) {
		if (!t) return "";
		return t.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u2010-\u2015]/g, "-")
			.replace(/[.:;!?]+$/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function cacheKey({
		doi,
		title
	}) {
		if (doi) return `doi:${doi.toLowerCase()}`;
		return `title:${normalizeTitle(title)}`;
	}

	/* =========================
	 * WOS visited storage
	 * ========================= */
	function getVisitedWOS() {
		try {
			return new Set(JSON.parse(localStorage.getItem(WOS_VISITED_KEY) || "[]"));
		} catch {
			return new Set();
		}
	}

	function saveVisitedWOS(set) {
		localStorage.setItem(WOS_VISITED_KEY, JSON.stringify([...set]));
	}
	const visitedWOS = getVisitedWOS();

	function extractWOSIDFromURL(url) {
		const m = (url || "").match(/WOS:\w+/);
		return m ? m[0] : null;
	}

	function markVisitedWOS(id) {
		if (!id || visitedWOS.has(id)) return;
		visitedWOS.add(id);
		saveVisitedWOS(visitedWOS);
	}

	/* =========================
	 * Helpers
	 * ========================= */
	function extractDOIFromText(text) {
		const m = (text || "").match(/10\.\d{4,9}\/[^\s"<>]+/i);
		return m ? m[0] : null;
	}

	function isStableTitle(title) {
		return title && title.length > 10 && !title.endsWith("…");
	}

	function highlightZotero(node) {
		node.style.background = ZOTERO_COLOR;
		node.style.padding = "2px 4px";
		node.style.borderRadius = "4px";
		node.title = "Already in Zotero";
		console.log(node);
	}

	function highlightVisitedWOS(node) {
		node.style.outline = WOS_VISITED_OUTLINE;
		node.style.outlineOffset = "2px";
		node.style.opacity = "0.65";
		const prev = node.title ? node.title + " | " : "";
		node.title = prev + "Previously opened";
	}

	/* =========================
	 * Site collectors
	 * ========================= */
	function collectScholarItems() {
		const items = [];
		document.querySelectorAll("div.gs_r").forEach((card, idx) => {
			const h = card.querySelector("h3.gs_rt");
			if (!h) return;

			let title = h.innerText.trim();
			if (!title) return;
			title = title.replace(/^\[[^\]]+\]\s*/, "");
			const doi = extractDOIFromText(card.innerText || "");

			items.push({
				id: `gs-${idx}`,
				node: h,
				title,
				doi,
				key: cacheKey({
					title,
					doi
				}),
				wosid: null,
			});
		});
		return items;
	}

	function collectWebOfScienceItems() {
		const items = [];
		document.querySelectorAll('a[data-ta="summary-record-title-link"]').forEach((a, idx) => {
			const title = a.innerText.trim();
			if (!title) return;

			const record = a.closest("app-summary-title")?.parentElement || a.parentElement;
			const doi = extractDOIFromText(record?.innerText || "");
			const wosid = extractWOSIDFromURL(a.href);

			items.push({
				id: `wos-${idx}`,
				node: a,
				title,
				doi,
				key: cacheKey({
					title,
					doi
				}),
				wosid,
			});
		});
		return items;
	}

	function collectArxivItems() {
		const items = [];

		document.querySelectorAll("li.arxiv-result").forEach((li, idx) => {

			// stable title selector (works across all arxiv layouts)
			const titleNode = li.querySelector("p.title");
			if (!titleNode) return;

			// normalize whitespace + remove weird line wraps
			const title = titleNode.innerText
				.replace(/\s+/g, " ")
				.replace(/\u200B/g, "") // zero width space
				.trim();

			if (!isStableTitle(title)) return;

			// arxiv id (always exists)
			const absLink = li.querySelector('.list-title a[href*="/abs/"]');
			const arxivID = absLink?.href?.match(/\/abs\/([^?#]+)/)?.[1] || null;

			// DOI occasionally embedded in comments / abstract
			const doi = extractDOIFromText(li.innerText || "");

			// unique key MUST prioritize arxiv id or infinite scroll duplicates happen
			const key = arxivID ?
				`arxiv:${arxivID}` :
				cacheKey({
					title,
					doi
				});

			let x = {
				id: `arxiv-${arxivID || idx}`,
				node: titleNode,
				title,
				doi,
				key,
				wosid: null
			};
			console.log(x);
			items.push(x);

		});

		return items;
	}


	function collectPubMedItems() {
		const items = [];
		document.querySelectorAll("a.docsum-title").forEach((a, idx) => {
			const title = a.innerText.replace(/\s+/g, " ").trim();
			if (!isStableTitle(title)) return;

			const pmid = a.getAttribute("data-article-id") ||
				(a.href.match(/\/(\d+)\//)?.[1] || null);

			items.push({
				id: `pm-${pmid || idx}`,
				node: a,
				title,
				doi: null,
				key: cacheKey({
					title
				}),
				wosid: null,
			});
		});
		return items;
	}

	function collectItemsBySite() {
		const host = location.hostname;
		if (host.includes("scholar.google.com")) return collectScholarItems();
		if (host.includes("webofscience")) return collectWebOfScienceItems();
		if (host.includes("pubmed.ncbi.nlm.nih.gov")) return collectPubMedItems();
		if (host.includes("arxiv.org")) return collectArxivItems();
		return [];
	}

	/* =========================
	 * Query Zotero (fixed)
	 * ========================= */
	async function checkZotero(items) {
		if (!items.length) return;

		// instant visited highlight
		if (location.hostname.includes("webofscience")) {
			items.forEach(it => {
				if (it.wosid && visitedWOS.has(it.wosid)) highlightVisitedWOS(it.node);
			});
		}

		// instant cache highlight
		items.forEach(it => {
			if (zoteroCache.get(it.key) === true) highlightZotero(it.node);
		});

		// filter: unknown AND not pending
		const toQuery = items.filter(it => {
			if (zoteroCache.has(it.key)) return false;
			if (zoteroPending.has(it.key)) return false;
			zoteroPending.add(it.key);
			return true;
		});

		if (!toQuery.length) return;

		const queries = toQuery.map(it => ({
			id: it.id,
			title: it.title,
			doi: it.doi || undefined,
		}));

		let data;
		try {
			data = await postJSON(API, {
				queries
			});
		} catch (e) {
			console.warn("Zotero exists server error", e);
			toQuery.forEach(it => zoteroPending.delete(it.key));
			return;
		}

		const existsMap = new Map((data.results || []).map(r => [r.id, !!r.exists]));

		toQuery.forEach(it => {
			const exists = existsMap.get(it.id) === true;
			zoteroPending.delete(it.key);
			zoteroCache.set(it.key, exists);
			if (exists) highlightZotero(it.node);
		});
	}

	/* =========================
	 * WOS click tracking
	 * ========================= */
	function installWOSClickCapture() {
		if (!location.hostname.includes("webofscience")) return;

		document.addEventListener("click", e => {
			const a = e.target.closest?.('a[href*="/full-record/"]');
			if (!a) return;
			const id = extractWOSIDFromURL(a.href);
			if (id) markVisitedWOS(id);
		}, true);
	}
	installWOSClickCapture();

	/* =========================
	 * Run + observer
	 * ========================= */
	let lastRun = 0;
	async function run() {
		const now = Date.now();
		if (now - lastRun < 800) return;
		lastRun = now;
		await checkZotero(collectItemsBySite());
	}

	run();
	new MutationObserver(run).observe(document.body, {
		childList: true,
		subtree: true
	});

})();
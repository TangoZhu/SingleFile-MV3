/*
 * Save scope popup: choose between saving the whole page, only the main article, or the current selection.
 *
 * This file is part of SingleFile (modified version).
 *
 *   The code in this file is free software: you can redistribute it and/or
 *   modify it under the terms of the GNU Affero General Public License
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 */

/* global chrome */

const SAVE_METHOD = "saveScope.save";
const EXCLUDE_ATTRIBUTE = "data-single-file-scope-exclude";

const savePageButton = document.getElementById("save-page");
const saveArticleButton = document.getElementById("save-article");
const saveSelectionButton = document.getElementById("save-selection");
const statusElement = document.getElementById("status");
const optionsLink = document.getElementById("open-options");

let tab;
// Where page scripts run and what is saved: the top frame, or the content frame of a frameset page
let scriptTarget;
let contentFrameId;

document.querySelectorAll("[data-i18n]").forEach(element => {
	element.textContent = chrome.i18n.getMessage(element.dataset.i18n) || element.dataset.i18n;
});

init();

async function init() {
	[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	scriptTarget = { tabId: tab.id };
	savePageButton.addEventListener("click", () => save({}, cleanUpPage));
	saveArticleButton.addEventListener("click", () => save({ selected: true, removedElementsSelector: "[" + EXCLUDE_ATTRIBUTE + "]" }, prepareArticle));
	saveSelectionButton.addEventListener("click", () => save({ selected: true }, cleanUpPage));
	optionsLink.addEventListener("click", event => {
		event.preventDefault();
		chrome.runtime.openOptionsPage();
		window.close();
	});
	let framesetNote = "";
	try {
		// Frameset pages (e.g. "URL forwarding" pages: <frameset><frame src="real site">) have no content in the top frame:
		// work on the frame containing the most text and save only this frame
		const frame = await findContentFrame();
		if (frame) {
			contentFrameId = frame.frameId;
			scriptTarget = { tabId: tab.id, frameIds: [frame.frameId] };
			framesetNote = chrome.i18n.getMessage("saveScopeFrameset", [frame.result.host]) + "\n";
		}
		const [{ result }] = await chrome.scripting.executeScript({ target: scriptTarget, func: inspectPage });
		if (result.selectionLength) {
			saveSelectionButton.hidden = false;
		}
		if (result.articleLength) {
			// "Save article only" is the default action: highlighted and focused, Enter saves the article
			saveArticleButton.disabled = false;
			setDefaultButton(saveArticleButton);
			statusElement.textContent = framesetNote + chrome.i18n.getMessage("saveScopeArticleFound", [String(result.articleLength)]);
		} else {
			setDefaultButton(savePageButton);
			statusElement.textContent = framesetNote + chrome.i18n.getMessage("saveScopeArticleNotFound");
		}
	} catch (error) {
		// Pages where scripts cannot run (chrome://, Web Store...): only the whole page can be tried
		setDefaultButton(savePageButton);
		statusElement.textContent = framesetNote + chrome.i18n.getMessage("saveScopeArticleNotFound");
	}
}

async function findContentFrame() {
	const [{ result: isFrameset }] = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: () => Boolean(document.body && document.body.tagName == "FRAMESET")
	});
	if (!isFrameset) {
		return null;
	}
	const frames = await chrome.scripting.executeScript({
		target: { tabId: tab.id, allFrames: true },
		func: () => ({
			top: window == window.top,
			textLength: document.body ? document.body.innerText.length : 0,
			host: location.host
		})
	});
	return frames.filter(frame => frame.result && !frame.result.top)
		.sort((frame1, frame2) => frame2.result.textLength - frame1.result.textLength)[0] || null;
}

function setDefaultButton(button) {
	[saveArticleButton, savePageButton].forEach(element => element.classList.toggle("primary", element == button));
	button.focus();
}

async function save(options, prepare) {
	try {
		// Expand collapsed content first (CSDN "展开" code blocks, "阅读全文"...), then prepare the chosen scope
		await chrome.scripting.executeScript({ target: scriptTarget, func: expandCollapsedContent });
		await chrome.scripting.executeScript({ target: scriptTarget, func: prepare });
	} catch (error) {
		// ignored: the page may not be scriptable, SingleFile reports its own errors
	}
	if (contentFrameId !== undefined) {
		// SingleFile's "save frame" feature: only the content frame of the frameset page is saved
		options = Object.assign({}, options, { frameId: contentFrameId });
	}
	await chrome.runtime.sendMessage({ method: SAVE_METHOD, tabId: tab.id, options });
	window.close();
}

// ---------- Functions injected into the page (must be self-contained) ----------

function inspectPage() {
	const HIGHLIGHT_ID = "single-file-scope-highlight";
	const MIN_TEXT = 200;

	function textLength(element) {
		return element ? element.textContent.replace(/\s+/g, " ").trim().length : 0;
	}
	function isVisible(element) {
		if (!element) return false;
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}
	function isArticle(element) {
		return isVisible(element) && textLength(element) >= MIN_TEXT;
	}

	// Known structures: [body selector, title selector]; the article is the closest ancestor of the body containing the title
	function findStructured() {
		const structures = [
			["#page_md_content", "#doc-title-box"], // ShowDoc
			["#content_views", "#articleContentId"] // CSDN
		];
		for (const [bodySelector, titleSelector] of structures) {
			const body = document.querySelector(bodySelector);
			if (!body) continue;
			const title = document.querySelector(titleSelector);
			let element = body;
			if (title) {
				while (element && element != document.body && !element.contains(title)) {
					element = element.parentElement;
				}
				if (!element || element == document.body) {
					element = body;
				}
			}
			if (isArticle(element)) return element;
		}
	}

	function findSemantic() {
		const selectors = ["article", "[itemprop=articleBody]", ".markdown-body", "main", "[role=main]",
			".post-content", ".entry-content", ".article-content", ".post-body"];
		for (const selector of selectors) {
			const candidates = Array.from(document.querySelectorAll(selector)).filter(isArticle);
			// A single matching element is a reliable signal, several ones (e.g. article lists) are not
			if (candidates.length == 1) return candidates[0];
		}
	}

	// Paragraph scoring: text-rich blocks give points to their parent and grandparent, links reduce the score
	function findByScore() {
		const scores = new Map();
		const blocks = document.body.querySelectorAll("p, pre, li, td, blockquote, h2, h3, h4");
		blocks.forEach(block => {
			const length = textLength(block);
			if (length < 25 || !isVisible(block)) return;
			const score = 1 + (block.textContent.match(/[,，。;；]/g) || []).length + Math.min(length / 100, 3);
			const parent = block.parentElement;
			const grandParent = parent && parent.parentElement;
			if (parent) scores.set(parent, (scores.get(parent) || 0) + score);
			if (grandParent) scores.set(grandParent, (scores.get(grandParent) || 0) + score / 2);
		});
		let best, bestScore = 0;
		scores.forEach((score, element) => {
			if (element == document.body || element == document.documentElement) return;
			const length = textLength(element) || 1;
			const linkLength = Array.from(element.querySelectorAll("a")).reduce((total, link) => total + textLength(link), 0);
			const finalScore = score * (1 - Math.min(linkLength / length, 1));
			if (finalScore > bestScore) {
				best = element;
				bestScore = finalScore;
			}
		});
		// Include the title / header when the parent adds little extra text
		while (best && best.parentElement && best.parentElement != document.body &&
			textLength(best.parentElement) <= textLength(best) * 1.25 && isVisible(best.parentElement)) {
			best = best.parentElement;
		}
		return isArticle(best) ? best : null;
	}

	const previous = document.getElementById(HIGHLIGHT_ID);
	if (previous) previous.remove();
	window.__singleFileScopeArticle = findStructured() || findSemantic() || findByScore() || null;
	const article = window.__singleFileScopeArticle;
	if (article) {
		// Temporary outline showing what "save article" will keep
		const rect = article.getBoundingClientRect();
		const highlight = document.createElement("div");
		highlight.id = HIGHLIGHT_ID;
		highlight.style.cssText = "position:absolute;z-index:2147483647;pointer-events:none;box-sizing:border-box;" +
			"border:3px solid #1a73e8;background:rgba(26,115,232,.08);border-radius:4px;" +
			"left:" + (rect.left + window.scrollX) + "px;top:" + (rect.top + window.scrollY) + "px;" +
			"width:" + rect.width + "px;height:" + rect.height + "px;";
		document.documentElement.appendChild(highlight);
		setTimeout(() => highlight.remove(), 8000);
	}
	const selection = window.getSelection();
	return {
		articleLength: article ? textLength(article) : 0,
		selectionLength: selection && !selection.isCollapsed ? selection.toString().trim().length : 0
	};
}

function prepareArticle() {
	const EXCLUDE_ATTRIBUTE = "data-single-file-scope-exclude";
	const highlight = document.getElementById("single-file-scope-highlight");
	if (highlight) highlight.remove();
	document.querySelectorAll("[" + EXCLUDE_ATTRIBUTE + "]").forEach(element => element.removeAttribute(EXCLUDE_ATTRIBUTE));
	const article = window.__singleFileScopeArticle;
	if (!article || !article.isConnected) return;
	// Floating widgets inside the article (table of contents, back to top, share bars) are left out of the saved copy
	const area = article.getBoundingClientRect();
	article.querySelectorAll("*").forEach(element => {
		const position = getComputedStyle(element).position;
		if (position == "fixed") {
			element.setAttribute(EXCLUDE_ATTRIBUTE, "");
		} else if (position == "absolute" || position == "sticky") {
			const rect = element.getBoundingClientRect();
			if (rect.width && (rect.left >= area.right - 1 || rect.right <= area.left + 1)) {
				element.setAttribute(EXCLUDE_ATTRIBUTE, "");
			}
		}
	});
	// SingleFile saves the selected content: select the whole article element
	const selection = window.getSelection();
	const range = document.createRange();
	range.selectNode(article);
	selection.removeAllRanges();
	selection.addRange(range);
	setTimeout(() => selection.removeAllRanges(), 10000);
}

function expandCollapsedContent() {
	function setImportant(element, property, value) {
		element.style.setProperty(property, value, "important");
	}
	// CSDN code blocks taller than 200px get "set-code-height set-code-hide" and a "展开" mask (.hide-preCode-box);
	// clicking the button switches them to "set-code-show"
	document.querySelectorAll("pre.set-code-hide, pre.set-code-height").forEach(pre => {
		pre.classList.remove("set-code-hide", "set-code-height");
		pre.classList.add("set-code-show");
	});
	document.querySelectorAll(".hide-preCode-box").forEach(mask => setImportant(mask, "display", "none"));
	// CSDN "阅读全文": the article is height-limited and covered by .hide-article-box
	const readMoreMask = document.querySelector(".hide-article-box");
	const csdnArticle = document.getElementById("article_content");
	if (readMoreMask && csdnArticle) {
		setImportant(csdnArticle, "height", "auto");
		setImportant(csdnArticle, "max-height", "none");
		setImportant(csdnArticle, "overflow", "visible");
		setImportant(readMoreMask, "display", "none");
	}
	// Other sites: code blocks (and wrappers containing little else) limited in height with hidden or scrolled overflow
	document.querySelectorAll("pre").forEach(pre => {
		const codeLength = pre.textContent.length;
		for (let element = pre, depth = 0; element && element != document.body && depth < 3; element = element.parentElement, depth++) {
			if (element != pre && (element.querySelectorAll("pre").length > 1 || element.textContent.length > codeLength * 1.2 + 200)) {
				break;
			}
			const overflowY = getComputedStyle(element).overflowY;
			if (["hidden", "auto", "scroll", "clip"].includes(overflowY) && element.scrollHeight > element.clientHeight + 4) {
				setImportant(element, "max-height", "none");
				setImportant(element, "height", "auto");
				setImportant(element, "overflow-y", "visible");
			}
		}
	});
}

function cleanUpPage() {
	const highlight = document.getElementById("single-file-scope-highlight");
	if (highlight) highlight.remove();
}

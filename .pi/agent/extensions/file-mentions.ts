/**
 * File Mentions Extension
 *
 * Adds Roo Code-style `@` mentions to Pi:
 * - Files: Type `@` to fuzzy-search project files, with optional line ranges
 * - Folders: Mention directories to include tree listing + file contents
 * - Commits: Mention git commit hashes to include diff and metadata
 *
 * Supports:
 * - File line ranges: @src/index.ts:10-50
 * - Folder mentions: @src/utils  (shows tree + reads immediate files)
 * - Commit mentions: @abc1234   (shows commit info + diff)
 * - Quoted paths: @"path with spaces":10-50
 *
 * Modifiers (placed immediately after @):
 *   For files & commits:
 *     @!path   or  @+path   — inject in full (no truncation / size limit)
 *   For directories:
 *     @!dir    — no size limit on individual files (but still shallow)
 *     @+dir    — read files recursively (with size limit)
 *     @!+dir   or  @+!dir  — recursive AND no size limit
 *
 * Place in ~/.pi/agent/extensions/file-mentions.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

// ── Constants ──────────────────────────────────────────────────────────

const MAX_INDEXED_FILES = 5_000;
const MAX_SUGGESTIONS = 20;
const MAX_LINES = 2_000;
const MAX_BYTES = 50 * 1024; // 50KB
const MAX_RECENT_COMMITS = 50; // Commits to index for autocomplete
const GIT_OUTPUT_LINE_LIMIT = 500; // Max lines for commit diff output

const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	".pi",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	".cache",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	"target",
	".svn",
	".hg",
]);

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".webp",
	".avif",
	".mp3",
	".mp4",
	".wav",
	".avi",
	".mov",
	".mkv",
	".flac",
	".ogg",
	".zip",
	".tar",
	".gz",
	".bz2",
	".7z",
	".rar",
	".xz",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".pyc",
	".class",
	".o",
	".obj",
	".wasm",
	".sqlite",
	".db",
]);

const COMMIT_HASH_RE = /^[a-f0-9]{7,40}$/i;

// ���─ Types ──────────────────────────────────────────────────────────────

interface FileMention {
	type: "file";
	filePath: string;
	lineStart?: number;
	lineEnd?: number;
	full?: boolean;
}

interface FolderMention {
	type: "folder";
	filePath: string;
	full?: boolean;
	recursive?: boolean;
}

interface CommitMention {
	type: "commit";
	hash: string;
	full?: boolean;
}

type Mention = FileMention | FolderMention | CommitMention;

interface CommitInfo {
	hash: string;
	shortHash: string;
	subject: string;
	author: string;
	date: string;
}

// ── File & commit discovery ────────────────────────────────────────────

async function discoverFilesGit(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string[] | undefined> {
	const result = await pi.exec(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{
			cwd,
			timeout: 5_000,
		},
	);
	if (result.code !== 0) return undefined;
	return result.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, MAX_INDEXED_FILES);
}

function discoverFilesWalk(cwd: string): string[] {
	const results: string[] = [];

	function walk(dir: string, rel: string) {
		if (results.length >= MAX_INDEXED_FILES) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (results.length >= MAX_INDEXED_FILES) return;
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("."))
					continue;
				walk(
					path.join(dir, entry.name),
					rel ? `${rel}/${entry.name}` : entry.name,
				);
			} else if (entry.isFile()) {
				results.push(rel ? `${rel}/${entry.name}` : entry.name);
			}
		}
	}

	walk(cwd, "");
	return results;
}

function extractFoldersFromFiles(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		let dir = file.replace(/\\/g, "/");
		let lastSlash = dir.lastIndexOf("/");
		if (lastSlash === -1) continue;
		dir = dir.substring(0, lastSlash);
		while (dir) {
			if (dirs.has(dir)) break; // Already added this and all parents
			dirs.add(dir);
			lastSlash = dir.lastIndexOf("/");
			if (lastSlash === -1) break;
			dir = dir.substring(0, lastSlash);
		}
	}
	return Array.from(dirs).sort();
}

async function discoverCommits(
	pi: ExtensionAPI,
	cwd: string,
): Promise<CommitInfo[]> {
	const result = await pi.exec(
		"git",
		[
			"log",
			"-n",
			String(MAX_RECENT_COMMITS),
			"--format=%H%n%h%n%s%n%an%n%ad",
			"--date=short",
			"--author-date-order",
		],
		{ cwd, timeout: 5_000 },
	);

	if (result.code !== 0) return [];

	const lines = result.stdout.trim().split("\n");
	const commits: CommitInfo[] = [];

	for (let i = 0; i + 4 < lines.length; i += 5) {
		commits.push({
			hash: lines[i],
			shortHash: lines[i + 1],
			subject: lines[i + 2],
			author: lines[i + 3],
			date: lines[i + 4],
		});
	}

	return commits;
}

// ── Mention parsing ────────────────────────────────────────────────────

// Matches either:
// 1. Quoted filepath: @"filename" followed by optional :range
// 2. Unquoted filepath: @filename (which might have a :range suffix)
// Supports optional modifier(s) like !, +, !+, or +! immediately after @
const MENTION_REGEX =
	/(?:^|(?<=\s))@([!+]{1,2})?(?:"([^"]+)"(?::(\d+)(?:-(\d+))?)?|([^\s"]+))/g;

/**
 * Parse and classify all @mentions in user text, returning both
 * the classified mentions and the cleaned text with @refs replaced.
 */
function processInput(
	text: string,
	cwd: string,
): { mentions: Mention[]; cleanText: string } {
	const mentions: Mention[] = [];
	const seen = new Set<string>();

	const cleanText = text.replace(
		MENTION_REGEX,
		(
			_match,
			modifier: string | undefined,
			quotedPath: string | undefined,
			qStart: string | undefined,
			qEnd: string | undefined,
			unquotedPart: string | undefined,
		) => {
			let filePath = "";
			let lineStart: number | undefined;
			let lineEnd: number | undefined;

			const mod = modifier ?? "";
			const hasExcl = mod.includes("!");
			const hasPlus = mod.includes("+");
			// For files & commits: either modifier means "full"
			const isFull = hasExcl || hasPlus;

			if (quotedPath) {
				filePath = quotedPath;
				if (qStart) lineStart = parseInt(qStart, 10);
				if (qEnd) lineEnd = parseInt(qEnd, 10);
			} else if (unquotedPart) {
				let raw = unquotedPart;
				// Strip trailing punctuation unlikely to be part of a filepath
				raw = raw.replace(/[,;:!?)]+$/, "");

				// Parse optional line range suffix  :start-end  or  :line
				const rangeMatch = raw.match(/:(\d+)(?:-(\d+))?$/);
				if (rangeMatch) {
					lineStart = parseInt(rangeMatch[1], 10);
					lineEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined;
					raw = raw.slice(0, raw.lastIndexOf(":"));
				}
				filePath = raw;
			} else {
				return _match;
			}

			// Normalize path separators and strip trailing slashes
			const normalized =
				filePath.replace(/\\/g, "/").replace(/\/+$/, "") || filePath;

			// ── Priority 1: existing directory ───────────────────────
			try {
				const absPath = path.resolve(cwd, expandHome(normalized));
				const stat = fs.statSync(absPath);
				if (stat.isDirectory()) {
					// For directories: ! = no size limit, + = recursive, !+ or +! = both
					const dirFull = hasExcl;
					const dirRecursive = hasPlus;
					const key = `folder:${normalized}:${dirFull ? "full" : "trunc"}:${dirRecursive ? "rec" : "shallow"}`;
					if (!seen.has(key)) {
						seen.add(key);
						mentions.push({
							type: "folder",
							filePath: normalized,
							full: dirFull,
							recursive: dirRecursive,
						});
					}
					return `'${normalized}'`;
				}
			} catch {
				// not an existing directory
			}

			// ── Priority 2: existing file ────────────────────────────
			try {
				const absPath = path.resolve(cwd, expandHome(normalized));
				const stat = fs.statSync(absPath);
				if (stat.isFile()) {
					const key = `file:${normalized}:${lineStart ?? ""}:${lineEnd ?? ""}:${isFull ? "full" : "trunc"}`;
					if (!seen.has(key)) {
						seen.add(key);
						mentions.push({
							type: "file",
							filePath: normalized,
							lineStart,
							lineEnd,
							full: isFull,
						});
					}
					return `'${normalized}'`;
				}
			} catch {
				// not an existing file
			}

			// ── Priority 3: git commit hash (7-40 hex chars) ─────────
			if (COMMIT_HASH_RE.test(normalized) && lineStart === undefined) {
				const key = `commit:${normalized}:${isFull ? "full" : "trunc"}`;
				if (!seen.has(key)) {
					seen.add(key);
					mentions.push({ type: "commit", hash: normalized, full: isFull });
				}
				return `Git commit '${normalized}' (see below for commit info)`;
			}

			// ── Default: treat as file (will show "not found" on read) ─
			const key = `file:${normalized}:${lineStart ?? ""}:${lineEnd ?? ""}:${isFull ? "full" : "trunc"}`;
			if (!seen.has(key)) {
				seen.add(key);
				mentions.push({
					type: "file",
					filePath: normalized,
					lineStart,
					lineEnd,
					full: isFull,
				});
			}
			return `'${normalized}'`;
		},
	);

	return { mentions, cleanText };
}

// ── Helpers ────────────────────────────────────────────────────────────

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

function isBinaryPath(filename: string): boolean {
	const ext = path.extname(filename).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

function formatLines(lines: string[], startLine = 1): string {
	const maxWidth = String(startLine + lines.length - 1).length;
	return lines
		.map((line, idx) => {
			const num = String(startLine + idx).padStart(maxWidth, " ");
			return `${num} | ${line}`;
		})
		.join("\n");
}

/**
 * Truncate git output keeping first 20% and last 80% of lines (Roo Code style).
 */
function truncateGitOutput(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;

	const keepStart = Math.floor(maxLines * 0.2);
	const keepEnd = maxLines - keepStart;
	const omitted = lines.length - maxLines;

	return [
		...lines.slice(0, keepStart),
		`\n... (${omitted} lines omitted) ...\n`,
		...lines.slice(lines.length - keepEnd),
	].join("\n");
}

// ── File reading & formatting ──────────────────────────────────────────

function readFileContent(cwd: string, mention: FileMention): string {
	const absPath = path.resolve(cwd, expandHome(mention.filePath));

	if (!fs.existsSync(absPath)) {
		return `[content for '${mention.filePath}']\nError: File not found: ${mention.filePath}`;
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(absPath);
	} catch {
		return `[content for '${mention.filePath}']\nError: Cannot stat file: ${mention.filePath}`;
	}

	if (!stat.isFile()) {
		return `[content for '${mention.filePath}']\nError: Not a regular file: ${mention.filePath}`;
	}

	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf8");
	} catch (err) {
		return `[content for '${mention.filePath}']\nError: Cannot read file: ${(err as Error).message}`;
	}

	const allLines = content.split("\n");
	const totalLines = allLines.length;

	// Line range requested
	if (mention.lineStart !== undefined) {
		const start = Math.max(1, mention.lineStart);
		const defaultLimit = mention.full ? totalLines : start + MAX_LINES - 1;
		const end =
			mention.lineEnd !== undefined
				? Math.min(totalLines, mention.lineEnd)
				: Math.min(totalLines, defaultLimit);
		const slice = allLines.slice(start - 1, end);

		return [
			`[content for '${mention.filePath}']`,
			`File: ${mention.filePath} (lines ${start}-${end} of ${totalLines})`,
			formatLines(slice, start),
		].join("\n");
	}

	// Full file — check truncation
	const byteSize = Buffer.byteLength(content, "utf8");
	if (mention.full || (totalLines <= MAX_LINES && byteSize <= MAX_BYTES)) {
		return [
			`[content for '${mention.filePath}']`,
			`File: ${mention.filePath}`,
			formatLines(allLines),
		].join("\n");
	}

	// Truncate
	const keptLines = allLines.slice(0, MAX_LINES);
	const nextOffset = MAX_LINES + 1;

	return [
		`[content for '${mention.filePath}']`,
		`IMPORTANT: File content was truncated to fit context.`,
		`Status: Showing lines 1-${MAX_LINES} of ${totalLines} total lines.`,
		`To read more: Use the read tool with offset=${nextOffset} and limit=${MAX_LINES}.`,
		``,
		`File: ${mention.filePath}`,
		formatLines(keptLines),
	].join("\n");
}

// ── Folder reading ─────────────────────────────────────────────────────

function readFolderContent(
	cwd: string,
	folderPath: string,
	full = false,
	recursive = false,
): string {
	const absPath = path.resolve(cwd, expandHome(folderPath));

	if (!fs.existsSync(absPath)) {
		return `[content for folder '${folderPath}']\nError: Folder not found: ${folderPath}`;
	}

	const folderListingLines: string[] = [];
	const fileContents: string[] = [];

	function walkFolder(dir: string, relDir: string, indentPrefix: string) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			folderListingLines.push(
				`${indentPrefix}(cannot read: ${(err as Error).message})`,
			);
			return;
		}

		// Filter out ignored directories, then sort: directories first, then files
		entries = entries.filter(
			(e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)),
		);
		entries.sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const isLast = i === entries.length - 1;
			const connector = isLast ? "└── " : "├── ";
			const childIndent = indentPrefix + (isLast ? "    " : "│   ");

			if (entry.isDirectory()) {
				folderListingLines.push(`${indentPrefix}${connector}${entry.name}/`);
				if (recursive) {
					const childDir = path.join(dir, entry.name);
					const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
					walkFolder(childDir, childRel, childIndent);
				}
			} else if (entry.isFile()) {
				folderListingLines.push(`${indentPrefix}${connector}${entry.name}`);

				// Read non-binary files
				if (!isBinaryPath(entry.name)) {
					const filePath = relDir ? `${relDir}/${entry.name}` : entry.name;
					const absFilePath = path.join(dir, entry.name);

					try {
						const content = fs.readFileSync(absFilePath, "utf8");
						const byteSize = Buffer.byteLength(content, "utf8");

						// Skip very large files in folder reads
						if (!full && byteSize > MAX_BYTES) {
							fileContents.push(
								`[content for '${filePath}']\nFile: ${filePath}\n(File too large: ${Math.round(byteSize / 1024)}KB, skipped)`,
							);
							continue;
						}

						const lines = content.split("\n");
						fileContents.push(
							[
								`[content for '${filePath}']`,
								`File: ${filePath}`,
								formatLines(lines),
							].join("\n"),
						);
					} catch {
						// Skip unreadable files silently
					}
				}
			}
		}
	}

	walkFolder(absPath, folderPath, "");

	const folderListing = folderListingLines.join("\n") + "\n";
	let result = `[content for folder '${folderPath}']\nFolder listing:\n${folderListing}`;
	if (fileContents.length > 0) {
		result += `\n--- File Contents ---\n\n${fileContents.join("\n\n")}`;
	}

	return result;
}

// ── Commit info ────────────────────────────────────────────────────────

async function getCommitInfo(
	pi: ExtensionAPI,
	hash: string,
	cwd: string,
	full = false,
): Promise<string> {
	// Verify we're in a git repo
	const checkResult = await pi.exec("git", ["rev-parse", "--git-dir"], {
		cwd,
		timeout: 3_000,
	});
	if (checkResult.code !== 0) return "Not a git repository";

	// Get commit metadata
	const infoResult = await pi.exec(
		"git",
		["show", "--format=%H%n%h%n%s%n%an%n%ad%n%b", "--no-patch", hash],
		{ cwd, timeout: 5_000 },
	);

	if (infoResult.code !== 0) {
		return `Failed to get commit info: ${infoResult.stderr.trim()}`;
	}

	const infoLines = infoResult.stdout.trim().split("\n");
	const [fullHash, shortHash, subject, author, date, ...bodyLines] = infoLines;
	const body = bodyLines.join("\n").trim();

	// Get file change stats
	const statsResult = await pi.exec(
		"git",
		["show", "--stat", "--format=", hash],
		{ cwd, timeout: 5_000 },
	);

	// Get diff
	const diffResult = await pi.exec("git", ["show", "--format=", hash], {
		cwd,
		timeout: 10_000,
	});

	const parts = [
		`Commit: ${shortHash} (${fullHash})`,
		`Author: ${author}`,
		`Date: ${date}`,
		`\nMessage: ${subject}`,
	];

	if (body) {
		parts.push(`\nDescription:\n${body}`);
	}

	parts.push("\nFiles Changed:");
	parts.push(statsResult.stdout.trim());
	parts.push("\nFull Changes:");

	const output = parts.join("\n") + "\n\n" + diffResult.stdout.trim();
	if (full) {
		return output;
	}
	return truncateGitOutput(output, GIT_OUTPUT_LINE_LIMIT);
}

// ── Autocomplete provider ──────────────────────────────────────────────

function extractMentionToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|(?<=\s))@([^\s@]*)$/);
	return match?.[1];
}

function createMentionAutocompleteProvider(
	current: AutocompleteProvider,
	getFiles: () => Promise<string[]>,
	getFolders: () => Promise<string[]>,
	getCommits: () => Promise<CommitInfo[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractMentionToken(textBeforeCursor);

			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			let prefixSymbol = "";
			let query = token;
			// Strip leading modifier chars (!, +, !+, +!)
			const modMatch = token.match(/^([!+]{1,2})/);
			if (modMatch) {
				prefixSymbol = modMatch[1];
				query = token.slice(prefixSymbol.length);
			}

			const files = await getFiles();
			const folders = await getFolders();
			const commits = await getCommits();
			if (options.signal.aborted) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const folderSet = new Set(folders);
			let items: AutocompleteItem[];

			if (!query.trim()) {
				// ── No query yet — show mix of commits, folders, files ──
				const commitItems: AutocompleteItem[] = commits
					.slice(0, 5)
					.map((c) => ({
						value: `@${prefixSymbol}${c.shortHash}`,
						label: `@${prefixSymbol}${c.shortHash}`,
						description: `${c.subject.slice(0, 50)} (${c.author}, ${c.date})`,
					}));
				const folderItems: AutocompleteItem[] = folders
					.slice(0, 5)
					.map((f) => ({
						value: `@${prefixSymbol}${f}`,
						label: `@${prefixSymbol}${f}/`,
						description: "folder",
					}));
				const fileItems: AutocompleteItem[] = files
					.slice(0, MAX_SUGGESTIONS - commitItems.length - folderItems.length)
					.map((f) => ({
						value: `@${prefixSymbol}${f}`,
						label: `@${prefixSymbol}${f}`,
						description: "file",
					}));

				items = [...commitItems, ...folderItems, ...fileItems];
			} else if (COMMIT_HASH_RE.test(query)) {
				// ── Hex-like query — show matching commits first, then paths ──
				const lowerToken = query.toLowerCase();
				const commitItems: AutocompleteItem[] = commits
					.filter(
						(c) =>
							c.hash.toLowerCase().startsWith(lowerToken) ||
							c.shortHash.toLowerCase().startsWith(lowerToken),
					)
					.slice(0, 10)
					.map((c) => ({
						value: `@${prefixSymbol}${c.shortHash}`,
						label: `@${prefixSymbol}${c.shortHash}`,
						description: `${c.subject.slice(0, 50)} (${c.author}, ${c.date})`,
					}));

				const allPaths = [...folders, ...files];
				const pathItems = fuzzyFilter(allPaths, query, (f) => f)
					.slice(0, MAX_SUGGESTIONS - commitItems.length)
					.map((f) => ({
						value: `@${prefixSymbol}${f}`,
						label: folderSet.has(f)
							? `@${prefixSymbol}${f}/`
							: `@${prefixSymbol}${f}`,
						description: folderSet.has(f) ? "folder" : "file",
					}));

				items = [...commitItems, ...pathItems];
			} else {
				// ── Regular query — search files, folders, and commits by subject ──
				const allPaths = [...folders, ...files];
				const pathItems = fuzzyFilter(allPaths, query, (f) => f)
					.slice(0, MAX_SUGGESTIONS - 3)
					.map((f) => ({
						value: `@${prefixSymbol}${f}`,
						label: folderSet.has(f)
							? `@${prefixSymbol}${f}/`
							: `@${prefixSymbol}${f}`,
						description: folderSet.has(f) ? "folder" : "file",
					}));

				// Also match commits by subject for non-hex queries
				const commitItems = fuzzyFilter(
					commits,
					query,
					(c) => `${c.shortHash} ${c.subject}`,
				)
					.slice(0, 3)
					.map((c) => ({
						value: `@${c.shortHash}`,
						label: `@${c.shortHash}`,
						description: `${c.subject.slice(0, 50)} (${c.author}, ${c.date})`,
					}));

				items = [...pathItems, ...commitItems];
			}

			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				items,
				prefix: `@${token}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

// ── Extension entry point ──────────────────────────────────────────────

export default function fileMentionsExtension(pi: ExtensionAPI) {
	let pendingMentions: Mention[] = [];
	let cwd = "";

	// ── Session start: set up autocomplete ─────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;

		let filesPromise: Promise<string[]> | undefined;
		let foldersPromise: Promise<string[]> | undefined;
		let commitsPromise: Promise<CommitInfo[]> | undefined;
		let loadErrorShown = false;

		const getFiles = async (): Promise<string[]> => {
			filesPromise ||= (async () => {
				// Try git first
				const gitFiles = await discoverFilesGit(pi, cwd);
				if (gitFiles) return gitFiles;

				// Fallback to filesystem walk
				try {
					return discoverFilesWalk(cwd);
				} catch (err) {
					if (!loadErrorShown) {
						loadErrorShown = true;
						ctx.ui.notify(
							`file-mentions: failed to index files: ${(err as Error).message}`,
							"error",
						);
					}
					return [];
				}
			})();
			return filesPromise;
		};

		const getFolders = async (): Promise<string[]> => {
			foldersPromise ||= (async () => {
				const files = await getFiles();
				return extractFoldersFromFiles(files);
			})();
			return foldersPromise;
		};

		const getCommits = async (): Promise<CommitInfo[]> => {
			commitsPromise ||= discoverCommits(pi, cwd);
			return commitsPromise;
		};

		// Pre-warm file list and commits
		void getFiles();
		void getCommits();

		// Register autocomplete provider
		ctx.ui.addAutocompleteProvider((current) =>
			createMentionAutocompleteProvider(
				current,
				getFiles,
				getFolders,
				getCommits,
			),
		);
	});

	// ── Input: parse @mentions, classify & transform text ──────────────

	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const { mentions, cleanText } = processInput(event.text, cwd);
		if (mentions.length === 0) return { action: "continue" as const };

		// Store for before_agent_start to pick up
		pendingMentions = mentions;

		// Replace @path references with clean references in user text
		return { action: "transform" as const, text: cleanText };
	});

	// ── Before agent start: inject file/folder/commit contents ─────────

	pi.on("before_agent_start", async (_event, ctx) => {
		if (pendingMentions.length === 0) return;

		const mentions = pendingMentions;
		pendingMentions = [];

		const contentBlocks: { type: "text"; text: string }[] = [];

		for (const m of mentions) {
			switch (m.type) {
				case "file":
					contentBlocks.push({
						type: "text",
						text: readFileContent(ctx.cwd, m),
					});
					break;

				case "folder":
					contentBlocks.push({
						type: "text",
						text: readFolderContent(ctx.cwd, m.filePath, m.full, m.recursive),
					});
					break;

				case "commit": {
					const info = await getCommitInfo(pi, m.hash, ctx.cwd, m.full);
					contentBlocks.push({
						type: "text",
						text: `<git_commit hash="${m.hash}">\n${info}\n</git_commit>`,
					});
					break;
				}
			}
		}

		return {
			message: {
				customType: "file-mentions",
				content: contentBlocks,
				display: false, // Hidden from TUI, visible to LLM
			},
		};
	});
}

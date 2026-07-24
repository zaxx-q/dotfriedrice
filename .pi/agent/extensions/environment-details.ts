/**
 * Environment Details Extension (v3.2)
 *
 * Implements a hybrid static/dynamic injection pipeline:
 * 1. Static (System Prompt) -> OS info, platform, shell, date, CWD, and Git Repo existence check.
 *    Stays frozen across turns, preserving system prompt context caching.
 * 2. Dynamic (Ephemeral via `context` hook) -> Time, timezone, git status, and recent commits.
 *    Injected in-memory right before the LLM call. Old dynamic blocks are
 *    stripped from past messages to prevent context duplication.
 * 3. Persisted (First Turn Hidden Message) -> Project File Listing.
 *    Injected once on session start as a hidden message, remaining permanently in history.
 *
 * Settings persist to ~/.pi/agent/environment-details.json.
 * Toggle sections with `/env`.
 *
 * Place in ~/.pi/agent/extensions/environment-details.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import ignore from "ignore";

// ── Constants ──────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(
	os.homedir(),
	CONFIG_DIR_NAME,
	"agent",
	"environment-details.json",
);
const MAX_WORKSPACE_FILES = 200;
const ENV_UPDATES_TAG = "environment_updates";
const ENV_UPDATES_REGEX =
	/\n*<environment_updates>[\s\S]*?<\/environment_updates>\n*/g;

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
	"vendor",
	"tmp",
	"temp",
	"deps",
	"pkg",
	"Pods",
	"bundle",
]);

// Clean up leftover v1/v2 injection remnants
const OLD_ENV_DETAILS_REGEX =
	/\n*## Environment Details\nAt the start of each turn[^\n]*\n/g;

// ── Settings ───────────────────────────────────────────────────────────

interface EnvSettings {
	showTime: boolean;
	showOs: boolean;
	showGit: boolean;
	showRecentCommits: boolean;
	showFileTree: boolean;
}

const DEFAULT_SETTINGS: EnvSettings = {
	showTime: true,
	showOs: true,
	showGit: true,
	showRecentCommits: true,
	showFileTree: true,
};

function loadSettings(): EnvSettings {
	try {
		if (fs.existsSync(SETTINGS_PATH)) {
			const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
			const parsed = JSON.parse(raw);
			return {
				showTime: parsed.showTime ?? DEFAULT_SETTINGS.showTime,
				showOs: parsed.showOs ?? DEFAULT_SETTINGS.showOs,
				showGit: parsed.showGit ?? DEFAULT_SETTINGS.showGit,
				showRecentCommits:
					parsed.showRecentCommits ?? DEFAULT_SETTINGS.showRecentCommits,
				showFileTree: parsed.showFileTree ?? DEFAULT_SETTINGS.showFileTree,
			};
		}
	} catch {
		// Corrupted — use defaults
	}
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: EnvSettings) {
	try {
		const dir = path.dirname(SETTINGS_PATH);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
	} catch {
		// Non-critical
	}
}

// ── OS & Shell detection ───────────────────────────────────────────────

function getShellInfo(): string {
	if (os.platform() === "win32") {
		return (
			"Bash (/usr/bin/bash via the bash tool; use POSIX syntax). " +
			"Windows paths use backslashes."
		);
	}
	return process.env.SHELL || "/bin/sh";
}

function getLinuxOsName(): string | undefined {
	try {
		for (const osReleasePath of ["/etc/os-release", "/usr/lib/os-release"]) {
			if (fs.existsSync(osReleasePath)) {
				const content = fs.readFileSync(osReleasePath, "utf8");
				const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
				if (match && match[1]) {
					return match[1];
				}
			}
		}
	} catch {
		// Ignore errors reading os-release
	}
	return undefined;
}

function getOsVersion(): string {
	const platform = os.platform();
	const release = os.release();

	if (platform === "win32") {
		try {
			const v = os.version();
			return v.startsWith("Windows")
				? `${v} (${release})`
				: `Windows ${v} (${release})`;
		} catch {
			return `Windows ${release}`;
		}
	}

	if (platform === "darwin") {
		return `macOS (${release})`;
	}

	if (platform === "linux") {
		const prettyName = getLinuxOsName();
		if (prettyName) {
			return `${prettyName} (${release})`;
		}
		return `Linux ${release}`;
	}

	return `${os.type()} ${release}`;
}

// ── Git repo checks & details extraction ────────────────────────────────

async function checkGitRepository(
	pi: ExtensionAPI,
	cwd: string,
): Promise<boolean> {
	try {
		const res = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
			timeout: 2_000,
		});
		return res.code === 0;
	} catch {
		return false;
	}
}

async function getGitInfo(
	pi: ExtensionAPI,
	cwd: string,
	includeRecentCommits: boolean,
): Promise<string> {
	const execOpts = { cwd, timeout: 5_000 };

	const commands = [
		pi.exec("git", ["branch", "--show-current"], execOpts),
		pi.exec("git", ["status", "--porcelain"], execOpts),
		pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], execOpts),
	] as const;

	const logPromise = includeRecentCommits
		? pi.exec("git", ["log", "--oneline", "-5"], execOpts)
		: undefined;

	const [branchResult, statusResult, defaultBranchResult] =
		await Promise.all(commands);

	const lines: string[] = [];

	const currentBranch = branchResult.stdout.trim() || "(detached HEAD)";
	lines.push(`Current branch: ${currentBranch}`);

	if (defaultBranchResult.code === 0) {
		const ref = defaultBranchResult.stdout.trim();
		const mainBranch = ref.split("/").pop() || ref;
		lines.push(
			`Main branch (you will usually use this for PRs): ${mainBranch}`,
		);
	}

	const statusOutput = statusResult.stdout.trim();
	if (statusOutput) {
		lines.push(`\nStatus:\n${statusOutput}`);
	} else {
		lines.push("\nStatus: clean (no uncommitted changes)");
	}

	if (logPromise) {
		const logResult = await logPromise;
		const logOutput = logResult.stdout.trim();
		if (logOutput) {
			lines.push(`\nRecent commits:\n${logOutput}`);
		}
	}

	lines.push(
		"\nNote: This git status updates each turn and is not a frozen snapshot.",
	);

	return lines.join("\n");
}

// ── File discovery ─────────────────────────────────────────────────────

async function discoverFilesGit(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string[] | undefined> {
	const result = await pi.exec(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{ cwd, timeout: 5_000 },
	);
	if (result.code !== 0) return undefined;
	return result.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, MAX_WORKSPACE_FILES);
}

function discoverFilesWalk(cwd: string): string[] {
	const results: string[] = [];

	// Load gitignore if present
	let ig: ReturnType<typeof ignore> | undefined;
	const gitignorePath = path.join(cwd, ".gitignore");
	const ignorePath = path.join(cwd, ".ignore");
	const fdignorePath = path.join(cwd, ".fdignore");

	try {
		const patterns: string[] = [];
		if (fs.existsSync(gitignorePath)) {
			patterns.push(...fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/));
		}
		if (fs.existsSync(ignorePath)) {
			patterns.push(...fs.readFileSync(ignorePath, "utf8").split(/\r?\n/));
		}
		if (fs.existsSync(fdignorePath)) {
			patterns.push(...fs.readFileSync(fdignorePath, "utf8").split(/\r?\n/));
		}

		const filteredPatterns = patterns
			.map((p) => p.trim())
			.filter((p) => p && !p.startsWith("#"));

		if (filteredPatterns.length > 0) {
			ig = ignore().add(filteredPatterns);
		}
	} catch {
		// skip
	}

	function walk(dir: string, rel: string) {
		if (results.length >= MAX_WORKSPACE_FILES) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (results.length >= MAX_WORKSPACE_FILES) return;
			const entryRel = rel ? `${rel}/${entry.name}` : entry.name;

			// Check standard ignored directory list or .ignore files
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("."))
					continue;
				if (ig && ig.ignores(entryRel + "/")) continue;
				walk(path.join(dir, entry.name), entryRel);
			} else if (entry.isFile()) {
				if (ig && ig.ignores(entryRel)) continue;
				results.push(entryRel);
			}
		}
	}

	walk(cwd, "");
	return results;
}

function formatFileTree(files: string[], didHitLimit: boolean): string {
	const sorted = [...files].sort((a, b) => {
		const aParts = a.split("/");
		const bParts = b.split("/");
		for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
			if (aParts[i] !== bParts[i]) {
				if (i + 1 === aParts.length && i + 1 < bParts.length) return -1;
				if (i + 1 === bParts.length && i + 1 < aParts.length) return 1;
				return aParts[i].localeCompare(bParts[i], undefined, {
					numeric: true,
					sensitivity: "base",
				});
			}
		}
		return aParts.length - bParts.length;
	});

	const output = sorted.join("\n");

	if (didHitLimit) {
		return `${output}\n\n(File list truncated at ${MAX_WORKSPACE_FILES} files. Use fffind/ffgrep to explore further.)`;
	}

	return output;
}

// ── Dynamic environment block builder ──────────────────────────────────

async function buildDynamicBlock(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: EnvSettings,
): Promise<string> {
	const sections: string[] = [];

	// Dynamic time & timezone
	if (settings.showTime) {
		const now = new Date();
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const offsetMinutes = -now.getTimezoneOffset();
		const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
		const offsetMins = Math.abs(offsetMinutes) % 60;
		const sign = offsetMinutes >= 0 ? "+" : "-";
		const offsetStr = `${sign}${offsetHours}:${offsetMins.toString().padStart(2, "0")}`;

		const hours = now.getHours().toString().padStart(2, "0");
		const mins = now.getMinutes().toString().padStart(2, "0");
		const secs = now.getSeconds().toString().padStart(2, "0");

		sections.push(
			`Current time: ${hours}:${mins}:${secs} (${timeZone}, UTC${offsetStr})`,
		);
	}

	// Dynamic git status
	if (settings.showGit) {
		const isGitRepo = await checkGitRepository(pi, ctx.cwd);
		if (isGitRepo) {
			const gitInfo = await getGitInfo(pi, ctx.cwd, settings.showRecentCommits);
			sections.push(gitInfo);
		}
	}

	if (sections.length === 0) return "";

	return `<${ENV_UPDATES_TAG}>\n${sections.join("\n\n")}\n</${ENV_UPDATES_TAG}>`;
}

// ── Content text helpers (avoids `as any`) ─────────────────────────────

interface TextBlock {
	type: "text";
	text: string;
}

function isTextBlock(block: { type: string }): block is TextBlock {
	return block.type === "text" && "text" in block;
}

function stripEnvUpdatesFromText(text: string): string {
	return text.replace(ENV_UPDATES_REGEX, "");
}

// ── Extension entry point ──────────────────────────────────────────────

export default function environmentDetailsExtension(pi: ExtensionAPI) {
	let settings = loadSettings();
	let isFirstTurn = true;

	// ── /env command ────────────────────────────────────────────────────

	pi.registerCommand("env", {
		description:
			"Toggle environment details sections (time, OS, git, file tree)",
		handler: async (_args, ctx) => {
			settings = loadSettings();

			const settingKeys: { key: keyof EnvSettings; label: string }[] = [
				{ key: "showTime", label: "Time & Timezone (dynamic per-turn)" },
				{ key: "showOs", label: "OS, Shell & Platform (static in prompt)" },
				{ key: "showGit", label: "Git Branch & Status (dynamic per-turn)" },
				{ key: "showRecentCommits", label: "Recent Commits (requires Git)" },
				{
					key: "showFileTree",
					label: "Project File Listing (first turn only)",
				},
			];

			const items: SettingItem[] = settingKeys.map(({ key, label }) => ({
				id: key,
				label,
				currentValue: settings[key] ? "on" : "off",
				values: ["on", "off"],
			}));

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const container = new Container();

				container.addChild(
					new Text(
						theme.fg(
							"accent",
							theme.bold(" Environment Details Configuration"),
						),
						1,
						1,
					),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 12),
					getSettingsListTheme(),
					(id, newValue) => {
						const key = id as keyof EnvSettings;
						settings[key] = newValue === "on";
						saveSettings(settings);
					},
					() => done(undefined),
					{ enableSearch: false },
				);

				container.addChild(settingsList);

				container.addChild(
					new Text(
						theme.fg("dim", " ↑↓ navigate • space/enter toggle • esc close"),
						1,
						1,
					),
				);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						_tui.requestRender();
					},
				};
			});

			// Show confirmation after closing
			const active = settingKeys
				.filter(({ key }) => settings[key])
				.map(({ label }) => label);
			if (active.length > 0) {
				ctx.ui.notify(`Active: ${active.join(", ")}`, "info");
			} else {
				ctx.ui.notify(
					"All optional sections disabled. Date & CWD still shown.",
					"info",
				);
			}
		},
	});

	// ── Session start ───────────────────────────────────────────────────

	pi.on("session_start", async () => {
		settings = loadSettings();
		isFirstTurn = true;
	});

	// ── before_agent_start: static system prompt replacement ────────────
	// Only replaces the core footer with stable, cacheable content.
	// Also tracks first-turn flag here (fires once per user prompt).

	pi.on("before_agent_start", async (event, ctx) => {
		let updatedPrompt = event.systemPrompt;

		// Clean up v1/v2 leftovers
		updatedPrompt = updatedPrompt.replace(OLD_ENV_DETAILS_REGEX, "\n");

		// Build the static <environment_static> block
		const lines: string[] = [];
		const cwd = ctx.cwd.replace(/\\/g, "/");

		// Date & CWD only (no time — time goes in dynamic block)
		const dateStr = new Date().toISOString().split("T")[0];
		lines.push(`Current date: ${dateStr}`);
		lines.push(`Current working directory: ${cwd}`);

		// Git repository status - ALWAYS static
		const isGitRepo = await checkGitRepository(pi, ctx.cwd);
		lines.push(`Is a git repository: ${isGitRepo}`);

		if (settings.showOs) {
			lines.push(`Platform: ${os.platform()}`);
			lines.push(`Shell: ${getShellInfo()}`);
			lines.push(`OS Version: ${getOsVersion()}`);
		}

		const staticBlock = `<environment_static>\n${lines.join("\n")}\n</environment_static>`;

		if (
			/<environment_static>[\s\S]*?<\/environment_static>/.test(updatedPrompt)
		) {
			updatedPrompt = updatedPrompt.replace(
				/\n*<environment_static>[\s\S]*?<\/environment_static>/g,
				`\n\n${staticBlock}`,
			);
		} else if (/Current working directory:\s*[^\r\n]+/.test(updatedPrompt)) {
			updatedPrompt = updatedPrompt.replace(
				/\n*Current working directory:\s*[^\r\n]+/g,
				`\n\n${staticBlock}`,
			);
		} else {
			updatedPrompt = `${updatedPrompt.trimEnd()}\n\n${staticBlock}`;
		}

		// First-turn project file tree on-demand
		let messageResult: any;
		if (settings.showFileTree && isFirstTurn) {
			isFirstTurn = false;
			const hasPersistedListing = ctx.sessionManager
				.getBranch()
				.some(
					(entry: any) =>
						entry.type === "custom_message" &&
						entry.customType === "project-file-listing" &&
						typeof entry.content === "string" &&
						entry.content.includes(`dir="${cwd}"`),
				);

			if (!hasPersistedListing) {
				const isHome = cwd === os.homedir().replace(/\\/g, "/");
				const isDesktop =
					cwd === path.join(os.homedir(), "Desktop").replace(/\\/g, "/");

				if (!isHome && !isDesktop) {
					try {
						let files = await discoverFilesGit(pi, ctx.cwd);
						let didHitLimit = false;

						if (files) {
							didHitLimit = files.length >= MAX_WORKSPACE_FILES;
						} else {
							files = discoverFilesWalk(ctx.cwd);
							didHitLimit = files.length >= MAX_WORKSPACE_FILES;
						}

						if (files.length > 0) {
							const tree = formatFileTree(files, didHitLimit);
							messageResult = {
								customType: "project-file-listing",
								content: `<project_file_listing dir="${cwd}">\n${tree}\n</project_file_listing>`,
								display: false,
							};
						}
					} catch {
						// skip
					}
				}
			}
		}

		return {
			systemPrompt: updatedPrompt,
			message: messageResult,
		};
	});

	// ── context: ephemeral dynamic injection ────────────────────────────
	// Fires before every LLM call. Strips old dynamic blocks from history,
	// appends fresh dynamic block to the last user message only.

	pi.on("context", async (event, ctx) => {
		const messages = event.messages;

		// 1. Strip all previous <environment_updates> blocks from history
		for (const msg of messages) {
			if (typeof msg.content === "string") {
				msg.content = stripEnvUpdatesFromText(msg.content);
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (isTextBlock(block)) {
						block.text = stripEnvUpdatesFromText(block.text);
					}
				}
			}
		}

		// 2. Build fresh dynamic block
		const dynamicBlock = await buildDynamicBlock(pi, ctx, settings);

		if (!dynamicBlock || messages.length === 0) {
			return { messages };
		}

		// 3. Find the last user message to append to (not tool results)
		let targetMsg: (typeof messages)[number] | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				targetMsg = messages[i];
				break;
			}
		}

		if (!targetMsg) {
			return { messages };
		}

		// 4. Append dynamic block to last user message
		if (typeof targetMsg.content === "string") {
			targetMsg.content = `${targetMsg.content}\n\n${dynamicBlock}`;
		} else if (Array.isArray(targetMsg.content)) {
			// Find last text block in the content array
			let lastTextBlock: TextBlock | undefined;
			for (let i = targetMsg.content.length - 1; i >= 0; i--) {
				const block = targetMsg.content[i];
				if (isTextBlock(block)) {
					lastTextBlock = block;
					break;
				}
			}

			if (lastTextBlock) {
				lastTextBlock.text = `${lastTextBlock.text}\n\n${dynamicBlock}`;
			} else {
				// No text block found — add one
				targetMsg.content.push({ type: "text", text: dynamicBlock });
			}
		}

		return { messages };
	});
}

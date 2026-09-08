/**
 * Custom Plan Mode Extension
 *
 * An inquisitive planning mode that creates comprehensive, file-backed plans
 * through dialogue. Uses the built-in ask_user tool for clarifying questions.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle plan mode
 * - Saves plans as markdown files in ./plans/ directory
 * - Bash restricted to read-only commands
 * - After plan approval, optionally continues implementation in a fresh session
 * - The plan file is comprehensive enough to stand alone as context
 *
 * Commands:
 *   /plan [options] [prompt] — enter plan mode (toggle off if already in plan mode)
 *                              options: --unrestricted, -u, --unsafe-bash (lifts bash read-only restrictions)
 *   /plan-exec               — execute the current plan in a new session
 *   Ctrl+Alt+P               — toggle plan mode
 *
 * Flags:
 *   --plan                   — start session in plan mode
 *   --plan-unrestricted      — start session in plan mode with unrestricted bash
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import fs from "fs";
import path from "path";
import { isSafeCommand } from "./utils.ts";

async function getPlanFiles(
	cwd: string,
): Promise<{ relPath: string; absPath: string; mtime: number }[]> {
	const plansDir = path.join(cwd, "plans");
	try {
		const stat = await fs.promises.stat(plansDir);
		if (!stat.isDirectory()) {
			return [];
		}
	} catch {
		return [];
	}

	try {
		const files = await fs.promises.readdir(plansDir);
		const planFiles = [];
		for (const file of files) {
			if (file.toLowerCase().endsWith(".md")) {
				const filePath = path.join(plansDir, file);
				try {
					const fileStat = await fs.promises.stat(filePath);
					if (fileStat.isFile()) {
						const relPath = `plans/${file}`.replace(/\\/g, "/");
						planFiles.push({
							relPath,
							absPath: filePath,
							mtime: fileStat.mtimeMs,
						});
					}
				} catch {
					// Ignore stat errors
				}
			}
		}
		return planFiles.sort((a, b) => b.mtime - a.mtime);
	} catch {
		return [];
	}
}

// Tools available during planning (read-only + ask_user for dialogue + write for saving plans)
const PLAN_TOOLS = [
	"read",
	"bash",
	"ffgrep",
	"fffind",
	"ls",
	"ask_user",
	"write",
	"Agent",
	"resolve-library-id",
	"query-docs",
	"steer_subagent",
	"get_subagent_result",
];

interface PlanState {
	enabled: boolean;
	planFile: string | undefined;
	bashUnrestricted?: boolean;
}

function parsePlanArgs(args?: string): {
	unrestricted: boolean;
	prompt?: string;
} {
	if (!args) return { unrestricted: false };
	let text = args.trim();
	const flagRegex =
		/(?:^|\s)(?:--unrestricted|-u|--unsafe-bash|--no-bash-restriction|--full-bash)(?=\s|$)/i;
	let unrestricted = false;

	while (flagRegex.test(text)) {
		unrestricted = true;
		text = text.replace(flagRegex, " ").trim();
	}

	return {
		unrestricted,
		prompt: text.length > 0 ? text : undefined,
	};
}

export default function customPlanMode(pi: ExtensionAPI): void {
	let planEnabled = false;
	let currentPlanFile: string | undefined;
	let bashUnrestricted = false;

	// ── Flags ───────────────────────────────────────────────────────────────
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration + planning)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("plan-unrestricted", {
		description: "Start in plan mode with unrestricted bash execution",
		type: "boolean",
		default: false,
	});

	// ── Helpers ─────────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (planEnabled) {
			const modeSuffix = bashUnrestricted ? " [unrestricted bash]" : "";
			const label = currentPlanFile
				? ctx.ui.theme.fg("warning", `⏸ plan${modeSuffix} (${currentPlanFile})`)
				: ctx.ui.theme.fg("warning", `⏸ plan${modeSuffix}`);
			ctx.ui.setStatus("custom-plan", label);
		} else {
			ctx.ui.setStatus("custom-plan", undefined);
		}
	}

	function enterPlanMode(
		ctx: ExtensionContext,
		options?: { unrestricted?: boolean },
	): void {
		planEnabled = true;
		bashUnrestricted = options?.unrestricted ?? false;
		currentPlanFile = undefined;
		pi.setActiveTools(PLAN_TOOLS);
		const notifyMsg = bashUnrestricted
			? "Plan mode enabled (unrestricted bash) — save plans to plans/. Use /plan to exit."
			: "Plan mode enabled — read-only tools only. Use /plan to exit.";
		ctx.ui.notify(notifyMsg, "info");
		updateStatus(ctx);
		persistState();
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		planEnabled = false;
		bashUnrestricted = false;
		pi.setActiveTools(pi.getAllTools().map((t) => t.name));
		ctx.ui.notify("Plan mode disabled. Full tool access restored.", "info");
		updateStatus(ctx);
		persistState();
	}

	function persistState(): void {
		pi.appendEntry("custom-plan-state", {
			enabled: planEnabled,
			planFile: currentPlanFile,
			bashUnrestricted,
		} as PlanState);
	}

	// ── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description:
			"Toggle plan mode, or start with options/prompt: /plan [--unrestricted|-u] <prompt>",
		handler: async (args, ctx) => {
			const parsed = parsePlanArgs(args);

			if (planEnabled) {
				if (!args?.trim()) {
					exitPlanMode(ctx);
					return;
				}

				// If switching restriction mode while already in plan mode
				if (parsed.unrestricted !== bashUnrestricted) {
					bashUnrestricted = parsed.unrestricted;
					const modeMsg = bashUnrestricted
						? "Plan mode updated: bash is now unrestricted."
						: "Plan mode updated: bash is now restricted to read-only commands.";
					ctx.ui.notify(modeMsg, "info");
					updateStatus(ctx);
					persistState();
				}

				if (parsed.prompt) {
					pi.sendUserMessage(parsed.prompt);
				}
				return;
			}

			enterPlanMode(ctx, { unrestricted: parsed.unrestricted });
			if (parsed.prompt) {
				pi.sendUserMessage(parsed.prompt);
			}
		},
	});

	pi.registerCommand("plan-exec", {
		description: "Execute a saved plan in a fresh new session",
		handler: async (_args, ctx) => {
			const planFiles = await getPlanFiles(ctx.cwd || process.cwd());

			if (planFiles.length === 0) {
				ctx.ui.notify(
					"No plan files found in ./plans/. Create a plan first with /plan.",
					"error",
				);
				return;
			}

			let planFile = currentPlanFile;

			if (planFiles.length > 1) {
				const options = planFiles.map((f) => f.relPath);
				const selected = await ctx.ui.select(
					"Select a plan to execute (most recent first):",
					options,
				);
				if (!selected) return;
				planFile = selected;
			} else {
				const singlePlan = planFiles[0].relPath;
				const ok = await ctx.ui.confirm(
					"Execute plan in new session?",
					`This will start a fresh session with the plan file: ${singlePlan}`,
				);
				if (!ok) return;
				planFile = singlePlan;
			}

			if (!planFile) return;

			// Exit plan mode before starting new session
			exitPlanMode(ctx);

			const parentSession = ctx.sessionManager.getSessionFile();

			await ctx.newSession({
				parentSession,
				withSession: async (newCtx) => {
					const kickoffMessage =
						`Thoroughly examine the plan @${planFile} and implement it step by step. ` +
						`Follow the plan exactly. Work through each step in order. ` +
						`After completing each step, briefly note what was done before moving to the next one.`;

					if (newCtx.hasUI) {
						newCtx.ui.setEditorText(kickoffMessage);
						newCtx.ui.notify(
							"Plan execution prompt prefilled. Press Enter to send or edit.",
							"info",
						);
					} else {
						await newCtx.sendUserMessage(kickoffMessage);
					}
				},
			});
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (planEnabled) {
				exitPlanMode(ctx);
			} else {
				enterPlanMode(ctx);
			}
		},
	});

	// ── Event: block destructive bash in plan mode ──────────────────────────
	pi.on("tool_call", async (event) => {
		if (!planEnabled) return;

		if (event.toolName === "bash" && !bashUnrestricted) {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not in read-only allowlist). Use /plan to exit plan mode or use /plan --unrestricted to allow unrestricted bash.\nCommand: ${command}`,
				};
			}
		}

		// Block file modifications in plan mode (except to plans/ directory)
		// write is available in plan mode but only for the plans/ directory
		if (event.toolName === "write") {
			const path = event.input.path as string;
			const normalized = path.replace(/\\/g, "/");
			if (!normalized.startsWith("plans/") && !normalized.includes("/plans/")) {
				return {
					block: true,
					reason: `Plan mode: the write tool is restricted to the plans/ directory only.\nPath: ${path}\nSave your plan to plans/<name>.md`,
				};
			}
		}
	});

	// ── Event: track when the agent writes a plan file ──────────────────────
	pi.on("tool_result", async (event) => {
		if (!planEnabled) return;

		if (event.toolName === "write" && !event.isError) {
			const path = (event.input as { path?: string }).path;
			if (path && /^plans\/.*\.md$/i.test(path.replace(/\\/g, "/"))) {
				currentPlanFile = path;
				persistState();
			}
		}
	});

	// ── Event: filter stale plan-mode context when not planning ─────────────
	pi.on("context", async (event) => {
		if (planEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as typeof m & { customType?: string };
				if (msg.customType === "custom-plan-context") return false;
				return true;
			}),
		};
	});

	// ── Event: inject planning prompt ───────────────────────────────────────
	pi.on("before_agent_start", async () => {
		if (!planEnabled) return;

		return {
			message: {
				customType: "custom-plan-context",
				content: buildPlanPrompt(bashUnrestricted),
				display: false,
			},
		};
	});

	// ── Event: after agent finishes in plan mode, prompt for next action ────
	pi.on("agent_end", async (_event, ctx) => {
		if (!planEnabled || !ctx.hasUI) return;

		// Only show the menu if a plan file exists
		if (!currentPlanFile) return;

		const options = [
			"Execute in a new session",
			"Refine the plan",
			"Exit plan mode",
			"Stay in plan mode",
		];

		const choice = await ctx.ui.select(
			`Plan saved to ${currentPlanFile}. What next?`,
			options,
		);

		if (choice === "Execute in a new session") {
			ctx.ui.setEditorText("/plan-exec");
			ctx.ui.notify(
				"Prefilled `/plan-exec`. Press Enter to run it and launch the execution session.",
				"info",
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor(
				"What would you like to change about the plan?",
				"",
			);
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		} else if (choice === "Exit plan mode") {
			exitPlanMode(ctx);
		}
		// "Stay in plan mode" — do nothing
	});

	// ── Event: restore state on session start ──────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan-unrestricted") === true) {
			planEnabled = true;
			bashUnrestricted = true;
		} else if (pi.getFlag("plan") === true) {
			planEnabled = true;
			bashUnrestricted = false;
		}

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "custom-plan-state",
			)
			.pop() as { data?: PlanState } | undefined;

		if (stateEntry?.data) {
			planEnabled = stateEntry.data.enabled ?? planEnabled;
			currentPlanFile = stateEntry.data.planFile ?? currentPlanFile;
			bashUnrestricted = stateEntry.data.bashUnrestricted ?? bashUnrestricted;
		}

		if (planEnabled) {
			pi.setActiveTools(PLAN_TOOLS);
		}
		updateStatus(ctx);
	});
}

// ── Plan mode system prompt ─────────────────────────────────────────────────

function buildPlanPrompt(bashUnrestricted: boolean = false): string {
	const tools = PLAN_TOOLS.join(", ");

	const bashRestrictionLine = bashUnrestricted
		? "- Bash commands are unrestricted (running tests, build scripts, dev commands, etc. is allowed, but do NOT modify source code files directly)"
		: "- Bash is restricted to read-only commands (ls, grep, git status, cat, find, rg, etc.)";

	const lines = [
		"[PLAN MODE ACTIVE]",
		"You are an experienced technical leader who is inquisitive and an excellent planner. Your goal is to gather information and get context to create a detailed, actionable plan for accomplishing the user's task.",
		"",
		"## Restrictions",
		`- Available tools: ${tools}`,
		bashRestrictionLine,
		"- You CANNOT use: edit, write (except to the plans/ directory)",
		"- Do NOT attempt to make code changes — just plan.",
		"",
		"## Planning Process",
		"",
		"1. **Gather Context**: Use read-only tools to explore the codebase and understand the current state unless told otherwise. Read relevant files IN FULL to get complete context. Grep for related code, find similar patterns, understand the architecture.",
		"",
		"2. **Ask Clarifying Questions**: Use ask_user to ask the user clarifying questions to better understand requirements, constraints, and preferences. Push back on weak assumptions and name trade-offs. Do not assume — ask.",
		"",
		"3. **Create a Detailed Plan**: Once you have enough context, create a comprehensive plan with clear, actionable steps. The plan must be detailed enough that someone with no prior context could follow it to implement the solution.",
		"",
		"4. **Review with User**: Present the plan and ask if they are pleased with it or want changes. Think of this as a brainstorming session where you discuss and refine.",
		"",
		"5. **Save the Plan**: Save the final approved plan as a markdown file in the plans/ directory using the write tool. Use a descriptive kebab-case filename like plans/add-auth-middleware.md.",
		"",
		"## Plan File Guidelines",
		"",
		"The plan file must be **comprehensive and self-contained**. It will be used as the sole context in a fresh implementation session executed by a less capable model.",
		"",
		"Structure the plan however best fits the task. A small config change might need just a few paragraphs; a large refactor might need detailed sub-sections with numbered steps. Use your judgment — but make sure the plan covers these essentials:",
		"",
		"- **What** is being done and **why** (the goal and motivation)",
		"- **Context** the implementer needs (relevant files, architecture, dependencies, constraints)",
		"- **Concrete steps** with specific file paths, function names, and code patterns — not vague descriptions",
		"- **Code snippets** for any non-trivial logic (see below)",
		"- **How to verify** the changes work correctly",
		"- **Key decisions** made during planning and their rationale",
		"",
		"You do not need to follow a rigid template. Adapt the format to the complexity and nature of the task. What matters is that someone reading the plan with no prior context can implement the solution unambiguously.",
		"",
		"## Code Snippets in Plans",
		"",
		"The implementation phase is executed by a weaker model. To compensate, include code snippets wherever the logic is important, subtle, or non-obvious:",
		"",
		"- **Complex algorithms or data transformations** — write the core logic directly.",
		"- **API usage patterns** — show the correct way to call an API, especially if the signature is unusual or has required options.",
		"- **Type definitions / interfaces** — provide the exact shape when it matters.",
		"- **Integration points** — show how pieces connect (imports, wiring, middleware chains, etc.).",
		"- **Edge case handling** — write out the guard clauses or error handling logic.",
		"- **Configuration** — provide exact config objects, environment variables, or settings.",
		"",
		"Keep snippets focused — show the important parts, not boilerplate. Use comments like `// ... existing code ...` to skip unchanged sections. The goal is to give the implementing model unambiguous code to follow rather than vague prose descriptions of what to write.",
		"",
		"## Important Rules",
		"- Never provide time estimates (hours, days, weeks) for tasks",
		"- Each step should be concrete enough to implement without ambiguity",
		"- Include file paths, function names, and specific code patterns where relevant",
		"- Include code snippets for any non-trivial logic — the implementing model benefits from concrete examples",
		"- The plan file must stand alone — a new session with only the plan file should have enough context to implement everything",
	];

	return lines.join("\n");
}
